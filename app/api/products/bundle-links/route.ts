import { NextRequest, NextResponse } from 'next/server';
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { validateCSRFToken } from '@/lib/csrf';
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

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
  const products = await prisma.product.findMany({
    where: { id: { in: internalIds } },
    select: { id: true, name: true, deletedAt: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

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

  const { link, backfilledCount } = await prisma.$transaction(async (tx) => {
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

    // D5 + D7: backfill pre-existing unmapped order items with snapshot
    const variantClause =
      body.externalVariantId
        ? { externalVariantId: body.externalVariantId }
        : { externalVariantId: null };

    const backfill = await tx.externalOrderItem.updateMany({
      where: {
        productLinkId: null,
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

    return { link, backfilledCount: backfill.count };
  });

  const response = NextResponse.json(
    {
      ...link,
      components: snapshot,
      backfilledCount,
    },
    { status: 201 },
  );
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
