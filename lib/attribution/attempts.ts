/**
 * THE ATTRIBUTION-ATTEMPT WRITER (reconciliation lane, spec REV-7 D1; pack
 * C1b.1). One row per LIVE attempt at BATCH grain — successes AND declines —
 * written beside the audit event, inside the caller's own transaction.
 *
 * WHY IT IS ONE FUNCTION AND NOT FOUR. Four route seams write these rows and
 * every one of them is a stock-writing path. The invariant they share is not
 * about attribution at all: recording that we could not attribute a deduction
 * must never be the reason the deduction fails to commit. That rule has to live
 * in exactly one place or it is not a rule.
 *
 * THE SWALLOW SET IS AN ALLOW-LIST, AND THAT DIRECTION IS THE WHOLE DESIGN
 * (spec D1 REV-5, CX-1). The obvious shape — catch everything except a short
 * list of known-fatal codes — fails closed in the wrong direction: on MySQL a
 * P2034 means the SERVER has already rolled the transaction back, so swallowing
 * it lets Prisma COMMIT a transaction that no longer exists and the route
 * answers 200 for stock that never moved. The complement of an enumerated fatal
 * set cannot prove the transaction is still usable for P2027/P2035/P2036/P2037
 * or for a code a future Prisma release invents. So: swallow only what has been
 * PROVEN statement-local, re-throw the rest, and let the caller abort exactly as
 * it would on an audit-write failure. A swallowed failure is not silent — it
 * logs one redacted line, and the batch later derives with the `post-lane gap`
 * annotation, which is the honest disclosure.
 *
 * APPEND-ONLY. Nothing in `app/ lib/ scripts/` may ever call update / updateMany
 * / upsert / delete / deleteMany on this delegate; a static scan in
 * __tests__/integration/attempts-write-boundary.test.ts enforces it, and the
 * same file pins the exact set of modules allowed to import THIS one.
 *
 * Next-free and route-free: no HTTP vocabulary, no `@/lib/prisma` import. Every
 * write joins the CALLER's transaction, which is what makes "the attempt row and
 * the stock movement commit together" true.
 */

import { Prisma } from '@prisma/client';

import type {
  AttemptClass,
  AttemptDetails,
  AttemptSource,
} from '@/lib/attribution/contracts';

// Re-exported so a route needs ONE import. The read path imports contracts.ts
// directly and must never reach this module (pack R-4 / C2b.5).
export type {
  AttemptClass,
  AttemptDetails,
  AttemptEvidence,
  AttemptOutcome,
  AttemptSource,
  DeclineReason,
  NoneReason,
} from '@/lib/attribution/contracts';

/**
 * What a writer hands over: the classified outcome plus the identifying facts.
 * `details` is a caller CONVENIENCE, not a passthrough — see the explicit pick
 * below; any extra key on the object is dropped before the row is built.
 */
export type AttemptInput = AttemptClass & {
  batchId: string;
  /** The first outbound row of the batch; NULL when only bundle sentinels moved. */
  ledgerRowId: number | null;
  source: AttemptSource;
  actorUserId: number | null;
  orderRecordId?: string | null;
  previousOrderRecordId?: string | null;
  details?: AttemptDetails;
};

/**
 * The ONLY known-request codes proven statement-local (the transaction stays
 * usable; MySQL rolls back only the failed statement).
 *
 * A code may be ADDED here only after a real-MySQL transaction test proves the
 * failing statement can be followed by another statement and a successful
 * COMMIT. Everything else re-throws.
 */
export const SWALLOWABLE_REQUEST_CODES: ReadonlySet<string> = new Set(['P2000']);

/** The redacted log token, pinned — it is what an operator greps for. */
export const ATTEMPT_INSERT_FAILED_LOG = '[attribution-attempts] insert failed';

/**
 * The label a swallowed CLIENT-SIDE validation error logs in place of a code.
 * `PrismaClientValidationError` carries none: the statement never reached the
 * database, so there is no server code to name.
 */
const VALIDATION_ERROR_LABEL = 'VALIDATION';

function isSwallowable(err: unknown): boolean {
  return (
    (err instanceof Prisma.PrismaClientKnownRequestError &&
      SWALLOWABLE_REQUEST_CODES.has(err.code)) ||
    err instanceof Prisma.PrismaClientValidationError
  );
}

function codeOf(err: unknown): string {
  return err instanceof Prisma.PrismaClientKnownRequestError ? err.code : VALIDATION_ERROR_LABEL;
}

/**
 * Record ONE attempt on the caller's transaction.
 *
 * Validates nothing at runtime beyond Prisma's own column types (D1): the
 * closed types above do the compile-time work, and a writer that threw on a
 * shape it disliked would be exactly the abort risk this module exists to
 * remove. `attemptedAt` is left to the column default — the row's time is the
 * database's, never the caller's clock.
 */
export async function recordAttributionAttempt(
  tx: Prisma.TransactionClient,
  input: AttemptInput
): Promise<void> {
  // EXPLICIT PICK, four keys, no spread. A caller object carrying anything else
  // — a typed reference, a customer name, a whole request body — cannot reach
  // the JSON column by accident, and the compile-time type is not the only
  // thing standing between it and the database.
  const d = input.details ?? {};
  const details: AttemptDetails = {
    ...(d.intent !== undefined ? { intent: d.intent } : {}),
    ...(d.overwriteReason !== undefined ? { overwriteReason: d.overwriteReason } : {}),
    ...(d.rowCount !== undefined ? { rowCount: d.rowCount } : {}),
    ...(d.completedFulfillment !== undefined
      ? { completedFulfillment: d.completedFulfillment }
      : {}),
  };

  const data: Prisma.OrderAttributionAttemptUncheckedCreateInput = {
    batchId: input.batchId,
    ledgerRowId: input.ledgerRowId,
    outcome: input.outcome,
    // NULL, never the string 'undefined': a VarChar holding that word reads as a
    // recorded class in every later report.
    evidence: input.evidence ?? null,
    reason: input.reason ?? null,
    orderRecordId: input.orderRecordId ?? null,
    previousOrderRecordId: input.previousOrderRecordId ?? null,
    source: input.source,
    actorUserId: input.actorUserId,
    // An empty pick OMITS the field so the column is NULL — never JsonNull,
    // which is a stored JSON `null` and would read as "details were recorded and
    // they were empty".
    ...(Object.keys(details).length > 0 ? { details: details as Prisma.InputJsonValue } : {}),
  };

  try {
    await tx.orderAttributionAttempt.create({ data });
  } catch (err) {
    if (isSwallowable(err)) {
      // The CODE only. The writer never receives the typed reference and never
      // logs the input it did receive.
      console.error(`${ATTEMPT_INSERT_FAILED_LOG} (${codeOf(err)}) — business write proceeds`);
      return;
    }
    throw err;
  }
}
