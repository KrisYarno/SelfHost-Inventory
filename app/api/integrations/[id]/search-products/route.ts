import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { SearchProductsQuerySchema } from '@/lib/validation/product-links';
import { ExternalProductSearchResult } from '@/types/product-links';
import { decryptOrNull, hostFromStoreUrl } from '@/lib/external-orders/shared';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// WooCommerce product search
// ---------------------------------------------------------------------------

async function searchWooCommerce(
  storeUrl: string,
  consumerKey: string,
  consumerSecret: string,
  query: string,
): Promise<ExternalProductSearchResult[]> {
  const url = new URL('/wp-json/wc/v3/products', storeUrl);
  url.searchParams.set('search', query);
  url.searchParams.set('per_page', '20');

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`WooCommerce API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const products = (await resp.json()) as any[];

  return products.map((p: any): ExternalProductSearchResult => ({
    externalId: String(p.id),
    externalVariantId: undefined,
    title: p.name ?? '',
    sku: p.sku || undefined,
    price: p.price ? parseFloat(p.price) : undefined,
    imageUrl: p.images?.[0]?.src ?? undefined,
    hasVariations: p.type === 'variable',
    type: p.type ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Shopify product search
// ---------------------------------------------------------------------------

async function searchShopify(
  shopDomain: string,
  accessToken: string,
  query: string,
): Promise<ExternalProductSearchResult[]> {
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';
  const url = new URL(
    `https://${shopDomain}/admin/api/${apiVersion}/products.json`,
  );
  // Shopify REST Admin API does not support title search natively.
  // Fetch a larger batch and filter client-side by title/sku match.
  url.searchParams.set('limit', '50');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Shopify API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { products?: any[] };
  const allProducts = data.products || [];

  // Client-side filter since Shopify REST API has no title search param
  const lowerQuery = query.toLowerCase();
  const products = allProducts.filter((p: any) => {
    const title = (p.title ?? '').toLowerCase();
    const sku = (p.variants?.[0]?.sku ?? '').toLowerCase();
    return title.includes(lowerQuery) || sku.includes(lowerQuery);
  }).slice(0, 20);

  return products.map((p: any): ExternalProductSearchResult => ({
    externalId: String(p.id),
    externalVariantId: undefined,
    title: p.title ?? '',
    sku: p.variants?.[0]?.sku || undefined,
    price: p.variants?.[0]?.price
      ? parseFloat(p.variants[0].price)
      : undefined,
    imageUrl: p.image?.src ?? undefined,
    hasVariations: (p.variants?.length ?? 0) > 1,
    type: p.product_type ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// GET /api/integrations/[id]/search-products?q=search_term
// ---------------------------------------------------------------------------

export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } },
) => {
  const { user } = await requireApproved();

  const integrationId = params.id;

  const rateLimitHeaders = enforceRateLimit(request, `wc-search:${integrationId}`, {
    identifier: user.id.toString(),
    limit: 30,
  });

  // Validate search query
  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q');
  const queryValidation = SearchProductsQuerySchema.parse({ q });

  // Load integration
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });

  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }

  // P0-4: Verify user belongs to the integration's company before exposing
  // credentials-backed external search. Throws 404 to avoid leaking existence.
  await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);

  if (!integration.isActive) {
    return NextResponse.json({ error: 'Integration is not active' }, { status: 400 });
  }

  // Decrypt credentials
  const apiKey = decryptOrNull(integration.encryptedApiKey);
  const apiSecret = decryptOrNull(integration.encryptedApiSecret);

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Integration credentials could not be decrypted' },
      { status: 500 },
    );
  }

  let products: ExternalProductSearchResult[];

  try {
    if (integration.platform === 'WOOCOMMERCE') {
      if (!apiSecret) {
        return NextResponse.json(
          { error: 'WooCommerce requires both consumer key and consumer secret' },
          { status: 500 },
        );
      }
      products = await searchWooCommerce(
        integration.storeUrl,
        apiKey,
        apiSecret,
        queryValidation.q,
      );
    } else if (integration.platform === 'SHOPIFY') {
      const shopDomain = hostFromStoreUrl(integration.storeUrl);
      products = await searchShopify(
        shopDomain,
        apiKey,
        queryValidation.q,
      );
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
    products,
    isStub: false,
    platform: integration.platform,
  });

  return applyRateLimitHeaders(response, rateLimitHeaders);
});
