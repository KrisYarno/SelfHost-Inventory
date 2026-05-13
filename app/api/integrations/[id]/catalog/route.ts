import { NextRequest, NextResponse } from 'next/server';
import {
  requireAdmin,
  requireCompanyMembership,
  apiHandler,
} from '@/lib/api-utils';
import prisma from '@/lib/prisma';
import { enforceRateLimit, applyRateLimitHeaders } from '@/lib/rateLimit';
import { decryptOrNull } from '@/lib/external-orders/shared';
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

  const apiKey = decryptOrNull(integration.encryptedApiKey);
  const apiSecret = decryptOrNull(integration.encryptedApiSecret);
  if (!apiKey || !apiSecret) {
    return NextResponse.json(
      { error: 'Integration credentials could not be decrypted' },
      { status: 500 },
    );
  }

  let rawRows: CatalogRow[];
  let warnings: CatalogWarning[];
  try {
    const result = await fetchWooCatalog(integration.storeUrl, apiKey, apiSecret, {
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
    include: { internalProduct: { select: { name: true } } },
  });

  const mapByKey = new Map<string, { linkId: string; internalProductId: number; internalProductName: string }>();
  for (const link of existing) {
    const key = `${link.externalProductId}::${link.externalVariantId ?? ''}`;
    mapByKey.set(key, {
      linkId: link.id,
      internalProductId: link.internalProductId,
      internalProductName: link.internalProduct?.name ?? '',
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
