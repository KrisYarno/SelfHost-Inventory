/**
 * lib/reports/movement.ts — the ONE movement-series module: an EXHAUSTIVE,
 * MUTUALLY-EXCLUSIVE partition of the inventory ledger (assistant toolsuite
 * breadth, spec §5 T-MOVE REV-2 buckets; W1-MOVE, W2-RCPT extends).
 *
 * Every `inventory_logs` row in the window lands in EXACTLY ONE bucket, keyed by
 * logType × sign:
 *   inbound   { stockIn, correctionIn, adjustmentIn, countIn }        (delta > 0)
 *   outbound  { sale, classifiedLoss, adjustmentUnclassified,
 *               correctionUnclassified, countOut }                    (delta < 0)
 *   transfers { transferIn, transferOut }                             (kept separate)
 *
 * `classifiedLoss` is the reason-coded subset of NEGATIVE ADJUSTMENT/CORRECTION
 * whose reasonCode is in SHRINKAGE_CLASS_REASONS (DAMAGE/THEFT/EXPIRY/COUNT — the
 * shared shrinkage set from lib/reports/metrics-contract). A DAMAGE-reasoned negative
 * ADJUSTMENT is classifiedLoss ONLY — never also adjustmentUnclassified.
 *
 * NORMATIVE INVARIANT (reconciliation test): `net === SUM(delta)` over EVERY
 * bucket including transfers. Because the partition is total and each bucket is a
 * signed sum of deltas, the 11 buckets always re-add to the window's true net
 * inventory change.
 *
 * STOCK_IN / SALE are keyed by logType alone (their natural direction). A rare
 * wrong-signed row (a receipt reversal posted as negative STOCK_IN, a return
 * posted as positive SALE) folds into the SAME bucket rather than becoming
 * homeless — a deliberate choice so `net === SUM(delta)` stays exact. Zero-delta
 * rows count NOWHERE: they add 0 to net, so excluding them honors the "count
 * nowhere" rule literally without disturbing the invariant.
 *
 * Transfers are NOT netted locally: transferIn and transferOut are always
 * reported separately, so a location-scoped read shows a lone leg (not a cancelled
 * 0) and an unscoped read shows +N/-N (not one collapsed 0). Only a caller may
 * choose to net them at the global grain.
 *
 * MUST stay Next-free (imported by report + assistant-tool layers): no `next/*`,
 * no `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { dayKeyStart, nextDayStart, toDayKey } from "@/lib/analytics/dates";
import { weekStartKey, monthKey, byStringKey } from "@/lib/analytics/date-grain";
import type { ResolvedWindow } from "@/lib/assistant/window";
import { SHRINKAGE_CLASS_REASONS } from "@/lib/reports/metrics-contract";
import { pageFromDb, type DbPage } from "@/lib/assistant/tools";

/** getReceipts default page size when the caller omits `limit` (spec §5 T-RCPT). */
const RECEIPTS_DEFAULT_LIMIT = 50;

export interface MovementBuckets {
  stockIn: number;
  correctionIn: number;
  adjustmentIn: number;
  countIn: number;
  sale: number;
  classifiedLoss: number;
  adjustmentUnclassified: number;
  correctionUnclassified: number;
  countOut: number;
  transferIn: number;
  transferOut: number;
  net: number;
}

/** The effective filter echo carried by EVERY movement envelope variant (spec C4 /
 *  contract-pack T4). `mode` is the envelope's discriminant and `filters.mode` ALWAYS
 *  equals the envelope's own `mode` — a mismatched pair is a contract violation.
 *  `productIds` is the batch scope (null until Task 2.4 populates it). */
export interface MovementFilters {
  productId: number | null;
  productIds: number[] | null;
  locationId: number | null;
  mode: "series" | "receipts" | "by_product";
}

export interface MovementSeriesResult {
  /** Envelope discriminant (spec C4 / T4). The receipts envelope is assembled in the
   *  tool layer and carries `mode: "receipts"`. */
  mode: "series";
  grain: "day" | "week" | "month";
  window: ResolvedWindow;
  filters: MovementFilters;
  points: Array<{ key: string } & MovementBuckets>;
  totals: MovementBuckets;
  coverage: { unclassifiedLegacyNote: string; reasonCodeNullRows: number };
}

/** Fixed coverage note: legacy negative ADJUSTMENT is this shop's pre-Lane-4
 *  shipping record — unclassified outbound, NOT sales (spec §5 T-MOVE). */
const UNCLASSIFIED_LEGACY_NOTE =
  "Legacy negative ADJUSTMENT is how this shop shipped product pre-Lane-4 — " +
  "unclassified outbound, not classifiable as sales.";

/** Shrinkage-class reasons as a membership set (shared with queries.ts). */
const SHRINKAGE_SET: ReadonlySet<string> = new Set(SHRINKAGE_CLASS_REASONS as readonly string[]);

/** The 11 signed-sum buckets (everything except the derived `net`). */
const BUCKET_KEYS = [
  "stockIn", "correctionIn", "adjustmentIn", "countIn",
  "sale", "classifiedLoss", "adjustmentUnclassified", "correctionUnclassified", "countOut",
  "transferIn", "transferOut",
] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];

function emptyBuckets(): MovementBuckets {
  return {
    stockIn: 0, correctionIn: 0, adjustmentIn: 0, countIn: 0,
    sale: 0, classifiedLoss: 0, adjustmentUnclassified: 0, correctionUnclassified: 0, countOut: 0,
    transferIn: 0, transferOut: 0, net: 0,
  };
}

/** `net` is DERIVED — the sum of the 11 buckets — so it can never disagree. */
function finalizeNet(b: MovementBuckets): void {
  b.net = BUCKET_KEYS.reduce((s, k) => s + b[k], 0);
}

/** Grain bucket key for a row's timestamp: day 'YYYY-MM-DD', week Monday key,
 *  month 'YYYY-MM'. weekStartKey/monthKey are the SHARED date-grain helpers
 *  (lib/analytics/date-grain) — the PRE-W3 dedup replaced this module's verbatim
 *  weekStartKey copy and inline month slice with those imports. */
function grainKey(grain: MovementSeriesResult["grain"], changeTime: Date): string {
  const dayKey = toDayKey(changeTime);
  if (grain === "week") return weekStartKey(dayKey);
  if (grain === "month") return monthKey(dayKey);
  return dayKey;
}

/**
 * Total classifier: every non-zero row maps to EXACTLY ONE bucket. logType is the
 * primary key; sign splits the four sign-ambiguous logTypes; the reason lookup
 * only runs for negative ADJUSTMENT/CORRECTION (so a negative ADJUSTMENT reasoned
 * 'COUNT' is classifiedLoss, while a COUNT-logType row is always count*).
 */
function classify(logType: string, delta: number, reasonCode: string | null): BucketKey {
  switch (logType) {
    case "STOCK_IN":
      return "stockIn";
    case "SALE":
      return "sale";
    case "TRANSFER":
      return delta > 0 ? "transferIn" : "transferOut";
    case "COUNT":
      return delta > 0 ? "countIn" : "countOut";
    case "ADJUSTMENT":
      if (delta > 0) return "adjustmentIn";
      return reasonCode != null && SHRINKAGE_SET.has(reasonCode) ? "classifiedLoss" : "adjustmentUnclassified";
    case "CORRECTION":
      if (delta > 0) return "correctionIn";
      return reasonCode != null && SHRINKAGE_SET.has(reasonCode) ? "classifiedLoss" : "correctionUnclassified";
    default:
      // Unreachable (logType is enum-constrained). Fold into the adjustment
      // buckets rather than drop the row, so `net === SUM(delta)` still holds.
      return delta > 0 ? "adjustmentIn" : "adjustmentUnclassified";
  }
}

/**
 * Movement series over a RESOLVED window. The tool layer parses from/to/
 * relativeDays and validates productId; this reads the ledger and partitions.
 *
 * @param opts.window  already-resolved day-key window (lib/assistant/window).
 * @param opts.grain   day | week | month bucketing.
 * @param opts.productId  optional single-product scope (pre-validated).
 * @param opts.locationId optional location scope.
 */
export async function getMovementSeries(opts: {
  productId?: number;
  locationId?: number;
  window: ResolvedWindow;
  grain: "day" | "week" | "month";
}): Promise<MovementSeriesResult> {
  const { productId, locationId, window, grain } = opts;

  // Map the inclusive day-key window to a half-open timestamp range
  // [start of `from`, start of the day after `to`). Same select/where shape as
  // lib/reports/demand.ts, but with NO delta/logType narrowing — the partition
  // is exhaustive, so every row in the window must be read.
  const rows = await prisma.inventory_logs.findMany({
    where: {
      changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
      ...(productId != null ? { productId } : {}),
      ...(locationId != null ? { locationId } : {}),
    },
    select: { delta: true, changeTime: true, logType: true, reasonCode: true },
  });

  const pointMap = new Map<string, MovementBuckets>();
  const totals = emptyBuckets();
  let reasonCodeNullRows = 0;

  for (const row of rows) {
    // Zero-delta rows count NOWHERE: 0 into any bucket and 0 into net, so
    // skipping them keeps net === SUM(delta) exact and honors "count nowhere".
    if (row.delta === 0) continue;

    // Coverage: negative ADJUSTMENT/CORRECTION with no reasonCode — the legacy
    // unclassified-outbound rows (row COUNT, independent of bucketing).
    if (
      row.delta < 0 &&
      (row.logType === "ADJUSTMENT" || row.logType === "CORRECTION") &&
      row.reasonCode == null
    ) {
      reasonCodeNullRows += 1;
    }

    const bucket = classify(row.logType, row.delta, row.reasonCode);
    const key = grainKey(grain, row.changeTime);
    let point = pointMap.get(key);
    if (point == null) {
      point = emptyBuckets();
      pointMap.set(key, point);
    }
    point[bucket] += row.delta;
    totals[bucket] += row.delta;
  }

  finalizeNet(totals);
  const points = Array.from(pointMap.entries())
    .sort(([a], [b]) => byStringKey(a, b))
    .map(([key, b]) => {
      finalizeNet(b);
      return { key, ...b };
    });

  return {
    mode: "series",
    grain,
    window,
    // Effective-scope echo (spec C4): what this series ACTUALLY covers, so a
    // single-product series can never be read as a catalog-wide one.
    filters: {
      productId: productId ?? null,
      productIds: null,
      locationId: locationId ?? null,
      mode: "series",
    },
    points,
    totals,
    coverage: { unclassifiedLegacyNote: UNCLASSIFIED_LEGACY_NOTE, reasonCodeNullRows },
  };
}

/** One STOCK_IN receipt row (W2-RCPT, spec §5 T-RCPT). `unitCostCents`/`batchId`
 *  relayed as-is — null means "no frozen cost/batch on this row", NEVER coerced
 *  to 0; `locationId` is nullable too (legacy null-location receipts exist). */
export interface ReceiptRow {
  productId: number;
  locationId: number | null;
  quantity: number;
  unitCostCents: number | null;
  batchId: string | null;
  changeTime: string;
}

/**
 * Receipts DETAIL over a resolved window: STOCK_IN rows with delta > 0 (a REAL
 * receipt — the where clause excludes wrong-signed STOCK_IN server-side, unlike
 * getMovementSeries's stockIn bucket, which folds a wrong-signed row into the
 * same logType-keyed signed sum so its `net === SUM(delta)` invariant holds. A
 * detail listing has no such invariant to protect, so it filters to the real
 * thing instead).
 *
 * DB-side skip/take + count paging via the shared `pageFromDb` (spec §5 T-RCPT
 * REV-2 — never materialize the full event history to slice in memory): `count`
 * runs an exact `prisma.inventory_logs.count` under the SAME where as `fetch`'s
 * `findMany({ skip, take })`, ordered NEWEST-first (`changeTime desc, id desc`
 * for determinism when many rows share a changeTime).
 *
 * Same half-open changeTime boundary convention as getMovementSeries:
 * [start of `from`, start of the day after `to`).
 */
export async function getReceipts(opts: {
  window: ResolvedWindow;
  productId?: number;
  locationId?: number;
  limit?: number;
  offset?: number;
  byteBudget: number;
}): Promise<DbPage<ReceiptRow>> {
  const { window, productId, locationId, byteBudget } = opts;
  const limit = opts.limit ?? RECEIPTS_DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  // W2 seam-fix item 2: `locationId` is threaded into the where clause so a
  // location-scoped receipts request is actually narrowed (it was silently
  // dropped before, returning the global receipt list). `count` and `findMany`
  // share this one `where`, so both are narrowed identically.
  const where = {
    logType: "STOCK_IN" as const,
    delta: { gt: 0 },
    changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
    ...(productId != null ? { productId } : {}),
    ...(locationId != null ? { locationId } : {}),
  };

  return pageFromDb<ReceiptRow>({
    count: () => prisma.inventory_logs.count({ where }),
    fetch: async (skip, take) => {
      const rows = await prisma.inventory_logs.findMany({
        where,
        orderBy: [{ changeTime: "desc" }, { id: "desc" }],
        skip,
        take,
        select: {
          productId: true,
          locationId: true,
          delta: true,
          unitCostCents: true,
          batchId: true,
          changeTime: true,
        },
      });
      return (rows ?? []).map((row) => ({
        productId: row.productId,
        locationId: row.locationId,
        quantity: row.delta,
        unitCostCents: row.unitCostCents,
        batchId: row.batchId,
        changeTime: row.changeTime.toISOString(),
      }));
    },
    offset,
    limit,
    byteBudget,
  });
}

// ---------------------------------------------------------------------------
// PER-PRODUCT breakdown (spec C10). The series above answers "what moved, when";
// this answers "WHICH products moved" in ONE call — the alternative was looping a
// per-product tool over the catalog (review #3's F7).
// ---------------------------------------------------------------------------

/** One product's full signed window partition, plus the ranking key. */
export interface MovementProductRow extends MovementBuckets {
  productId: number;
  name: string | null;
  lifecycle: "active" | "deleted" | null;
  /**
   * SIGN-FIRST outbound magnitude (spec C10 / G3): the summed |delta| of this product's
   * NEGATIVE non-TRANSFER rows — the same population the outbound mixes classify. It is
   * the RANK key, exposed so the ordering is auditable rather than asserted. A positive
   * SALE row (a return) can never cancel outbound here, which is exactly the point: a
   * product that shipped 500 and took 500 back still MOVED 500 out.
   */
  outboundUnits: number;
}

export interface MovementByProductResult {
  mode: "by_product";
  window: ResolvedWindow;
  filters: MovementFilters;
  rows: MovementProductRow[];
  coverage: { unclassifiedLegacyNote: string; reasonCodeNullRows: number };
}

/**
 * Per-product movement over a RESOLVED window.
 *
 * @param opts.productIds  the ALREADY-RESOLVED bounded set (visibility-checked by the
 *   caller's batch resolver). Each one gets a row even with NO ledger activity — an
 *   all-zero row is the honest answer to "how much did X move?", and it is what makes
 *   "0 deductions recorded" answerable in one call instead of an ambiguous absence.
 * @param opts.approvedIds the G5 approved universe for the CATALOG-WIDE case (no
 *   productIds). Applied at the SQL boundary so an unapproved product never contributes
 *   to a row nor to the coverage counts.
 * @param opts.identities  name/lifecycle for the rows (the shared T2 lookup).
 */
export async function getMovementByProduct(opts: {
  window: ResolvedWindow;
  locationId?: number;
  productIds?: number[];
  approvedIds: number[];
  identities: Map<number, { name: string; lifecycle: "active" | "deleted" }>;
}): Promise<MovementByProductResult> {
  const { window, locationId, productIds, approvedIds, identities } = opts;
  // A bounded request reads exactly its resolved ids; a catalog-wide one reads the
  // approved universe. Either way the id set is EXPLICIT — never raw caller input.
  const idScope = productIds ?? approvedIds;

  const rows = await prisma.inventory_logs.findMany({
    where: {
      changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
      productId: { in: idScope },
      ...(locationId != null ? { locationId } : {}),
    },
    // The breakdown needs productId beside the classifier's inputs (spec C10).
    select: { productId: true, delta: true, logType: true, reasonCode: true },
  });

  const byProduct = new Map<number, { buckets: MovementBuckets; outboundUnits: number }>();
  const ensure = (productId: number) => {
    let entry = byProduct.get(productId);
    if (!entry) {
      entry = { buckets: emptyBuckets(), outboundUnits: 0 };
      byProduct.set(productId, entry);
    }
    return entry;
  };
  // Requested products materialize FIRST, so a silent one is an all-zero row rather
  // than a missing one.
  if (productIds) for (const id of productIds) ensure(id);

  let reasonCodeNullRows = 0;
  for (const row of rows ?? []) {
    if (row.delta === 0) continue; // counts NOWHERE (same rule as the series)
    if (
      row.delta < 0 &&
      (row.logType === "ADJUSTMENT" || row.logType === "CORRECTION") &&
      row.reasonCode == null
    ) {
      reasonCodeNullRows += 1;
    }
    const entry = ensure(row.productId);
    entry.buckets[classify(row.logType, row.delta, row.reasonCode)] += row.delta;
    // Sign-first: the SAME predicate the outbound mixes use (delta < 0, not TRANSFER).
    if (row.delta < 0 && row.logType !== "TRANSFER") entry.outboundUnits += Math.abs(row.delta);
  }

  const productRows: MovementProductRow[] = Array.from(byProduct.entries()).map(
    ([productId, entry]) => {
      finalizeNet(entry.buckets);
      const identity = identities.get(productId);
      return {
        productId,
        name: identity?.name ?? null,
        lifecycle: identity?.lifecycle ?? null,
        outboundUnits: entry.outboundUnits,
        ...entry.buckets,
      };
    },
  );
  // Most-moved first; ties by productId so paging is deterministic.
  productRows.sort((a, b) => b.outboundUnits - a.outboundUnits || a.productId - b.productId);

  return {
    mode: "by_product",
    window,
    filters: {
      productId: null,
      productIds: productIds ?? null,
      locationId: locationId ?? null,
      mode: "by_product",
    },
    rows: productRows,
    coverage: { unclassifiedLegacyNote: UNCLASSIFIED_LEGACY_NOTE, reasonCodeNullRows },
  };
}
