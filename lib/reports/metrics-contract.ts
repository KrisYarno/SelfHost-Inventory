/**
 * lib/reports/metrics-contract.ts — the SINGLE home for the movement predicates,
 * the days-covered denominator, and the definition strings (assistant toolsuite
 * breadth, spec §2 D1-D5).
 *
 * Before this module the two outbound predicates and the days-covered math lived in
 * lib/reports/demand.ts, and reorder.ts / queries.ts carried their own copies of the
 * definition prose. This module is the one place they are defined; demand.ts,
 * reorder.ts, low-stock.ts, queries.ts, and every tool consume it so identical
 * concepts use identical math everywhere (G3).
 *
 * There are exactly TWO outbound predicates (spec §2 D1). No caller defines its own:
 *   - physicalOutbound = `delta < 0 AND logType != TRANSFER` (corrections INCLUDED —
 *     they deplete). The units-out velocity source of truth.
 *   - reorderDemand    = the EXISTING LOCKED predicate moved verbatim from demand.ts:
 *     `delta < 0 AND logType != TRANSFER AND (reasonCode IS NULL OR reasonCode !=
 *     'CORRECTION')` — reasonCode-based, NOT logType-based.
 *
 * MUST stay Next-free (imported by report + assistant-tool layers): no `next/*`, no
 * `@/lib/api-utils`.
 */

import { Prisma, inventory_logs_logType } from "@prisma/client";

const DAY_MS = 86_400_000;

/**
 * Classified shrinkage reasons (Lane 6 / review B1 / D-T3). ONLY a row that carries
 * one of these reason codes is loss. Every other negative movement — a null
 * reasonCode, a bare CORRECTION, and above all the negative ADJUSTMENT rows this
 * business uses to SHIP product — is unclassified outbound, surfaced as a coverage
 * figure and NEVER bucketed as shrinkage.
 *
 * MOVED HERE from lib/analytics/queries.ts (quality+reach Task 2.1 / G2-5): the mix
 * classifier (lib/reports/outbound-mix.ts) needs the taxonomy, and queries.ts imports
 * the mix classifier — leaving the constant there would close a module cycle
 * (queries -> outbound-mix -> queries). queries.ts keeps a DEPRECATED re-export for
 * existing importers.
 */
export type ShrinkageReason = "DAMAGE" | "THEFT" | "EXPIRY" | "COUNT";
export const SHRINKAGE_CLASS_REASONS = ["DAMAGE", "THEFT", "EXPIRY", "COUNT"] as const;

/** The taxonomy as a membership set, keyed by the CANONICAL uppercase spelling. */
const SHRINKAGE_SET: ReadonlySet<string> = new Set(SHRINKAGE_CLASS_REASONS as readonly string[]);

/**
 * THE shrinkage-classification rule, in ONE function (FD-5). Every consumer that decides
 * "is this row a classified loss?" routes through it — the mix classifier, movement's
 * bucket classifier, get_shrinkage's per-reason accumulator, and the operations 90-day
 * shrink fold — so a `damage` row can never be a loss in one tool and unclassified
 * depletion in another.
 *
 * The LOOKUP is normalized, never the row: the ledger keeps whatever casing it stored.
 * Returns the CANONICAL reason (so a caller can key a per-reason bucket with it) or null
 * when the row is not a classified loss.
 *
 * COLLATION NOTE (binding on every SQL site): this is a JS decision on purpose. A
 * `reasonCode: { in: SHRINKAGE_CLASS_REASONS }` filter delegates the same decision to the
 * column's collation — case-insensitive under MySQL's `*_ci` default, case-SENSITIVE the
 * moment that column or connection is `_bin`/`_cs`. No classification site may depend on
 * that assumption: SQL narrows, JS classifies.
 *
 * THE ONE reasonCode COMPARISON THAT STILL HAPPENS IN SQL is `REORDER_DEMAND_WHERE`
 * below — read its annotation before adding a caller. It is a NARROWING, not a
 * classification, and the live reorder path re-decides in JS.
 */
export function shrinkageReasonOf(reasonCode: string | null | undefined): ShrinkageReason | null {
  if (reasonCode == null) return null;
  const canonical = reasonCode.toUpperCase();
  return SHRINKAGE_SET.has(canonical) ? (canonical as ShrinkageReason) : null;
}

/** A single inventory-log row, reduced to the fields the predicates read. */
export interface LedgerRow {
  delta: number;
  logType: string;
  reasonCode: string | null;
  changeTime: Date;
  productId: number;
}

/**
 * Physical outbound: stock physically leaving the shelf = a negative delta that is
 * NOT an internal transfer. Corrections COUNT (they still deplete). This is the ONE
 * units-out / velocity predicate — shared so units-out, last-outbound, and the
 * low-stock velocity can never disagree.
 */
export function isPhysicalOutboundRow(r: Pick<LedgerRow, "delta" | "logType">): boolean {
  return r.delta < 0 && r.logType !== "TRANSFER";
}

/**
 * LOCKED reorder-demand predicate: `delta < 0 AND logType != TRANSFER AND
 * (reasonCode IS NULL OR reasonCode != 'CORRECTION')`. `reasonCode !== 'CORRECTION'`
 * is null-safe — a null reason satisfies it (a plain sale/loss carries no reason).
 *
 * Moved VERBATIM from lib/reports/demand.ts (spec §2 D1). Excludes internal transfers
 * (not consumption) AND CORRECTION reversals (accounting, not real movement); a null /
 * DAMAGE / THEFT / EXPIRY reason IS included (you replace what you lose).
 */
export function isReorderDemandRow(r: Pick<LedgerRow, "delta" | "logType" | "reasonCode">): boolean {
  return r.delta < 0 && r.logType !== "TRANSFER" && r.reasonCode !== "CORRECTION";
}

/** Prisma WHERE for physicalOutbound (the SQL-boundary half both predicates share). */
export const PHYSICAL_OUTBOUND_WHERE: Prisma.inventory_logsWhereInput = {
  delta: { lt: 0 },
  logType: { not: inventory_logs_logType.TRANSFER },
};

/**
 * Prisma WHERE for reorderDemand: `delta < 0 AND logType != TRANSFER AND (reasonCode IS
 * NULL OR reasonCode != 'CORRECTION')`.
 *
 * PRISMA GOTCHA (SQL three-valued logic): a bare `NOT: { reasonCode: 'CORRECTION' }` is
 * NOT null-inclusive. Prisma's docs are explicit — "`not` will return all items that do
 * not match a given value. However, if the column is nullable, `NULL` values will not be
 * returned. If you require null values to be returned, use an `OR` operator to include
 * `NULL` values." reasonCode IS nullable, and a null reason is exactly a plain sale/loss
 * demand MUST count, so the bare NOT would silently drop every null-reason outbound. The
 * `OR: [{ reasonCode: null }, { NOT: { reasonCode: 'CORRECTION' } }]` restores the
 * null-INCLUSIVE intent and matches isReorderDemandRow (`reasonCode !== 'CORRECTION'`).
 * The base delta/logType conditions stay top-level (AND-composed with the OR). Pinned by
 * the contract test.
 *
 * COLLATION CAVEAT — THE ONE DOCUMENTED EXCEPTION to the `shrinkageReasonOf` rule above
 * (FD2-5). `NOT: { reasonCode: 'CORRECTION' }` compares reasonCode IN SQL, so which rows
 * it excludes depends on the column's collation: under MySQL's `*_ci` default a lowercase
 * 'correction' is excluded too; under a `_bin`/`_cs` column it would be KEPT. That is
 * tolerable HERE and nowhere else, because this WHERE is a NARROWING, not a
 * classification — SQL narrows, JS classifies.
 *
 * NOT FOR CLASSIFICATION DECISIONS. The LIVE reorder path does not read this constant at
 * all: `lib/reports/demand.ts` pulls the rows and predicates them in JS via
 * `isReorderDemandRow`, which is where the demand-vs-not decision is actually made. A
 * caller that needs to DECIDE something about a row must do the same rather than trust
 * this predicate's SQL-side reasonCode comparison. The export stays because the contract
 * pack names it as the SQL-boundary half of the locked reorder-demand predicate (spec §2
 * D1) and the contract test pins its exact shape.
 */
export const REORDER_DEMAND_WHERE: Prisma.inventory_logsWhereInput = {
  delta: { lt: 0 },
  logType: { not: inventory_logs_logType.TRANSFER },
  OR: [{ reasonCode: null }, { NOT: { reasonCode: "CORRECTION" } }],
};

/**
 * The shared days-covered denominator (spec §2 D2): the span from the first
 * qualifying outbound in the window to now, in whole days, floored at 1 (no
 * divide-by-zero for a same-day signal) and clamped to the window. NEVER a flat 30.
 */
export function daysCovered(firstEventMs: number, nowMs: number, windowDays: number): number {
  const spanDays = Math.ceil((nowMs - firstEventMs) / DAY_MS);
  return Math.min(windowDays, Math.max(1, spanDays));
}

/**
 * How much of a requested window the underlying SOURCE actually covers (spec C6).
 *   full    — the source starts on or before the window's first day: silence in the
 *             window is a MEASURED zero.
 *   partial — the source starts INSIDE or AFTER the window: any sum is at best a
 *             partial one, so absence is UNKNOWN, never zero.
 *   none    — the source has no rows at all for this caller: nothing is measurable.
 */
export type WindowCoverage = "full" | "partial" | "none";

/**
 * THE source-level zero-vs-unknown decision, in ONE place (spec C6/C9, seam S8).
 * get_sales' `coverage.windowCoverage` and compare_periods' per-period resolution
 * BOTH route through this, so the two surfaces can never classify the same seeded
 * source differently. Day-key granularity throughout (never sub-day), matching every
 * other window in this codebase.
 *
 * NOTE the deliberate coarseness: a window that PREDATES the source entirely and one
 * that STRADDLES its start are both `partial` here — neither can yield a trustworthy
 * total. Callers that need to say WHICH (compare_periods' reason strings) compare
 * `dataStart` against the window's `to` themselves.
 */
export function classifyWindowCoverage(dataStart: string | null, windowFrom: string): WindowCoverage {
  if (dataStart == null) return "none";
  return dataStart <= windowFrom ? "full" : "partial";
}

/**
 * Definition string for physicalOutbound velocity (spec §2 D3). The exact prose a
 * tool relays next to any units-out / avgDailyOutbound figure it carries.
 */
export const PHYSICAL_OUTBOUND_DEFINITION =
  "Physical outbound = every ledger row with delta < 0 and logType != TRANSFER — " +
  "sales, classified losses (DAMAGE/THEFT/EXPIRY/COUNT), unclassified adjustments/" +
  "corrections, count depletion, and rare wrong-signed receipt reversals alike. It is " +
  "NOT evidence of verified sales; outboundMix30 breaks the SAME rows into sale / " +
  "classifiedLoss / adjustmentUnclassified / correctionUnclassified / countOut / " +
  "stockInReversal so the composition is visible instead of assumed.";

/**
 * Definition string for reorderDemand (spec §2 D3). reorder.ts's duplicate string
 * migrates here in W0-1; this is the canonical text.
 */
export const REORDER_DEMAND_DEFINITION =
  "Reorder demand = every ledger row with delta < 0, logType != TRANSFER, and " +
  "reasonCode != CORRECTION (null/unclassified reasons ARE included — depletion you must " +
  "replace, whether or not it was a sale; NOT evidence of verified sales). avgDailyDemand " +
  "= units out / days covered since the first such movement in the window (never a flat " +
  "window, never 0-as-measurement).";

/**
 * Definition string for the outbound-usage velocity rate (spec §2 D3): the units/day
 * figure derived from physicalOutbound over the days actually covered.
 */
export const OUTBOUND_USAGE_DEFINITION =
  "units/day = physical outbound (every row with delta < 0 and logType != TRANSFER, " +
  "corrections included; NOT evidence of verified sales) over the days actually covered " +
  "by outbound data in the window — not a flat divide by the full window, and null " +
  "(unknown) when there is no outbound movement.";
