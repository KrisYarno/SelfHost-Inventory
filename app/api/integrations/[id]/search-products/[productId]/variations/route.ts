import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { ExternalProductSearchResult } from '@/types/product-links';
import { platformRead } from '@/lib/platforms/egress';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// WooCommerce variations fetch
// ---------------------------------------------------------------------------

async function fetchWooVariations(
  integrationId: string,
  productId: string,
): Promise<{ variations: any[]; parentName: string }> {
  const encoded = encodeURIComponent(productId);

  // Fetch parent product name and variations in parallel, through the chokepoint.
  const [parentResp, variationsResp] = await Promise.all([
    platformRead(
      integrationId,
      `/wp-json/wc/v3/products/${encoded}`,
      undefined,
      { timeoutMs: 10_000 },
    ),
    platformRead(
      integrationId,
      `/wp-json/wc/v3/products/${encoded}/variations`,
      { per_page: '100' },
      { timeoutMs: 10_000 },
    ),
  ]);

  if (!parentResp.ok) {
    const body = await parentResp.text().catch(() => '');
    throw new Error(
      `WooCommerce API error ${parentResp.status}: ${body.slice(0, 300)}`,
    );
  }
  if (!variationsResp.ok) {
    const body = await variationsResp.text().catch(() => '');
    throw new Error(
      `WooCommerce API error ${variationsResp.status}: ${body.slice(0, 300)}`,
    );
  }

  const parent = (await parentResp.json()) as any;
  const variations = (await variationsResp.json()) as any[];

  return { variations, parentName: parent.name ?? '' };
}

// ---------------------------------------------------------------------------
// Shopify variants fetch
// ---------------------------------------------------------------------------

async function fetchShopifyVariants(
  integrationId: string,
  productId: string,
): Promise<{ variants: any[]; parentName: string }> {
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

  const resp = await platformRead(
    integrationId,
    `/admin/api/${apiVersion}/products/${encodeURIComponent(productId)}.json`,
    undefined,
    { timeoutMs: 10_000 },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Shopify API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { product?: any };
  const product = data.product || {};
  return {
    variants: product.variants || [],
    parentName: product.title ?? '',
  };
}

// ---------------------------------------------------------------------------
// Format variation attribute list into a readable title
// ---------------------------------------------------------------------------

function formatVariantTitle(attributes: any[]): string {
  if (!Array.isArray(attributes) || attributes.length === 0) return '';
  return attributes.map((a: any) => a.option ?? a.value ?? '').filter(Boolean).join(' / ');
}

// ---------------------------------------------------------------------------
// GET /api/integrations/[id]/search-products/[productId]/variations
// ---------------------------------------------------------------------------

export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string; productId: string } },
) => {
  const { user } = await requireApproved();

  const integrationId = params.id;
  const productId = params.productId;

  const rateLimitHeaders = enforceRateLimit(request, `wc-search:${integrationId}`, {
    identifier: user.id.toString(),
    limit: 30,
  });

  // Load integration
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }

  // P0-4: Verify user belongs to the integration's company
  await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);

  if (!integration.isActive) {
    return NextResponse.json({ error: 'Integration is not active' }, { status: 400 });
  }

  // Lane 6: credentials are resolved inside egress (READ scope).
  let results: ExternalProductSearchResult[];

  try {
    if (integration.platform === 'WOOCOMMERCE') {
      const { variations, parentName } = await fetchWooVariations(
        integrationId,
        productId,
      );

      results = variations.map((v: any): ExternalProductSearchResult => ({
        externalId: String(productId),
        externalVariantId: String(v.id),
        title: parentName,
        variantTitle: formatVariantTitle(v.attributes),
        sku: v.sku || undefined,
        price: v.price ? parseFloat(v.price) : undefined,
        regularPrice: v.regular_price ? parseFloat(v.regular_price) : undefined,
        imageUrl: v.image?.src ?? undefined,
        type: 'variation',
      }));
    } else if (integration.platform === 'SHOPIFY') {
      const { variants, parentName } = await fetchShopifyVariants(
        integrationId,
        productId,
      );

      results = variants.map((v: any): ExternalProductSearchResult => ({
        externalId: String(productId),
        externalVariantId: String(v.id),
        title: parentName,
        variantTitle: [v.option1, v.option2, v.option3].filter(Boolean).join(' / '),
        sku: v.sku || undefined,
        price: v.price ? parseFloat(v.price) : undefined,
        imageUrl: v.image?.src ?? undefined,
        type: 'variant',
      }));
    } else {
      return NextResponse.json(
        { error: `Unsupported platform: ${integration.platform}` },
        { status: 400 },
      );
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return NextResponse.json(
        { error: 'Store is not responding. Try again later.' },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: err?.message || 'External API error' },
      { status: 502 },
    );
  }

  const response = NextResponse.json({
    variations: results,
    platform: integration.platform,
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
