/**
 * lib/analytics/stock-asof.ts — data layer for the `get_stock_asof` assistant tool
 * (assistant toolsuite breadth, spec §5 T-ASOF REV-2 NARROWED).
 *
 * "What was my stock on day D?" answered EXACTLY and HONESTLY from
 * `ProductStockSnapshot` — the end-of-completed-day level table the nightly rebuild
 * writes. The narrowing that shapes this module (spec §5 T-ASOF, both adversarial
 * gates): the snapshot table has NO per-row validity marker, and a flagged rebuild
 * (a pair whose reconstruction went negative) is SKIPPED — its stale rows are
 * PRESERVED, never overwritten. So this module can only be truthful about three
 * things, and refuses to guess beyond them:
 *
 *  1. EXACT-DAY read. Stock on day D = SUM across locations of the (product, day=D)
 *     snapshot rows. A product with NO row for that day gets `units: null` +
 *     `reason: "no snapshot recorded for that day"` — NEVER a fabricated 0 (a product
 *     that genuinely had 0 on hand that day DOES have a row summing to 0, which is a
 *     real, distinct answer).
 *  2. seriesEndsAt = the product's MAX snapshot dayKey overall (across every location
 *     and day). `null` when the product has no snapshot rows at all.
 *  3. possiblyStale — a LABELED READ-TIME HEURISTIC, never a certainty. True when a
 *     product's `seriesEndsAt` lags the GLOBAL snapshot watermark: the product's
 *     series ends before the catalog frontier, so its rows MAY be the preserved output
 *     of a flagged rebuild (or the product simply stopped moving / was added late — we
 *     cannot tell which per row, so we only flag the possibility). The row carries
 *     nothing implying which. A real per-pair validity marker is REGISTERED follow-up
 *     work (spec §10).
 *
 * WATERMARK CHOICE (documented per spec §5 T-ASOF — "pick the honest one and
 * document"). The global snapshot watermark = the LATER (string-max) of:
 *   (a) MAX(dayKey) across the WHOLE snapshot table — the data's own frontier: the
 *       newest completed day ANY pair actually reached; and
 *   (b) the snapshots-job `analytics_rebuild_state.lastWindowTo` (a Char(10) dayKey) —
 *       the day the last rebuild INTENDED to bring the catalog current to, read the
 *       way lib/assistant/freshness.ts reads that same snapshots-job row.
 * Neither alone is fully honest: (a) alone under-flags the degenerate "every pair was
 * flagged this run" case (nothing new was written, so the frontier looks old and no
 * row is called stale even though all are); (b) alone under-flags a NARROW backfill
 * (its `to` is an old day, behind the healthy frontier) and is `null` on a
 * restored/pruned DB. The string-max of the two is robust in both directions, both
 * values are dayKeys directly comparable to `seriesEndsAt`, and both fall out of reads
 * this module already makes (the aggregate for dataStart, the rebuild-state row for
 * flaggedPairs). When both are absent the watermark is `null` and NO row is flagged
 * (there is no frontier to lag).
 *
 * Scope: approved, non-deleted products (the SAME predicate as lib/analytics/
 * valuation.ts). `productId` narrows to one product; an unknown/out-of-scope id yields
 * an empty page here — resolution + NOT_FOUND is the tool's job (W2-INT), mirroring
 * valuation.ts. Catalog mode paginates DB-side via `pageFromDb` (count = in-scope
 * product count; products fetched id-ascending for deterministic paging).
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { toDayKey, lastCompletedDayKey } from "@/lib/analytics/dates";
import { AppError } from "@/lib/error-handling";
import { pageFromDb, type DbPage } from "@/lib/assistant/tools";

/** The ONE reason string a null-units row carries (spec §5 T-ASOF — word for word).
 *  Used uniformly whether the product has no row for THAT day or no snapshots at all;
 *  the narrowing forbids flagged-vs-absent labeling (not derivable per row). */
export const NO_SNAPSHOT_REASON = "no snapshot recorded for that day";

/** Default page size when the caller (tests / direct calls) omits `limit`. The tool
 *  layer (W2-INT) always passes an explicit bound; this covers the ~80-product catalog
 *  in one page for a direct call. */
const DEFAULT_LIMIT = 100;

/** One as-of row (per product, summed across locations). `reason` is present ONLY when
 *  `units` is null. `possiblyStale` is a labeled heuristic (see module doc). */
export interface StockAsOfRow {
  productId: number;
  name: string | null;
  units: number | null;
  reason?: string;
  seriesEndsAt: string | null;
  possiblyStale: boolean;
}

/**
 * Global coverage the tool layer (W2-INT) needs to build its coverage block WITHOUT
 * re-querying (spec §5 T-ASOF item 5). All fields are GLOBAL (the snapshot table has no
 * company dimension) and computed once per call:
 *  - `dayKey`            — the validated as-of day, echoed.
 *  - `snapshotWatermark` — the dayKey the `possiblyStale` heuristic compares against.
 *  - `snapshotDataStart` — the earliest snapshot dayKey overall (analogous to
 *                          freshness.ts's `dataStarts.snapshotStart`).
 *  - `flaggedPairs`      — the snapshots-job flagged-pair count (labeled; a flagged
 *                          pair is why any single row MIGHT be stale).
 */
export interface StockAsOfCoverage {
  dayKey: string;
  snapshotWatermark: string | null;
  snapshotDataStart: string | null;
  flaggedPairs: number;
}

/**
 * The module's return shape: a `DbPage<StockAsOfRow>` (so it satisfies the declared
 * `Promise<DbPage<...>>` contract and W2-INT pages it exactly like every other list
 * tool) EXTENDED with the global `coverage` block. W2-INT reads `page.rows` for the
 * tool payload and `page.coverage` for the coverage envelope.
 */
export interface StockAsOfPage extends DbPage<StockAsOfRow> {
  coverage: StockAsOfCoverage;
}

/** Scope predicate — MUST match lib/analytics/valuation.ts (approved, non-deleted). */
type ProductScope = { deletedAt: null; approvalStatus: "APPROVED"; id?: number };

function productScope(productId?: number): ProductScope {
  return { deletedAt: null, approvalStatus: "APPROVED", ...(productId ? { id: productId } : {}) };
}

/** String-max of two nullable dayKeys ('YYYY-MM-DD' sorts chronologically). Nulls drop
 *  out; both null -> null. */
function laterDayKey(a: string | null | undefined, b: string | null | undefined): string | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return a >= b ? a : b;
}

/**
 * Validate the as-of dayKey and reject today/future. Format is checked with the SAME
 * round-trip convention as `isoDay` in lib/assistant/tools.ts (SEAM: that refine is
 * module-private there and not importable, so it is replicated here; W2-INT's zod
 * schema validates again at the tool boundary — this keeps the data layer safe for
 * direct calls/tests). All failures throw the same VALIDATION/400 AppError so the tool
 * surfaces one error shape.
 */
function assertCompletedDay(dayKey: string, now: Date): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new AppError("dayKey must be an ISO calendar day (YYYY-MM-DD)", "VALIDATION", 400);
  }
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || toDayKey(d) !== dayKey) {
    // e.g. 2026-02-30 — `new Date` silently rolls it to Mar 2, so the round-trip fails.
    throw new AppError("dayKey is not a valid calendar day", "VALIDATION", 400);
  }
  // Snapshots cover COMPLETED days only: today's live level lives in product_locations,
  // not a snapshot row, and future days do not exist. `> lastCompletedDayKey(now)`
  // rejects today and everything after it.
  if (dayKey > lastCompletedDayKey(now)) {
    throw new AppError("snapshots cover completed days only", "VALIDATION", 400);
  }
}

/**
 * As-of stock for a completed day D (spec §5 T-ASOF REV-2 NARROWED).
 *
 * @param now injected for testability — drives the today/future boundary. Defaults to
 *            the current instant.
 */
export async function getStockAsOf(
  opts: {
    dayKey: string;
    productId?: number;
    limit?: number;
    offset?: number;
    byteBudget: number;
  },
  now: Date = new Date(),
): Promise<StockAsOfPage> {
  assertCompletedDay(opts.dayKey, now);

  const dayKey = opts.dayKey;
  const scope = productScope(opts.productId);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const offset = opts.offset ?? 0;

  // ---- GLOBAL reads (once): watermark inputs + coverage. Both fall out of two reads. ----
  const [snapAgg, snapState] = await Promise.all([
    // Earliest + latest snapshot dayKey across the WHOLE table (global — no company col).
    prisma.productStockSnapshot.aggregate({ _min: { dayKey: true }, _max: { dayKey: true } }),
    // The snapshots-job rebuild-state row — read the SAME row lib/assistant/freshness.ts
    // reads for `flaggedPairs`, additionally taking `lastWindowTo` (the rebuild's intended
    // frontier) for the watermark. `findUnique` -> null on a restored/pruned DB.
    prisma.analyticsRebuildState.findUnique({
      where: { job: "snapshots" },
      select: { lastWindowTo: true, flaggedPairs: true },
    }),
  ]);

  const snapshotDataStart = snapAgg?._min?.dayKey ?? null;
  const maxSnapshotDay = snapAgg?._max?.dayKey ?? null;
  const snapshotWatermark = laterDayKey(maxSnapshotDay, snapState?.lastWindowTo ?? null);
  const flaggedPairs = snapState?.flaggedPairs ?? 0;

  const coverage: StockAsOfCoverage = {
    dayKey,
    snapshotWatermark,
    snapshotDataStart,
    flaggedPairs,
  };

  // ---- Paged, DB-side, per-product assembly (spec "never materialize" rule). ----
  const page = await pageFromDb<StockAsOfRow>({
    // count = in-scope product count (drives totalRows exactly; deterministic paging).
    count: () => prisma.product.count({ where: scope }),
    fetch: async (skip, take) => {
      const products = await prisma.product.findMany({
        where: scope,
        orderBy: { id: "asc" }, // deterministic paging
        skip,
        take,
        select: { id: true, name: true },
      });
      if (products.length === 0) return [];
      const ids = products.map((p) => p.id);

      const [daySums, seriesEnds] = await Promise.all([
        // Exact-day on-hand per product = SUM(quantity) over that product's day-D rows.
        // groupBy returns ONLY products that HAVE a day-D row, so absence => null + reason
        // (a real 0-on-hand day is a present row summing to 0 — kept distinct).
        prisma.productStockSnapshot.groupBy({
          by: ["productId"],
          where: { productId: { in: ids }, dayKey },
          _sum: { quantity: true },
        }),
        // The product's series end = MAX(dayKey) over ALL its snapshot rows (any day/loc).
        prisma.productStockSnapshot.groupBy({
          by: ["productId"],
          where: { productId: { in: ids } },
          _max: { dayKey: true },
        }),
      ]);

      const sumByProduct = new Map<number, number | null>();
      for (const g of daySums ?? []) sumByProduct.set(g.productId, g._sum?.quantity ?? null);
      const endByProduct = new Map<number, string | null>();
      for (const g of seriesEnds ?? []) endByProduct.set(g.productId, g._max?.dayKey ?? null);

      return products.map((p) => {
        const hasDayRow = sumByProduct.has(p.id);
        const units = hasDayRow ? sumByProduct.get(p.id) ?? null : null;
        const seriesEndsAt = endByProduct.get(p.id) ?? null;
        // Labeled heuristic: the product's series ends before the global frontier. Never
        // computed when there is no series (null end) or no frontier (null watermark).
        const possiblyStale =
          seriesEndsAt !== null && snapshotWatermark !== null && seriesEndsAt < snapshotWatermark;
        const row: StockAsOfRow = { productId: p.id, name: p.name, units, seriesEndsAt, possiblyStale };
        if (units === null) row.reason = NO_SNAPSHOT_REASON;
        return row;
      });
    },
    offset,
    limit,
    byteBudget: opts.byteBudget,
  });

  return { ...page, coverage };
}
