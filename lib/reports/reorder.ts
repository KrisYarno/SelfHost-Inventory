/**
 * lib/reports/reorder.ts — the reorder computation (Lane reorder-points, Task 3).
 *
 * Turns the truthful demand series (lib/reports/demand.ts, reorderDemand) plus the
 * effective per-product config (lib/reorder-config.ts) into an actionable, AUDITABLE
 * "order N units" suggestion — with every input shown next to the number.
 *
 * TRUTHFUL-DATA CORE (non-negotiable):
 *  - Discriminated rows: a product either has a demand signal + enough evidence (a
 *    `suggested` row with all the numbers), or it does not (an `unavailable` row that
 *    carries NO reorder numbers — never null-numbers that render as 0).
 *  - No suggestion without a demand signal (avgDaily null => no_demand_signal) AND
 *    minimum evidence (outboundEvents < minEvidenceEvents => insufficient_history: a
 *    day-one event must not drive a big order).
 *  - Math carries RAW DECIMALS through; Math.ceil is applied to the LEVELS exactly
 *    once. Sub-components are never pre-rounded.
 *  - cost is number|null: explicit 0 = known-free ($0); null = unknown (no value).
 *    NEVER collapsed.
 *  - `inventoryPositionKnown: false` on every result: this number is GROSS and does
 *    NOT subtract units already on order (no PO / on-order tracking in v1).
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { reorderDemand } from "@/lib/reports/demand";
import { REORDER_DEMAND_DEFINITION } from "@/lib/reports/metrics-contract";
import {
  getGlobalReorderSettings,
  resolveReorderConfig,
} from "@/lib/reorder-config";

/** Demand look-back window. Wider than the low-stock 30-day sibling so a buying
 *  decision draws on more evidence and the min-evidence gate is more often satisfied;
 *  the days-covered denominator means a new product is still measured over its actual
 *  span, not this window. Disclosed in `assumptions.windowDays`. */
export const REORDER_WINDOW_DAYS = 90;

export type ReorderUrgency = "OUT" | "CRITICAL" | "REORDER_NOW" | "APPROACHING";

export type ReorderRow =
  | {
      status: "suggested";
      productId: number;
      productName: string;
      currentStock: number;
      avgDailyDemand: number;
      daysCovered: number;
      leadTimeDays: number;
      leadTimeSource: "product" | "default";
      bufferDays: number;
      reorderPoint: number;
      targetLevel: number;
      grossReplenishmentNeed: number;
      minOrderQuantity: number;
      urgency: ReorderUrgency;
      costPrice: number | null;
      orderValue: number | null;
    }
  | {
      status: "unavailable";
      productId: number;
      productName: string;
      currentStock: number;
      reason: "no_demand_signal" | "insufficient_history";
    };

export interface ReorderReport {
  rows: ReorderRow[];
  inventoryPositionKnown: false;
  assumptions: {
    windowDays: number;
    bufferDaysDefault: number;
    targetCoverageMultiple: number;
    demandDefinition: string;
  };
  /**
   * Accounting over the approved-ACTIVE population (spec C5, review F3). NORMATIVE
   * invariant: `total = suggested + unavailable + healthy + approachingOmitted`.
   * Category definitions are BINDING (contract pack T5/CP-4):
   *   - `suggested`          emitted suggested rows
   *   - `unavailable`        emitted no_demand_signal / insufficient_history rows
   *   - `healthy`            FINAL urgency null (classifyUrgency returned null) AND not emitted
   *   - `approachingOmitted` APPROACHING dropped by includeOkay=false
   * `costed` is a property of the suggested rows, NOT a partition member.
   */
  coverage: {
    total: number;
    suggested: number;
    unavailable: number;
    healthy: number;
    approachingOmitted: number;
    costed: number;
  };
  /** Prose for the coverage block — states what `healthy` means and when it is a row. */
  coverageNote: string;
}

/** Spec C5 verbatim. `healthy` is defined by FINAL urgency null, never by a
 *  stock-vs-reorderPoint phrase (which would overlap APPROACHING's band). */
export const REORDER_COVERAGE_NOTE =
  "healthy = final urgency null (classifyUrgency returned null — stock comfortably " +
  "above 1.2x the reorder point) — counted, and a row ONLY when explicitly requested " +
  "(productIds) or includeHealthy is set.";

// The reorder-demand definition prose now lives in the metrics contract (spec §2 D3)
// so reorder, low-stock, ops, and every tool draw the same text. The duplicate string
// that used to live here is deleted — `REORDER_DEMAND_DEFINITION` is the canonical text.

const URGENCY_RANK: Record<ReorderUrgency, number> = {
  OUT: 4,
  CRITICAL: 3,
  REORDER_NOW: 2,
  APPROACHING: 1,
};

/** Round a gross need UP to a whole multiple of the minimum order quantity. */
function roundUpToMOQ(need: number, moq: number): number {
  if (need <= 0) return 0;
  const q = Math.max(1, moq);
  return Math.ceil(need / q) * q;
}

/**
 * Reorder-SPECIFIC urgency (NOT warehouse-metrics getOrderStatus, which is calibrated
 * off days-of-supply vs a flat lead time). Returns null for a healthy product (stock
 * comfortably above the reorder point) — such a product is not a row by default.
 */
function classifyUrgency(
  currentStock: number,
  leadTimeDemand: number,
  reorderPoint: number,
): ReorderUrgency | null {
  if (currentStock <= 0) return "OUT";
  if (currentStock < leadTimeDemand) return "CRITICAL";
  if (currentStock <= reorderPoint) return "REORDER_NOW";
  if (currentStock <= reorderPoint * 1.2) return "APPROACHING";
  return null;
}

interface ProductRow {
  id: number;
  name: string;
  costPrice: unknown; // Prisma.Decimal | null
  product_locations: { quantity: number }[];
  reorderConfig: {
    leadTimeDays: number | null;
    customSafetyStockDays: number | null;
    minOrderQuantity: number | null;
    reorderPointOverride: number | null;
  } | null;
}

/**
 * Build the reorder report over every approved, non-deleted product.
 *
 * @param opts.includeOkay when true, also include APPROACHING rows (near the reorder
 *   point but not yet at it); default false shows the buying worklist (OUT / CRITICAL /
 *   REORDER_NOW). Fully-healthy products are never rows (only counted in coverage).
 * @param opts.limit / opts.offset paginate the combined rows (suggested first by
 *   urgency, then unavailable) — the Lane-6 pagination shape reused by the tool.
 */
export async function getReorderReport(
  opts: { includeOkay?: boolean; limit?: number; offset?: number } = {},
): Promise<ReorderReport> {
  const includeOkay = opts.includeOkay ?? false;

  const [globals, products] = await Promise.all([
    getGlobalReorderSettings(),
    prisma.product.findMany({
      where: { deletedAt: null, approvalStatus: "APPROVED" },
      select: {
        id: true,
        name: true,
        costPrice: true,
        product_locations: { select: { quantity: true } },
        reorderConfig: {
          select: {
            leadTimeDays: true,
            customSafetyStockDays: true,
            minOrderQuantity: true,
            reorderPointOverride: true,
          },
        },
      },
    }) as unknown as Promise<ProductRow[]>,
  ]);

  const demandMap = await reorderDemand(
    products.map((p) => p.id),
    REORDER_WINDOW_DAYS,
  );

  const suggested: Extract<ReorderRow, { status: "suggested" }>[] = [];
  const unavailable: Extract<ReorderRow, { status: "unavailable" }>[] = [];
  const total = products.length;
  // C5 accounting: the two NON-emitted outcomes, so every approved-active product is
  // accounted for instead of silently vanishing from the coverage block.
  let healthy = 0;
  let approachingOmitted = 0;

  for (const product of products) {
    const currentStock = product.product_locations.reduce((s, l) => s + l.quantity, 0);
    const demand = demandMap.get(product.id) ?? {
      avgDailyDemand: null,
      outboundEvents: 0,
      daysCovered: 0,
    };
    const config = resolveReorderConfig(product.reorderConfig, globals);

    // Gate 1: no demand signal at all.
    if (demand.avgDailyDemand === null) {
      unavailable.push({
        status: "unavailable",
        productId: product.id,
        productName: product.name,
        currentStock,
        reason: "no_demand_signal",
      });
      continue;
    }

    // Gate 2: some movement, but too little evidence to stand behind a number.
    if (demand.outboundEvents < config.minEvidenceEvents) {
      unavailable.push({
        status: "unavailable",
        productId: product.id,
        productName: product.name,
        currentStock,
        reason: "insufficient_history",
      });
      continue;
    }

    const avgDaily = demand.avgDailyDemand;
    // Raw decimal components — never pre-rounded.
    const leadTimeDemand = avgDaily * config.leadTimeDays;
    const bufferDemand = avgDaily * config.bufferDays;

    const reorderPoint =
      config.reorderPointOverride != null
        ? config.reorderPointOverride
        : Math.ceil(leadTimeDemand + bufferDemand);

    // The max() is load-bearing: it guarantees targetLevel >= reorderPoint, closing
    // the lead=1/buffer=7/stock=8 hole where a small 2x-lead target produced a 0 need
    // for a product that plainly needs reordering.
    const targetLevel = Math.max(
      reorderPoint,
      Math.ceil(avgDaily * config.leadTimeDays * config.targetCoverageMultiple),
    );

    const grossReplenishmentNeed = roundUpToMOQ(
      Math.max(0, targetLevel - currentStock),
      config.minOrderQuantity,
    );

    const urgency = classifyUrgency(currentStock, leadTimeDemand, reorderPoint);
    // Healthy products are never rows; APPROACHING only when includeOkay. Both
    // outcomes are COUNTED (C5) — a product that leaves the row set must still be
    // accounted for, and the two reasons are never conflated.
    if (urgency === null) {
      healthy += 1;
      continue;
    }
    if (urgency === "APPROACHING" && !includeOkay) {
      approachingOmitted += 1;
      continue;
    }

    const costPrice = product.costPrice == null ? null : Number(product.costPrice);
    const orderValue = costPrice == null ? null : costPrice * grossReplenishmentNeed;

    suggested.push({
      status: "suggested",
      productId: product.id,
      productName: product.name,
      currentStock,
      avgDailyDemand: avgDaily,
      daysCovered: demand.daysCovered,
      leadTimeDays: config.leadTimeDays,
      leadTimeSource: config.leadTimeSource,
      bufferDays: config.bufferDays,
      reorderPoint,
      targetLevel,
      grossReplenishmentNeed,
      minOrderQuantity: config.minOrderQuantity,
      urgency,
      costPrice,
      orderValue,
    });
  }

  // Suggested first, most-urgent first (then largest need, then name); unavailable
  // after, by name. Deterministic so offset paging is stable.
  suggested.sort(
    (a, b) =>
      URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] ||
      b.grossReplenishmentNeed - a.grossReplenishmentNeed ||
      a.productName.localeCompare(b.productName),
  );
  unavailable.sort((a, b) => a.productName.localeCompare(b.productName));

  const allRows: ReorderRow[] = [...suggested, ...unavailable];
  const offset = Math.max(0, opts.offset ?? 0);
  const rows =
    opts.limit != null ? allRows.slice(offset, offset + opts.limit) : allRows.slice(offset);

  return {
    rows,
    inventoryPositionKnown: false,
    assumptions: {
      windowDays: REORDER_WINDOW_DAYS,
      bufferDaysDefault: globals.defaultSafetyStockDays,
      targetCoverageMultiple: globals.defaultTargetCoverageMultiple,
      demandDefinition: REORDER_DEMAND_DEFINITION,
    },
    coverage: {
      total,
      suggested: suggested.length,
      unavailable: unavailable.length,
      healthy,
      approachingOmitted,
      costed: suggested.filter((r) => r.costPrice != null).length,
    },
    coverageNote: REORDER_COVERAGE_NOTE,
  };
}
