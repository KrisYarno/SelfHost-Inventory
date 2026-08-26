/**
 * THE OVERVIEW COUNTS (reconciliation lane, spec REV-7 D11; pack C2c.3).
 *
 * Two numbers, and the instant they were taken: how many exception rows are
 * open, and how many outbound batches in the last fortnight NAMED an order and
 * were never attributed to one. This is what the ops-health panel renders as a
 * WORKLOAD figure (plan P-10) — a report, not an alarm.
 *
 * COUNT-ONLY, BY CONTRACT. It never runs the derivation, never classifies a
 * batch and never grows a third figure quietly: the panel polls it every sixty
 * seconds on a page nobody is looking at, and the cost of that has to stay flat
 * and obvious. `openExceptions` comes through the exceptions producer's own
 * counter rather than naming the delegate here, because this module is reached
 * from an ops-health GET segment, where the exceptions write boundary forbids
 * the word entirely (pack R-5).
 *
 * M IS R4-BEFORE-R5 (spec D11). "Named an order" means the operator's stated
 * intent was not `other`/`damage-loss` AND (the intent was `order` OR a
 * reference was typed) — in that order. The workbench's "Other" tap always
 * sends a reference along with its intent, so an R5-first reading would count
 * every one of them and report a backlog that does not exist. The presence test
 * for the typed reference is the SAME guarded one the report's R5 uses (a JSON
 * string, non-empty), so this figure and that rule can never disagree about the
 * same batch.
 *
 * Next-free by contract.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { rowWhereSql } from './population';
import { countOpenExceptions } from './exceptions';

export type ReconciliationOverview = {
  openExceptions: number;
  unmatchedIntended14d: number;
  asOf: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window the Overview line speaks about, said out loud in its copy. */
const WINDOW_DAYS = 14;

/**
 * The audit event's `intent`, or NULL. Guarded on `JSON_TYPE` so a JSON `null`
 * does not arrive as the four-character string "null" and get compared as a
 * value (the `lib/reconciliation/attribution.ts` idiom).
 */
const INTENT = Prisma.sql`CASE WHEN JSON_TYPE(JSON_EXTRACT(a.details, '$.intent')) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.intent')) END`;

/** Was a non-empty reference typed at all? R5's only question. */
const HAS_REFERENCE = Prisma.sql`(JSON_TYPE(JSON_EXTRACT(a.details, '$.orderReference')) = 'STRING' AND JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.orderReference')) <> '')`;

/**
 * M — population batches in the window whose rows carry NO stamp and whose
 * earliest audit event says somebody meant to name an order.
 *
 * The ledger is aggregated FIRST (one row per batch, windowed on
 * `MIN(changeTime)` — the batch's own time axis) and only then joined to the
 * earliest audit row by scalar subquery, so a batch with two audit rows cannot
 * be counted twice.
 *
 * THE ROW-LEVEL PRE-FILTER (`l.changeTime < end`) is what bounds the scan: the
 * HAVING alone made this poll group the WHOLE population and then throw away
 * every batch older than the fortnight (OC-3). It is EXACT here, and only here,
 * because this window's `end` is NOW — no ledger row exists after it, so no
 * batch can lose a row to the filter and mis-report its `MAX(orderRecordId IS
 * NOT NULL)` or its `MIN(changeTime)`. The REPORT's CTE deliberately stays
 * HAVING-only: its window is historical, and a batch straddling the far edge
 * must keep its full aggregates rather than the half that fell inside.
 */
function unmatchedIntendedSql(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`SELECT COUNT(*) AS n
FROM (
  SELECT l.batchId AS batchId
  FROM inventory_logs l
  WHERE ${rowWhereSql('l')} AND l.changeTime < ${end}
  GROUP BY l.batchId
  HAVING MIN(l.changeTime) >= ${start} AND MIN(l.changeTime) < ${end} AND MAX(l.orderRecordId IS NOT NULL) = 0
) b
JOIN audit_logs a ON a.id = (SELECT a2.id FROM audit_logs a2 WHERE a2.batchId = b.batchId ORDER BY a2.id ASC LIMIT 1)
WHERE (${INTENT} IS NULL OR ${INTENT} NOT IN ('other','damage-loss'))
  AND (${INTENT} = 'order' OR ${HAS_REFERENCE})`;
}

/** MySQL hands COUNT back as BigInt. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

export async function getReconciliationOverview(now: Date = new Date()): Promise<ReconciliationOverview> {
  const start = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);

  const openExceptions = await countOpenExceptions();
  const rows = await prisma.$queryRaw<Array<{ n: unknown }>>(unmatchedIntendedSql(start, now));

  return {
    openExceptions,
    unmatchedIntended14d: toNumber(rows[0]?.n),
    asOf: now.toISOString(),
  };
}
