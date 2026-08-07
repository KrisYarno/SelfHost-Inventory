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
import { shrinkageReasonOf } from "@/lib/reports/metrics-contract";
import {
  approvalDisclosure,
  archivedCountOf,
  excludedUnapprovedProductCount,
  productIdentities,
  APPROVED_UNIVERSE_NOTE,
  type ApprovalDisclosure,
} from "@/lib/reports/outbound-mix";
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

/** Every movement mode (spec C4 / contract-pack T4). */
export type MovementMode = "series" | "receipts" | "by_product";

/** The effective filter echo carried by EVERY movement envelope variant (spec C4 /
 *  contract-pack T4). `mode` is the envelope's discriminant and `filters.mode` ALWAYS
 *  equals the envelope's own `mode` — a mismatched pair is a contract violation.
 *  `productIds` is the batch scope (null until Task 2.4 populates it).
 *
 *  G2-4: the mode is a TYPE PARAMETER, so each envelope pins its own literal and tsc
 *  rejects a mismatched pair at compile time. The equality used to be a convention three
 *  runtime tests policed; now the type system enforces it and the tests confirm it. */
export interface MovementFilters<M extends MovementMode> {
  productId: number | null;
  productIds: number[] | null;
  locationId: number | null;
  mode: M;
}

/**
 * The mode-BINDING envelope skeleton every movement variant is built on (T4 / G2-4
 * completed by FD-6). `MovementFilters<M>` alone pinned the INNER `mode` to whatever
 * literal each interface happened to declare — nothing tied it to the OUTER discriminant,
 * so an envelope could still be assembled (by hand, in the tool layer, where the receipts
 * variant lives) with `mode: "series"` beside a receipts filter echo and compile. Sharing
 * ONE type parameter across both makes `filters.mode === mode` a compile error to break.
 */
export interface MovementEnvelope<M extends MovementMode> {
  /** Envelope discriminant (spec C4 / T4). */
  mode: M;
  /** Effective-scope echo — its `mode` is the SAME parameter as the discriminant. */
  filters: MovementFilters<M>;
}

export interface MovementSeriesResult extends MovementEnvelope<"series"> {
  grain: "day" | "week" | "month";
  window: ResolvedWindow;
  points: Array<{ key: string } & MovementBuckets>;
  totals: MovementBuckets;
  coverage: {
    unclassifiedLegacyNote: string;
    reasonCodeNullRows: number;
    // G5 disclosure (spec C13). ALWAYS present since G2-3 made `approvedIds` required:
    // every caller of this read is on the assistant surface, so every result states the
    // universe it covers. A product-scoped call reports 0/0 — a true statement about a
    // scope that can hold nothing else — rather than omitting the claim.
    excludedUnapprovedProducts: number;
    archivedProductsIncluded: number;
    approvalNote: string;
  };
}

/** Fixed coverage note: legacy negative ADJUSTMENT is this shop's pre-Lane-4
 *  shipping record — unclassified outbound, NOT sales (spec §5 T-MOVE). */
const UNCLASSIFIED_LEGACY_NOTE =
  "Legacy negative ADJUSTMENT is how this shop shipped product pre-Lane-4 — " +
  "unclassified outbound, not classifiable as sales.";

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
      // OC-9 / FD-5 parity: the loss decision routes through the ONE shared rule
      // (`shrinkageReasonOf`, metrics-contract) exactly as outbound-mix.ts does, so the
      // two classifiers that both promise "never diverge" actually cannot.
      return shrinkageReasonOf(reasonCode) != null ? "classifiedLoss" : "adjustmentUnclassified";
    case "CORRECTION":
      if (delta > 0) return "correctionIn";
      return shrinkageReasonOf(reasonCode) != null ? "classifiedLoss" : "correctionUnclassified";
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
 * @param opts.approvedIds the G5 approved universe (spec C13). REQUIRED (G2-3): this
 *   function has NO web callers, so there is no legacy behavior to preserve and no reason
 *   for the trust-boundary filter to be forgettable. The product-scoped composite caller
 *   passes it too — its product is already approved, but "the caller checked" is an
 *   assumption the SQL boundary should not have to make.
 */
export async function getMovementSeries(opts: {
  productId?: number;
  locationId?: number;
  window: ResolvedWindow;
  grain: "day" | "week" | "month";
  approvedIds: number[];
}): Promise<MovementSeriesResult> {
  const { productId, locationId, window, grain, approvedIds } = opts;

  // The window predicate, stated ONCE: the ledger read below and the disclosure census
  // must agree about what "in this window" means, or the caveat describes a different
  // question than the answer.
  const windowPredicate = {
    changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
    ...(locationId != null ? { locationId } : {}),
  };

  // Map the inclusive day-key window to a half-open timestamp range
  // [start of `from`, start of the day after `to`). Same select/where shape as
  // lib/reports/demand.ts, but with NO delta/logType narrowing — the partition
  // is exhaustive, so every row in the window must be read.
  const rows = await prisma.inventory_logs.findMany({
    where: {
      ...windowPredicate,
      // productId (already approval-checked by the caller's resolver) and the approved-id
      // set narrow the SAME column, so they combine as one IntFilter rather than one
      // silently overwriting the other.
      productId: {
        ...(productId != null ? { equals: productId } : {}),
        in: approvedIds,
      },
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

  // Series points/totals carry NO product ids, so the archived half is the same
  // window-scoped census as the excluded half (spec G5, non-product grain).
  const disclosure = await approvalDisclosure({
    relation: "inventory_logs",
    some: windowPredicate,
    productId,
  });
  const coverage: MovementSeriesResult["coverage"] = {
    unclassifiedLegacyNote: UNCLASSIFIED_LEGACY_NOTE,
    reasonCodeNullRows,
    excludedUnapprovedProducts: disclosure.excludedUnapprovedProducts,
    archivedProductsIncluded: disclosure.archivedProductsIncluded,
    approvalNote: APPROVED_UNIVERSE_NOTE,
  };

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
    coverage,
  };
}

/** One STOCK_IN receipt row (W2-RCPT, spec §5 T-RCPT). `unitCostCents`/`batchId`
 *  relayed as-is — null means "no frozen cost/batch on this row", NEVER coerced
 *  to 0; `locationId` is nullable too (legacy null-location receipts exist). */
export interface ReceiptRow {
  productId: number;
  /** Identity (spec C13, seam S14): receipts used to be productId-only, which made an
   *  archived product's receipts indistinguishable from a live one's — and unreadable
   *  without a second call. Both come from the shared `productIdentities` lookup. */
  name: string | null;
  lifecycle: "active" | "deleted" | null;
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
  /** The G5 approved universe (spec C13). REQUIRED (G2-3) — no web callers, so the
   *  trust-boundary filter is never optional here. */
  approvedIds: number[];
}): Promise<DbPage<ReceiptRow> & { disclosure: ApprovalDisclosure }> {
  const { window, productId, locationId, byteBudget, approvedIds } = opts;
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
    productId: {
      ...(productId != null ? { equals: productId } : {}),
      in: approvedIds,
    },
    ...(locationId != null ? { locationId } : {}),
  };

  // Receipts is a DB-PAGED detail listing: the full matching set is never materialized,
  // so the archived count cannot come from result ids without describing one page as if
  // it were the whole answer. Both halves therefore use the window census, whose scope is
  // exactly this read's `where` (spec G5's contributor-census shape).
  const disclosure = await approvalDisclosure({
    relation: "inventory_logs",
    some: {
      logType: "STOCK_IN",
      delta: { gt: 0 },
      changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
      ...(locationId != null ? { locationId } : {}),
    },
    productId,
  });

  const page = await pageFromDb<ReceiptRow>({
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
      // Identities for THIS PAGE's products only — the listing is DB-paged, so a
      // catalog-wide identity read would fetch names for rows nobody asked for.
      const identities = await productIdentities((rows ?? []).map((r) => r.productId));
      return (rows ?? []).map((row) => ({
        productId: row.productId,
        name: identities.get(row.productId)?.name ?? null,
        lifecycle: identities.get(row.productId)?.lifecycle ?? null,
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
  return { ...page, disclosure };
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

export interface MovementByProductResult extends MovementEnvelope<"by_product"> {
  window: ResolvedWindow;
  rows: MovementProductRow[];
  coverage: {
    unclassifiedLegacyNote: string;
    reasonCodeNullRows: number;
    excludedUnapprovedProducts: number;
    archivedProductsIncluded: number;
    /** QA-1, mirroring get_sales' OC-2 shape: archived products present ONLY as a
     *  force-emitted all-zero row. Present on BOUNDED requests alone (nothing else can
     *  force a row), exactly as get_sales emits its sibling under includeZeroRows only. */
    archivedZeroRows?: number;
    approvalNote: string;
  };
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

  const windowPredicate = {
    changeTime: { gte: dayKeyStart(window.from), lt: nextDayStart(window.to) },
    ...(locationId != null ? { locationId } : {}),
  };

  // AGGREGATED DB-SIDE (review OC-6). The breakdown used to stream EVERY ledger row in
  // the window into memory to classify one at a time — the one unbounded read left on
  // this surface, and the one whose cost grows with history rather than with the answer.
  //
  // Two groupBys, not one, because the buckets are SIGNED: a (productId, logType,
  // reasonCode) group can hold both a shipment and its return, and a single group sum
  // would classify their NET — silently moving units between buckets (a -500/+500 SALE
  // pair would report 0 outbound instead of 500). Partitioning the window predicate by
  // SIGN makes every group's sum unambiguous, so a group sum classifies exactly as its
  // rows would have. Zero-delta rows are in NEITHER partition, which is the same "count
  // nowhere" rule the row loop applied. `_count` preserves the reasonCode-null ROW count,
  // which is a count of rows, not of units, and cannot be recovered from a sum.
  const [negativeGroups, positiveGroups] = await Promise.all([
    prisma.inventory_logs.groupBy({
      by: ["productId", "logType", "reasonCode"],
      where: { ...windowPredicate, productId: { in: idScope }, delta: { lt: 0 } },
      _sum: { delta: true },
      _count: true,
    }),
    prisma.inventory_logs.groupBy({
      by: ["productId", "logType", "reasonCode"],
      where: { ...windowPredicate, productId: { in: idScope }, delta: { gt: 0 } },
      _sum: { delta: true },
    }),
  ]);

  // `contributed` is set the moment a real group lands on a product (QA-1): it is what
  // separates a product whose facts moved these numbers from one that was force-emitted
  // as an all-zero row. It cannot be read back off the finished row — a product whose
  // only group is a +5/-5 SALE pair nets to 0 in a bucket the same way an untouched row
  // reads 0 — so it is recorded where the classification happens.
  const byProduct = new Map<
    number,
    { buckets: MovementBuckets; outboundUnits: number; contributed: boolean }
  >();
  const ensure = (productId: number) => {
    let entry = byProduct.get(productId);
    if (!entry) {
      entry = { buckets: emptyBuckets(), outboundUnits: 0, contributed: false };
      byProduct.set(productId, entry);
    }
    return entry;
  };
  // Requested products materialize FIRST, so a silent one is an all-zero row rather
  // than a missing one.
  if (productIds) for (const id of productIds) ensure(id);

  /** One (productId, logType, reasonCode) group, reduced to what the classifier reads. */
  type MovementGroup = {
    productId: number;
    logType: string;
    reasonCode: string | null;
    _sum: { delta: number | null };
    _count?: number | { _all?: number };
  };
  /** Rows behind a group — `_count: true` yields a number; a deep mock may yield the
   *  `{ _all }` object shape, and a missing count must read as 0, never NaN. */
  const rowsIn = (g: MovementGroup): number =>
    typeof g._count === "number" ? g._count : (g._count?._all ?? 0);

  let reasonCodeNullRows = 0;
  for (const g of (negativeGroups ?? []) as MovementGroup[]) {
    const delta = g._sum?.delta ?? 0;
    // Structurally impossible under `delta: { lt: 0 }` (a group of negative rows sums
    // negative); a stubbed read is the only way here, and it must not be classified.
    if (!(delta < 0)) continue;
    if ((g.logType === "ADJUSTMENT" || g.logType === "CORRECTION") && g.reasonCode == null) {
      reasonCodeNullRows += rowsIn(g);
    }
    const entry = ensure(g.productId);
    entry.contributed = true;
    entry.buckets[classify(g.logType, delta, g.reasonCode)] += delta;
    // Sign-first: the SAME predicate the outbound mixes use (delta < 0, not TRANSFER).
    if (g.logType !== "TRANSFER") entry.outboundUnits += Math.abs(delta);
  }
  for (const g of (positiveGroups ?? []) as MovementGroup[]) {
    const delta = g._sum?.delta ?? 0;
    if (!(delta > 0)) continue;
    const entry = ensure(g.productId);
    entry.contributed = true;
    entry.buckets[classify(g.logType, delta, g.reasonCode)] += delta;
  }

  const productRows: MovementProductRow[] = [];
  /** The two halves of the SAME rows, kept for the disclosure: products whose facts moved
   *  these numbers, and the force-emitted ones with no group in the window. */
  const contributingRows: MovementProductRow[] = [];
  const zeroRows: MovementProductRow[] = [];
  for (const [productId, entry] of Array.from(byProduct.entries())) {
    finalizeNet(entry.buckets);
    const identity = identities.get(productId);
    const row: MovementProductRow = {
      productId,
      name: identity?.name ?? null,
      lifecycle: identity?.lifecycle ?? null,
      outboundUnits: entry.outboundUnits,
      ...entry.buckets,
    };
    productRows.push(row);
    (entry.contributed ? contributingRows : zeroRows).push(row);
  }
  // Most-moved first; ties by productId so paging is deterministic.
  productRows.sort((a, b) => b.outboundUnits - a.outboundUnits || a.productId - b.productId);

  // PRODUCT-GRAIN disclosure (spec G5): the archived half is a JS count over the result's
  // own rows (they already carry the identities' `lifecycle`); only the excluded half —
  // unreachable from approved result ids by construction — needs the census. The census
  // MIRRORS the read's scope, so a bounded request never reports catalog-wide noise.
  //
  // QA-1 (get_sales' OC-2, mirrored here): `archivedProductsIncluded` counts
  // CONTRIBUTORS — products whose real facts moved these numbers — so the force-emitted
  // all-zero rows are excluded from it. A synthesized zero row proves the opposite of a
  // contribution, and folding it in made the count read as "N archived products' history
  // is in these figures" when the honest answer was 0. That population is disclosed
  // SEPARATELY (`archivedZeroRows`), so nothing is hidden by the correction.
  const excludedUnapprovedProducts = await excludedUnapprovedProductCount({
    relation: "inventory_logs",
    some: windowPredicate,
    productIds,
  });

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
    coverage: {
      unclassifiedLegacyNote: UNCLASSIFIED_LEGACY_NOTE,
      reasonCodeNullRows,
      excludedUnapprovedProducts,
      archivedProductsIncluded: archivedCountOf(contributingRows),
      // Only a BOUNDED request can force a row, so the sibling key rides exactly there —
      // the same "emitted with the mode that creates the population" rule get_sales uses.
      ...(productIds != null ? { archivedZeroRows: archivedCountOf(zeroRows) } : {}),
      approvalNote: APPROVED_UNIVERSE_NOTE,
    },
  };
}
