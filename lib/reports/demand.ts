/**
 * lib/reports/demand.ts — the ONE definition of "average daily outbound demand per
 * product over a window" (Lane reorder-points, Task 2; codex #9).
 *
 * Before this module there were >=3 divergent velocity implementations (low-stock,
 * the metrics route — which still counted TRANSFERs as usage, a live prod bug — and
 * the stock-checker email path). This consolidates them.
 *
 * TWO named predicates share one query engine:
 *   - `reorderDemand`  — the LOCKED reorder-demand predicate: depletion that must be
 *     REPLACED. Excludes internal transfers (not consumption) AND CORRECTION reversals
 *     (accounting, not real movement). A null / DAMAGE / THEFT / EXPIRY reason IS
 *     included (you replace what you lose).
 *   - `outboundVelocity` — units-out velocity: excludes only TRANSFER (corrections
 *     COUNT). This is the sibling low-stock / metrics / stock-checker adopt. It is
 *     DELIBERATELY NOT aligned to the reorder predicate (registered scope note) — a
 *     low-stock alert is a different judgement than a buying suggestion.
 *
 * Both share the truthful days-covered math: avgDailyDemand = sum(|delta|) /
 * daysCovered, where daysCovered = the span from the first qualifying outbound in the
 * window to now, clamped to [1, windowDays]. NEVER a flat 30, NEVER 0-as-measurement:
 * a product with no qualifying outbound has `avgDailyDemand: null`.
 *
 * MUST stay Next-free (imported by report + assistant-tool layers): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { inventory_logs_logType } from "@prisma/client";
import {
  isReorderDemandRow,
  isPhysicalOutboundRow,
  daysCovered as daysCoveredInWindow,
} from "@/lib/reports/metrics-contract";

const DAY_MS = 86_400_000;

export interface ProductDemand {
  /** null = no qualifying outbound movement in the window (NEVER 0-as-measurement). */
  avgDailyDemand: number | null;
  /** Count of qualifying outbound rows — drives the reorder min-evidence gate. */
  outboundEvents: number;
  /** Days from the first qualifying outbound in the window to now, clamped
   *  [1, windowDays]; 0 when there is no qualifying outbound. */
  daysCovered: number;
}

/** A single inventory-log row, reduced to the fields the predicates read. */
export interface DemandRow {
  delta: number;
  logType: string;
  reasonCode: string | null;
}

/**
 * LOCKED reorder-demand predicate — now defined VERBATIM in
 * lib/reports/metrics-contract.ts (spec §2 D1) and re-exported here for existing
 * importers. Semantics unchanged: `delta < 0 AND logType != TRANSFER AND (reasonCode
 * IS NULL OR reasonCode != 'CORRECTION')`.
 */
export { isReorderDemandRow };

/** Units-out usage: outbound that is not an internal transfer. Corrections INCLUDED.
 *  Delegates to the contract's shared physicalOutbound predicate (spec §2 D1). */
export function isOutboundUsageRow(row: DemandRow): boolean {
  return isPhysicalOutboundRow(row);
}

interface ComputeOpts {
  productIds: number[];
  windowDays: number;
  predicate: (row: DemandRow) => boolean;
  locationId?: number;
}

/**
 * Core engine. Reads outbound rows once (TRANSFER excluded at the SQL boundary — the
 * one filter both predicates share), then applies the given JS predicate so the
 * reasonCode / null logic is exact and unit-testable with real rows. Returns an entry
 * for EVERY queried productId (null when it has no qualifying outbound), so consumers
 * get an explicit "no signal" rather than an ambiguous undefined.
 */
async function computeDemand(opts: ComputeOpts): Promise<Map<number, ProductDemand>> {
  const { productIds, windowDays, predicate, locationId } = opts;
  const result = new Map<number, ProductDemand>();
  for (const id of productIds) {
    result.set(id, { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0 });
  }
  if (productIds.length === 0) return result;

  const now = Date.now();
  const windowStart = new Date(now - windowDays * DAY_MS);

  const rows = await prisma.inventory_logs.findMany({
    where: {
      productId: { in: productIds },
      changeTime: { gte: windowStart },
      delta: { lt: 0 },
      logType: { not: inventory_logs_logType.TRANSFER },
      ...(locationId != null ? { locationId } : {}),
    },
    select: { productId: true, delta: true, changeTime: true, logType: true, reasonCode: true },
  });

  // Accumulate per product: total outbound units, event count, earliest event time.
  const acc = new Map<number, { total: number; events: number; firstMs: number }>();
  for (const row of rows) {
    if (!predicate(row)) continue;
    const cur = acc.get(row.productId) ?? { total: 0, events: 0, firstMs: Infinity };
    cur.total += Math.abs(row.delta);
    cur.events += 1;
    const t = row.changeTime.getTime();
    if (t < cur.firstMs) cur.firstMs = t;
    acc.set(row.productId, cur);
  }

  acc.forEach((a, productId) => {
    // Span from the first qualifying outbound to now — the shared contract denominator
    // (spec §2 D2): whole days, floored at 1 (no divide-by-zero for a same-day signal),
    // clamped to the window.
    const covered = daysCoveredInWindow(a.firstMs, now, windowDays);
    result.set(productId, {
      avgDailyDemand: a.total / covered,
      outboundEvents: a.events,
      daysCovered: covered,
    });
  });

  return result;
}

/**
 * Reorder demand (LOCKED predicate) per product over the window. Global pool — no
 * location scoping (the reorder feature is global; multi-location split is out of
 * scope).
 */
export function reorderDemand(
  productIds: number[],
  windowDays: number,
): Promise<Map<number, ProductDemand>> {
  return computeDemand({ productIds, windowDays, predicate: isReorderDemandRow });
}

/**
 * Units-out velocity (corrections included) per product over the window. The shared
 * definition low-stock / metrics / stock-checker adopt. `locationId` optionally scopes
 * usage to one location (the metrics route's location filter).
 */
export function outboundVelocity(
  productIds: number[],
  windowDays: number,
  opts: { locationId?: number } = {},
): Promise<Map<number, ProductDemand>> {
  return computeDemand({
    productIds,
    windowDays,
    predicate: isOutboundUsageRow,
    locationId: opts.locationId,
  });
}
