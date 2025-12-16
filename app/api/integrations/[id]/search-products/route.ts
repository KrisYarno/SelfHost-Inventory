import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { ZodError } from 'zod';
import { authOptions } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { enforceRateLimit, RateLimitError, applyRateLimitHeaders } from '@/lib/rateLimit';
import { SearchProductsQuerySchema } from '@/lib/validation/product-links';
import { ExternalProductSearchResult } from '@/types/product-links';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: {
    id: string;
  };
}

/**
 * GET /api/integrations/[id]/search-products?q=search_term
 * Search external platform products
 *
 * This is currently a stub that returns mock data.
 * Actual platform API calls will be implemented later.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, 'integration-search:GET', {
      identifier: session.user.id,
      limit: 60, // Higher limit for search queries
    });

    const integrationId = params.id;

    // Get search query from URL params
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');

    const queryValidation = SearchProductsQuerySchema.parse({ q });

    // Check if integration exists and is active
    const integration = await prisma.integration.findUnique({
      where: {
        id: integrationId,
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

    // TODO: Implement actual platform API calls based on integration.platform
    // For now, return mock data
    const mockResults: ExternalProductSearchResult[] = generateMockSearchResults(
      queryValidation.q,
      integration.platform
    );

    const response = NextResponse.json({
      query: queryValidation.q,
      platform: integration.platform,
      results: mockResults,
      isStub: true, // Flag to indicate this is mock data
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

    console.error('Error searching external products:', error);
    return NextResponse.json(
      { error: 'Failed to search external products' },
      { status: 500 }
    );
  }
}

/**
 * Generate mock search results for development/testing
 * This will be replaced with actual API calls to external platforms
 */
function generateMockSearchResults(
  query: string,
  platform: string
): ExternalProductSearchResult[] {
  const baseResults: ExternalProductSearchResult[] = [
    {
      externalId: 'ext-prod-001',
      externalVariantId: 'ext-var-001',
      title: `${query} - Premium Edition`,
      variantTitle: 'Medium / Blue',
      sku: `SKU-${query.toUpperCase()}-001`,
      price: 29.99,
      imageUrl: 'https://via.placeholder.com/150',
    },
    {
      externalId: 'ext-prod-002',
      externalVariantId: 'ext-var-002',
      title: `${query} - Standard Edition`,
      variantTitle: 'Large / Red',
      sku: `SKU-${query.toUpperCase()}-002`,
      price: 19.99,
      imageUrl: 'https://via.placeholder.com/150',
    },
    {
      externalId: 'ext-prod-003',
      title: `${query} - Basic`,
      sku: `SKU-${query.toUpperCase()}-003`,
      price: 9.99,
      imageUrl: 'https://via.placeholder.com/150',
    },
  ];

  // Add platform-specific formatting
  if (platform === 'SHOPIFY') {
    return baseResults.map((result) => ({
      ...result,
      externalId: `gid://shopify/Product/${result.externalId}`,
      externalVariantId: result.externalVariantId
        ? `gid://shopify/ProductVariant/${result.externalVariantId}`
        : undefined,
    }));
  }

  if (platform === 'WOOCOMMERCE') {
    return baseResults.map((result) => ({
      ...result,
      externalId: `wc-${result.externalId}`,
      externalVariantId: result.externalVariantId
        ? `wc-var-${result.externalVariantId}`
        : undefined,
    }));
  }

  return baseResults;
}
