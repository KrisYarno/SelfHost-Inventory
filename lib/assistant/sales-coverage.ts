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

/** The fixed bundle-revenue disclosure (spec §3 E2). */
export const BUNDLE_REVENUE_DISCLOSURE = "excluded — bundle components carry units only";

export interface CallerScopedSalesCoverage {
  /** DISTINCT orders in the caller's companies carrying >= 1 unmapped line item. */
  unattributedOrders: number;
  /** Fixed disclosure — bundle components carry units only. */
  bundleRevenue: string;
  /** Latest sales-fact rebuild run instant (ISO), or null. Not company-sensitive. */
  lastRebuildAt: string | null;
}

/**
 * Caller-scoped sales coverage for get_sales (spec §3 E2).
 *
 *  - `unattributedOrders`: COUNT(DISTINCT orderId) over `external_order_items` JOIN
 *    `external_orders` WHERE `companyId IN companyIds AND isMapped = false`, expressed
 *    as "orders in scope with at least one unmapped line item" — computed LIVE (cheap
 *    at current volume). NEVER the global `analytics_rebuild_state.unattributed`.
 *  - `bundleRevenue`: the fixed disclosure string.
 *  - `lastRebuildAt`: the "sales" rebuild job's last-run instant (recency only —
 *    global, not company-scoped).
 *
 * Empty `companyIds` ⇒ `{ unattributedOrders: 0, ... }` WITHOUT querying.
 */
export async function callerScopedSalesCoverage(
  companyIds: string[],
): Promise<CallerScopedSalesCoverage> {
  if (companyIds.length === 0) {
    return { unattributedOrders: 0, bundleRevenue: BUNDLE_REVENUE_DISCLOSURE, lastRebuildAt: null };
  }

  const [unattributedOrders, rebuildState] = await Promise.all([
    // DISTINCT-order count = orders in the caller's companies that carry >= 1 unmapped
    // line item — the caller-scoped equivalent of COUNT(DISTINCT orderId) over the
    // item×order join with isMapped=false. Never the global rebuild count.
    prisma.externalOrder.count({
      where: { companyId: { in: companyIds }, items: { some: { isMapped: false } } },
    }),
    // Rebuild recency is GLOBAL (not company-sensitive): the sales-fact job's row.
    prisma.analyticsRebuildState.findUnique({
      where: { job: "sales" },
      select: { lastRunAt: true },
    }),
  ]);

  return {
    unattributedOrders: unattributedOrders ?? 0,
    bundleRevenue: BUNDLE_REVENUE_DISCLOSURE,
    lastRebuildAt: rebuildState?.lastRunAt ? rebuildState.lastRunAt.toISOString() : null,
  };
}
