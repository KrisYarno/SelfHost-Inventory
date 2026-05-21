import { NextRequest, NextResponse } from 'next/server';
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { validateCSRFToken } from '@/lib/csrf';
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

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
    await tx.bundleComponent.deleteMany({ where: { productLinkId: link.id } });
    await tx.bundleComponent.createMany({
      data: body.components.map((c, i) => ({
        productLinkId: link.id,
        internalProductId: c.internalProductId,
        quantity: c.quantity,
        sortOrder: i,
      })),
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
