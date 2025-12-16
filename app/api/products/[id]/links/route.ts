import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { ZodError } from 'zod';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { validateCSRFToken } from '@/lib/csrf';
import { enforceRateLimit, RateLimitError, applyRateLimitHeaders } from '@/lib/rateLimit';
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

/**
 * GET /api/products/[id]/links
 * List all product links for a given internal product
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
    }

    // Check if product exists
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
      },
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // Fetch all product links with integration details
    const productLinks = await prisma.productLink.findMany({
      where: {
        internalProductId: productId,
      },
      include: {
        integration: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return NextResponse.json(productLinks);
  } catch (error) {
    console.error('Error fetching product links:', error);
    return NextResponse.json(
      { error: 'Failed to fetch product links' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/products/[id]/links
 * Create a new product link
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);

    // Require admin privileges for creating product links
    if (!session?.user?.isApproved || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, 'product-links:POST', {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
    }

    const body = CreateProductLinkSchema.parse(await request.json());

    // Check if product exists and is not deleted
    const product = await prisma.product.findFirst({
      where: {
        id: productId,
        deletedAt: null,
      },
    });

    if (!product) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 });
    }

    // Check if integration exists and is active
    const integration = await prisma.integration.findUnique({
      where: {
        id: body.integrationId,
      },
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

    // Check for existing link (unique constraint on integrationId + externalProductId + externalVariantId)
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

    // Create the product link
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
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
      },
    });

    const response = NextResponse.json(productLink, { status: 201 });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request payload',
          details: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    console.error('Error creating product link:', error);
    return NextResponse.json(
      { error: 'Failed to create product link' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/products/[id]/links?linkId=xxx
 * Remove a product link by linkId
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);

    // Require admin privileges for deleting product links
    if (!session?.user?.isApproved || !session.user.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, 'product-links:DELETE', {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const productId = parseInt(params.id);
    if (isNaN(productId)) {
      return NextResponse.json({ error: 'Invalid product ID' }, { status: 400 });
    }

    // Get linkId from query params
    const { searchParams } = new URL(request.url);
    const linkId = searchParams.get('linkId');

    const queryValidation = ProductLinkQuerySchema.parse({ linkId });

    // Check if link exists and belongs to this product
    const existingLink = await prisma.productLink.findUnique({
      where: {
        id: queryValidation.linkId,
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

    // Delete the product link
    await prisma.productLink.delete({
      where: {
        id: queryValidation.linkId,
      },
    });

    const response = NextResponse.json({
      message: 'Product link deleted successfully',
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid query parameters',
          details: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    console.error('Error deleting product link:', error);
    return NextResponse.json(
      { error: 'Failed to delete product link' },
      { status: 500 }
    );
  }
}
