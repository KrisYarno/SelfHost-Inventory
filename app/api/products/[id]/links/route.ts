import { NextRequest, NextResponse } from 'next/server';
import {
  requireApproved,
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
  requireCSRF,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import {
  CreateProductLinkSchema,
  ProductLinkQuerySchema,
} from '@/lib/validation/product-links';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

export const GET = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  await requireApproved();

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
  });

  if (!product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  const productLinks = await prisma.productLink.findMany({
    where: { internalProductId: productId },
    include: {
      integration: {
        select: { id: true, name: true, platform: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return NextResponse.json(productLinks);
});

export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-links:POST', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  const body = CreateProductLinkSchema.parse(await request.json());

  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
  });

  if (!product) {
    return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  }

  const integration = await prisma.integration.findUnique({
    where: { id: body.integrationId },
  });

  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }

  // P0-4 extension: verify user belongs to the integration's company. Previously
  // any admin could create mappings between their own products and any
  // company's integrations.
  await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);

  if (!integration.isActive) {
    return NextResponse.json(
      { error: 'Integration is not active' },
      { status: 400 }
    );
  }

  const existingLink = await prisma.productLink.findFirst({
    where: {
      integrationId: body.integrationId,
      externalProductId: body.externalProductId,
      externalVariantId: body.externalVariantId || null,
    },
  });

  if (existingLink) {
    return NextResponse.json(
      {
        error:
          'A product link already exists for this integration and external product/variant combination',
      },
      { status: 409 }
    );
  }

  // Issue 1a fix: create the ProductLink AND retroactively backfill any
  // existing ExternalOrderItem rows that match the same external product+
  // variant tuple. Without this, items synced before the mapping was created
  // remain isMapped=false until their order is re-upserted by a webhook or
  // sync — leading to "I mapped it but the UI still shows unmapped" bugs.
  const { productLink, backfilledCount } = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const link = await tx.productLink.create({
        data: {
          integrationId: body.integrationId,
          internalProductId: productId,
          externalProductId: body.externalProductId,
          externalVariantId: body.externalVariantId || null,
          externalSku: body.externalSku || null,
          externalTitle: body.externalTitle || null,
        },
        include: {
          integration: {
            select: { id: true, name: true, platform: true },
          },
        },
      });

      // Backfill matching unlinked items. The match must include the variant
      // (NULL-safe) so we don't accidentally link parent-product items to a
      // variant-specific link (or vice versa).
      const variantClause =
        body.externalVariantId
          ? { externalVariantId: body.externalVariantId }
          : { externalVariantId: null };

      const backfill = await tx.externalOrderItem.updateMany({
        where: {
          productLinkId: null,
          externalProductId: body.externalProductId,
          ...variantClause,
          order: {
            integrationId: body.integrationId,
          },
        },
        data: {
          productLinkId: link.id,
          isMapped: true,
        },
      });

      return { productLink: link, backfilledCount: backfill.count };
    }
  );

  const response = NextResponse.json(
    { ...productLink, backfilledCount },
    { status: 201 }
  );
  return applyRateLimitHeaders(response, rateLimitHeaders);
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-links:DELETE', {
    identifier: user.id,
  });

  await requireCSRF(request);

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const linkId = searchParams.get('linkId');

  const queryValidation = ProductLinkQuerySchema.parse({ linkId });

  const existingLink = await prisma.productLink.findUnique({
    where: { id: queryValidation.linkId },
    include: {
      integration: { select: { companyId: true } },
    },
  });

  if (!existingLink) {
    return NextResponse.json({ error: 'Product link not found' }, { status: 404 });
  }

  if (existingLink.internalProductId !== productId) {
    return NextResponse.json(
      { error: 'Product link does not belong to this product' },
      { status: 400 }
    );
  }

  // P0-4 extension: verify user belongs to the link's integration's company.
  await requireCompanyMembership(
    user.id,
    existingLink.integration.companyId,
    user.isAdmin
  );

  await prisma.productLink.delete({
    where: { id: queryValidation.linkId },
  });

  const response = NextResponse.json({
    message: 'Product link deleted successfully',
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
