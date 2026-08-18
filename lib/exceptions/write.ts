/**
 * THE inventory-exception writer (contract pack REV-3 T1, EXCEPTIONS block).
 *
 * `inventory_exceptions` is a LIVING REGISTER, not a log. One row per stable
 * key, seen over and over, resolved and sometimes seen again — so the table has
 * a lifecycle, and this module is the only place that lifecycle exists:
 *
 *   upsertException   first sighting inserts; every later sighting advances
 *                     lastSeenAt and refreshes `subject`. `firstSeenAt` is never
 *                     rewritten — it is the AGE the reconciliation surface sorts
 *                     by, and a discrepancy that has been open for three weeks
 *                     must not read as new because somebody recounted it today.
 *                     A RESOLVED key that recurs REOPENS: resolvedAt/resolvedBy
 *                     cleared, the prior note KEPT, an audit-visible line added.
 *   resolveException  idempotent. Resolving twice is not two resolutions, and
 *                     resolving a key nobody ever raised is a silent no-op —
 *                     which is what lets the auto-resolve caller fire on EVERY
 *                     matching count without checking first.
 *
 * PURE + TX-SCOPED. No `prisma` import of its own, no route logic, no HTTP
 * vocabulary: every write joins the CALLER's transaction, which is what makes
 * "the discrepancy row and the count commit together, or neither does" true.
 *
 * THE READ IS A LOCKING READ (Receiving/Labeling overhaul, PK-11, spec §6).
 * `findUnique` answers from the transaction's REPEATABLE READ snapshot — taken
 * at its FIRST read, which is older than every lock the caller holds by the time
 * it gets here. A product decline's resolve and a concurrent booking's raise
 * would then each decide from a state the other had already replaced. `SELECT
 * ... FOR UPDATE` on the key serializes them ON THE ROW ITSELF: the loser waits
 * for the winner to commit and reads what it actually wrote. Callers with
 * competing product/exception locks own the deadlock retry (seam S14).
 *
 * WRITE BOUNDARY (binding, zero-business-writes adjacent): only explicitly-
 * mutating routes may import this module. No GET, no assistant tool, ever —
 * enforced by __tests__/integration/exceptions-write-boundary.test.ts, which
 * also pins that this file is the ONLY one touching the Prisma delegate.
 */

import { Prisma } from '@prisma/client';
import type { InventoryException } from '@prisma/client';
import type { ExceptionKind, Resolution } from '@/lib/exceptions/kinds';
import { AppError } from '@/lib/error-handling';

/** `inventory_exceptions.key` is VarChar(191) and UNIQUE. */
export const EXCEPTION_KEY_MAX_LENGTH = 191;

/**
 * A subject payload. Flat by convention (every declared kind is a scalar map),
 * but typed against Prisma's JSON input so a future kind is not boxed in.
 */
export type ExceptionSubject = Record<string, Prisma.InputJsonValue | null>;

export type UpsertExceptionArgs = {
  kind: ExceptionKind;
  /** MUST be the canonical `<kind>:<subject id>` encoding — see lib/exceptions/kinds.ts. */
  key: string;
  subject: ExceptionSubject;
  /** Appended as a note LINE; a line identical to the current last one is not repeated. */
  note?: string;
  /**
   * The caller's transaction instant. Passing the same `Date` the business write
   * used keeps lastSeenAt exactly equal to the event that raised it, instead of
   * a few milliseconds adrift.
   */
  now?: Date;
};

export type ResolveExceptionArgs = {
  key: string;
  /** NULL (the default) means the SYSTEM resolved it — an auto-resolve, not a person. */
  resolvedBy?: number | null;
  note?: string;
  /**
   * HOW it was settled (spec §6 / D5) — a CLASSIFICATION, stored beside
   * `resolvedAt`/`resolvedBy` rather than inside `subject`, which the upsert
   * replaces wholesale. Absent leaves an existing classification alone; a
   * DIFFERENT one RE-LABELS the row (see below).
   */
  resolution?: Resolution;
  /**
   * Fields to refresh on the subject before settling (PK2-2). Every resolution
   * recomputes the money from the line's current counters, so the register can
   * answer "how much" from the row alone — MERGED into the locked subject, never
   * replacing it, because the caller knows the money and not the identity.
   */
  subjectPatch?: ExceptionSubject;
  now?: Date;
};

/**
 * The key must encode its own kind. Two writers disagreeing about which kind a
 * key belongs to would silently split one subject's history across two rows (or
 * merge two subjects into one), and neither is recoverable from the data.
 */
function assertKeyMatchesKind(kind: ExceptionKind, key: string): void {
  if (!key.startsWith(`${kind}:`)) {
    throw new Error(
      `Exception key "${key}" does not encode its kind "${kind}" — expected "${kind}:<subject id>"`,
    );
  }
  if (key.length > EXCEPTION_KEY_MAX_LENGTH) {
    // MySQL outside strict mode would TRUNCATE, and truncated keys collide —
    // two different subjects would share one register row.
    throw new Error(
      `Exception key "${key}" is ${key.length} characters; the column holds ${EXCEPTION_KEY_MAX_LENGTH}`,
    );
  }
}

/**
 * Notes are an append-only line log: whoever wrote the last note explained why
 * this row was closed, and no later event gets to erase that. Consecutive
 * duplicates are dropped so a repeated automatic line cannot grow the column
 * without adding information.
 */
function appendNoteLine(note: string | null, line: string): string {
  if (!note) return line;
  const lines = note.split('\n');
  if (lines[lines.length - 1] === line) return note;
  return `${note}\n${line}`;
}

function reopenNoteLine(now: Date): string {
  return `[${now.toISOString()}] auto: reopened — the condition recurred after resolution`;
}

/**
 * The row for `key`, READ UNDER ITS OWN LOCK (PK-11).
 *
 * Raw SQL because Prisma has no `FOR UPDATE` (house precedent:
 * `lib/products/decline.ts`, `app/api/inbound-shipments/[id]/route.ts`). The key
 * is a BOUND parameter, never interpolated; `key` is backticked because it is a
 * MySQL reserved word. The statement only ACQUIRES and READS — every write below
 * still goes through the Prisma delegate, which is what the boundary gate scans
 * for.
 */
async function lockedException(
  tx: Prisma.TransactionClient,
  key: string,
): Promise<InventoryException | null> {
  const rows = await tx.$queryRaw<InventoryException[]>(
    Prisma.sql`SELECT id, \`key\`, kind, subject, firstSeenAt, lastSeenAt, resolvedAt, resolvedBy, note, resolution FROM inventory_exceptions WHERE \`key\` = ${key} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/**
 * WRITE the row `lockedException` just read, and hand back its new state.
 *
 * WHY `updateMany` AND NOT `update` (M7B-D1 — found by the concurrency gate,
 * scenario 5): Prisma's `update({ where: { key } })` first runs a PLAIN
 * `SELECT` to find the row, and a plain read answers from the transaction's
 * REPEATABLE READ snapshot — the one established at the transaction's FIRST
 * consistent read (a booking's idempotency read, an approval's product read),
 * which is long before this writer runs. `lockedException` bypasses that snapshot
 * (a locking read returns the latest committed row), so a row that a racing
 * winner INSERTED and committed while this transaction was waiting on a lock is
 * visible to the lock and invisible to the update: P2025 "record not found",
 * un-retried, a 500 for the whole business write. DML has no such snapshot:
 * `UPDATE ... WHERE key = ?` acts on the latest committed row — the row this
 * transaction already holds the lock on — so exactly one row moves. The return
 * value is then read back under the same lock, again from the latest state.
 *
 * `count !== 1` is unreachable in a correctly locked flow (the row was just read
 * FOR UPDATE and nobody can delete it under us) and is therefore an INVARIANT,
 * never silently `null`.
 */
async function writeLocked(
  tx: Prisma.TransactionClient,
  key: string,
  data: Prisma.InventoryExceptionUpdateManyMutationInput,
): Promise<InventoryException> {
  const { count } = await tx.inventoryException.updateMany({ where: { key }, data });
  if (count !== 1) {
    throw new AppError(
      `exception row ${key} vanished under its own lock (updated ${count} rows)`,
      'INVARIANT',
      500,
    );
  }
  const row = await lockedException(tx, key);
  if (!row) {
    throw new AppError(`exception row ${key} unreadable after its write`, 'INVARIANT', 500);
  }
  return row;
}

/**
 * The stored subject as an object to merge onto.
 *
 * `subject` is a JSON column, and a raw read can hand it back as the parsed
 * value or as the JSON TEXT depending on the connector. Spreading a string would
 * silently produce a character map — a corrupted register row — so the string
 * case is parsed, and anything that is not an object at all degrades to `{}`
 * rather than to nonsense.
 */
function subjectObject(subject: unknown): Record<string, unknown> {
  const value = typeof subject === 'string' ? safeParse(subject) : subject;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Raise (or re-raise) an exception. Returns the row as it now stands.
 *
 * RACE NOTE: the prior row is READ before the write, because the reopen decision
 * and the note history cannot be expressed as a single blind upsert. Two
 * concurrent first-sightings of the same key therefore contend on the UNIQUE
 * index — one commits, the other's transaction fails and its caller's business
 * write rolls back with it. That is the correct outcome here (retry re-reads and
 * takes the update path); it is not a silent data hazard.
 */
export async function upsertException(
  tx: Prisma.TransactionClient,
  args: UpsertExceptionArgs,
): Promise<InventoryException> {
  const { kind, key, subject, note } = args;
  assertKeyMatchesKind(kind, key);
  const now = args.now ?? new Date();

  const existing = await lockedException(tx, key);

  if (!existing) {
    return tx.inventoryException.create({
      data: {
        key,
        kind,
        subject: subject as Prisma.InputJsonObject,
        firstSeenAt: now,
        lastSeenAt: now,
        note: note ?? null,
      },
    });
  }

  // `kind` is fixed by the key (asserted above), so it is never rewritten.
  const data: Prisma.InventoryExceptionUpdateManyMutationInput = {
    subject: subject as Prisma.InputJsonObject,
    lastSeenAt: now,
  };

  const reopening = existing.resolvedAt !== null;
  let nextNote = existing.note;
  if (reopening) {
    data.resolvedAt = null;
    data.resolvedBy = null;
    // The CLASSIFICATION goes with the settlement it described: this row is open
    // again, and "supplier-credited" would now be a statement about a state that
    // no longer holds (spec §6).
    data.resolution = null;
    nextNote = appendNoteLine(nextNote, reopenNoteLine(now));
  }
  if (note) {
    nextNote = appendNoteLine(nextNote, note);
  }
  if (nextNote !== existing.note) {
    data.note = nextNote;
  }

  return writeLocked(tx, key, data);
}

/** "resolution relabeled: accepted-loss -> supplier-credited". */
function relabelNoteLine(from: string | null, to: Resolution): string {
  return `resolution relabeled: ${from ?? 'unclassified'} -> ${to}`;
}

/**
 * Resolve an exception. Returns the row, or `null` when the key was never
 * raised.
 *
 * `lastSeenAt` is deliberately NOT advanced: resolving is not another sighting,
 * and letting it move would make "how long has this been open" unanswerable.
 *
 * SETTLEMENT-IDEMPOTENT: an already-resolved key keeps the FIRST resolution's
 * instant, actor and note — a second call (a confirming recount, a repeated
 * recompute) must not overwrite them. A note passed to a call that does not
 * settle anything is therefore not written; re-raise through `upsertException`
 * if the condition actually came back.
 *
 * Three things the overhaul adds on top of that (spec §6 / D5, PK2-2), all of
 * them about the difference between WHEN something was settled and HOW:
 *
 *   subjectPatch  MERGED into the locked subject BEFORE any of the branching
 *                 below, so EVERY resolution refreshes the row's current money
 *                 even when the settlement itself is idempotent. The register
 *                 has to answer "how much" from the row alone.
 *   resolution    the CLASSIFICATION. Stamped with the settlement on an open
 *                 row; absent on a later call, it is never erased — silence is
 *                 not a reclassification.
 *   RE-LABEL      a DIFFERENT resolution on an already-resolved row updates the
 *                 classification and says so in the note, while `resolvedAt` /
 *                 `resolvedBy` stay at the FIRST settlement. "We thought this
 *                 was an accepted loss, the supplier credited it after all" is a
 *                 correction to the label, not a second settlement.
 */
export async function resolveException(
  tx: Prisma.TransactionClient,
  args: ResolveExceptionArgs,
): Promise<InventoryException | null> {
  const { key, note, resolution, subjectPatch } = args;
  const now = args.now ?? new Date();

  const existing = await lockedException(tx, key);
  if (!existing) return null;

  // The money first, whatever branch settles below.
  const mergedSubject = subjectPatch
    ? ({ ...subjectObject(existing.subject), ...subjectPatch } as Prisma.InputJsonObject)
    : null;

  if (existing.resolvedAt !== null) {
    const relabelling = resolution !== undefined && resolution !== existing.resolution;
    if (!relabelling && mergedSubject === null) {
      // Nothing to say and nothing to refresh: the first settlement stands.
      return existing;
    }

    const data: Prisma.InventoryExceptionUpdateManyMutationInput = {};
    if (mergedSubject !== null) data.subject = mergedSubject;
    if (relabelling) {
      data.resolution = resolution;
      let nextNote = appendNoteLine(existing.note, relabelNoteLine(existing.resolution, resolution));
      if (note) nextNote = appendNoteLine(nextNote, note);
      data.note = nextNote;
    }

    return writeLocked(tx, key, data);
  }

  const data: Prisma.InventoryExceptionUpdateManyMutationInput = {
    resolvedAt: now,
    resolvedBy: args.resolvedBy ?? null,
    resolution: resolution ?? null,
  };
  if (mergedSubject !== null) data.subject = mergedSubject;

  const nextNote = note ? appendNoteLine(existing.note, note) : existing.note;
  if (nextNote !== existing.note) {
    data.note = nextNote;
  }

  return writeLocked(tx, key, data);
}
