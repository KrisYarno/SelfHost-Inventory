import type { CatalogRow, CatalogWarning } from '@/types/bulk-map';
import { isBundleType } from './bundle-detection';
import { parseWoosbIds } from './parse-woosb-ids';

const PER_PAGE = 100;
const CONCURRENCY = 10;
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_CAP = 100; // safety: max product pages we'll fetch

interface RawProduct {
  id: number;
  name: string;
  sku: string | null;
  type: 'simple' | 'variable' | string;
  meta_data?: Array<{ key: string; value: string | unknown }>;
}

interface RawVariation {
  id: number;
  sku: string | null;
  attributes: Array<{ name?: string; option?: string }>;
}

export interface WooCatalogResult {
  rows: CatalogRow[];
  warnings: CatalogWarning[];
}

export interface FetchCatalogOptions {
  deadlineMs?: number; // total wall-clock budget; default 45_000
  signal?: AbortSignal;
}

function authHeader(key: string, secret: string): string {
  const token = Buffer.from(`${key}:${secret}`).toString('base64');
  return `Basic ${token}`;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllProducts(
  storeUrl: string,
  auth: string,
  warnings: CatalogWarning[],
): Promise<RawProduct[]> {
  const out: RawProduct[] = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const url = new URL('/wp-json/wc/v3/products', storeUrl);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    const resp = await timedFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`WooCommerce products page ${page} failed (${resp.status}): ${body.slice(0, 200)}`);
    }
    const batch = (await resp.json()) as RawProduct[];
    if (batch.length === 0) return out;
    out.push(...batch);
  }
  warnings.push({
    kind: 'page-cap-reached',
    message: `Hit product page cap of ${PAGE_CAP} (${PAGE_CAP * PER_PAGE} products). Some products may be missing.`,
  });
  return out;
}

async function fetchVariations(
  storeUrl: string,
  auth: string,
  productId: number,
): Promise<RawVariation[]> {
  const out: RawVariation[] = [];
  for (let page = 1; page <= PAGE_CAP; page++) {
    const url = new URL(`/wp-json/wc/v3/products/${productId}/variations`, storeUrl);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    const resp = await timedFetch(url.toString(), {
      method: 'GET',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`variations ${productId} page ${page} failed (${resp.status}): ${body.slice(0, 200)}`);
    }
    const batch = (await resp.json()) as RawVariation[];
    out.push(...batch);
    if (batch.length < PER_PAGE) return out;
  }
  return out;
}

async function runWithConcurrency<T, R>(
  inputs: T[],
  limit: number,
  worker: (input: T) => Promise<R>,
): Promise<Array<{ input: T; ok: true; value: R } | { input: T; ok: false; error: Error }>> {
  const results: Array<{ input: T; ok: true; value: R } | { input: T; ok: false; error: Error }> = [];
  let idx = 0;
  async function pump() {
    while (idx < inputs.length) {
      const myIdx = idx++;
      const input = inputs[myIdx];
      try {
        const value = await worker(input);
        results[myIdx] = { input, ok: true, value };
      } catch (e) {
        results[myIdx] = { input, ok: false, error: e instanceof Error ? e : new Error(String(e)) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, pump));
  return results;
}

function formatVariantTitle(attrs: Array<{ name?: string; option?: string }>): string {
  return attrs.map((a) => a?.option ?? '').filter(Boolean).join(' / ');
}

export async function fetchWooCatalog(
  storeUrl: string,
  consumerKey: string,
  consumerSecret: string,
  options: FetchCatalogOptions = {},
): Promise<WooCatalogResult> {
  const deadlineMs = options.deadlineMs ?? 45_000;
  const deadline = Date.now() + deadlineMs;
  const warnings: CatalogWarning[] = [];
  const auth = authHeader(consumerKey, consumerSecret);

  const products = await fetchAllProducts(storeUrl, auth, warnings);

  const simpleRows: CatalogRow[] = [];
  const variableProducts: RawProduct[] = [];
  for (const p of products) {
    if (p.type === 'variable') {
      variableProducts.push(p);
    } else {
      const isBundle = isBundleType(p.type);
      let wcBundledItems: CatalogRow['wcBundledItems'] | undefined;
      if (isBundle && p.meta_data) {
        const woosbMeta = p.meta_data.find((m) => m.key === '_woosb_ids');
        if (woosbMeta && typeof woosbMeta.value === 'string') {
          const parsed = parseWoosbIds(woosbMeta.value);
          if (parsed.length > 0) {
            wcBundledItems = parsed.map((item) => ({
              productId: item.productId,
              variantId: item.variantId,
              defaultQuantity: item.quantity,
            }));
          }
        }
      }
      simpleRows.push({
        externalProductId: String(p.id),
        externalVariantId: null,
        parentTitle: p.name ?? '',
        variantTitle: null,
        sku: p.sku || null,
        type: 'simple',
        attributes: [],
        alreadyMapped: false,
        ...(isBundle && { isBundleCandidate: true }),
        ...(wcBundledItems && { wcBundledItems }),
      });
    }
  }

  const variationResults = await runWithConcurrency(
    variableProducts,
    CONCURRENCY,
    async (p) => {
      if (Date.now() > deadline) {
        const err = new Error('skipped: deadline exceeded');
        (err as any).code = 'DEADLINE';
        throw err;
      }
      return fetchVariations(storeUrl, auth, p.id);
    },
  );

  const variationRows: CatalogRow[] = [];
  for (let i = 0; i < variationResults.length; i++) {
    const parent = variableProducts[i];
    const result = variationResults[i];
    if (!result.ok) {
      const isDeadline = (result.error as any)?.code === 'DEADLINE';
      warnings.push({
        kind: isDeadline ? 'timeout-skipped' : 'variations-failed',
        productId: String(parent.id),
        parentTitle: parent.name ?? '',
        message: result.error.message,
      });
      continue;
    }
    for (const v of result.value) {
      variationRows.push({
        externalProductId: String(parent.id),
        externalVariantId: String(v.id),
        parentTitle: parent.name ?? '',
        variantTitle: formatVariantTitle(v.attributes ?? []) || null,
        sku: v.sku || null,
        type: 'variation',
        attributes: (v.attributes ?? [])
          .filter((a): a is { name: string; option: string } => !!a.name && !!a.option)
          .map((a) => ({ name: a.name, option: a.option })),
        alreadyMapped: false,
      });
    }
  }

  return { rows: [...simpleRows, ...variationRows], warnings };
}
