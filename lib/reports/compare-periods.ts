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
 * WHAT PER-COMPANY DEGRADATION DOES TO THAT RULE (FD2-2, binding): a sales caller whose
 * companies do not share one start has a window that is degraded to "partial" even
 * though the metric's own `dataStart` covers it. That degradation governs ZERO LEGALITY
 * ONLY — no measured zero may be synthesized, no growth-from-zero may be computed, and a
 * period with NO matching rows reads null + a reason. It NEVER discards a MEASURED sum:
 * a sum over rows that were really recorded is a true statement about recorded facts, and
 * it is returned with the `companyCoverage` disclosure beside it. (get_sales has always
 * had exactly this shape — real rows survive a "partial" window; only the SYNTHESIZED
 * zero rows go null-with-a-reason. Nulling measured sums here made the two surfaces
 * contradict each other over one seeded source, which is the failure seam S8 exists to
 * prevent.) The window-level cases are untouched: when the metric's OWN source starts
 * after the period began (predates or straddles), no sum can stand for the whole
 * interval and the value stays null — the distinction is structural-vs-windowed, and it
 * falls out of asking the caller-wide classification separately from the degraded one.
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
  companyCoverageDetail,
  salesDataStartsByCompany,
  SALES_COMPANY_COVERAGE_NOTE,
  SALES_COMPANY_COVERAGE_MEASURED_NOTE,
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
  /** FD2-2 disclosure: the per-company sales starts, present ONLY when they differ (a
   *  degraded window). It rides even when both periods are MEASURED — that is precisely
   *  the case a reader cannot otherwise see. Absent for the ledger metrics (no company
   *  dimension) and for callers whose companies share one start. */
  companyCoverage?: Array<{ companyId: string; salesDataStart: string | null }>;
  /** The sentence that goes with it: which companies degrade the window, and what the
   *  degradation does (zero legality only). Present exactly when companyCoverage is. */
  companyCoverageNote?: string;
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
 *  each other over ONE seeded source.
 *
 *  FD2-1: the PER-COMPANY question is asked SOURCE-LEVEL — `productId` narrows the VALUE
 *  reads, never "was this company recording sales at all?". Folding it in made a company
 *  that simply never sold THAT product indistinguishable from a company with no coverage,
 *  so a product-scoped comparison across two fully-recording companies degraded itself on
 *  the strength of a product's absence. get_sales asks the identical question source-level
 *  (its `salesDataStart` carries no productId), and seam S8 only holds if both ask it the
 *  same way. The CALLER-WIDE `dataStart` keeps its product-scoped meaning: it is what the
 *  predates/straddles reason strings quote ("starts <date>") and what has classified
 *  single-company product comparisons since birth — narrowing that too would change
 *  answers this finding never questioned. */
async function salesStarts(
  companyIds: string[],
  productId: number | undefined,
  approvedIds?: number[],
): Promise<MetricCoverageSource> {
  if (companyIds.length === 0) return { dataStart: null };
  const [source, scopedStart] = await Promise.all([
    salesDataStartsByCompany(companyIds, productFilter(undefined, approvedIds)),
    // One extra read ONLY when a productId narrows the values; otherwise the two
    // questions are the same question. It is a bare `_min(dayKey)` — the per-company
    // half of the product-scoped answer is exactly what must NOT govern coverage.
    productId == null ? null : callerWideSalesStart(companyIds, productId, approvedIds),
  ]);
  return {
    dataStart: productId == null ? source.salesDataStart : scopedStart,
    ...(source.staggered ? { companyCoverage: source.perCompany } : {}),
  };
}

/** `MIN(dayKey)` for the caller's companies under the PRODUCT-scoped narrowing — the
 *  date the predates/straddles reason strings quote. Company scoping is applied here and
 *  is not optional, same as every other read in this module. */
async function callerWideSalesStart(
  companyIds: string[],
  productId: number,
  approvedIds?: number[],
): Promise<string | null> {
  const row = await prisma.productSalesFact.aggregate({
    where: {
      companyId: { in: companyIds },
      ...productFilter(productId, approvedIds),
    },
    _min: { dayKey: true },
  });
  return row?._min?.dayKey ?? null;
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
 * The reason a period's ABSENCE is unknown rather than zero under per-company degradation
 * (FD2-2). Deliberately worded as a statement about the PERIOD's coverage, not about the
 * rows: by_product reuses this exact vocabulary for its unranked rows, where the period
 * itself may well have rows — just not for that product.
 */
function degradedCoverageReason(
  periodLabel: "A" | "B",
  metric: CompareMetric,
  source: MetricCoverageSource,
): string {
  const detail = companyCoverageDetail(source.companyCoverage);
  return (
    `period ${periodLabel} is not fully covered by ${metric} data in every company ` +
    `(${detail}; ${SALES_COMPANY_COVERAGE_NOTE}) — absence here is UNKNOWN, never zero`
  );
}

/**
 * Resolve one period's raw aggregate into the zero-vs-unknown result.
 *
 * The WINDOW-level check comes first and is unchanged (spec §5 T-CMP REV-2): a real sum
 * is only trustworthy when the metric's own source covers the WHOLE interval
 * (`dataStart <= window.from`); a period straddling `dataStart` has, at best, a PARTIAL
 * sum for its covered tail, and must read as unknown just like a period that predates the
 * data entirely — never as an authoritative total.
 *
 * PER-COMPANY degradation is the OTHER axis (FD2-2) and does strictly less: the
 * caller-wide source DOES cover the interval, one of the caller's companies just was not
 * recording in it. That makes SILENCE unreadable, not the recorded rows — so `raw`
 * survives when it exists, and only an absent sum becomes null + a named reason. The
 * disclosure (`companyCoverage`) rides on the result either way.
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
  // degrades the set outright.
  const coverage = periodCoverage(source, window);
  if (coverage === "none") {
    reasons[label] = `no ${metric} data recorded`;
    return null;
  }
  // The caller-wide classification, asked SEPARATELY from the degraded one: it is what
  // distinguishes "this window is outside the data" (no sum can be trusted) from "a
  // member company was not recording" (only silence cannot be trusted).
  if (classifyWindowCoverage(dataStart, window.from) !== "full") {
    reasons[label] =
      dataStart! > window.to
        ? `period${periodLabel} predates ${metric} data (starts ${dataStart})`
        : `period ${periodLabel} is not fully covered by ${metric} data (starts ${dataStart})`;
    return null;
  }
  if (coverage === "partial") {
    // FD2-2: per-company degradation, and the source covers the interval. A sum over rows
    // that were recorded is reported; only its ABSENCE stays unknown.
    if (raw == null) {
      reasons[label] = degradedCoverageReason(periodLabel, metric, source);
      return null;
    }
    return raw;
  }
  // dataStart <= window.from: source is complete for the whole interval, so an
  // absent sum is a real measured zero, not an unknown.
  return raw ?? 0;
}

/** The `companyCoverage` + note disclosure pair, present exactly when the caller's
 *  companies do not share one start (FD2-2). Spread into both modes' results. */
function companyCoverageDisclosure(
  source: MetricCoverageSource,
): Pick<ComparePeriodsResult, "companyCoverage" | "companyCoverageNote"> {
  if (source.companyCoverage == null) return {};
  return {
    companyCoverage: source.companyCoverage,
    companyCoverageNote:
      `${companyCoverageDetail(source.companyCoverage)}; ` +
      `${SALES_COMPANY_COVERAGE_NOTE} ${SALES_COMPANY_COVERAGE_MEASURED_NOTE}`,
  };
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
    ...companyCoverageDisclosure(starts),
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
//
// FD2-2 QUALIFIES THE "ALL-OR-NOTHING" HALF (deviation from the erratum's prose, forced
// by the adjudicated semantic): it still holds for WINDOW-level coverage — a period the
// metric's own source does not cover leaves every product unknown at once. It does NOT
// hold under PER-COMPANY degradation, which governs zero legality only: there, a product
// with rows in both periods is measured and RANKED, while a product with no rows in one
// of them is unknown there and unranked. So the two arrays CAN both be non-empty (the
// joint byte fitter in tools.ts handles that: ranked takes its share, unranked the
// measured remainder). What never happens is the thing the erratum exists to stop — a
// product being ranked on a base nobody measured.
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
  /** Either side unknown: the period is not fully covered at the WINDOW level (then every
   *  product lands here at once), or coverage is degraded per company and this product has
   *  no rows in that period (FD2-2 — its absence cannot be read as a zero). Citable as
   *  unknown-base, NEVER as growth. */
  unranked: ComparePeriodsProductRow[];
  /** Period-level reason vocabulary (the scalar mode's strings), shared by every
   *  unranked row because the cause is the SOURCE, not the product. */
  reasons: Record<string, string>;
  periodCoverage: { a: WindowCoverage; b: WindowCoverage };
  unequalLengths: boolean;
  /** FD2-2 disclosure, identical to the scalar mode's: the per-company starts + their
   *  sentence, present ONLY when the caller's companies do not share one. */
  companyCoverage?: Array<{ companyId: string; salesDataStart: string | null }>;
  companyCoverageNote?: string;
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
    // starts for a sales metric. A by_product row carrying a measured 0 under a staggered
    // membership is precisely the manufactured zero this rule exists to prevent, per
    // product — FD2-2: and precisely that, no more. A row with real sums in both periods
    // is still measured and still ranked.
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

  // The caller-wide classifications, asked separately from the degraded ones (FD2-2):
  // window-level coverage decides whether ANY value in the period is trustworthy;
  // per-company degradation decides only whether ABSENCE may be read as a zero.
  const callerWideA = classifyWindowCoverage(starts.dataStart, periodA.from);
  const callerWideB = classifyWindowCoverage(starts.dataStart, periodB.from);

  /** One product's value in ONE period, under that period's two classifications. */
  const valueOf = (
    coverage: WindowCoverage,
    callerWide: WindowCoverage,
    sums: Map<number, number>,
    productId: number,
  ): number | null => {
    // A fully-covered period turns absence into a MEASURED 0.
    if (coverage === "full") return sums.get(productId) ?? 0;
    // Degraded per company, source covers the window: a recorded sum stands, absence is
    // unknown. Never a manufactured zero standing in for a company that was not recording.
    if (callerWide === "full") return sums.get(productId) ?? null;
    // The window itself is outside the data — nothing in it is measurable.
    return null;
  };

  const ranked: ComparePeriodsProductRow[] = [];
  const unranked: ComparePeriodsProductRow[] = [];
  for (const productId of productIds) {
    const a = valueOf(coverageA, callerWideA, aByProduct, productId);
    const b = valueOf(coverageB, callerWideB, bByProduct, productId);
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
    ...companyCoverageDisclosure(starts),
    excludedUnapprovedProducts,
  };
}
