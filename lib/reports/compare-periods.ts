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
import {
  approvedProductIds,
  approvalDisclosure,
  excludedUnapprovedProductCount,
  APPROVED_UNIVERSE_NOTE,
} from "@/lib/reports/outbound-mix";
import {
  callerWindowCoverage,
  salesDataStartsByCompany,
  SALES_COMPANY_COVERAGE_NOTE,
} from "@/lib/assistant/sales-coverage";

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
  /** G5 disclosure (spec C13). Totals mode carries no product ids, so BOTH counts come
   *  from the contributor census, over BOTH periods (a product that contributed to
   *  either one is a contributor to this comparison). */
  excludedUnapprovedProducts: number;
  archivedProductsIncluded: number;
  approvalNote: string;
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

/**
 * The productId narrowing, built ONCE for every read in this module (Task 3.1).
 *
 * An explicit `productId` (already approval-checked by the caller's resolver) and the G5
 * approved-id set narrow the SAME column. Spreading them as two `productId` keys made the
 * second silently OVERWRITE the first — harmless while only the by_product path passed
 * `approvedIds` (it never passes a productId), but a real hole the moment totals mode
 * passes both, which it now does. One IntFilter carries both and they AND together.
 */
function productFilter(
  productId: number | undefined,
  approvedIds: number[] | undefined,
): { productId?: { equals?: number; in?: number[] } } {
  if (productId == null && approvedIds == null) return {};
  return {
    productId: {
      ...(productId != null ? { equals: productId } : {}),
      ...(approvedIds != null ? { in: approvedIds } : {}),
    },
  };
}

/**
 * A metric's coverage SOURCE: the caller-wide data-start, plus (sales metrics only) the
 * PER-COMPANY starts that govern zero legality (FD-1, seam S8).
 *
 * The ledger metrics have no company dimension at all, so they carry a bare data-start —
 * `companyCoverage` is absent and the classification is the plain one.
 */
interface MetricCoverageSource {
  dataStart: string | null;
  companyCoverage?: Array<{ companyId: string; salesDataStart: string | null }>;
}

/** MIN(dayKey) of ProductSalesFact for this caller's scope (company + optional product),
 *  narrowed to the G5 approved universe, PLUS the per-company starts (FD-1). An
 *  unapproved product's older fact must never move a disclosed data-start any more than
 *  it may move a total.
 *
 *  FD-1: this used to return the caller-wide minimum alone, so a caller in two companies
 *  whose second one started recording last month read BOTH periods as fully covered —
 *  and every silence became a measured 0 (a by_product row of 0, a scalar delta computed
 *  from a manufactured base). get_sales degrades exactly this case; comparing the same
 *  facts over the same window had to classify it identically or the two tools contradict
 *  each other over ONE seeded source. */
async function salesStarts(
  companyIds: string[],
  productId: number | undefined,
  approvedIds?: number[],
): Promise<MetricCoverageSource> {
  if (companyIds.length === 0) return { dataStart: null };
  const starts = await salesDataStartsByCompany(companyIds, productFilter(productId, approvedIds));
  return {
    dataStart: starts.salesDataStart,
    ...(starts.staggered ? { companyCoverage: starts.perCompany } : {}),
  };
}

/** Sum of ProductSalesFact.orderedQty over a window, company + optional product scoped. */
async function salesUnitsValue(
  companyIds: string[],
  productId: number | undefined,
  window: ResolvedWindow,
  approvedIds?: number[],
): Promise<number | null> {
  if (companyIds.length === 0) return null;
  const row = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      dayKey: { gte: window.from, lte: window.to },
      ...productFilter(productId, approvedIds),
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
  approvedIds?: number[],
): Promise<number | null> {
  if (companyIds.length === 0) return null;
  const row = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      dayKey: { gte: window.from, lte: window.to },
      ...productFilter(productId, approvedIds),
    },
    _sum: { revenue: true },
  });
  return row._sum.revenue != null ? Number(row._sum.revenue) : null;
}

/** MIN(changeTime) under a ledger predicate, optional product scoped — GLOBAL (no company
 *  dimension), narrowed to the G5 approved universe. */
async function ledgerDataStart(
  where: Prisma.inventory_logsWhereInput,
  productId: number | undefined,
  approvedIds?: number[],
): Promise<string | null> {
  const row = await prisma.inventory_logs.aggregate({
    where: {
      ...where,
      ...productFilter(productId, approvedIds),
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
  approvedIds?: number[],
): Promise<number | null> {
  const row = await prisma.inventory_logs.aggregate({
    where: {
      ...where,
      changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
      ...productFilter(productId, approvedIds),
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
  approvedIds: number[],
): {
  starts: () => Promise<MetricCoverageSource>;
  value: (window: ResolvedWindow) => Promise<number | null>;
} {
  const ledgerStarts = async (where: Prisma.inventory_logsWhereInput) => ({
    dataStart: await ledgerDataStart(where, productId, approvedIds),
  });
  switch (metric) {
    case "sales_units":
      return {
        starts: () => salesStarts(companyIds, productId, approvedIds),
        value: (window) => salesUnitsValue(companyIds, productId, window, approvedIds),
      };
    case "sales_revenue":
      return {
        starts: () => salesStarts(companyIds, productId, approvedIds),
        value: (window) => salesRevenueValue(companyIds, productId, window, approvedIds),
      };
    case "outbound_units":
      return {
        starts: () => ledgerStarts(PHYSICAL_OUTBOUND_WHERE),
        value: (window) => ledgerValue(PHYSICAL_OUTBOUND_WHERE, productId, window, approvedIds),
      };
    case "inbound_units":
      return {
        starts: () => ledgerStarts(INBOUND_UNITS_WHERE),
        value: (window) => ledgerValue(INBOUND_UNITS_WHERE, productId, window, approvedIds),
      };
  }
}

/**
 * The contributor-census scope for a TWO-PERIOD comparison (spec G5). A product counts as
 * a contributor when it has a qualifying row in EITHER period — expressed as an OR of the
 * two window predicates, never as one span covering the gap between them (disjoint periods
 * are the normal case, and the gap is not part of the question).
 */
function comparisonCensusScope(
  metric: CompareMetric,
  companyIds: string[],
  periodA: ResolvedWindow,
  periodB: ResolvedWindow,
  productId?: number,
): Parameters<typeof approvalDisclosure>[0] {
  const isSales = metric === "sales_units" || metric === "sales_revenue";
  if (isSales) {
    return {
      relation: "salesFacts",
      some: {
        companyId: { in: companyIds },
        OR: [
          { dayKey: { gte: periodA.from, lte: periodA.to } },
          { dayKey: { gte: periodB.from, lte: periodB.to } },
        ],
      },
      productId,
    };
  }
  const where = metric === "outbound_units" ? PHYSICAL_OUTBOUND_WHERE : INBOUND_UNITS_WHERE;
  return {
    relation: "inventory_logs",
    some: {
      ...(where as Record<string, unknown>),
      OR: [
        { changeTime: { gte: dayKeyStart(periodA.from), lt: nextDayStart(periodA.to) } },
        { changeTime: { gte: dayKeyStart(periodB.from), lt: nextDayStart(periodB.to) } },
      ],
    },
    productId,
  };
}

/**
 * ONE period's coverage under the SAME rule get_sales applies (FD-1, seam S8): the
 * caller-wide start classifies the period, and for a SALES metric the per-company starts
 * can only degrade it further (`callerWindowCoverage` — the latest-starting company
 * governs, and a company with no facts governs hardest). Ledger metrics carry no
 * `companyCoverage`, so this is the plain classification for them.
 */
function periodCoverage(source: MetricCoverageSource, window: ResolvedWindow): WindowCoverage {
  return callerWindowCoverage(
    { salesDataStart: source.dataStart, companyCoverage: source.companyCoverage },
    window.from,
  );
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
  source: MetricCoverageSource,
  metric: CompareMetric,
  reasons: Record<string, string>,
): number | null {
  const periodLabel = label === "a" ? "A" : "B";
  const dataStart = source.dataStart;
  // The zero-vs-unknown decision routes through the SHARED classifier (seam S8), so
  // get_sales' windowCoverage and this tool can never classify one seeded source
  // differently — INCLUDING the per-company degradation (FD-1): with staggered company
  // starts the LATEST-starting company governs, and a company with no facts at all
  // degrades the set outright. The reason TEXT still distinguishes predates-vs-straddles
  // vs per-company below — that distinction is prose, not a different verdict.
  const coverage = periodCoverage(source, window);
  if (coverage === "none") {
    reasons[label] = `no ${metric} data recorded`;
    return null;
  }
  if (coverage === "partial") {
    // Source does not cover the whole interval — either the period predates the
    // data entirely (dataStart > window.to), straddles it (dataStart falls
    // inside the window), or the caller-wide start covers it while a MEMBER COMPANY's
    // does not. Either way `raw` (even a non-null partial sum) is discarded: it cannot
    // stand in for the whole period.
    reasons[label] =
      classifyWindowCoverage(dataStart, window.from) === "full"
        ? `period ${periodLabel} is not fully covered by ${metric} data in every company ` +
          `(${SALES_COMPANY_COVERAGE_NOTE})`
        : dataStart! > window.to
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
  // G5 (Task 3.1 retrofit): totals mode reads the SAME approved universe by_product has
  // read since birth — active+archived, because both periods are HISTORICAL facts.
  const approvedIds = await approvedProductIds({ includeArchived: true });
  const source = metricSource(metric, companyIds, productId, approvedIds);

  const [starts, rawA, rawB, disclosure] = await Promise.all([
    source.starts(),
    source.value(periodA),
    source.value(periodB),
    approvalDisclosure(comparisonCensusScope(metric, companyIds, periodA, periodB, productId)),
  ]);

  const reasons: Record<string, string> = {};
  const a = resolvePeriod(rawA, periodA, "a", starts, metric, reasons);
  const b = resolvePeriod(rawB, periodB, "b", starts, metric, reasons);

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
    excludedUnapprovedProducts: disclosure.excludedUnapprovedProducts,
    archivedProductsIncluded: disclosure.archivedProductsIncluded,
    approvalNote: APPROVED_UNIVERSE_NOTE,
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
  /** G5 disclosure, excluded half (spec C13). The ARCHIVED half is product-grain here —
   *  the tool layer counts it off the rows' own `lifecycle` after attaching identities. */
  excludedUnapprovedProducts: number;
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

  const [starts, aByProduct, bByProduct, excludedUnapprovedProducts] = await Promise.all([
    // FD-1: the SAME coverage source the scalar mode resolves — including the per-company
    // starts for a sales metric. A degraded window must leave EVERY row's a/b null; a
    // by_product row carrying a measured 0 under a staggered membership is precisely the
    // manufactured zero this rule exists to prevent, per product.
    isSales
      ? salesStarts(companyIds, undefined, approvedIds)
      : ledgerDataStart(
          metric === "outbound_units" ? PHYSICAL_OUTBOUND_WHERE : INBOUND_UNITS_WHERE,
          undefined,
          approvedIds,
        ).then((dataStart) => ({ dataStart })),
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
    excludedUnapprovedProductCount(comparisonCensusScope(metric, companyIds, periodA, periodB)),
  ]);

  // Source-level coverage, computed ONCE per period (the erratum's all-or-nothing).
  const reasons: Record<string, string> = {};
  const coverageA = periodCoverage(starts, periodA);
  const coverageB = periodCoverage(starts, periodB);
  // Reuse the scalar reason vocabulary verbatim: same strings, same meanings.
  resolvePeriod(null, periodA, "a", starts, metric, reasons);
  resolvePeriod(null, periodB, "b", starts, metric, reasons);

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
    excludedUnapprovedProducts,
  };
}
