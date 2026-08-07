/**
 * lib/reports/compare-periods.ts — the ONE cross-period delta engine (assistant
 * toolsuite breadth, spec §5 T-CMP REV-2 zero-vs-unknown rule; W2-CMP).
 *
 * `compare_periods` is a MIXED-SCOPE tool (spec §6): `sales_units`/`sales_revenue`
 * are company-scoped reads of ProductSalesFact (companyIds scoping is MANDATORY —
 * never trust an unfiltered read); `outbound_units`/`inbound_units` are GLOBAL
 * physical-ledger reads of inventory_logs (inventory has no company dimension,
 * same convention as lib/analytics/queries.ts's Tier-1 Operations rows and
 * lib/reports/movement.ts).
 *
 * THE ZERO-VS-UNKNOWN RULE (normative, spec §5 T-CMP REV-2, codex): a period with
 * no matching rows counts as `0` ONLY when the metric's own `dataStart` is on or
 * before the period's start day-key (the source is complete for the WHOLE
 * interval, so silence really does mean "nothing happened"). Otherwise the period
 * predates the data source and the value is `null` + a named reason — growth
 * computed FROM a pre-history period must read as unknown, never as growth from
 * a manufactured zero. This is day-key granularity throughout (both `dataStart`
 * and `period.from` are compared as ISO day-keys, matching every other window in
 * this codebase), never sub-day.
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { Prisma, inventory_logs_logType } from "@prisma/client";
import type { ResolvedWindow } from "@/lib/assistant/window";
import { toDayKey, dayKeyStart, nextDayStart } from "@/lib/analytics/dates";
import {
  PHYSICAL_OUTBOUND_WHERE,
  classifyWindowCoverage,
  type WindowCoverage,
} from "@/lib/reports/metrics-contract";
import { approvedProductIds } from "@/lib/reports/outbound-mix";

export type CompareMetric = "sales_units" | "sales_revenue" | "outbound_units" | "inbound_units";

export interface ComparePeriodsOpts {
  metric: CompareMetric;
  periodA: ResolvedWindow;
  periodB: ResolvedWindow;
  productId?: number;
  companyIds: string[];
}

export interface ComparePeriodsResult {
  a: number | null;
  b: number | null;
  delta: number | null;
  pctChange: number | null;
  reasons: Record<string, string>;
  unequalLengths: boolean;
}

/**
 * inbound_units predicate: positive-delta, non-TRANSFER ledger rows —
 * `delta > 0 AND logType != TRANSFER`. ALIGNMENT NOTE: this is the same "inbound
 * family" lib/reports/movement.ts partitions into stockIn + correctionIn +
 * adjustmentIn + countIn (STOCK_IN plus positive CORRECTION/ADJUSTMENT/COUNT —
 * TRANSFER's positive leg is transferIn, kept separate there too). TWO documented
 * divergences from movement.ts, both because movement.ts keys STOCK_IN and SALE
 * by `logType` ALONE while this predicate is sign-first:
 *   1. a negative-delta STOCK_IN row (a receipt reversal) is excluded HERE but
 *      would still land in movement.ts's `stockIn` bucket (a rare wrong-signed
 *      row folds into its natural logType bucket so movement.ts's
 *      `net === SUM(delta)` invariant holds).
 *   2. a positive-delta SALE row (a return/refund) counts as inbound HERE but
 *      movement.ts always routes SALE-logType rows to its outbound `sale`
 *      bucket, regardless of sign.
 * Nothing is imported from movement.ts — this predicate is restated inline per
 * the module-writer fence. inbound_units is a standalone, sign-based "physical
 * inbound" definition, not a re-derivation of movement.ts's bucket set — the two
 * are expected to diverge on these wrong-signed edge rows.
 */
const INBOUND_UNITS_WHERE: Prisma.inventory_logsWhereInput = {
  delta: { gt: 0 },
  logType: { not: inventory_logs_logType.TRANSFER },
};

/** MIN(dayKey) of ProductSalesFact for this caller's scope (company + optional product).
 *  `approvedIds`, when given, narrows to the G5 approved universe — the BY_PRODUCT path
 *  (new code) always passes it; totals mode does not yet (Task 3.1 retrofits it). */
async function salesDataStart(
  companyIds: string[],
  productId: number | undefined,
  approvedIds?: number[],
): Promise<string | null> {
  if (companyIds.length === 0) return null;
  const row = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      ...(productId != null ? { productId } : {}),
      ...(approvedIds != null ? { productId: { in: approvedIds } } : {}),
    },
    _min: { dayKey: true },
  });
  return row._min.dayKey ?? null;
}

/** Sum of ProductSalesFact.orderedQty over a window, company + optional product scoped. */
async function salesUnitsValue(
  companyIds: string[],
  productId: number | undefined,
  window: ResolvedWindow,
): Promise<number | null> {
  if (companyIds.length === 0) return null;
  const row = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      dayKey: { gte: window.from, lte: window.to },
      ...(productId != null ? { productId } : {}),
    },
    _sum: { orderedQty: true },
  });
  return row._sum.orderedQty ?? null;
}

/** Sum of ProductSalesFact.revenue over a window, company + optional product scoped. */
async function salesRevenueValue(
  companyIds: string[],
  productId: number | undefined,
  window: ResolvedWindow,
): Promise<number | null> {
  if (companyIds.length === 0) return null;
  const row = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      dayKey: { gte: window.from, lte: window.to },
      ...(productId != null ? { productId } : {}),
    },
    _sum: { revenue: true },
  });
  return row._sum.revenue != null ? Number(row._sum.revenue) : null;
}

/** MIN(changeTime) under a ledger predicate, optional product scoped — GLOBAL (no company
 *  dimension). `approvedIds` narrows to the G5 approved universe (by_product path only —
 *  see salesDataStart). */
async function ledgerDataStart(
  where: Prisma.inventory_logsWhereInput,
  productId: number | undefined,
  approvedIds?: number[],
): Promise<string | null> {
  const row = await prisma.inventory_logs.aggregate({
    where: {
      ...where,
      ...(productId != null ? { productId } : {}),
      ...(approvedIds != null ? { productId: { in: approvedIds } } : {}),
    },
    _min: { changeTime: true },
  });
  return row._min.changeTime != null ? toDayKey(row._min.changeTime) : null;
}

/** |SUM(delta)| under a ledger predicate over a window, optional product scoped. */
async function ledgerValue(
  where: Prisma.inventory_logsWhereInput,
  productId: number | undefined,
  window: ResolvedWindow,
): Promise<number | null> {
  const row = await prisma.inventory_logs.aggregate({
    where: {
      ...where,
      changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
      ...(productId != null ? { productId } : {}),
    },
    _sum: { delta: true },
  });
  return row._sum.delta != null ? Math.abs(row._sum.delta) : null;
}

/** Per-metric { dataStart, value } source, dispatched once per call. */
function metricSource(
  metric: CompareMetric,
  companyIds: string[],
  productId: number | undefined,
): { dataStart: () => Promise<string | null>; value: (window: ResolvedWindow) => Promise<number | null> } {
  switch (metric) {
    case "sales_units":
      return {
        dataStart: () => salesDataStart(companyIds, productId),
        value: (window) => salesUnitsValue(companyIds, productId, window),
      };
    case "sales_revenue":
      return {
        dataStart: () => salesDataStart(companyIds, productId),
        value: (window) => salesRevenueValue(companyIds, productId, window),
      };
    case "outbound_units":
      return {
        dataStart: () => ledgerDataStart(PHYSICAL_OUTBOUND_WHERE, productId),
        value: (window) => ledgerValue(PHYSICAL_OUTBOUND_WHERE, productId, window),
      };
    case "inbound_units":
      return {
        dataStart: () => ledgerDataStart(INBOUND_UNITS_WHERE, productId),
        value: (window) => ledgerValue(INBOUND_UNITS_WHERE, productId, window),
      };
  }
}

/**
 * Resolve one period's raw aggregate into the zero-vs-unknown result. Coverage is
 * checked FIRST, before ever looking at `raw` — a real sum is only trustworthy
 * when the source covers the WHOLE interval (`dataStart <= window.from`); a period
 * straddling `dataStart` (window.from < dataStart <= window.to) has, at best, a
 * PARTIAL sum for its covered tail, and must read as unknown just like a period
 * that predates the data entirely — never as an authoritative total. Only once
 * coverage is confirmed does an absent sum become a real measured `0`.
 */
function resolvePeriod(
  raw: number | null,
  window: ResolvedWindow,
  label: "a" | "b",
  dataStart: string | null,
  metric: CompareMetric,
  reasons: Record<string, string>,
): number | null {
  const periodLabel = label === "a" ? "A" : "B";
  // The zero-vs-unknown decision routes through the SHARED classifier (seam S8), so
  // get_sales' windowCoverage and this tool can never classify one seeded source
  // differently. The reason TEXT still distinguishes predates-vs-straddles below —
  // that distinction is prose, not a different verdict.
  const coverage = classifyWindowCoverage(dataStart, window.from);
  if (coverage === "none") {
    reasons[label] = `no ${metric} data recorded`;
    return null;
  }
  if (coverage === "partial") {
    // Source does not cover the whole interval — either the period predates the
    // data entirely (dataStart > window.to) or straddles it (dataStart falls
    // inside the window). Either way `raw` (even a non-null partial sum) is
    // discarded: it cannot stand in for the whole period.
    reasons[label] =
      dataStart! > window.to
        ? `period${periodLabel} predates ${metric} data (starts ${dataStart})`
        : `period ${periodLabel} is not fully covered by ${metric} data (starts ${dataStart})`;
    return null;
  }
  // dataStart <= window.from: source is complete for the whole interval, so an
  // absent sum is a real measured zero, not an unknown.
  return raw ?? 0;
}

/**
 * Compare a metric across two resolved windows. Server-computed absolute delta
 * (`b - a`) and percent change (`(b - a) / a`) — the model never does this
 * arithmetic itself. `unequalLengths` is a disclosure flag only; the comparison
 * still runs (spec §5 T-CMP: "unequal lengths allowed but flagged").
 */
export async function comparePeriods(opts: ComparePeriodsOpts): Promise<ComparePeriodsResult> {
  const { metric, periodA, periodB, productId, companyIds } = opts;
  const source = metricSource(metric, companyIds, productId);

  const [dataStart, rawA, rawB] = await Promise.all([
    source.dataStart(),
    source.value(periodA),
    source.value(periodB),
  ]);

  const reasons: Record<string, string> = {};
  const a = resolvePeriod(rawA, periodA, "a", dataStart, metric, reasons);
  const b = resolvePeriod(rawB, periodB, "b", dataStart, metric, reasons);

  let delta: number | null = null;
  let pctChange: number | null = null;
  if (a != null && b != null) {
    delta = b - a;
    if (a === 0) {
      reasons.pctChange = "period A is zero — percent change undefined";
    } else {
      pctChange = (b - a) / a;
    }
  }

  return {
    a,
    b,
    delta,
    pctChange,
    reasons,
    unequalLengths: periodA.days !== periodB.days,
  };
}

// ---------------------------------------------------------------------------
// PER-PRODUCT mode (spec C9 as amended by REV-4 erratum 1). The scalar engine above
// answers "did the business grow?"; this one answers "WHICH products grew?" without
// the model looping a per-product tool over the catalog and ranking deltas itself
// (review #3's most expensive failure).
//
// THE ERRATUM, stated where it is implemented: `unranked` is a COVERAGE ARTIFACT, not
// the "started moving" answer. Coverage is decided at the SOURCE (one dataStart per
// metric, compared against the period), so it is ALL-OR-NOTHING per period: either the
// source covers the whole period and EVERY product is measurable in it, or it does not
// and EVERY product is unknown in it. A "started moving" product is therefore a RANKED
// row with a MEASURED a == 0 — never an unranked one.
// ---------------------------------------------------------------------------

/** One product's cross-period comparison. `name`/`lifecycle` and the evidence fields
 *  are filled by the TOOL layer (identity + post-pagination evidence). */
export interface ComparePeriodsProductRow {
  productId: number;
  a: number | null;
  b: number | null;
  delta: number | null;
  pctChange: number | null;
  reasons?: Record<string, string>;
}

export interface ComparePeriodsByProductResult {
  /** Both sides measured: ranked |delta| desc (ties delta desc, then productId asc),
   *  with `direction` ALREADY applied — so a caller's totalRows is post-direction. */
  ranked: ComparePeriodsProductRow[];
  /** Either side unknown. Non-empty ONLY when a period is not fully covered, and then
   *  for every product alike. Citable as unknown-base, NEVER as growth. */
  unranked: ComparePeriodsProductRow[];
  /** Period-level reason vocabulary (the scalar mode's strings), shared by every
   *  unranked row because the cause is the SOURCE, not the product. */
  reasons: Record<string, string>;
  periodCoverage: { a: WindowCoverage; b: WindowCoverage };
  unequalLengths: boolean;
}

/** Per-product sums for one window, keyed by productId. */
async function salesUnitsByProduct(
  companyIds: string[],
  approvedIds: number[],
  window: ResolvedWindow,
  field: "orderedQty" | "revenue",
): Promise<Map<number, number>> {
  if (companyIds.length === 0) return new Map();
  const rows = (await prisma.productSalesFact.groupBy({
    by: ["productId"],
    where: {
      companyId: { in: companyIds },
      productId: { in: approvedIds },
      dayKey: { gte: window.from, lte: window.to },
    },
    _sum: field === "orderedQty" ? { orderedQty: true } : { revenue: true },
  })) as unknown as Array<{ productId: number; _sum: { orderedQty?: number | null; revenue?: unknown } }>;
  const out = new Map<number, number>();
  for (const r of rows ?? []) {
    const value =
      field === "orderedQty" ? r._sum?.orderedQty ?? 0 : r._sum?.revenue != null ? Number(r._sum.revenue) : 0;
    out.set(r.productId, value);
  }
  return out;
}

async function ledgerByProduct(
  where: Prisma.inventory_logsWhereInput,
  approvedIds: number[],
  window: ResolvedWindow,
): Promise<Map<number, number>> {
  const rows = (await prisma.inventory_logs.groupBy({
    by: ["productId"],
    where: {
      ...where,
      productId: { in: approvedIds },
      changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
    },
    _sum: { delta: true },
  })) as unknown as Array<{ productId: number; _sum: { delta: number | null } }>;
  const out = new Map<number, number>();
  // |SUM(delta)| — the same absolute convention the scalar mode uses.
  for (const r of rows ?? []) out.set(r.productId, Math.abs(r._sum?.delta ?? 0));
  return out;
}

/**
 * Compare ONE metric across TWO windows, PER PRODUCT.
 *
 * G5 FROM BIRTH: every read here is narrowed by the APPROVED-id set (archived
 * INCLUDED — these are historical facts), so an unapproved product can never appear in
 * a row nor move the source dataStart, even before Task 3.1 retrofits the pre-existing
 * reads beside it.
 */
export async function comparePeriodsByProduct(opts: {
  metric: CompareMetric;
  periodA: ResolvedWindow;
  periodB: ResolvedWindow;
  companyIds: string[];
  direction?: "increase" | "decrease";
}): Promise<ComparePeriodsByProductResult> {
  const { metric, periodA, periodB, companyIds, direction } = opts;
  const approvedIds = await approvedProductIds({ includeArchived: true });
  const isSales = metric === "sales_units" || metric === "sales_revenue";

  const [dataStart, aByProduct, bByProduct] = await Promise.all([
    isSales
      ? salesDataStart(companyIds, undefined, approvedIds)
      : ledgerDataStart(
          metric === "outbound_units" ? PHYSICAL_OUTBOUND_WHERE : INBOUND_UNITS_WHERE,
          undefined,
          approvedIds,
        ),
    isSales
      ? salesUnitsByProduct(companyIds, approvedIds, periodA, metric === "sales_units" ? "orderedQty" : "revenue")
      : ledgerByProduct(
          metric === "outbound_units" ? PHYSICAL_OUTBOUND_WHERE : INBOUND_UNITS_WHERE,
          approvedIds,
          periodA,
        ),
    isSales
      ? salesUnitsByProduct(companyIds, approvedIds, periodB, metric === "sales_units" ? "orderedQty" : "revenue")
      : ledgerByProduct(
          metric === "outbound_units" ? PHYSICAL_OUTBOUND_WHERE : INBOUND_UNITS_WHERE,
          approvedIds,
          periodB,
        ),
  ]);

  // Source-level coverage, computed ONCE per period (the erratum's all-or-nothing).
  const reasons: Record<string, string> = {};
  const coverageA = classifyWindowCoverage(dataStart, periodA.from);
  const coverageB = classifyWindowCoverage(dataStart, periodB.from);
  // Reuse the scalar reason vocabulary verbatim: same strings, same meanings.
  resolvePeriod(null, periodA, "a", dataStart, metric, reasons);
  resolvePeriod(null, periodB, "b", dataStart, metric, reasons);

  // The product universe: everything with a qualifying row in EITHER window.
  const productIds = Array.from(
    new Set([...Array.from(aByProduct.keys()), ...Array.from(bByProduct.keys())]),
  );

  const ranked: ComparePeriodsProductRow[] = [];
  const unranked: ComparePeriodsProductRow[] = [];
  for (const productId of productIds) {
    // A fully-covered period turns absence into a MEASURED 0; anything else leaves it
    // unknown. Never a manufactured zero standing in for "we cannot see that far back".
    const a = coverageA === "full" ? aByProduct.get(productId) ?? 0 : null;
    const b = coverageB === "full" ? bByProduct.get(productId) ?? 0 : null;
    if (a == null || b == null) {
      unranked.push({ productId, a, b, delta: null, pctChange: null, reasons });
      continue;
    }
    const delta = b - a;
    const row: ComparePeriodsProductRow = {
      productId,
      a,
      b,
      delta,
      pctChange: a === 0 ? null : delta / a,
    };
    if (a === 0) row.reasons = { pctChange: "period A is zero — percent change undefined" };
    ranked.push(row);
  }

  // Pipeline order (normative): direction FIRST, then rank — so a caller's totalRows is
  // the post-direction count and paging never walks rows the filter already removed.
  const directed =
    direction == null
      ? ranked
      : ranked.filter((r) => (direction === "increase" ? (r.delta ?? 0) > 0 : (r.delta ?? 0) < 0));
  directed.sort(
    (x, y) =>
      Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) ||
      (y.delta ?? 0) - (x.delta ?? 0) ||
      x.productId - y.productId,
  );
  unranked.sort((x, y) => x.productId - y.productId);

  return {
    ranked: directed,
    unranked,
    reasons,
    periodCoverage: { a: coverageA, b: coverageB },
    unequalLengths: periodA.days !== periodB.days,
  };
}
