import { NextRequest, NextResponse } from 'next/server';
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
  requireCSRF,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { recordChange } from '@/lib/change-tracking';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { CreateBundleLinkSchema } from '@/lib/validation/bundle-links';
import type { BundleComponentSnapshot } from '@/types/bulk-map';
import { ZodError } from 'zod';

export const dynamic = 'force-dynamic';

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-links:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  let body: ReturnType<typeof CreateBundleLinkSchema.parse>;
  try {
    body = CreateBundleLinkSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? 'Invalid input' }, { status: 400 });
    }
    throw err;
  }

  const integration = await prisma.integration.findUnique({
    where: { id: body.integrationId },
  });
  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }
  await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);

  if (!integration.isActive) {
    return NextResponse.json({ error: 'Integration is not active' }, { status: 400 });
  }

  // Validate all component internal products exist + not soft-deleted
  const internalIds = body.components.map((c) => c.internalProductId);
  type ProductInfo = { id: number; name: string; deletedAt: Date | null };
  const products: ProductInfo[] = await prisma.product.findMany({
    where: { id: { in: internalIds } },
    select: { id: true, name: true, deletedAt: true },
  });
  const productMap = new Map<number, ProductInfo>(products.map((p) => [p.id, p]));

  for (const c of body.components) {
    const p = productMap.get(c.internalProductId);
    if (!p) {
      return NextResponse.json(
        { error: `Internal product ${c.internalProductId} not found` },
        { status: 400 },
      );
    }
    if (p.deletedAt !== null) {
      return NextResponse.json(
        { error: `Internal product ${c.internalProductId} (${p.name}) has been deleted` },
        { status: 400 },
      );
    }
  }

  // 409 if external already mapped within this integration
  const existing = await prisma.productLink.findFirst({
    where: {
      integrationId: body.integrationId,
      externalProductId: body.externalProductId,
      externalVariantId: body.externalVariantId ?? null,
    },
  });
  if (existing) {
    return NextResponse.json(
      { error: 'A product link already exists for this integration and external product/variant' },
      { status: 409 },
    );
  }

  // Build snapshot data for backfill (D5 + D7)
  const snapshot: BundleComponentSnapshot[] = body.components.map((c, i) => ({
    internalProductId: c.internalProductId,
    internalProductName: productMap.get(c.internalProductId)?.name ?? '',
    quantity: c.quantity,
    sortOrder: i,
  }));

  let txResult: { link: Awaited<ReturnType<typeof prisma.productLink.create>>; backfilledCount: number };
  try {
    txResult = await prisma.$transaction(async (tx) => {
      const link = await tx.productLink.create({
        data: {
          integrationId: body.integrationId,
          internalProductId: null,
          isBundle: true,
          externalProductId: body.externalProductId,
          externalVariantId: body.externalVariantId ?? null,
          externalSku: body.externalSku ?? null,
          externalTitle: body.externalTitle ?? null,
        },
      });

      await tx.bundleComponent.createMany({
        data: body.components.map((c, i) => ({
          productLinkId: link.id,
          internalProductId: c.internalProductId,
          quantity: c.quantity,
          sortOrder: i,
        })),
      });

      // D5 + D7: backfill pre-existing unmapped order items with snapshot.
      // Skip already-fulfilled items — they were deducted before the bundle link
      // existed and have no snapshot to restore from. A future unfulfill on these
      // would credit phantom stock for components that were never deducted.
      const variantClause =
        body.externalVariantId
          ? { externalVariantId: body.externalVariantId }
          : { externalVariantId: null };

      const backfill = await tx.externalOrderItem.updateMany({
        where: {
          productLinkId: null,
          fulfilledQty: 0,
          externalProductId: body.externalProductId,
          ...variantClause,
          order: { integrationId: body.integrationId },
        },
        data: {
          productLinkId: link.id,
          isMapped: true,
          bundleComponentSnapshot: snapshot as unknown as object,
        },
      });

      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: 'MAPPING_CREATE',
        entityType: 'MAPPING',
        entityId: link.id,
        companyId: integration.companyId,
        action: `Created bundle mapping ${link.id}`,
        details: {
          integrationId: body.integrationId,
          internalProductId: null,
          externalProductId: body.externalProductId,
          externalVariantId: body.externalVariantId ?? null,
          isBundle: true,
          components: body.components.map((c) => ({
            internalProductId: c.internalProductId,
            quantity: c.quantity,
          })),
          backfilledOrderItems: backfill.count,
        },
      });

      return { link, backfilledCount: backfill.count };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json(
        { error: 'A product link already exists for this integration and external product/variant' },
        { status: 409 },
      );
    }
    throw err;
  }
  const { link, backfilledCount } = txResult;

  // Explicit projection (future-safe) — must match PATCH response shape.
  // See app/api/products/bundle-links/[linkId]/route.ts.
  const response = NextResponse.json(
    {
      id: link.id,
      integrationId: link.integrationId,
      externalProductId: link.externalProductId,
      externalVariantId: link.externalVariantId,
      externalSku: link.externalSku,
      externalTitle: link.externalTitle,
      isBundle: link.isBundle,
      internalProductId: link.internalProductId,
      createdAt: link.createdAt,
      components: snapshot,
      backfilledCount,
    },
    { status: 201 },
  );
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
