import { NextRequest, NextResponse } from 'next/server';
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
  requireCSRF,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { recordChange } from '@/lib/change-tracking';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { UpdateBundleLinkSchema } from '@/lib/validation/bundle-links';
import { ZodError } from 'zod';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: { linkId: string };
}

export const PATCH = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-links:PATCH', {
    identifier: user.id,
  });

  await requireCSRF(request);

  let body: ReturnType<typeof UpdateBundleLinkSchema.parse>;
  try {
    body = UpdateBundleLinkSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message ?? 'Invalid input' }, { status: 400 });
    }
    throw err;
  }

  const link = await prisma.productLink.findUnique({
    where: { id: params.linkId },
    include: { integration: { select: { companyId: true } } },
  });

  if (!link) {
    return NextResponse.json({ error: 'Bundle link not found' }, { status: 404 });
  }

  await requireCompanyMembership(user.id, link.integration.companyId, user.isAdmin);

  if (!link.isBundle) {
    return NextResponse.json(
      { error: 'Link is not a bundle. Use POST /api/products/[id]/links for single mappings.' },
      { status: 400 },
    );
  }

  // Validate component internal products
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

  // D7: replace components atomically; do NOT touch existing ExternalOrderItem snapshots
  await prisma.$transaction(async (tx) => {
    // R-D16: the OLD component rows' ids ARE the destroyed identities — capture
    // them BEFORE the deleteMany. The new set lands via createMany (no ids
    // returned), so `to` carries the component set, which IS the created state
    // (R-D11 create semantics). Cap 1000 (schema caps components at 50).
    const oldComponents = await tx.bundleComponent.findMany({
      where: { productLinkId: link.id },
      select: { id: true, internalProductId: true, quantity: true },
      orderBy: { sortOrder: 'asc' },
      take: 1000,
    });

    await tx.bundleComponent.deleteMany({ where: { productLinkId: link.id } });
    await tx.bundleComponent.createMany({
      data: body.components.map((c, i) => ({
        productLinkId: link.id,
        internalProductId: c.internalProductId,
        quantity: c.quantity,
        sortOrder: i,
      })),
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: 'BUNDLE_CHANGE',
      entityType: 'MAPPING',
      entityId: link.id,
      companyId: link.integration.companyId,
      action: `Updated bundle components for ${link.id}`,
      changes: {
        components: {
          from: oldComponents,
          to: body.components.map((c) => ({
            internalProductId: c.internalProductId,
            quantity: c.quantity,
          })),
        },
      },
    });
  });

  const updated = await prisma.productLink.findUnique({
    where: { id: link.id },
    include: {
      bundleComponents: {
        include: { internalProduct: { select: { name: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  if (!updated) {
    return NextResponse.json({ error: 'Bundle link not found after update' }, { status: 404 });
  }

  // Return clean response matching POST shape — exclude raw bundleComponents relation.
  // Field order/keys must match app/api/products/bundle-links/route.ts (POST).
  const response = NextResponse.json({
    id: updated.id,
    integrationId: updated.integrationId,
    externalProductId: updated.externalProductId,
    externalVariantId: updated.externalVariantId,
    externalSku: updated.externalSku,
    externalTitle: updated.externalTitle,
    isBundle: updated.isBundle,
    internalProductId: updated.internalProductId,
    createdAt: updated.createdAt,
    components: updated.bundleComponents.map((c) => ({
      internalProductId: c.internalProductId,
      internalProductName: (c.internalProduct as { name: string }).name,
      quantity: c.quantity,
      sortOrder: c.sortOrder,
    })),
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
