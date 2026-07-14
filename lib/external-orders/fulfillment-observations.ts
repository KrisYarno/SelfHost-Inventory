/**
 * lib/external-orders/fulfillment-observations.ts — Lane 6 (L-WOO).
 *
 * A READ-ONLY observation feed of WooCommerce fulfillment. Every read goes
 * through `platformRead` (egress, READ credential, origin-pinned). This module
 * NEVER imports fetch or any HTTP client — it is physically incapable of writing
 * to the store, which is the whole point of the credential split (R-E8).
 *
 * ---------------------------------------------------------------------------
 * WHAT WOO CAN AND CANNOT PROVE (research brief, embedded in spec §4)
 * ---------------------------------------------------------------------------
 * - Woo core has NO per-item fulfillment quantity (the native Order Fulfillments
 *   feature is beta + disabled by default). So the ONLY truthful metric is
 *   `unitsOnCompletedOrder` — the line quantity, counted only while the order is
 *   `completed`, attributed to `date_completed_gmt`. NEVER "fulfilled quantity".
 * - `date_completed` is OVERWRITTEN by Woo on re-completion (no set-once guard) —
 *   so we store an idempotent OBSERVATION keyed by (order, item) and re-apply it,
 *   never a monotonic mutation.
 * - Woo's per-line refund quantities are documented-buggy (#27376, #22203) — we
 *   derive refund posture from ORDER-LEVEL refund records + status only.
 * - There is no `order.completed` webhook topic; delivery is best-effort; Woo
 *   auto-disables a webhook after 5 consecutive failures. The webhook is a
 *   latency HINT only; the poll is the source of truth.
 */

import { AppError } from "@/lib/error-handling";
import { platformRead } from "@/lib/platforms/egress";
import prisma from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Woo order shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface WooLineItem {
  id: number | string;
  product_id?: number | string | null;
  variation_id?: number | string | null;
  quantity: number;
  name?: string;
  sku?: string | null;
}

export interface WooRefundRecord {
  id?: number | string;
  total?: string | number | null;
}

export interface WooOrder {
  id: number | string;
  status: string;
  date_completed_gmt?: string | null;
  date_modified_gmt?: string | null;
  date_created_gmt?: string | null;
  line_items?: WooLineItem[];
  refunds?: WooRefundRecord[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Woo caps per_page at 100. */
const PER_PAGE = 100;

/**
 * Re-query the last 15 minutes each incremental run. `date_modified` is
 * second-precision and `modified_after` is exclusive, so without overlap an
 * order modified exactly at the cursor boundary would be dropped (REV-2 #23).
 * The watermark rule makes the overlap free of double-counting.
 */
const OVERLAP_MS = 15 * 60 * 1000;

/** Lease length for the per-integration job lock (mirrors the analytics lock). */
const LEASE_MS = 15 * 60 * 1000;

/** Bounded Retry-After backoff for the backfill (REV-2 #28). */
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_RETRY_AFTER_SECONDS = 5;
const MAX_PAGE_RETRIES = 3;

const WOO_ORDERS_PATH = "/wp-json/wc/v3/orders";

// ---------------------------------------------------------------------------
// Woo GMT date parsing
// ---------------------------------------------------------------------------

/**
 * Woo returns `date_*_gmt` fields with NO timezone suffix (e.g.
 * "2026-07-14T10:00:00"), yet the value is UTC. Appending `Z` is what makes
 * `new Date` interpret it correctly — otherwise it parses in the server's local
 * timezone and silently shifts the timestamp.
 */
export function parseWooGmt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(trimmed);
  const d = new Date(hasZone ? trimmed : `${trimmed}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Refund posture (REV-2 #26)
// ---------------------------------------------------------------------------

/**
 * Refund posture from ORDER-LEVEL records + status. We NEVER read Woo's per-line
 * refund quantities (documented-buggy) and we NEVER net units per item.
 *
 *   isFullyRefunded — the order's status is exactly `refunded`.
 *   hasPartialRefund — money was refunded (a non-zero refund record exists) AND
 *                      the order is not fully refunded.
 *
 * A zero-value refund record (total 0 — often the buggy per-item case) moves no
 * money, so it does NOT flag a partial refund. That is the truthful reading.
 */
export function refundPosture(order: WooOrder): {
  isFullyRefunded: boolean;
  hasPartialRefund: boolean;
} {
  const isFullyRefunded = order.status === "refunded";
  const refunds = Array.isArray(order.refunds) ? order.refunds : [];
  const refundedAmount = refunds.reduce((sum, r) => {
    const raw = typeof r.total === "number" ? r.total : parseFloat(String(r.total ?? "0"));
    return sum + (Number.isFinite(raw) ? Math.abs(raw) : 0);
  }, 0);
  const hasPartialRefund = !isFullyRefunded && refundedAmount > 0;
  return { isFullyRefunded, hasPartialRefund };
}

// ---------------------------------------------------------------------------
// Product mapping resolution (via product_links)
// ---------------------------------------------------------------------------

interface MappingEntry {
  /** internalProductId of a NON-bundle mapping (null when the link is unmapped). */
  productId: number | null;
  isBundle: boolean;
  /** Frozen component expansion for a bundle mapping. */
  components: Array<{ internalProductId: number; quantity: number }>;
}

/** Canonical key for a (product, variation) pair, mirroring the ProductLink unique. */
function mappingKey(
  externalProductId: string | null,
  externalVariantId: string | null
): string {
  return `${externalProductId ?? ""}::${externalVariantId ?? ""}`;
}

/** Normalize a Woo id-ish field to a non-empty string, or null. */
function idOrNull(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  // Woo uses 0 for "no variation".
  if (!s || s === "0") return null;
  return s;
}

/**
 * Resolve every (product, variation) pair referenced by the given orders to a
 * mapping entry, in a bounded number of queries. Bundle components are read
 * once and frozen into the returned entries.
 */
export async function resolveMappings(
  integrationId: string,
  orders: WooOrder[]
): Promise<Map<string, MappingEntry>> {
  const pairs = new Map<string, { productId: string; variantId: string | null }>();
  for (const order of orders) {
    for (const li of order.line_items ?? []) {
      const productId = idOrNull(li.product_id);
      if (!productId) continue;
      const variantId = idOrNull(li.variation_id);
      pairs.set(mappingKey(productId, variantId), { productId, variantId });
    }
  }

  const result = new Map<string, MappingEntry>();
  if (pairs.size === 0) return result;

  const links = await prisma.productLink.findMany({
    where: {
      integrationId,
      OR: Array.from(pairs.values()).map((p) => ({
        externalProductId: p.productId,
        externalVariantId: p.variantId,
      })),
    },
    select: {
      id: true,
      externalProductId: true,
      externalVariantId: true,
      internalProductId: true,
      isBundle: true,
    },
  });

  const bundleLinkIds = links.filter((l) => l.isBundle).map((l) => l.id);
  const componentsByLink = new Map<
    string,
    Array<{ internalProductId: number; quantity: number }>
  >();
  if (bundleLinkIds.length > 0) {
    const components = await prisma.bundleComponent.findMany({
      where: { productLinkId: { in: bundleLinkIds } },
      select: { productLinkId: true, internalProductId: true, quantity: true },
      orderBy: { sortOrder: "asc" },
    });
    for (const c of components) {
      const list = componentsByLink.get(c.productLinkId) ?? [];
      list.push({ internalProductId: c.internalProductId, quantity: c.quantity });
      componentsByLink.set(c.productLinkId, list);
    }
  }

  for (const link of links) {
    result.set(mappingKey(link.externalProductId, link.externalVariantId ?? null), {
      productId: link.internalProductId ?? null,
      isBundle: link.isBundle,
      components: link.isBundle ? componentsByLink.get(link.id) ?? [] : [],
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Derivation (pure): Woo order -> line-item observations
// ---------------------------------------------------------------------------

export interface DerivedObservation {
  externalOrderId: string;
  externalItemId: string;
  productId: number | null;
  unitsOnCompletedOrder: number;
  orderStatus: string;
  completedAt: Date | null;
  sourceModifiedAt: Date;
  hasPartialRefund: boolean;
  isFullyRefunded: boolean;
}

/**
 * Derive the line-item observations for one order. PURE given the mapping map.
 *
 * - Units count ONLY while the order is `completed` (a fully-refunded order is
 *   `refunded`, so it resolves to 0 and drops from totals). Partial refunds are
 *   FLAGGED, never netted — the full completed quantity still stands.
 * - A bundle line expands into one row per frozen component
 *   (units = lineQty * componentQty), each with its own synthetic externalItemId.
 * - An unmapped line yields ONE row with productId=null (coverage, not zero).
 */
export function deriveObservations(
  order: WooOrder,
  mappings: Map<string, MappingEntry>
): DerivedObservation[] {
  const externalOrderId = String(order.id);
  const orderStatus = order.status;
  const completedAt = parseWooGmt(order.date_completed_gmt);
  // The watermark. Prefer date_modified_gmt; fall back to created; last resort now.
  const sourceModifiedAt =
    parseWooGmt(order.date_modified_gmt) ??
    parseWooGmt(order.date_created_gmt) ??
    new Date();
  const { isFullyRefunded, hasPartialRefund } = refundPosture(order);
  const counts = orderStatus === "completed";

  const rows: DerivedObservation[] = [];
  for (const li of order.line_items ?? []) {
    const lineId = String(li.id);
    const qty = Number.isFinite(li.quantity) ? li.quantity : 0;
    const baseUnits = counts ? qty : 0;
    const productId = idOrNull(li.product_id);
    const variantId = idOrNull(li.variation_id);
    const mapping = productId
      ? mappings.get(mappingKey(productId, variantId))
      : undefined;

    const common = {
      externalOrderId,
      orderStatus,
      completedAt,
      sourceModifiedAt,
      hasPartialRefund,
      isFullyRefunded,
    };

    if (mapping?.isBundle && mapping.components.length > 0) {
      // Frozen bundle-component expansion (REV-2 #18).
      for (const comp of mapping.components) {
        rows.push({
          ...common,
          externalItemId: `${lineId}:c:${comp.internalProductId}`,
          productId: comp.internalProductId,
          unitsOnCompletedOrder: baseUnits * comp.quantity,
        });
      }
    } else {
      rows.push({
        ...common,
        externalItemId: lineId,
        productId: mapping?.productId ?? null,
        unitsOnCompletedOrder: baseUnits,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Apply: the watermark rule (REV-2 #21)
// ---------------------------------------------------------------------------

export interface ApplySummary {
  applied: number;
  skippedStale: number;
}

/**
 * Upsert observations under the WATERMARK RULE: a row is written only when the
 * incoming `sourceModifiedAt` is STRICTLY NEWER than the stored one. An
 * out-of-order arrival (a slow poll or a late webhook hint) therefore leaves the
 * fresher stored state intact.
 *
 * `lastObservedAt` is telemetry (REV-2 #27) and is set on every applied write; it
 * is not a business field, so it does not affect idempotence.
 *
 * Applying an observation also CLEARS any tombstone: seeing the order again means
 * it is present in Woo (a restore).
 */
export async function applyObservations(
  integrationId: string,
  derived: DerivedObservation[],
  now: Date = new Date()
): Promise<ApplySummary> {
  let applied = 0;
  let skippedStale = 0;

  for (const obs of derived) {
    const existing = await prisma.fulfillmentObservation.findUnique({
      where: {
        integrationId_externalOrderId_externalItemId: {
          integrationId,
          externalOrderId: obs.externalOrderId,
          externalItemId: obs.externalItemId,
        },
      },
      select: { sourceModifiedAt: true },
    });

    // Out-of-order guard: never let older state overwrite newer state.
    if (existing && existing.sourceModifiedAt >= obs.sourceModifiedAt) {
      skippedStale += 1;
      continue;
    }

    const businessFields = {
      productId: obs.productId,
      unitsOnCompletedOrder: obs.unitsOnCompletedOrder,
      orderStatus: obs.orderStatus,
      completedAt: obs.completedAt,
      sourceModifiedAt: obs.sourceModifiedAt,
      hasPartialRefund: obs.hasPartialRefund,
      isFullyRefunded: obs.isFullyRefunded,
      tombstonedAt: null,
    };

    await prisma.fulfillmentObservation.upsert({
      where: {
        integrationId_externalOrderId_externalItemId: {
          integrationId,
          externalOrderId: obs.externalOrderId,
          externalItemId: obs.externalItemId,
        },
      },
      create: {
        integrationId,
        externalOrderId: obs.externalOrderId,
        externalItemId: obs.externalItemId,
        ...businessFields,
        lastObservedAt: now,
      },
      update: {
        ...businessFields,
        lastObservedAt: now,
      },
    });
    applied += 1;
  }

  return { applied, skippedStale };
}

/**
 * Resolve mappings for a batch of orders, derive line-item observations, and
 * apply them under the watermark rule. The one entry point every poll path uses.
 */
export async function observeOrders(
  integrationId: string,
  orders: WooOrder[],
  now: Date = new Date()
): Promise<ApplySummary> {
  if (orders.length === 0) return { applied: 0, skippedStale: 0 };
  const mappings = await resolveMappings(integrationId, orders);
  const derived: DerivedObservation[] = [];
  for (const order of orders) {
    derived.push(...deriveObservations(order, mappings));
  }
  return applyObservations(integrationId, derived, now);
}

// ---------------------------------------------------------------------------
// The per-integration job lease (mirrors lib/analytics/rebuild-lock)
// ---------------------------------------------------------------------------

/** Ensure the state row exists WITHOUT disturbing an existing lease. */
async function ensureSyncStateRow(integrationId: string): Promise<void> {
  await prisma.fulfillmentSyncState.upsert({
    where: { integrationId },
    create: { integrationId },
    update: {},
  });
}

/**
 * Atomic acquire: succeeds only if the lease is free or the prior holder's lease
 * went stale. Returns the acquire timestamp (fencing token) or null.
 */
export async function acquireFulfillmentLock(
  integrationId: string
): Promise<Date | null> {
  await ensureSyncStateRow(integrationId);
  const now = new Date();
  const stale = new Date(now.getTime() - LEASE_MS);
  const res = await prisma.fulfillmentSyncState.updateMany({
    where: {
      integrationId,
      OR: [
        { lockedAt: null },
        { heartbeatAt: { lt: stale } },
        { heartbeatAt: null, lockedAt: { lt: stale } },
      ],
    },
    data: { lockedAt: now, heartbeatAt: now },
  });
  return res.count === 1 ? now : null;
}

/** Extend the lease; returns false if superseded (the caller must stop). */
export async function heartbeatFulfillmentLock(
  integrationId: string,
  token: Date
): Promise<boolean> {
  const res = await prisma.fulfillmentSyncState.updateMany({
    where: { integrationId, lockedAt: token },
    data: { heartbeatAt: new Date() },
  });
  return res.count === 1;
}

/** Fencing release: only clears the lock if we still own it (token match). */
export async function releaseFulfillmentLock(
  integrationId: string,
  token: Date
): Promise<void> {
  await prisma.fulfillmentSyncState.updateMany({
    where: { integrationId, lockedAt: token },
    data: { lockedAt: null, heartbeatAt: null },
  });
}

// ---------------------------------------------------------------------------
// Reading orders through egress
// ---------------------------------------------------------------------------

interface OrderPage {
  orders: WooOrder[];
  totalPages: number;
}

async function fetchOrderPage(
  integrationId: string,
  query: Record<string, string>
): Promise<OrderPage> {
  const resp = await platformRead(integrationId, WOO_ORDERS_PATH, query);
  if (!resp.ok) {
    const retryAfter = parseRetryAfterHeader(resp.headers.get("Retry-After"));
    const body = await resp.text().catch(() => "");
    const err = new AppError(
      `WooCommerce orders read failed (${resp.status}): ${body.slice(0, 200)}`,
      "FULFILLMENT_READ_FAILED",
      502
    ) as AppError & { httpStatus?: number; retryAfterSeconds?: number };
    err.httpStatus = resp.status;
    if (retryAfter !== undefined) err.retryAfterSeconds = retryAfter;
    throw err;
  }
  const totalPagesHeader = resp.headers.get("X-WP-TotalPages");
  const totalPages = Math.max(1, parseInt(totalPagesHeader ?? "1", 10) || 1);
  const orders = (await resp.json()) as WooOrder[];
  return { orders: Array.isArray(orders) ? orders : [], totalPages };
}

function parseRetryAfterHeader(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Incremental sync (REV-2 #22/#23)
// ---------------------------------------------------------------------------

export interface IncrementalResult {
  integrationId: string;
  skipped?: "lock-held";
  pages: number;
  ordersSeen: number;
  applied: number;
  skippedStale: number;
  cursorFrom: string | null;
  cursorTo: string | null;
}

/**
 * Incremental fulfillment poll.
 *
 * FREEZES an upper watermark (`modified_before = now`) for the whole run, queries
 * from `cursor - 15min` overlap, EXHAUSTS every page (per_page=100, driven by
 * `X-WP-TotalPages`), and advances the durable cursor to the frozen upper bound
 * ONLY after every page succeeds. Any error throws with the cursor untouched, so
 * the next run re-covers the same window (the watermark rule keeps it idempotent).
 */
export async function syncFulfillmentObservations(
  integrationId: string,
  opts: { now?: Date; initialLookbackMs?: number } = {}
): Promise<IncrementalResult> {
  const token = await acquireFulfillmentLock(integrationId);
  if (!token) {
    return {
      integrationId,
      skipped: "lock-held",
      pages: 0,
      ordersSeen: 0,
      applied: 0,
      skippedStale: 0,
      cursorFrom: null,
      cursorTo: null,
    };
  }

  const upper = opts.now ?? new Date();
  const state = await prisma.fulfillmentSyncState.findUnique({
    where: { integrationId },
    select: { cursorModifiedAt: true },
  });
  const cursor = state?.cursorModifiedAt ?? null;
  const since = cursor
    ? new Date(cursor.getTime() - OVERLAP_MS)
    : new Date(upper.getTime() - (opts.initialLookbackMs ?? OVERLAP_MS));

  let pages = 0;
  let ordersSeen = 0;
  let applied = 0;
  let skippedStale = 0;

  try {
    let page = 1;
    // Exhaust ALL pages before advancing the cursor.
    for (;;) {
      const { orders, totalPages } = await fetchOrderPage(integrationId, {
        per_page: String(PER_PAGE),
        page: String(page),
        orderby: "modified",
        order: "asc",
        modified_after: since.toISOString(),
        modified_before: upper.toISOString(),
        dates_are_gmt: "true",
        status: "any",
      });
      pages += 1;
      ordersSeen += orders.length;

      const summary = await observeOrders(integrationId, orders, new Date());
      applied += summary.applied;
      skippedStale += summary.skippedStale;

      await heartbeatFulfillmentLock(integrationId, token);

      if (orders.length === 0 || page >= totalPages) break;
      page += 1;
    }

    // Every page succeeded — advance the cursor to the frozen upper watermark.
    await prisma.fulfillmentSyncState.update({
      where: { integrationId },
      data: { cursorModifiedAt: upper, lastRunAt: new Date(), lastError: null },
    });

    return {
      integrationId,
      pages,
      ordersSeen,
      applied,
      skippedStale,
      cursorFrom: cursor ? cursor.toISOString() : null,
      cursorTo: upper.toISOString(),
    };
  } catch (err) {
    // The cursor is NOT advanced — the next run re-covers this window.
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.fulfillmentSyncState
      .update({ where: { integrationId }, data: { lastError: message.slice(0, 500) } })
      .catch(() => undefined);
    throw err;
  } finally {
    await releaseFulfillmentLock(integrationId, token);
  }
}

// ---------------------------------------------------------------------------
// Backfill (REV-2 #28) — resumable, heartbeat-leased, Retry-After-aware
// ---------------------------------------------------------------------------

export interface BackfillResult {
  integrationId: string;
  skipped?: "lock-held";
  done: boolean;
  pagesProcessed: number;
  ordersSeen: number;
  applied: number;
  resumePage: number | null;
}

/**
 * Backfill historical completed orders, resumably.
 *
 * A FROZEN upper bound (`before`) is set on first start and saved, so pagination
 * is stable across runs. The saved page is checkpointed AFTER each page's
 * observations are applied, so a crash resumes at the same page — and because
 * apply is idempotent (upsert-by-key + watermark), re-processing that page never
 * double-counts. `maxPages` bounds a single run so a cron tick stays short; the
 * remainder resumes next run.
 */
export async function backfillFulfillmentObservations(
  integrationId: string,
  opts: { now?: Date; maxPages?: number } = {}
): Promise<BackfillResult> {
  const token = await acquireFulfillmentLock(integrationId);
  if (!token) {
    return {
      integrationId,
      skipped: "lock-held",
      done: false,
      pagesProcessed: 0,
      ordersSeen: 0,
      applied: 0,
      resumePage: null,
    };
  }

  const maxPages = Math.max(1, opts.maxPages ?? Number.MAX_SAFE_INTEGER);

  try {
    const state = await prisma.fulfillmentSyncState.findUnique({
      where: { integrationId },
      select: { backfillPage: true, backfillBefore: true, backfillComplete: true },
    });

    if (state?.backfillComplete) {
      return {
        integrationId,
        done: true,
        pagesProcessed: 0,
        ordersSeen: 0,
        applied: 0,
        resumePage: null,
      };
    }

    // Freeze the upper bound on first start; reuse the saved one on resume.
    const before = state?.backfillBefore ?? opts.now ?? new Date();
    let page = state?.backfillPage ?? 1;
    if (!state?.backfillBefore) {
      await prisma.fulfillmentSyncState.update({
        where: { integrationId },
        data: { backfillBefore: before, backfillPage: page },
      });
    }

    let pagesProcessed = 0;
    let ordersSeen = 0;
    let applied = 0;
    let done = false;

    while (pagesProcessed < maxPages) {
      const { orders, totalPages } = await fetchOrderPageWithRetry(integrationId, {
        per_page: String(PER_PAGE),
        page: String(page),
        orderby: "date",
        order: "asc",
        before: before.toISOString(),
        dates_are_gmt: "true",
        status: "completed",
      });

      ordersSeen += orders.length;
      const summary = await observeOrders(integrationId, orders, new Date());
      applied += summary.applied;
      pagesProcessed += 1;

      const exhausted = orders.length === 0 || page >= totalPages;
      // Checkpoint AFTER applying the page (crash-resume lands on the next page).
      await prisma.fulfillmentSyncState.update({
        where: { integrationId },
        data: {
          backfillPage: exhausted ? null : page + 1,
          backfillComplete: exhausted,
          lastRunAt: new Date(),
          lastError: null,
        },
      });
      await heartbeatFulfillmentLock(integrationId, token);

      if (exhausted) {
        done = true;
        break;
      }
      page += 1;
    }

    return {
      integrationId,
      done,
      pagesProcessed,
      ordersSeen,
      applied,
      resumePage: done ? null : page,
    };
  } catch (err) {
    // Backfill state (saved page + frozen before) is retained for resumption.
    const message = err instanceof Error ? err.message : "Unknown error";
    await prisma.fulfillmentSyncState
      .update({ where: { integrationId }, data: { lastError: message.slice(0, 500) } })
      .catch(() => undefined);
    throw err;
  } finally {
    await releaseFulfillmentLock(integrationId, token);
  }
}

/** One page with bounded, Retry-After-aware retries on 429 / 5xx. */
async function fetchOrderPageWithRetry(
  integrationId: string,
  query: Record<string, string>
): Promise<OrderPage> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_PAGE_RETRIES; attempt += 1) {
    try {
      return await fetchOrderPage(integrationId, query);
    } catch (err) {
      lastErr = err;
      const status = (err as { httpStatus?: number }).httpStatus;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable || attempt === MAX_PAGE_RETRIES) throw err;
      const retryAfter =
        (err as { retryAfterSeconds?: number }).retryAfterSeconds ??
        DEFAULT_RETRY_AFTER_SECONDS;
      await sleep(retryAfter * 1000);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Tombstones (REV-2 #24) — poll trash + full seen-set reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  integrationId: string;
  liveOrders: number;
  trashedOrders: number;
  ourOrders: number;
  tombstoned: number;
}

/** Scan every page of an order query, collecting distinct order ids. */
async function collectOrderIds(
  integrationId: string,
  status: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let page = 1;
  for (;;) {
    const { orders, totalPages } = await fetchOrderPage(integrationId, {
      per_page: String(PER_PAGE),
      page: String(page),
      orderby: "id",
      order: "asc",
      status,
      dates_are_gmt: "true",
    });
    for (const o of orders) ids.add(String(o.id));
    if (orders.length === 0 || page >= totalPages) break;
    page += 1;
  }
  return ids;
}

/**
 * Reconcile tombstones. Builds the LIVE set of order ids (status=any) plus the
 * TRASH set (explicit poll, REV-2 #24). Any order we have observations for that
 * is no longer live — deleted or trashed — is tombstoned, dropping its units out
 * of totals. A restored order is un-tombstoned automatically on its next
 * observation (applyObservations clears tombstonedAt).
 */
export async function reconcileFulfillmentTombstones(
  integrationId: string,
  opts: { now?: Date } = {}
): Promise<ReconcileResult> {
  const now = opts.now ?? new Date();

  const liveSet = await collectOrderIds(integrationId, "any");
  const trashedSet = await collectOrderIds(integrationId, "trash");

  const ours = await prisma.fulfillmentObservation.findMany({
    where: { integrationId, tombstonedAt: null },
    select: { externalOrderId: true },
    distinct: ["externalOrderId"],
  });

  let tombstoned = 0;
  for (const row of ours) {
    const id = row.externalOrderId;
    const gone = trashedSet.has(id) || !liveSet.has(id);
    if (!gone) continue;
    const res = await prisma.fulfillmentObservation.updateMany({
      where: { integrationId, externalOrderId: id, tombstonedAt: null },
      data: { tombstonedAt: now },
    });
    tombstoned += res.count;
  }

  return {
    integrationId,
    liveOrders: liveSet.size,
    trashedOrders: trashedSet.size,
    ourOrders: ours.length,
    tombstoned,
  };
}

/**
 * Total units on completed orders for an integration — the truthful metric. It
 * ALWAYS excludes tombstoned rows, so a vanished order drops out of totals.
 */
export async function getUnitsOnCompletedOrders(
  integrationId: string
): Promise<number> {
  const agg = await prisma.fulfillmentObservation.aggregate({
    where: { integrationId, tombstonedAt: null },
    _sum: { unitsOnCompletedOrder: true },
  });
  return agg._sum.unitsOnCompletedOrder ?? 0;
}

// ---------------------------------------------------------------------------
// Webhook HINT (REV-2 #15) + hint processing (the poll's GET side)
// ---------------------------------------------------------------------------

/**
 * Persist a latency hint. Called by the webhook AFTER signature verification.
 *
 * This does a single cheap upsert and NOTHING else — in particular it NEVER
 * issues a Woo GET. A GET that failed here would count toward Woo's 5-strike
 * webhook auto-disable, so the fetch of current state is deliberately deferred to
 * the poll (`processFulfillmentHints`). Best-effort: any error is swallowed so a
 * hint failure can never fail webhook delivery.
 */
export async function persistFulfillmentHint(
  integrationId: string,
  platform: string,
  externalOrderId: string | null | undefined
): Promise<void> {
  if (platform !== "WOOCOMMERCE") return;
  const orderId = externalOrderId ? String(externalOrderId).trim() : "";
  if (!orderId) return;
  // Defensive: if the model is unavailable (e.g. an unrelated suite's partial
  // prisma mock), skip quietly rather than logging on every webhook. In
  // production this branch never runs.
  if (typeof prisma.fulfillmentObservationHint?.upsert !== "function") return;
  try {
    const now = new Date();
    await prisma.fulfillmentObservationHint.upsert({
      where: {
        integrationId_externalOrderId: { integrationId, externalOrderId: orderId },
      },
      create: { integrationId, externalOrderId: orderId, receivedAt: now },
      update: { receivedAt: now, processedAt: null },
    });
  } catch (err) {
    console.error(
      `[fulfillment] failed to persist hint for ${integrationId}/${orderId} (non-fatal)`,
      err
    );
  }
}

export interface HintProcessResult {
  processed: number;
  failed: number;
  applied: number;
}

/**
 * Consume unprocessed hints: GET each hinted order's CURRENT state through egress
 * (this is the Woo GET the webhook must never do), apply it under the watermark
 * rule, and mark the hint processed. A GET that fails leaves the hint unprocessed
 * for the next run. THE POLL IS THE SOURCE OF TRUTH — a hint only lowers latency.
 */
export async function processFulfillmentHints(
  integrationId: string,
  opts: { limit?: number } = {}
): Promise<HintProcessResult> {
  const limit = Math.max(1, opts.limit ?? 50);
  const hints = await prisma.fulfillmentObservationHint.findMany({
    where: { integrationId, processedAt: null },
    orderBy: { receivedAt: "asc" },
    take: limit,
    select: { id: true, externalOrderId: true },
  });

  let processed = 0;
  let failed = 0;
  let applied = 0;

  for (const hint of hints) {
    try {
      const resp = await platformRead(
        integrationId,
        `${WOO_ORDERS_PATH}/${encodeURIComponent(hint.externalOrderId)}`
      );
      if (!resp.ok) {
        // 404 = the order was deleted; drop the hint (tombstone job handles totals).
        if (resp.status === 404) {
          await prisma.fulfillmentObservationHint.update({
            where: { id: hint.id },
            data: { processedAt: new Date() },
          });
          processed += 1;
          continue;
        }
        failed += 1;
        continue;
      }
      const order = (await resp.json()) as WooOrder;
      const summary = await observeOrders(integrationId, [order], new Date());
      applied += summary.applied;
      await prisma.fulfillmentObservationHint.update({
        where: { id: hint.id },
        data: { processedAt: new Date() },
      });
      processed += 1;
    } catch (err) {
      // Leave the hint unprocessed; the poll reconciles regardless.
      console.error(
        `[fulfillment] hint GET failed for ${integrationId}/${hint.externalOrderId}`,
        err
      );
      failed += 1;
    }
  }

  return { processed, failed, applied };
}

// ---------------------------------------------------------------------------
// Orchestration for the cron route
// ---------------------------------------------------------------------------

export interface RunResult {
  integrationId: string;
  hints: HintProcessResult;
  incremental: IncrementalResult;
}

/**
 * The default cron job: drain pending hints (low-latency GETs), then run the
 * incremental poll (the source of truth). Backfill and tombstone reconciliation
 * are separate, heavier jobs the route selects explicitly.
 */
export async function runFulfillmentSync(
  integrationId: string,
  opts: { now?: Date } = {}
): Promise<RunResult> {
  const hints = await processFulfillmentHints(integrationId);
  const incremental = await syncFulfillmentObservations(integrationId, opts);
  return { integrationId, hints, incremental };
}
