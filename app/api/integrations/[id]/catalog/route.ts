import { NextRequest, NextResponse } from 'next/server';
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { fetchWooCatalog } from '@/lib/platforms/woocommerce/fetch-catalog';
import type { CatalogResponse, CatalogRow, CatalogWarning } from '@/types/bulk-map';

export const dynamic = 'force-dynamic';

export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: { id: string } },
) => {
  const { user } = await requireAdmin();

  const integrationId = params.id;
  const rateLimitHeaders = enforceRateLimit(request, `wc-catalog:${integrationId}`, {
    identifier: user.id.toString(),
    limit: 6,
  });

  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
  });
  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }

  await requireCompanyMembership(user.id, integration.companyId, user.isAdmin);

  if (!integration.isActive) {
    return NextResponse.json({ error: 'Integration is not active' }, { status: 400 });
  }

  if (integration.platform !== 'WOOCOMMERCE') {
    return NextResponse.json(
      { error: `Bulk-map catalog fetch is not yet implemented for platform: ${integration.platform}` },
      { status: 501 },
    );
  }

  // Lane 6: credentials are resolved inside egress (READ scope). This route no
  // longer decrypts anything, and the catalog fetch it triggers is physically
  // incapable of writing to the store.
  let rawRows: CatalogRow[];
  let warnings: CatalogWarning[];
  try {
    const result = await fetchWooCatalog(integrationId, {
      deadlineMs: 45_000,
    });
    rawRows = result.rows;
    warnings = result.warnings;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Store fetch failed: ${msg}` }, { status: 502 });
  }

  const existing = await prisma.productLink.findMany({
    where: { integrationId },
    include: {
      internalProduct: { select: { name: true } },
      bundleComponents: { select: { id: true } },
    },
  });

  // Uniform shape: isBundle is always present (defaults false), componentCount
  // is always present (null for non-bundles). Clients can value-check instead
  // of presence-check.
  const mapByKey = new Map<string, {
    linkId: string;
    internalProductId: number | null;
    internalProductName: string;
    isBundle: boolean;
    componentCount: number | null;
  }>();
  for (const link of existing) {
    const key = `${link.externalProductId}::${link.externalVariantId ?? ''}`;
    mapByKey.set(key, {
      linkId: link.id,
      internalProductId: link.isBundle ? null : link.internalProductId,
      internalProductName: link.isBundle ? '' : (link.internalProduct?.name ?? ''),
      isBundle: link.isBundle,
      componentCount: link.isBundle ? link.bundleComponents.length : null,
    });
  }

  const joinedRows: CatalogRow[] = rawRows.map((r) => {
    const key = `${r.externalProductId}::${r.externalVariantId ?? ''}`;
    const existingMapping = mapByKey.get(key);
    return existingMapping
      ? { ...r, alreadyMapped: true, existingMapping }
      : r;
  });

  const body: CatalogResponse = {
    integration: {
      id: integration.id,
      name: integration.name,
      platform: integration.platform as 'WOOCOMMERCE' | 'SHOPIFY',
      storeUrl: integration.storeUrl,
    },
    rows: joinedRows,
    fetchedAt: new Date().toISOString(),
    warnings,
  };

  const response = NextResponse.json(body);
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
