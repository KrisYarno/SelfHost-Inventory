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
 * A2 pack C7: the sales rebuild's run history (`salesRebuildState`) and the note order
 * figures carry when that history says they are materially stale (`salesFreshnessNote`).
 *
 * MUST stay Next-free (imported by the assistant-tool layer): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { approvedProductIds } from "@/lib/reports/outbound-mix";
import { classifyWindowCoverage, type WindowCoverage } from "@/lib/reports/metrics-contract";

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
   * product universe THE CALLING TOOL REPORTS ON (OC-4: archived-inclusive for the
   * historical get_sales, active-only for the current-state composites). null = this
   * caller has no attributed sales facts at all.
   * It is what makes "no attributed sales RECORDED (since <date>)" a legal sentence
   * where "no sales ever" never was.
   */
  salesDataStart: string | null;
  /**
   * PER-COMPANY first-fact days (OC-3), present ONLY when the caller's companies do NOT
   * share one start. `salesDataStart` is the EARLIEST across them, so a multi-membership
   * caller whose second company started recording last month would otherwise read a
   * window as fully covered for a company that has no data in most of it — and every
   * silence in that company's window would become a MEASURED zero. Presence of this
   * field IS the signal that the starts are staggered; the tool degrades coverage
   * accordingly (see `callerWindowCoverage`).
   *
   * FD-2: EVERY requested company appears here, including one with NO facts at all —
   * as `salesDataStart: null`. A company absent from the per-company read used to be
   * absent from this list too, so it silently INHERITED the recording company's start
   * and its window read as fully covered: exactly the manufactured-zero the per-company
   * rule exists to prevent, in the one case where nothing was ever recorded.
   *
   * A2 pack C8: each entry carries the company's `name` (null when the company row is
   * gone), so a reader is never handed a bare id.
   */
  companyCoverage?: CompanyCoverageEntry[];
}

/**
 * One per-company coverage entry (A2 pack C8). `name` is optional on INPUT — the prose
 * helpers below read an absent name exactly as a null one (the id fallback) — and
 * `salesDataStartsByCompany`, the only producer, always sets it.
 */
export interface CompanyCoverageEntry {
  companyId: string;
  salesDataStart: string | null;
  name?: string | null;
}

/** How company prose names a company (A2 pack C8): its name alone when known, else
 *  `company <id>` — never "name (id X)", and never an id where the name is known. */
export function companyLabel(entry: { companyId: string; name?: string | null }): string {
  return entry.name != null && entry.name !== "" ? entry.name : `company ${entry.companyId}`;
}

/** The extra sentence that rides with a staggered-start disclosure (OC-3). */
export const SALES_COMPANY_COVERAGE_NOTE =
  "coverage classified per company; the latest-starting company governs zero legality.";

/**
 * What degraded per-company coverage does and does NOT do (FD2-2), stated where a reader
 * meets a measured figure that a degraded window nevertheless produced.
 *
 * The degradation is a rule about SILENCE: absence cannot be read as zero when a company
 * was not recording. It is NOT a rule about the rows that WERE recorded — a sum over
 * them is a true statement about recorded facts, and withholding it would answer a
 * question about real sales with "unknown" while the facts sit in the table.
 */
export const SALES_COMPANY_COVERAGE_MEASURED_NOTE =
  "degraded coverage governs ZERO legality only: sums shown are MEASURED over the facts " +
  "that WERE recorded, while a period with no matching rows reads null + a reason " +
  "instead of 0.";

/**
 * WHICH companies degrade the window, NAMED (FD2-2 / FD2-3). A disclosure that says
 * "some company started later" sends the reader to look for a company it will not name;
 * the companies are already in hand, so they are said out loud — the companies with NO
 * recorded facts first (they degrade hardest), then the latest start among those that do
 * record (the day that actually governs zero legality).
 *
 * A2 pack C8: each company is named by its name alone (`companyLabel`); only a company
 * whose name is gone is said as `company <id>`.
 *
 * Empty/absent input yields "" — every caller only builds this string when the
 * degradation it describes is real.
 */
export function companyCoverageDetail(companyCoverage: CompanyCoverageEntry[] | undefined): string {
  const entries = companyCoverage ?? [];
  const silent = entries.filter((c) => c.salesDataStart == null).map(companyLabel);
  const starts = entries
    .map((c) => c.salesDataStart)
    .filter((day): day is string => day != null);
  const parts: string[] = [];
  if (silent.length > 0) {
    parts.push(`no sales data recorded for ${silent.join(", ")}`);
  }
  if (starts.length > 0) {
    parts.push(`latest company start ${starts.reduce((a, b) => (a >= b ? a : b))}`);
  }
  return parts.join("; ");
}

/**
 * WHY a window's silence is unknown, in get_sales' own words (A2 pack C4, A2-OCR2-17 /
 * A2-G2S-9) — extracted from get_sales' zero-row synthesis so the reorder order signal
 * states an unknown exactly as get_sales does, never in a new paraphrase. The same
 * three-way discrimination: no data at all / the WINDOW predates or straddles the data /
 * the window is covered caller-wide but a MEMBER COMPANY was not recording (named).
 *
 * Only the third sentence carries the per-company detail, and it never ships an empty
 * parenthesis: when the detail would be "" the sentence carries the rule alone.
 */
export function salesCoverageReason(
  salesDataStart: string | null,
  windowFrom: string,
  companyCoverage?: CompanyCoverageEntry[],
): string {
  // No truthful substitution exists for the starts-<date> template.
  if (salesDataStart == null) return "no attributed sales data recorded";
  if (classifyWindowCoverage(salesDataStart, windowFrom) === "full") {
    const detail = companyCoverageDetail(companyCoverage);
    return detail === ""
      ? `sales data is not recorded in every company for this window (${SALES_COMPANY_COVERAGE_NOTE})`
      : `sales data is not recorded in every company for this window ` +
          `(${detail}; ${SALES_COMPANY_COVERAGE_NOTE})`;
  }
  return `window predates/straddles sales data (starts ${salesDataStart})`;
}

/**
 * The caller-scoped windowCoverage (OC-3). `salesDataStart` alone classifies the EARLIEST
 * company's coverage; when the caller's companies start at DIFFERENT days, the window is
 * only fully covered if the LATEST-starting one covers it too — so a staggered caller
 * degrades to "partial" and its zero rows stay null-with-a-reason instead of being
 * manufactured as measured zeros for a company that was not recording yet.
 */
export function callerWindowCoverage(
  coverage: Pick<CallerScopedSalesCoverage, "salesDataStart" | "companyCoverage">,
  windowFrom: string,
): WindowCoverage {
  const base = classifyWindowCoverage(coverage.salesDataStart, windowFrom);
  const perCompany = coverage.companyCoverage;
  if (base !== "full" || perCompany == null || perCompany.length === 0) return base;
  // FD-2: a company with NO facts has no start that could cover anything, so it degrades
  // the set to "partial" — NOT to "none" (the caller-wide source really does cover the
  // window for at least one company, and claiming otherwise would be its own lie).
  if (perCompany.some((c) => c.salesDataStart == null)) return "partial";
  const starts = perCompany.map((c) => c.salesDataStart as string);
  const latest = starts.reduce((a, b) => (a >= b ? a : b));
  return classifyWindowCoverage(latest, windowFrom);
}

/** Per-company first-fact days plus the caller-wide minimum (OC-3 / FD-2). */
export interface SalesDataStarts {
  /** The EARLIEST start across the caller's companies; null when none recorded. */
  salesDataStart: string | null;
  /** EVERY requested company, in id order — a company with no facts carries null. A2 C8:
   *  `name` is the company's name, null when its row is gone. */
  perCompany: Array<{ companyId: string; salesDataStart: string | null; name: string | null }>;
  /** True when the companies do NOT share one start (a null start counts as different). */
  staggered: boolean;
}

/**
 * `_min(dayKey)` over ProductSalesFact for a caller's companies, BOTH caller-wide and
 * PER COMPANY, over ONE fact scope (OC-3 / FD-2 / seam S8).
 *
 * Exported because `compare_periods` classifies the same sales sources against the same
 * windows: if it kept using the caller-wide minimum alone, a staggered caller would read
 * a period as fully covered — and every per-product silence in the late company's window
 * would become a measured 0 in one tool and a null in the other, over one seeded source.
 *
 * `scopeWhere` is the CALLER's own narrowing (approved-id set, optional productId). The
 * company predicate is applied HERE and cannot be widened by a caller.
 *
 * A2 pack C8: the names are read here too — one `company.findMany` over exactly the
 * requested ids (the caller's own companies; `{ id, name }` only), so every
 * `companyCoverage` array built from this carries them.
 */
export async function salesDataStartsByCompany(
  companyIds: string[],
  scopeWhere: Prisma.ProductSalesFactWhereInput = {},
): Promise<SalesDataStarts> {
  if (companyIds.length === 0) return { salesDataStart: null, perCompany: [], staggered: false };
  const where: Prisma.ProductSalesFactWhereInput = {
    ...scopeWhere,
    companyId: { in: companyIds },
  };
  const [row, groups, companies] = await Promise.all([
    prisma.productSalesFact.aggregate({ where, _min: { dayKey: true } }),
    // PER-COMPANY starts (OC-3): the earliest day alone cannot tell a caller whose second
    // company started recording last month that half their window is uncovered there.
    prisma.productSalesFact.groupBy({
      by: ["companyId"],
      where,
      _min: { dayKey: true },
    }) as unknown as Promise<Array<{ companyId: string; _min: { dayKey: string | null } }>>,
    prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true } }),
  ]);
  // Guards a deep-mocked prisma returning undefined (as the tool layer's name helpers do).
  const names = new Map<string, string>((companies ?? []).map((c) => [c.id, c.name]));
  const found = new Map<string, string | null>(
    (groups ?? []).map((g) => [g.companyId, g?._min?.dayKey ?? null]),
  );
  // FD-2: MATERIALIZE every requested company. The read only returns companies that HAVE
  // facts, so a silent company used to vanish from the disclosure entirely and inherit
  // the recording company's start.
  const perCompany = Array.from(new Set(companyIds))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((companyId) => ({
      companyId,
      salesDataStart: found.get(companyId) ?? null,
      name: names.get(companyId) ?? null,
    }));
  // "Staggered" = the companies do not share ONE start. A null start (no facts at all) is
  // a DIFFERENT start, not an absent one: it is the strongest possible degradation.
  const staggered =
    perCompany.length > 1 &&
    perCompany.some((g) => g.salesDataStart !== perCompany[0].salesDataStart);
  return { salesDataStart: row?._min?.dayKey ?? null, perCompany, staggered };
}

/**
 * Which approved universe `salesDataStart` is measured over (OC-4 / G2-2). It MUST match
 * the universe of the totals it is relayed beside: a start date drawn from a product the
 * figures exclude describes a window the figures never covered — and windowCoverage is
 * derived from it, so the mismatch decides whether an absent product reads as a MEASURED
 * zero. Default archived-inclusive (get_sales, the historical reader).
 */
export interface SalesCoverageScope {
  includeArchived?: boolean;
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
  scope: SalesCoverageScope = {},
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
    scopedSalesDataStart(companyIds, scope),
  ]);

  return {
    unattributedOrders: unattributedOrders ?? 0,
    totalOrders: totalOrders ?? 0,
    attributionNote: SALES_ATTRIBUTION_NOTE,
    bundleRevenue: BUNDLE_REVENUE_DISCLOSURE,
    lastRebuildAt: rebuildState?.lastRunAt ? rebuildState.lastRunAt.toISOString() : null,
    salesDataStart: salesDataStart.salesDataStart,
    ...(salesDataStart.staggered ? { companyCoverage: salesDataStart.perCompany } : {}),
  };
}

/**
 * The sales rebuild's state as order figures need it (A2 pack C7): when the last
 * SUCCESSFUL rebuild finished, and whether a newer attempt did not succeed.
 */
export interface SalesRebuildState {
  /** The newest SUCCEEDED run's `finishedAt` (ISO UTC) — the same clock as
   *  `lastRunAt` — or null when no successful run is on record. */
  lastSucceededAt: string | null;
  /** A FAILED or ABORTED run (lock-held skips excluded) started after that success. */
  latestAttemptFailedAfterSuccess: boolean;
  /** A2 pack C14 (internal): the same success's `startedAt` (ISO UTC), or null. A run that
   *  started on day D re-read every order updated before it, so D−1 is the last day whose
   *  sales are complete — compare_periods measures its per-day figures through it. Never
   *  shown to the model (`get_data_freshness` relays `lastSucceededAt` only). */
  lastSucceededStartedAt: string | null;
}

/** How many of the newest sales runs `salesRebuildState` reads (A2 pack C7). */
// 50, not 10 (orchestrator, M4 review): lock-held skips are filtered in JS AFTER the read,
// so a burst of contended triggers must not push the last success out of the window.
// Retention keeps the newest 100 runs per job (rebuild-lock.ts), so 50 is always held.
const SALES_REBUILD_RUNS_READ = 50;

/** A run that never started because another held the lock — not an attempt. */
const LOCK_HELD_SKIP = "lock-held";

/**
 * The sales rebuild state (A2 pack C7), from the newest 10 `analyticsRebuildRun` rows of
 * the "sales" job. The lock-held skips are filtered HERE, in JS: a Prisma
 * `{ not: 'lock-held' }` compiles to SQL `<>`, which also drops every FAILED run (their
 * `skippedReason` is NULL) — the very rows this read exists to see (A2-G1R3-3).
 *
 * `lastSucceededAt` is the success's `finishedAt`, never its `startedAt`: `lastRunAt`
 * (finalizeRebuildRun's stamp) is a finish time, so the two read on one clock
 * (A2-G1R3-2). Global, not company-sensitive (like `lastRebuildAt`).
 */
export async function salesRebuildState(): Promise<SalesRebuildState> {
  const runs = await prisma.analyticsRebuildRun.findMany({
    where: { job: "sales" },
    orderBy: { startedAt: "desc" },
    take: SALES_REBUILD_RUNS_READ,
    select: { status: true, startedAt: true, finishedAt: true, skippedReason: true },
  });
  // Guards a deep-mocked prisma returning undefined (as the tool layer's name helpers do).
  const attempts = (runs ?? []).filter((run) => run.skippedReason !== LOCK_HELD_SKIP);
  const success = attempts.find((run) => run.status === "SUCCEEDED" && run.finishedAt != null);
  if (!success) {
    return { lastSucceededAt: null, latestAttemptFailedAfterSuccess: false, lastSucceededStartedAt: null };
  }
  const latestAttemptFailedAfterSuccess = attempts.some(
    (run) =>
      (run.status === "FAILED" || run.status === "ABORTED") &&
      run.startedAt.getTime() > success.startedAt.getTime(),
  );
  return {
    lastSucceededAt: (success.finishedAt as Date).toISOString(),
    latestAttemptFailedAfterSuccess,
    lastSucceededStartedAt: success.startedAt.toISOString(),
  };
}

/** Past this, the last successful rebuild is materially stale (A2 pack C7): the nightly
 *  run plus a margin, so an ordinary day never raises the note. */
const SALES_FRESHNESS_STALE_MS = 26 * 60 * 60 * 1000;

/**
 * The sales-freshness note (A2 pack C7) — MATERIAL staleness only: no successful rebuild
 * on record, the last success finished more than 26 hours ago, or a newer attempt did
 * not succeed. Undefined otherwise: today's figures being partial is a standing sentence
 * in the descriptions, never a note on every answer.
 */
export function salesFreshnessNote(state: SalesRebuildState, now: Date): string | undefined {
  const failed = state.latestAttemptFailedAfterSuccess;
  let note: string | undefined;
  if (state.lastSucceededAt === null) {
    note = "No successful sales rebuild is on record — order figures may be missing.";
  } else if (now.getTime() - new Date(state.lastSucceededAt).getTime() > SALES_FRESHNESS_STALE_MS) {
    note =
      `The last successful sales rebuild finished at ${state.lastSucceededAt}, more than a day ` +
      `ago; orders recorded after that are not counted yet.`;
  } else if (failed) {
    return (
      `The latest sales rebuild attempt did not succeed; figures are as of the last successful ` +
      `rebuild, finished at ${state.lastSucceededAt}.`
    );
  }
  if (note !== undefined && failed) note += " The latest rebuild attempt did not succeed.";
  return note;
}

/**
 * `_min(dayKey)` over ProductSalesFact for this caller's companies (spec C6), PLUS the
 * same minimum per company (OC-3).
 *
 * G5 FROM BIRTH (plan G4/G5, gate cluster A): this is a NEW read, so it carries the
 * APPROVED-id-set filter from the start — an unapproved product's facts must never move
 * `salesDataStart`, not even in the window between this task and Task 3.1's retrofit of
 * the pre-existing reads. Archived-but-approved products are included by DEFAULT (this is
 * a HISTORICAL fact read for get_sales, and their past sales really did happen); a
 * CURRENT-STATE caller passes `includeArchived: false` so its start date is measured over
 * exactly the population its totals sum (OC-4 / G2-2).
 *
 * The id set is ALWAYS applied, even when empty: an empty approved universe must read
 * as "no facts in scope" (`in: []` matches nothing), never as an unfiltered read.
 */
async function scopedSalesDataStart(
  companyIds: string[],
  scope: SalesCoverageScope,
): Promise<SalesDataStarts> {
  const approvedIds = await approvedProductIds({
    includeArchived: scope.includeArchived ?? true,
  });
  return salesDataStartsByCompany(companyIds, { productId: { in: approvedIds } });
}
