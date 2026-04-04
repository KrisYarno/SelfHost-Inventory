import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireAdmin, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { validateCSRFToken } from '@/lib/csrf';
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

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

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

  const productLink = await prisma.productLink.create({
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

  const response = NextResponse.json(productLink, { status: 201 });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});

export const DELETE = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireAdmin();

  const rateLimitHeaders = enforceRateLimit(request, 'product-links:DELETE', {
    identifier: user.id,
  });

  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  const productId = parseInt(params.id);
  if (isNaN(productId)) {
    return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const linkId = searchParams.get('linkId');

  const queryValidation = ProductLinkQuerySchema.parse({ linkId });

  const existingLink = await prisma.productLink.findUnique({
    where: { id: queryValidation.linkId },
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

  await prisma.productLink.delete({
    where: { id: queryValidation.linkId },
  });

  const response = NextResponse.json({
    message: 'Product link deleted successfully',
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
