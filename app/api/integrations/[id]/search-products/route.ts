import { NextRequest, NextResponse } from 'next/server';
import { requireApproved, requireCompanyMembership, apiHandler } from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { SearchProductsQuerySchema } from '@/lib/validation/product-links';
import { ExternalProductSearchResult } from '@/types/product-links';
import { platformRead } from '@/lib/platforms/egress';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// WooCommerce product search
// ---------------------------------------------------------------------------

async function searchWooCommerce(
  integrationId: string,
  query: string,
): Promise<ExternalProductSearchResult[]> {
  const resp = await platformRead(
    integrationId,
    '/wp-json/wc/v3/products',
    { search: query, per_page: '20' },
    { timeoutMs: 10_000 },
  );

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
    regularPrice: p.regular_price ? parseFloat(p.regular_price) : undefined,
    imageUrl: p.images?.[0]?.src ?? undefined,
    hasVariations: p.type === 'variable',
    type: p.type ?? undefined,
  }));
}

// ---------------------------------------------------------------------------
// Shopify product search
// ---------------------------------------------------------------------------

async function searchShopify(
  integrationId: string,
  query: string,
): Promise<ExternalProductSearchResult[]> {
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-10';

  // P1-11: Shopify REST Admin API supports `title` as a prefix match. Use it
  // for the authoritative search instead of fetching 50 and filtering
  // client-side, which silently truncated results for stores with >50 products.
  const resp = await platformRead(
    integrationId,
    `/admin/api/${apiVersion}/products.json`,
    { title: query, limit: '50' },
    { timeoutMs: 10_000 },
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Shopify API error ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { products?: any[] };
  const allProducts = data.products || [];

  // P1-11: Server already filtered by title prefix via `title` param. We still
  // do a local SKU filter since Shopify's title filter doesn't match SKUs, and
  // trim to the top 20 for UI responsiveness.
  const lowerQuery = query.toLowerCase();
  const products = allProducts
    .filter((p: any) => {
      const title = (p.title ?? '').toLowerCase();
      const sku = (p.variants?.[0]?.sku ?? '').toLowerCase();
      return title.includes(lowerQuery) || sku.includes(lowerQuery);
    })
    .slice(0, 20);

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

  // Lane 6: credentials are resolved inside egress (READ scope) — this route
  // never sees them, and this search cannot mutate the store.
  let products: ExternalProductSearchResult[];

  try {
    if (integration.platform === 'WOOCOMMERCE') {
      products = await searchWooCommerce(integrationId, queryValidation.q);
    } else if (integration.platform === 'SHOPIFY') {
      products = await searchShopify(integrationId, queryValidation.q);
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
