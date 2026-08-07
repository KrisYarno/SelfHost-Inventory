/**
 * lib/reports/outbound-mix.ts — the ONE outbound-mix classifier + the ONE
 * product name/lifecycle lookup (assistant quality+reach lane, spec C12 / contract
 * pack T1+T2).
 *
 * WHY THIS EXISTS (review #3, failure class F2): `unitsOut30` and `avgDailyDemand`
 * are PHYSICAL DEPLETION figures, and both got relayed as "units sold". A single
 * number cannot carry its own composition, so every mix-bearing figure now ships the
 * six-bucket breakdown beside it and the reader can see for themselves how much of
 * the depletion was an actual SALE row.
 *
 * THE SIXTH BUCKET is load-bearing (both plan-gate voices, blocker): the two outbound
 * predicates admit ANY negative non-TRANSFER row, INCLUDING a negative STOCK_IN
 * (a receipt reversal), which lib/reports/movement.ts deliberately folds into its
 * `stockIn` bucket. Without `stockInReversal` the partition invariant is FALSE on
 * legal ledger rows.
 *
 * G3: mix values are ABSOLUTE unit magnitudes (every classified row has delta < 0, so
 * sum-of-abs == abs-of-sum). movement.ts's buckets stay SIGNED — the two are different
 * definitions, never a contradiction.
 *
 * MUST stay Next-free (imported by report + assistant-tool layers): no `next/*`, no
 * `@/lib/api-utils`.
 */

import prisma from "@/lib/prisma";
import { SHRINKAGE_CLASS_REASONS } from "@/lib/reports/metrics-contract";

/**
 * The six-bucket outbound composition (spec C12 / contract pack T1). ABSOLUTE unit
 * magnitudes; the buckets partition the classified rows exactly, so
 * `sum(buckets) === SUM(|delta|)` always.
 */
export interface OutboundMix {
  sale: number;
  classifiedLoss: number;
  adjustmentUnclassified: number;
  correctionUnclassified: number;
  countOut: number;
  stockInReversal: number;
}

/** Shrinkage-class reasons as a membership set (the shared taxonomy). */
const SHRINKAGE_SET: ReadonlySet<string> = new Set(SHRINKAGE_CLASS_REASONS as readonly string[]);

/** A ledger row reduced to the fields the classifier reads. */
export interface OutboundRow {
  delta: number;
  logType: string;
  reasonCode: string | null;
}

export function emptyOutboundMix(): OutboundMix {
  return {
    sale: 0,
    classifiedLoss: 0,
    adjustmentUnclassified: 0,
    correctionUnclassified: 0,
    countOut: 0,
    stockInReversal: 0,
  };
}

/**
 * The FULL decision table (contract pack T1 — binding; mirrors movement.ts's
 * `classify` for negative rows so the two classifiers can never diverge):
 *
 *   SALE                                            -> sale
 *   STOCK_IN                                        -> stockInReversal
 *   COUNT                                           -> countOut
 *   ADJUSTMENT  reason in DAMAGE/THEFT/EXPIRY/COUNT -> classifiedLoss
 *   ADJUSTMENT  any other reason (incl. null, incl.
 *               the literal "CORRECTION")           -> adjustmentUnclassified
 *   CORRECTION  reason in DAMAGE/THEFT/EXPIRY/COUNT -> classifiedLoss
 *   CORRECTION  any other reason (incl. null)       -> correctionUnclassified
 *   any OTHER logType                               -> adjustmentUnclassified
 *
 * INPUT POPULATION PRECONDITION: every row satisfies `delta < 0 AND logType !=
 * TRANSFER` — the shared floor of BOTH outbound predicates. A TRANSFER or
 * non-negative row is a CALLER BUG, so it THROWS rather than being absorbed into a
 * bucket (a silently mis-bucketed row is exactly the kind of quiet lie this lane
 * exists to kill). The throw is a plain Error — a programmer-error assertion, never
 * part of the tool error contract.
 */
export function outboundBucketOf(row: OutboundRow): keyof OutboundMix {
  if (row.logType === "TRANSFER") {
    throw new Error(
      "classifyOutboundMix: a TRANSFER row is not physical outbound — the caller must " +
        "filter it out before classifying (precondition: delta < 0 AND logType != TRANSFER)",
    );
  }
  if (!(row.delta < 0)) {
    throw new Error(
      `classifyOutboundMix: expected a negative delta, got ${row.delta} — the caller must ` +
        "filter to outbound rows before classifying (precondition: delta < 0 AND logType != TRANSFER)",
    );
  }
  switch (row.logType) {
    case "SALE":
      return "sale";
    case "STOCK_IN":
      // A wrong-signed receipt (a reversal posted as negative STOCK_IN). Rare, legal,
      // and the reason this bucket exists.
      return "stockInReversal";
    case "COUNT":
      return "countOut";
    case "ADJUSTMENT":
      return row.reasonCode != null && SHRINKAGE_SET.has(row.reasonCode)
        ? "classifiedLoss"
        : "adjustmentUnclassified";
    case "CORRECTION":
      return row.reasonCode != null && SHRINKAGE_SET.has(row.reasonCode)
        ? "classifiedLoss"
        : "correctionUnclassified";
    default:
      // Unreachable for real rows (logType is the Prisma enum inventory_logs_logType).
      // Mirrors movement.ts's negative-side default so the two can never diverge.
      return "adjustmentUnclassified";
  }
}

/**
 * Partition outbound rows into the six-bucket mix. See `outboundBucketOf` for the
 * decision table and the input precondition.
 */
export function classifyOutboundMix(rows: OutboundRow[]): OutboundMix {
  const mix = emptyOutboundMix();
  for (const row of rows) {
    mix[outboundBucketOf(row)] += Math.abs(row.delta);
  }
  return mix;
}

/**
 * The G5 approved-universe filter, as an ID SET (spec G5 / contract pack T8). Every
 * aggregate read on this surface narrows with `productId: { in: approvedProductIds() }`
 * rather than a relation join — index-preserving, and identical across both Prisma
 * relation spellings (which differ per fact table, and must never be guessed).
 *
 * `includeArchived` follows the TOOL's policy row (spec C13): HISTORICAL fact reads
 * pass true (an archived product's past is still true history); CURRENT-STATE reads
 * leave it false. Unapproved products are excluded either way — that is the platform
 * trust boundary, not a display preference.
 */
export async function approvedProductIds(
  opts: { includeArchived?: boolean } = {},
): Promise<number[]> {
  const rows = await prisma.product.findMany({
    where: {
      approvalStatus: "APPROVED",
      ...(opts.includeArchived ? {} : { deletedAt: null }),
    },
    select: { id: true },
  });
  return (rows ?? []).map((r) => r.id);
}

/** A product's identity as every historical surface reports it (contract pack T2). */
export interface ProductIdentity {
  name: string;
  lifecycle: "active" | "deleted";
}

/**
 * The ONE name/lifecycle lookup (contract pack T2 / OC-7). Reads `id`/`name`/
 * `deletedAt` only and applies NO approval filter — callers pass ids that are ALREADY
 * scoped (by the G5 approved-id set, or by a resolver). `lifecycle` is derived from
 * `deletedAt` at QUERY time, so a product archived after the fact is labeled the
 * moment it is read.
 *
 * An ABSENT id has no map entry; callers null the name themselves rather than
 * fabricating one. Guards against a deep-mocked prisma returning undefined.
 */
export async function productIdentities(ids: number[]): Promise<Map<number, ProductIdentity>> {
  const uniq = Array.from(new Set(ids)).filter((v): v is number => typeof v === "number");
  if (uniq.length === 0) return new Map();
  const rows = await prisma.product.findMany({
    where: { id: { in: uniq } },
    select: { id: true, name: true, deletedAt: true },
  });
  return new Map(
    (rows ?? []).map((r) => [
      r.id,
      { name: r.name, lifecycle: r.deletedAt != null ? ("deleted" as const) : ("active" as const) },
    ]),
  );
}
