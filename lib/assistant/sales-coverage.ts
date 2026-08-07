/**
 * lib/assistant/sales-coverage.ts — CALLER-SCOPED sales coverage for get_sales
 * (assistant toolsuite breadth, spec §3 E2).
 *
 * The unattributed-order count is computed LIVE for the caller's companies — NEVER
 * the global `analytics_rebuild_state.unattributed`, which would leak cross-company
 * order volume to a company-scoped caller (REV-2 codex blocker). Rebuild recency
 * (`lastRebuildAt`) is NOT company-sensitive, so it is read from the shared
 * rebuild-state row. Bundle revenue is a fixed disclosure — bundle components carry
 * units only (allocation is blocked on the multi-company retail-sync bug).
 *
 * W1-FRESH (`get_data_freshness`) consumes THIS exact function.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { approvedProductIds } from "@/lib/reports/outbound-mix";

/** The fixed bundle-revenue disclosure (spec §3 E2). */
export const BUNDLE_REVENUE_DISCLOSURE = "excluded — bundle components carry units only";

/**
 * The always-on get_sales rows disclosure (spec C6). Absence is the ambiguity this
 * closes: a product missing from the rows could mean "sold nothing" or "we could not
 * attribute its orders", and the reader cannot tell without being told where to look.
 */
export const SALES_ROWS_NOTE =
  "products with no attributed sales in the window are absent unless includeZeroRows " +
  "is set; absent or zero means no ATTRIBUTED orders, not necessarily no orders — see " +
  "unattributedOrders/totalOrders for how much of the order stream is unattributed.";

/**
 * The fixed attribution disclosure (spec C7, review F4). The two order counts are
 * ALL-TIME and company-scoped, but they are relayed beside WINDOWED sales figures —
 * without this sentence a reader naturally reads them as "in the window".
 */
export const SALES_ATTRIBUTION_NOTE =
  "unattributedOrders of totalOrders company-scoped orders (all time) contain at least " +
  "one unmapped line item — both counts are ALL-TIME and company-scoped, never scoped " +
  "to the query window beside them.";

export interface CallerScopedSalesCoverage {
  /** DISTINCT orders in the caller's companies carrying >= 1 unmapped line item. */
  unattributedOrders: number;
  /** The DENOMINATOR (spec C7): all orders in the caller's companies, ALL-TIME. */
  totalOrders: number;
  /** Fixed disclosure — the two counts above are all-time and company-scoped. */
  attributionNote: string;
  /** Fixed disclosure — bundle components carry units only. */
  bundleRevenue: string;
  /** Latest sales-fact rebuild run instant (ISO), or null. Not company-sensitive. */
  lastRebuildAt: string | null;
  /**
   * The FIRST day-key with an attributed sales fact for this caller (spec C6) —
   * caller-scoped `_min(dayKey)` over ProductSalesFact, narrowed to the APPROVED
   * product universe. null = this caller has no attributed sales facts at all.
   * It is what makes "no attributed sales RECORDED (since <date>)" a legal sentence
   * where "no sales ever" never was.
   */
  salesDataStart: string | null;
}

/**
 * Caller-scoped sales coverage for get_sales (spec §3 E2).
 *
 *  - `unattributedOrders`: COUNT(DISTINCT orderId) over `external_order_items` JOIN
 *    `external_orders` WHERE `companyId IN companyIds AND isMapped = false`, expressed
 *    as "orders in scope with at least one unmapped line item" — computed LIVE (cheap
 *    at current volume). NEVER the global `analytics_rebuild_state.unattributed`.
 *  - `totalOrders` (spec C7): the DENOMINATOR — the SAME company-scoped order
 *    population with NO `isMapped` predicate and NO date window, so the unattributed
 *    figure can be read as a ratio instead of a bare, unscaleable count.
 *  - `attributionNote`: the fixed disclosure that both counts are ALL-TIME (they are
 *    relayed beside WINDOWED sales figures and must not be read as windowed).
 *  - `bundleRevenue`: the fixed disclosure string.
 *  - `lastRebuildAt`: the "sales" rebuild job's last-run instant (recency only —
 *    global, not company-scoped).
 *
 * Empty `companyIds` ⇒ `{ unattributedOrders: 0, totalOrders: 0, ... }` WITHOUT querying.
 */
export async function callerScopedSalesCoverage(
  companyIds: string[],
): Promise<CallerScopedSalesCoverage> {
  if (companyIds.length === 0) {
    return {
      unattributedOrders: 0,
      totalOrders: 0,
      attributionNote: SALES_ATTRIBUTION_NOTE,
      bundleRevenue: BUNDLE_REVENUE_DISCLOSURE,
      lastRebuildAt: null,
      salesDataStart: null,
    };
  }

  const [unattributedOrders, totalOrders, rebuildState, salesDataStart] = await Promise.all([
    // DISTINCT-order count = orders in the caller's companies that carry >= 1 unmapped
    // line item — the caller-scoped equivalent of COUNT(DISTINCT orderId) over the
    // item×order join with isMapped=false. Never the global rebuild count.
    prisma.externalOrder.count({
      where: { companyId: { in: companyIds }, items: { some: { isMapped: false } } },
    }),
    // The denominator (spec C7): the same company scope, nothing else. Deliberately
    // UNWINDOWED — a windowed denominator beside an all-time numerator is a ratio that
    // means nothing, so the note discloses the span instead.
    prisma.externalOrder.count({ where: { companyId: { in: companyIds } } }),
    // Rebuild recency is GLOBAL (not company-sensitive): the sales-fact job's row.
    prisma.analyticsRebuildState.findUnique({
      where: { job: "sales" },
      select: { lastRunAt: true },
    }),
    scopedSalesDataStart(companyIds),
  ]);

  return {
    unattributedOrders: unattributedOrders ?? 0,
    totalOrders: totalOrders ?? 0,
    attributionNote: SALES_ATTRIBUTION_NOTE,
    bundleRevenue: BUNDLE_REVENUE_DISCLOSURE,
    lastRebuildAt: rebuildState?.lastRunAt ? rebuildState.lastRunAt.toISOString() : null,
    salesDataStart,
  };
}

/**
 * `_min(dayKey)` over ProductSalesFact for this caller's companies (spec C6).
 *
 * G5 FROM BIRTH (plan G4/G5, gate cluster A): this is a NEW read, so it carries the
 * APPROVED-id-set filter from the start — an unapproved product's facts must never move
 * `salesDataStart`, not even in the window between this task and Task 3.1's retrofit of
 * the pre-existing reads. Archived-but-approved products ARE included: this is a
 * HISTORICAL fact read, and their past sales really did happen.
 *
 * The id set is ALWAYS applied, even when empty: an empty approved universe must read
 * as "no facts in scope" (`in: []` matches nothing), never as an unfiltered read.
 */
async function scopedSalesDataStart(companyIds: string[]): Promise<string | null> {
  const approvedIds = await approvedProductIds({ includeArchived: true });
  const row = await prisma.productSalesFact.aggregate({
    where: { companyId: { in: companyIds }, productId: { in: approvedIds } },
    _min: { dayKey: true },
  });
  return row?._min?.dayKey ?? null;
}
