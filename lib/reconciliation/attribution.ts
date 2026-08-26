/**
 * THE ATTRIBUTION REPORT (reconciliation lane, spec REV-7 §2.2 / D6 / D7 / D9;
 * pack C2a.4). Every ATTRIBUTABLE outbound batch in a window: whether the ledger
 * says it was attributed, by which evidence, and — when it was not — why.
 *
 * TWO TRUTH SOURCES, NEVER MIXED (spec §2.2). Attributed-or-not is the LEDGER
 * STAMP. The evidence and the reason come from the LATEST attempt row when one
 * exists, and otherwise from the read-time derivation, which is labelled as
 * derived and carries the rule that fired. A batch is never described by a class
 * nobody recorded and never called "before the lane" when recording was live.
 *
 * ONE READ, ONE CLASSIFICATION (D7 / CX-7). The window's batches arrive as ONE
 * BATCH-SUMMARY ROW EACH: the ledger is aggregated FIRST, and only then does the
 * statement reach for the earliest audit row and the latest attempt — through
 * scalar subqueries keyed on `id`, never a 1:N join that could multiply the
 * units of a batch with two audit rows or two attempts. R0 and R1-R7 then run
 * ONCE, in TypeScript, over those summaries; the class filter and the keyset
 * page are applied AFTER classification, and `byClass` is computed BEFORE the
 * active class filter so the other chips keep telling the truth. The statement
 * budget for a report read is AT MOST FIVE, and the exclusion figures ride in
 * the same statement rather than buying one of their own.
 *
 * WHAT IT COSTS, said out loud: the summary CTE groups the whole population and
 * windows on `MIN(changeTime)`, because the window's axis IS the batch's first
 * row (spec §2.0). The 366-day span cap is what bounds the read; measured
 * wall-time on the dev prod-dump belongs to the wave close, not to a comment.
 *
 * PII (D6). Orders are projected through ONE frozen select and rebuilt field by
 * field — never spread — and `companyId` (the membership math) is stripped on
 * the way out. The LIST read does not select the audit `details` blob at all: it
 * extracts the five typed facts the rules read, so the operator's free text
 * stays in the audit row and reaches only the drill-down, labelled.
 *
 * Next-free by contract, and TEXTUALLY WRITE-FREE (pack R-4): this module is on
 * the assistant's read path, where no Prisma write-method token may appear —
 * comments included. The manual-attribution core is named here, never called;
 * the cursor codec is JSON over `Buffer`, deliberately, because a `Map`/`Set`
 * removal method would trip the same textual scan.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { AppError } from '@/lib/error-handling';
import type { AttemptDetails, AttemptSource } from '@/lib/attribution/contracts';
import {
  ATTRIBUTABLE_DEFINITION,
  ATTRIBUTABLE_PREDICATE,
  batchEvidence,
  FULFILLMENT_ACTION_TYPE_LIST,
  renderRowWhereSql,
  rowWhere,
  rowWhereSql,
  type BatchAuditRow,
} from './population';
import { MANUAL_ATTRIBUTION_ROW_LIMIT } from './refusals';
import {
  deriveHistoricalAttempt,
  type DerivedClass,
  type DeriveAuditEvent,
} from './derive';
import { RECONCILIATION_ORDER_SELECT, RECONCILIATION_USER_SELECT } from './pii';

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/** Who is asking. The routes pass `admin`; the assistant tool passes a member. */
export type Viewer = { kind: 'admin' } | { kind: 'member'; companyIds: string[] };

/**
 * THE CHIP VOCABULARY — outcome and evidence-or-reason, joined by a middle dot.
 * Closed and non-empty (the tool's `z.enum` reads this tuple), and every member
 * is reachable: the four recorded evidences plus `derived`, the five decline
 * classes plus the `unknown` the derivation must use for a decline nobody
 * recorded, and the four none-reasons plus its own `unknown`.
 */
// The class-key vocabulary lives in ./class-keys (Next-free, prisma-free) so the
// UI and the tool can value-import it without pulling this module's Prisma import
// into a client chunk (M4b build audit). Re-exported here for server callers.
export { ATTRIBUTION_CLASS_KEYS } from './class-keys';
import { ATTRIBUTION_CLASS_KEYS } from './class-keys';

export type { AttributionClassKey } from './class-keys';
import type { AttributionClassKey } from './class-keys';

// The batch-grain evidence helper lives in ./population beside R0 itself, so the
// WRITE path can read it without importing this module's Prisma client (the
// class-keys precedent above). Re-exported here for the read-path callers that
// already speak this module's vocabulary.
export { batchEvidence } from './population';
export type { BatchAuditRow, BatchEvidence } from './population';

const CLASS_KEY_SET: ReadonlySet<string> = new Set(ATTRIBUTION_CLASS_KEYS);

export type AttributionInput = {
  /** ISO day keys (`YYYY-MM-DD`); `to` is INCLUSIVE end-of-day UTC. */
  from: string;
  to: string;
  classKey?: AttributionClassKey;
  orderNumber?: string;
  /** At most 200 — the route refuses more. */
  limit: number;
  /** Opaque: base64url of `{ t, b, c }` (changeTime ms, batchId, consumed). */
  cursor?: string;
};

export type OrderRef =
  | {
      id: string;
      orderNumber: string;
      internalStatus: string;
      platform: string;
      externalCreatedAt: string | null;
    }
  | { orderRedacted: true; reason: string }
  | { orderMissing: true };

export type AttributionHow = {
  classKey: AttributionClassKey;
  sentence: string;
  ruleId?: string;
  ledgerUnstamped?: true;
  postLaneGap?: true;
};

export type AttributionRow = {
  batchId: string;
  at: string;
  source: AttemptSource | 'pipeline' | 'derived';
  actor: { id: number; username: string } | null;
  how: AttributionHow;
  logTypes: string[];
  units: number;
  productCount: number;
  order: OrderRef | null;
  canAttribute: boolean;
  attributeLock: { orderRecordId: string; reason: 'r2b-completion' } | null;
  fulfilledAgainst: { orderRecordId: string; orderNumber: string | null } | null;
};

export type AttributionTotals = {
  attributable: number;
  byClass: Record<AttributionClassKey, number>;
  exclusions: { nonAttributable: number; historicalMassUpdate: number; noBatchRows: number };
};

export type AttributionCoverage = {
  batchesInWindow: number;
  rowsReturned: number;
  derivedShare: number | null;
  ledgerUnstamped: number;
  needsALook: { stampDisagreesWithLatestAttempt: number; mixedStamps: number };
  recordingSince: string | null;
  orderFilterScope: 'all orders' | 'your companies only';
  notes: string[];
};

export type AttributionReport = {
  window: { from: string; to: string };
  rows: AttributionRow[];
  totals: AttributionTotals;
  coverage: AttributionCoverage;
  count: number;
  /** The ONE authoritative bound: `count - consumed - rowsReturned`. */
  moreCount: number;
  nextCursor: string | null;
  definitions: Record<string, string>;
};

export type BatchDetail = {
  batch: AttributionRow;
  ledgerRows: Array<{
    id: number;
    productId: number;
    productName: string;
    delta: number;
    logType: string;
    changeTime: string;
    orderRecordId: string | null;
  }>;
  auditEvent: {
    id: number;
    actionType: string;
    createdAt: string;
    orderReference?: string;
    intent?: string;
    selectedExternalOrderId?: string;
    label: 'from the audit event (free text, admin-visible on /admin/logs)';
  } | null;
  /**
   * ABOUT THE ARRAY, and only the array. The ledger read is BOUNDED at the
   * manual-attribution limit + 1 (OC-8): a pre-lane mass update holds thousands
   * of rows and used to send every one of them to the browser. TRUE means
   * `ledgerRows` is the first page of the batch.
   *
   * `batch` IS EXACT EITHER WAY (QA-1): over the bound it is computed from a
   * batch-scoped aggregate over the FULL ledger, so its units, row count,
   * product count, time axis, log types and stamps — and therefore its class,
   * its order and `canAttribute` — describe the whole batch, not the page.
   */
  ledgerRowsTruncated: boolean;
  attempts: Array<{
    id: number;
    attemptedAt: string;
    outcome: string;
    evidence: string | null;
    reason: string | null;
    source: string;
    actor: { id: number; username: string } | null;
    orderRecordId: string | null;
    previousOrderRecordId: string | null;
    details: AttemptDetails | null;
  }>;
  attributionEvents: Array<{
    id: number;
    createdAt: string;
    actor: { id: number; username: string } | null;
    details: {
      orderRecordId: string;
      previousOrderRecordId: string | null;
      reason: string | null;
      rowCount: number;
    };
  }>;
  derived: DerivedClass | null;
};

// ---------------------------------------------------------------------------
// The sentences and the definitions that ride with the numbers (R-2)
// ---------------------------------------------------------------------------

/**
 * One sentence per class for a RECORDED attempt. The derivation brings its own
 * (DERIVED_SENTENCES, including the post-lane wording), so these are only ever
 * read for a batch whose attempt row said so at the time.
 */
const RECORDED_SENTENCES: Readonly<Record<AttributionClassKey, string>> = Object.freeze({
  'attributed·fulfillment': 'fulfilling the order deducted this batch',
  'attributed·selected': 'the operator picked this order at the deduction',
  'attributed·reference-resolved': 'the reference the operator typed resolved to this order',
  'attributed·manual': 'an admin attributed this batch afterwards',
  'attributed·derived': 'computed at read time because no attempt row exists',
  'declined·unusable': 'the reference the operator typed could not be used',
  'declined·unmatched': 'the reference the operator typed matched no order',
  'declined·ambiguous': 'the reference the operator typed matched more than one order',
  'declined·not-a-member':
    'the reference named an order in a company the operator is not a member of',
  'declined·resolver-error': 'looking the reference up failed',
  'declined·unknown': 'a reference was typed and nothing recorded whether it matched',
  'none·no-reference-typed': 'no order was picked and no reference was typed',
  'none·explicit-non-order-intent': 'the operator said this was not an order',
  'none·order-intent-no-id': 'the operator said order, but no order was identified',
  'none·no-order-context': 'nothing in the request said anything about an order',
  'none·unknown': 'nothing recorded says what happened here',
});

const REDACTED_REASON = 'order belongs to a company you are not a member of';

/** The standing disclosure R0 cannot make for itself (pack amendment 3c). */
const R0_INVISIBLE_NOTE =
  'a pre-0b-1 mass update whose summary event was never written is invisible to R0 and appears here as an unknown-class batch with a large row count';

const NO_MEMBER_ORDER_NOTE = 'no order matching that number in your companies';

const NO_DENOMINATOR_NOTE =
  'no attributable batch in this window, so the derived share has no denominator';

const DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  population: ATTRIBUTABLE_DEFINITION,
  window:
    'from 00:00 UTC on `from` through 23:59:59.999 UTC on `to` (inclusive), placed by the batch time axis MIN(changeTime)',
  batchesInWindow:
    'batches whose earliest population row falls in the window, after the order-number filter and before the R0 and class filters',
  attributable:
    'batches in the window that passed R0 — everything this report is allowed to speak about',
  nonAttributable:
    'batches with at least one ledger row in the window and no population row at all: transfer legs, count sessions, correction reversals and positive-only adjusts',
  noBatchRows:
    'outbound rows in the window carrying no batch id (before 2026-07-10) — they cannot be grouped, so they are outside this report',
  historicalMassUpdate:
    'population batches excluded by R0 — pre-0b-1 mass-update sessions that wrote their rows under one batch id',
  derived:
    'computed at read time because no attempt row exists — before the lane, or a path that did not record',
  derivedShare:
    'the share of the attributable batches in this window whose class was derived rather than recorded',
  moreCount:
    'rows this window still holds beyond the ones consumed through this page: count minus the consumed count the cursor carries minus the rows returned',
  needsALook:
    'invariant tripwires: a ledger stamp that disagrees with the latest recorded attempt, and a batch whose rows carry different order ids (reported, never averaged)',
  recordingSince:
    "the first attempt row's attemptedAt — batches before it were never recorded live and carry a derived class",
  canAttribute:
    'whether the manual-attribution core would accept this batch: attributable, at most 50 rows, uniformly stamped (one id on every row, or none on any), not a stamped fulfillment, and not a fulfillment whose event names no order to complete',
});

// ---------------------------------------------------------------------------
// Bounds, cursors and small conversions
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** The picker's bound, said out loud by `searchOrders`'s `moreCount`. */
const ORDER_SEARCH_LIMIT = 20;

/**
 * `[from 00:00 UTC, the day AFTER `to` 00:00 UTC)` — the
 * `lib/analytics/supply-orders.ts` idiom, mirrored rather than imported so this
 * module stays free of the analytics graph. Half-open and computed in UTC: a
 * `<= to 23:59:59` form drops the final millisecond of the day, and local-time
 * arithmetic moves the boundary twice a year.
 */
function windowBounds(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);
  return { start, end };
}

type Cursor = { t: number; b: string; c: number };

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Opaque in, validated out. A cursor the client edited is a 400, never a silent
 * first page — a page that quietly restarts would report a `moreCount` that
 * contradicts the rows above it.
 */
function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('invalid cursor', 'VALIDATION_ERROR', 400);
  }
  if (
    !isObj(parsed) ||
    typeof parsed.t !== 'number' ||
    !Number.isFinite(parsed.t) ||
    typeof parsed.b !== 'string' ||
    typeof parsed.c !== 'number' ||
    !Number.isFinite(parsed.c) ||
    parsed.c < 0
  ) {
    throw new AppError('invalid cursor', 'VALIDATION_ERROR', 400);
  }
  return { t: parsed.t, b: parsed.b, c: parsed.c };
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** MySQL hands aggregates back as BigInt (COUNT) or DECIMAL (SUM). */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value === null || value === undefined) return 0;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

// ---------------------------------------------------------------------------
// The one read (D7 / CX-7)
// ---------------------------------------------------------------------------

/** The five typed facts the rules read off an audit event, plus R0's two keys. */
const AUDIT_SOURCE_KEY = 'orderAttributionSource';
const AUDIT_INTENT_KEY = 'intent';
const AUDIT_SELECTED_KEY = 'selectedExternalOrderId';
const AUDIT_ORDER_KEY = 'orderId';
const AUDIT_REFERENCE_KEY = 'orderReference';
const AUDIT_ROWS_KEY = 'rows';
const AUDIT_ROWS_OMITTED_KEY = 'rowsOmitted';

/**
 * What derive is told about a typed reference. The RULES only ask whether one
 * exists (R5); the text itself never leaves the audit row, and the drill-down is
 * the one surface that shows it — labelled.
 */
const REFERENCE_PRESENT = 'a reference was typed';

function jsonPath(key: string): Prisma.Sql {
  // The keys are module constants, never client input — raw is safe and keeps
  // the path a literal, which is what MySQL's JSON functions want.
  return Prisma.raw(`'$.${key}'`);
}

/** A JSON string field, or NULL. Guarded on JSON_TYPE so a JSON `null` does not
 *  arrive as the four-character string "null" and get read as a value. The alias
 *  is a module constant (`ae`, the earliest row; `fe`, the fulfillment one). */
function jsonText(key: string, alias = 'ae'): Prisma.Sql {
  const path = jsonPath(key);
  const a = Prisma.raw(alias);
  return Prisma.sql`CASE WHEN JSON_TYPE(JSON_EXTRACT(${a}.details, ${path})) = 'STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(${a}.details, ${path})) END`;
}

/** Does the details object CARRY this key at all (R0's `rows`/`rowsOmitted`)? */
function jsonHasKey(key: string): Prisma.Sql {
  return Prisma.sql`CASE WHEN JSON_CONTAINS_PATH(ae.details, 'one', ${jsonPath(key)}) THEN 1 ELSE 0 END`;
}

/** Is there a non-empty typed reference (R5's only question)? */
function jsonHasText(key: string): Prisma.Sql {
  const path = jsonPath(key);
  return Prisma.sql`CASE WHEN JSON_TYPE(JSON_EXTRACT(ae.details, ${path})) = 'STRING' AND JSON_UNQUOTE(JSON_EXTRACT(ae.details, ${path})) <> '' THEN 1 ELSE 0 END`;
}

/** The membership scope, as SQL. A member of nothing matches nothing. */
function companyScopeSql(viewer: Viewer, alias: string): Prisma.Sql {
  if (viewer.kind === 'admin') return Prisma.empty;
  const a = Prisma.raw(alias);
  if (viewer.companyIds.length === 0) return Prisma.sql` AND 1 = 0`;
  return Prisma.sql` AND ${a}.companyId IN (${Prisma.join(viewer.companyIds)})`;
}

type BatchSummarySqlRow = {
  nonAttributableBatches: unknown;
  noBatchRows: unknown;
  orderNumberMatches: unknown;
  batchId: string | null;
  minChangeTime: Date | null;
  rowCount: unknown;
  units: unknown;
  productCount: unknown;
  logTypes: string | null;
  distinctStamps: unknown;
  firstStamp: string | null;
  lastStamp: string | null;
  unstampedRows: unknown;
  auditId: number | null;
  auditActionType: string | null;
  auditEntityId: string | null;
  auditOrderAttributionSource: string | null;
  auditIntent: string | null;
  auditSelectedExternalOrderId: string | null;
  auditOrderId: string | null;
  auditHasOrderReference: unknown;
  auditHasRows: unknown;
  auditHasRowsOmitted: unknown;
  fulfillmentAuditId: number | null;
  fulfillmentActionType: string | null;
  fulfillmentEntityId: string | null;
  fulfillmentOrderId: string | null;
  attemptId: number | null;
  attemptOutcome: string | null;
  attemptEvidence: string | null;
  attemptReason: string | null;
  attemptSource: string | null;
  attemptActorUserId: number | null;
  attemptOrderRecordId: string | null;
};

/**
 * ONE statement: the window's batch summaries, each batch's earliest audit row,
 * its FULFILLMENT event and its latest attempt, and the two exclusion figures.
 *
 * The exclusions ride along in a one-row CTE that the batches LEFT JOIN onto, so
 * an empty window still answers with its coverage instead of losing it with the
 * rows. The order-number filter is a subquery rather than an id list: the read
 * stays one statement, and nothing about a batch is ever enumerated into SQL.
 *
 * THE FULFILLMENT EVENT IS READ BATCH-WIDE (QA-6). It joins through its OWN
 * id-scalar subquery rather than being read off `ae`: the earliest audit row is
 * not necessarily the fulfillment one, and a batch whose fulfillment event came
 * second used to arrive here with no fulfillment fact at all — so the Attribute…
 * control lit on a batch the core refuses, which is the OC-1 class exactly. Both
 * joins are 1:1 on `id`, so neither can multiply a batch's units.
 */
function batchSummarySql(
  start: Date,
  end: Date,
  orderNumber: string | undefined,
  viewer: Viewer
): Prisma.Sql {
  const orderMatches =
    orderNumber === undefined
      ? Prisma.sql`0`
      : Prisma.sql`(SELECT COUNT(*) FROM external_orders o WHERE o.orderNumber = ${orderNumber}${companyScopeSql(viewer, 'o')})`;

  const orderFilter =
    orderNumber === undefined
      ? Prisma.empty
      : Prisma.sql` AND SUM(CASE WHEN l.orderRecordId IN (SELECT f.id FROM external_orders f WHERE f.orderNumber = ${orderNumber}${companyScopeSql(viewer, 'f')}) THEN 1 ELSE 0 END) > 0`;

  // The population predicate WITHOUT its batch-id conjunct: the ungroupable
  // outbound rows are exactly the ones it would otherwise exclude.
  const unbatchedOutbound = renderRowWhereSql(
    { ...ATTRIBUTABLE_PREDICATE, batchIdRequired: false },
    'n'
  );

  return Prisma.sql`WITH t AS (
  SELECT
    (SELECT COUNT(*) FROM (SELECT k.batchId FROM inventory_logs k WHERE k.changeTime >= ${start} AND k.changeTime < ${end} AND k.batchId IS NOT NULL GROUP BY k.batchId HAVING SUM(CASE WHEN ${rowWhereSql('k')} THEN 1 ELSE 0 END) = 0) nk) AS nonAttributableBatches,
    (SELECT COUNT(*) FROM inventory_logs n WHERE n.changeTime >= ${start} AND n.changeTime < ${end} AND ${unbatchedOutbound} AND n.batchId IS NULL) AS noBatchRows,
    ${orderMatches} AS orderNumberMatches
),
b AS (
  SELECT
    l.batchId AS batchId,
    MIN(l.changeTime) AS minChangeTime,
    COUNT(*) AS rowCount,
    CAST(SUM(-l.delta) AS SIGNED) AS units,
    COUNT(DISTINCT l.productId) AS productCount,
    GROUP_CONCAT(DISTINCT l.logType ORDER BY l.logType SEPARATOR ',') AS logTypes,
    COUNT(DISTINCT l.orderRecordId) AS distinctStamps,
    MIN(l.orderRecordId) AS firstStamp,
    MAX(l.orderRecordId) AS lastStamp,
    SUM(CASE WHEN l.orderRecordId IS NULL THEN 1 ELSE 0 END) AS unstampedRows
  FROM inventory_logs l
  WHERE ${rowWhereSql('l')}
  GROUP BY l.batchId
  HAVING MIN(l.changeTime) >= ${start} AND MIN(l.changeTime) < ${end}${orderFilter}
)
SELECT
  t.nonAttributableBatches, t.noBatchRows, t.orderNumberMatches,
  b.batchId, b.minChangeTime, b.rowCount, b.units, b.productCount, b.logTypes,
  b.distinctStamps, b.firstStamp, b.lastStamp, b.unstampedRows,
  ae.id AS auditId, ae.actionType AS auditActionType, ae.entityId AS auditEntityId,
  ${jsonText(AUDIT_SOURCE_KEY)} AS auditOrderAttributionSource,
  ${jsonText(AUDIT_INTENT_KEY)} AS auditIntent,
  ${jsonText(AUDIT_SELECTED_KEY)} AS auditSelectedExternalOrderId,
  ${jsonText(AUDIT_ORDER_KEY)} AS auditOrderId,
  ${jsonHasText(AUDIT_REFERENCE_KEY)} AS auditHasOrderReference,
  ${jsonHasKey(AUDIT_ROWS_KEY)} AS auditHasRows,
  ${jsonHasKey(AUDIT_ROWS_OMITTED_KEY)} AS auditHasRowsOmitted,
  fe.id AS fulfillmentAuditId, fe.actionType AS fulfillmentActionType,
  fe.entityId AS fulfillmentEntityId,
  ${jsonText(AUDIT_ORDER_KEY, 'fe')} AS fulfillmentOrderId,
  ap.id AS attemptId, ap.outcome AS attemptOutcome, ap.evidence AS attemptEvidence,
  ap.reason AS attemptReason, ap.source AS attemptSource, ap.actorUserId AS attemptActorUserId,
  ap.orderRecordId AS attemptOrderRecordId
FROM t
LEFT JOIN b ON 1 = 1
LEFT JOIN audit_logs ae ON ae.id = (SELECT a2.id FROM audit_logs a2 WHERE a2.batchId = b.batchId ORDER BY a2.id ASC LIMIT 1)
LEFT JOIN audit_logs fe ON fe.id = (SELECT f2.id FROM audit_logs f2 WHERE f2.batchId = b.batchId AND f2.actionType IN (${Prisma.join(
    [...FULFILLMENT_ACTION_TYPE_LIST]
  )}) ORDER BY f2.id ASC LIMIT 1)
LEFT JOIN order_attribution_attempts ap ON ap.id = (SELECT p2.id FROM order_attribution_attempts p2 WHERE p2.batchId = b.batchId ORDER BY p2.attemptedAt DESC, p2.id DESC LIMIT 1)
ORDER BY b.minChangeTime DESC, b.batchId DESC`;
}

// ---------------------------------------------------------------------------
// Facts -> class
// ---------------------------------------------------------------------------

type BatchFacts = {
  batchId: string;
  at: Date;
  rowCount: number;
  units: number;
  productCount: number;
  logTypes: string[];
  /** The distinct-stamp FACTS the rules need — never a fan-out of ids. */
  stamps: Array<string | null>;
  distinctStamps: number;
  /** The batch's ONE stamp, or null when it is unstamped or mixed. */
  theStamp: string | null;
  /** The EARLIEST audit row, in the shape the derivation reads. */
  audit: DeriveAuditEvent | null;
  /**
   * The audit rows the batch-grain rules read (`batchEvidence`), id-ascending.
   * The LIST read carries only the earliest one (D7's single statement, D6's
   * no-details rule), so its array holds at most one; the drill-down and the
   * manual-attribution core hand over every row filed under the batch id.
   */
  auditRows: ReadonlyArray<BatchAuditRow>;
  attempt: {
    id: number;
    outcome: string;
    evidence: string | null;
    reason: string | null;
    source: string | null;
    actorUserId: number | null;
    orderRecordId: string | null;
  } | null;
};

type ClassifiedBatch = BatchFacts & {
  attributable: boolean;
  how: AttributionHow;
  source: AttributionRow['source'];
  actorUserId: number | null;
  derived: DerivedClass | null;
  /** Evidence is a fulfillment — recorded, or R2/R2b. */
  fulfillment: boolean;
  /** The order the fulfillment event named (R2b's completion target). */
  fulfillmentOrderId: string | null;
};

const ATTEMPT_SOURCES: ReadonlySet<string> = new Set([
  'live-deduct',
  'live-adjust',
  'live-batch-adjust',
  'fulfillment',
  'manual',
]);

/** Compose a chip key, or nothing when the row speaks a word we do not know. */
function classKeyOf(outcome: string, label: string | null): AttributionClassKey | null {
  const key = `${outcome}·${label ?? 'unknown'}`;
  return CLASS_KEY_SET.has(key) ? (key as AttributionClassKey) : null;
}

/** The stamp FACTS an aggregate carries, in the shape the rules read them. */
type StampFacts = Pick<BatchFacts, 'stamps' | 'distinctStamps' | 'theStamp'>;

/**
 * `COUNT(DISTINCT orderRecordId)` ignores NULLs, so the aggregate says HOW MANY
 * distinct ids there are, the MIN/MAX say which (for one or two of them), and
 * the unstamped count says whether any row carries none. That is everything the
 * rules ask — read once here, by the report's summary read and by the
 * drill-down's batch-scoped aggregate alike (QA-1).
 */
function stampFactsOf(
  distinctStamps: number,
  firstStamp: string | null,
  lastStamp: string | null,
  unstampedRows: number
): StampFacts {
  const stamps: Array<string | null> = [];
  if (distinctStamps >= 1 && firstStamp !== null) stamps.push(firstStamp);
  if (distinctStamps >= 2 && lastStamp !== null && lastStamp !== firstStamp) {
    stamps.push(lastStamp);
  }
  if (unstampedRows > 0) stamps.push(null);
  return { stamps, distinctStamps, theStamp: distinctStamps === 1 ? firstStamp : null };
}

function summaryToFacts(row: BatchSummarySqlRow): BatchFacts | null {
  if (row.batchId === null || row.minChangeTime === null) return null;

  const stampFacts = stampFactsOf(
    toNumber(row.distinctStamps),
    row.firstStamp,
    row.lastStamp,
    toNumber(row.unstampedRows)
  );

  const details: Record<string, unknown> = {};
  if (row.auditOrderAttributionSource !== null) {
    details[AUDIT_SOURCE_KEY] = row.auditOrderAttributionSource;
  }
  if (row.auditIntent !== null) details[AUDIT_INTENT_KEY] = row.auditIntent;
  if (row.auditSelectedExternalOrderId !== null) {
    details[AUDIT_SELECTED_KEY] = row.auditSelectedExternalOrderId;
  }
  if (row.auditOrderId !== null) details[AUDIT_ORDER_KEY] = row.auditOrderId;
  if (toNumber(row.auditHasOrderReference) === 1) details[AUDIT_REFERENCE_KEY] = REFERENCE_PRESENT;

  // The audit rows the batch-grain helper reads, ID-ASCENDING: the earliest one,
  // and — when the batch's fulfillment event is a DIFFERENT row — that one after
  // it (QA-6). `fe` is the lowest-id fulfillment row, so it can never sort before
  // `ae`. Only the TYPED fact travels (D6): the order the event names, never the
  // writer's blob, so R0's shape keys stay exactly what `ae` reported.
  const auditRows: BatchAuditRow[] = [];
  if (row.auditId !== null) {
    auditRows.push({
      actionType: row.auditActionType ?? '',
      entityId: row.auditEntityId,
      details: {
        ...details,
        // R0 reads the SHAPE of the summary event, so the PRESENCE of its two
        // keys is the whole fact — the values never leave the audit row (D6).
        ...(toNumber(row.auditHasRows) === 1 ? { [AUDIT_ROWS_KEY]: null } : {}),
        ...(toNumber(row.auditHasRowsOmitted) === 1 ? { [AUDIT_ROWS_OMITTED_KEY]: null } : {}),
      },
    });
  }
  if (row.fulfillmentAuditId !== null && row.fulfillmentAuditId !== row.auditId) {
    auditRows.push({
      actionType: row.fulfillmentActionType ?? '',
      entityId: row.fulfillmentEntityId,
      details:
        row.fulfillmentOrderId === null ? {} : { [AUDIT_ORDER_KEY]: row.fulfillmentOrderId },
    });
  }

  return {
    batchId: row.batchId,
    at: row.minChangeTime,
    rowCount: toNumber(row.rowCount),
    units: toNumber(row.units),
    productCount: toNumber(row.productCount),
    logTypes: (row.logTypes ?? '').split(',').filter((t) => t.length > 0),
    ...stampFacts,
    audit:
      row.auditId === null
        ? null
        : {
            id: row.auditId,
            actionType: row.auditActionType ?? '',
            entityId: row.auditEntityId,
            details,
          },
    auditRows,
    attempt:
      row.attemptId === null
        ? null
        : {
            id: row.attemptId,
            outcome: row.attemptOutcome ?? '',
            evidence: row.attemptEvidence,
            reason: row.attemptReason,
            source: row.attemptSource,
            actorUserId: row.attemptActorUserId,
            orderRecordId: row.attemptOrderRecordId,
          },
  };
}

/**
 * R0 and the class, ONCE, in TypeScript (D7). A recorded attempt wins; a batch
 * with none — or with an attempt row speaking a word outside the closed
 * vocabulary, which only a hand-written statement could produce — falls to the
 * derivation, which is total.
 */
function classifyBatch(facts: BatchFacts, recordingSince: Date | null): ClassifiedBatch {
  const auditEvents = facts.audit === null ? [] : [facts.audit];

  // ONE evidence assembly, shared with the drill-down and with the
  // manual-attribution core (OC-2): R0, whether a fulfillment moved this stock,
  // and which order that event named.
  const evidence = batchEvidence(
    facts.auditRows,
    facts.logTypes.map((logType) => ({ logType }))
  );
  const attributable = evidence.attributable;

  // THE FULFILLMENT FACT, read the way the core reads it (OC-1): the ledger's
  // own event OR the latest attempt's evidence — in BOTH branches below. Keying
  // it on the attempt alone let a MANUAL attempt recorded after an R2b
  // completion re-open the Attribute… control on a batch the core refuses,
  // because the manual row displaced the fulfillment one.
  const fulfillment =
    evidence.fulfillmentEvent !== null || facts.attempt?.evidence === 'fulfillment';

  const recordedKey =
    facts.attempt === null
      ? null
      : classKeyOf(facts.attempt.outcome, facts.attempt.evidence ?? facts.attempt.reason);

  if (facts.attempt !== null && recordedKey !== null) {
    const source =
      facts.attempt.source !== null && ATTEMPT_SOURCES.has(facts.attempt.source)
        ? (facts.attempt.source as AttemptSource)
        : 'pipeline';
    return {
      ...facts,
      attributable,
      how: { classKey: recordedKey, sentence: RECORDED_SENTENCES[recordedKey] },
      source,
      actorUserId: facts.attempt.actorUserId,
      derived: null,
      fulfillment,
      fulfillmentOrderId: evidence.fulfillmentOrderId,
    };
  }

  const derived = deriveHistoricalAttempt(
    { batchId: facts.batchId, stamps: facts.stamps, at: facts.at },
    auditEvents,
    { recordingSince }
  );
  const derivedKey =
    classKeyOf(derived.outcome, derived.evidence ?? derived.reason ?? null) ?? 'none·unknown';

  return {
    ...facts,
    attributable,
    how: {
      classKey: derivedKey,
      sentence: derived.sentence,
      ruleId: derived.ruleId,
      ...(derived.ledgerUnstamped ? { ledgerUnstamped: true as const } : {}),
      ...(derived.postLaneGap ? { postLaneGap: true as const } : {}),
    },
    source: 'derived',
    actorUserId: null,
    derived,
    fulfillment,
    fulfillmentOrderId: evidence.fulfillmentOrderId,
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

type OrderProjection = {
  id: string;
  orderNumber: string;
  internalStatus: string;
  externalCreatedAt: Date | null;
  companyId: string;
  integration: { platform: string } | null;
};

/** Field by field, never a spread: the second half of the D6 PII contract. */
function projectOrder(order: OrderProjection | undefined, viewer: Viewer): OrderRef {
  if (order === undefined) return { orderMissing: true };
  if (viewer.kind === 'member' && !viewer.companyIds.includes(order.companyId)) {
    return { orderRedacted: true, reason: REDACTED_REASON };
  }
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    internalStatus: order.internalStatus,
    platform: order.integration?.platform ?? 'unknown',
    externalCreatedAt: iso(order.externalCreatedAt),
  };
}

function actorOf(
  actorUserId: number | null,
  actors: Map<number, { id: number; username: string }>,
  viewer: Viewer
): { id: number; username: string } | null {
  // A member viewer never learns WHO — the global batch population is visible,
  // the operator behind it is not (D9).
  if (viewer.kind === 'member' || actorUserId === null) return null;
  return actors.get(actorUserId) ?? null;
}

function buildRow(
  batch: ClassifiedBatch,
  orders: Map<string, OrderProjection>,
  actors: Map<number, { id: number; username: string }>,
  viewer: Viewer
): AttributionRow {
  const order = batch.theStamp === null ? null : projectOrder(orders.get(batch.theStamp), viewer);
  const stampedFulfillment = batch.fulfillment && batch.theStamp !== null;
  const orderNumber =
    batch.theStamp === null ? null : (orders.get(batch.theStamp)?.orderNumber ?? null);

  // PARTLY STAMPED (OC-6): exactly one id, and rows beside it carrying none. The
  // guarded write names the id it locked, so it can move the stamped half or the
  // unstamped half and never the batch — the core refuses this shape outright,
  // and so does the predicate that decides whether to offer the control.
  const partiallyStamped = batch.distinctStamps === 1 && batch.stamps.includes(null);

  // FULFILLED, AND THE EVENT NAMES NOTHING (QA-7). R2b lets an unstamped
  // fulfillment batch COMPLETE the stamp its own event names — and when the event
  // names no order at all, there is no id that completion could target: the core
  // answers every order the picker could offer with `R2B_OTHER_TARGET`. Offering
  // the control here is offering a button whose only outcome is a 409.
  const unnamedFulfillment = batch.fulfillment && batch.fulfillmentOrderId === null;

  const canAttribute =
    batch.attributable &&
    batch.rowCount <= MANUAL_ATTRIBUTION_ROW_LIMIT &&
    batch.distinctStamps <= 1 &&
    !partiallyStamped &&
    !stampedFulfillment &&
    !unnamedFulfillment;

  return {
    batchId: batch.batchId,
    at: batch.at.toISOString(),
    source: batch.source,
    actor: actorOf(batch.actorUserId, actors, viewer),
    how: batch.how,
    logTypes: batch.logTypes,
    units: batch.units,
    productCount: batch.productCount,
    order,
    canAttribute,
    // THE LOCK IS THE FACT, never the rule id (OC-1). An UNSTAMPED batch whose
    // fulfillment event names an order may only COMPLETE that stamp — which is
    // what the core enforces, whether or not the derivation is what classified
    // it. Reading `ruleId === 'R2b'` lost the lock the moment any attempt row
    // existed, and the picker then offered every order in the book.
    attributeLock:
      batch.distinctStamps === 0 && batch.fulfillmentOrderId !== null
        ? { orderRecordId: batch.fulfillmentOrderId, reason: 'r2b-completion' }
        : null,
    fulfilledAgainst: stampedFulfillment
      ? { orderRecordId: batch.theStamp as string, orderNumber }
      : null,
  };
}

async function loadOrders(ids: string[]): Promise<Map<string, OrderProjection>> {
  const map = new Map<string, OrderProjection>();
  if (ids.length === 0) return map;
  // ONE findMany for the page, through the frozen select. A member's redaction
  // happens on the way OUT (projectOrder), so the count of statements does not
  // depend on who is asking.
  const rows = (await prisma.externalOrder.findMany({
    where: { id: { in: ids } },
    select: RECONCILIATION_ORDER_SELECT,
  })) as unknown as OrderProjection[];
  for (const row of rows) map.set(row.id, row);
  return map;
}

async function loadActors(
  ids: number[],
  viewer: Viewer
): Promise<Map<number, { id: number; username: string }>> {
  const map = new Map<number, { id: number; username: string }>();
  // `actorUserId` is a soft int with no relation, so identity is ONE batched
  // lookup per read — never a per-row one (OCk-7).
  if (viewer.kind === 'member' || ids.length === 0) return map;
  const rows = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: RECONCILIATION_USER_SELECT,
  });
  for (const row of rows) map.set(row.id, { id: row.id, username: row.username });
  return map;
}

// ---------------------------------------------------------------------------
// The recording boundary
// ---------------------------------------------------------------------------

let recordingSinceMemo: Date | null = null;

/**
 * ATTEMPTS_RECORDING_SINCE — the first attempt row's `attemptedAt` (spec §2.1).
 *
 * Memoized ONLY when it is non-null. A null means "recording has not started",
 * and memoizing that would freeze the answer for the life of the process: every
 * batch written after the deploy would keep being labelled "before the lane"
 * until a restart. The read is a PK-ordered `LIMIT 1`, so paying for it again is
 * cheap compared to a report that lies about when the lane began (OCk-8).
 */
export async function getRecordingSince(): Promise<Date | null> {
  if (recordingSinceMemo !== null) return recordingSinceMemo;
  const first = await prisma.orderAttributionAttempt.findFirst({
    orderBy: { id: 'asc' },
    select: { attemptedAt: true },
  });
  if (!first) return null;
  recordingSinceMemo = first.attemptedAt;
  return recordingSinceMemo;
}

/** Drop the memo between tests (and only there). */
export function __resetForTests(): void {
  recordingSinceMemo = null;
}

// ---------------------------------------------------------------------------
// THE REPORT
// ---------------------------------------------------------------------------

export async function getAttributionReport(
  input: AttributionInput,
  viewer: Viewer
): Promise<AttributionReport> {
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const { start, end } = windowBounds(input.from, input.to);

  const recordingSince = await getRecordingSince();
  const summaryRows = await prisma.$queryRaw<BatchSummarySqlRow[]>(
    batchSummarySql(start, end, input.orderNumber, viewer)
  );

  const head = summaryRows[0];
  const exclusionCounts = {
    nonAttributable: toNumber(head?.nonAttributableBatches),
    noBatchRows: toNumber(head?.noBatchRows),
  };
  const orderNumberMatches = toNumber(head?.orderNumberMatches);

  const facts = summaryRows
    .map(summaryToFacts)
    .filter((fact): fact is BatchFacts => fact !== null);
  const classified = facts.map((fact) => classifyBatch(fact, recordingSince));
  const attributable = classified.filter((batch) => batch.attributable);

  // `byClass` is computed here — after the window and order-number filters, and
  // BEFORE the active class filter — so a chip never reports the count of the
  // chip that is currently selected (D7).
  const byClass = Object.fromEntries(
    ATTRIBUTION_CLASS_KEYS.map((key) => [key, 0])
  ) as Record<AttributionClassKey, number>;
  for (const batch of attributable) byClass[batch.how.classKey] += 1;

  const derivedCount = attributable.filter((batch) => batch.source === 'derived').length;
  const ledgerUnstamped = attributable.filter((batch) => batch.how.ledgerUnstamped === true).length;
  const mixedStamps = attributable.filter((batch) => batch.distinctStamps > 1).length;
  const stampDisagrees = attributable.filter(
    (batch) =>
      batch.attempt !== null &&
      batch.attempt.outcome === 'attributed' &&
      batch.attempt.orderRecordId !== null &&
      batch.attempt.orderRecordId !== batch.theStamp
  ).length;

  const selected =
    input.classKey === undefined
      ? attributable
      : attributable.filter((batch) => batch.how.classKey === input.classKey);

  // The keyset page, over the CLASSIFIED summaries: (changeTime DESC, batchId
  // DESC), which is the order the statement already returned them in.
  const ordered = [...selected].sort((a, b) => {
    const byTime = b.at.getTime() - a.at.getTime();
    return byTime !== 0 ? byTime : (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0);
  });
  const after =
    cursor === null
      ? ordered
      : ordered.filter(
          (batch) =>
            batch.at.getTime() < cursor.t ||
            (batch.at.getTime() === cursor.t && batch.batchId < cursor.b)
        );
  const page = after.slice(0, input.limit);

  const orders = await loadOrders(
    Array.from(new Set(page.map((batch) => batch.theStamp).filter((id): id is string => id !== null)))
  );
  const actors = await loadActors(
    Array.from(
      new Set(page.map((batch) => batch.actorUserId).filter((id): id is number => id !== null))
    ),
    viewer
  );

  const rows = page.map((batch) => buildRow(batch, orders, actors, viewer));
  const consumed = cursor?.c ?? 0;
  const count = selected.length;
  const moreCount = Math.max(count - consumed - rows.length, 0);
  const last = page[page.length - 1];

  const notes: string[] = [R0_INVISIBLE_NOTE];
  if (viewer.kind === 'member' && input.orderNumber !== undefined && orderNumberMatches === 0) {
    notes.push(NO_MEMBER_ORDER_NOTE);
  }
  if (attributable.length === 0) notes.push(NO_DENOMINATOR_NOTE);

  return {
    window: { from: input.from, to: input.to },
    rows,
    totals: {
      attributable: attributable.length,
      byClass,
      exclusions: {
        nonAttributable: exclusionCounts.nonAttributable,
        historicalMassUpdate: classified.length - attributable.length,
        noBatchRows: exclusionCounts.noBatchRows,
      },
    },
    coverage: {
      batchesInWindow: classified.length,
      rowsReturned: rows.length,
      derivedShare:
        attributable.length === 0
          ? null
          : Math.round((derivedCount / attributable.length) * 1000) / 1000,
      ledgerUnstamped,
      needsALook: { stampDisagreesWithLatestAttempt: stampDisagrees, mixedStamps },
      recordingSince: iso(recordingSince),
      orderFilterScope: viewer.kind === 'admin' ? 'all orders' : 'your companies only',
      notes,
    },
    count,
    moreCount,
    nextCursor:
      moreCount > 0 && last !== undefined
        ? encodeCursor({ t: last.at.getTime(), b: last.batchId, c: consumed + rows.length })
        : null,
    definitions: { ...DEFINITIONS },
  };
}

// ---------------------------------------------------------------------------
// THE DRILL-DOWN
// ---------------------------------------------------------------------------

const ATTRIBUTION_ACTION_TYPE = 'INVENTORY_ATTRIBUTE';

const AUDIT_EVENT_LABEL = 'from the audit event (free text, admin-visible on /admin/logs)' as const;

/** What one batch's ledger sums to, over EVERY row (QA-1) — the `b` CTE's shape. */
type BatchAggregateSqlRow = {
  rowCount: unknown;
  units: unknown;
  productCount: unknown;
  minChangeTime: Date | null;
  logTypes: string | null;
  distinctStamps: unknown;
  firstStamp: string | null;
  lastStamp: string | null;
  unstampedRows: unknown;
};

/**
 * The batch-summary shape, scoped to ONE batch id (QA-1).
 *
 * The drill-down's ledger array is bounded, and the row built off it was bounded
 * with it: a five-hundred-row batch reported the units of its first fifty, and a
 * batch stamped from row 100 reported itself unstamped — a class, an order and a
 * `canAttribute` that were simply false on the wire. So over the bound the row
 * comes from here instead: exact figures over the full ledger, and not one row
 * materialised to get them.
 *
 * The batch id comes FIRST and the population predicate after it — the
 * manual-attribution core's lock statement, mirrored.
 */
function batchAggregateSql(batchId: string): Prisma.Sql {
  return Prisma.sql`SELECT
  COUNT(*) AS rowCount,
  CAST(SUM(-l.delta) AS SIGNED) AS units,
  COUNT(DISTINCT l.productId) AS productCount,
  MIN(l.changeTime) AS minChangeTime,
  GROUP_CONCAT(DISTINCT l.logType ORDER BY l.logType SEPARATOR ',') AS logTypes,
  COUNT(DISTINCT l.orderRecordId) AS distinctStamps,
  MIN(l.orderRecordId) AS firstStamp,
  MAX(l.orderRecordId) AS lastStamp,
  SUM(CASE WHEN l.orderRecordId IS NULL THEN 1 ELSE 0 END) AS unstampedRows
FROM inventory_logs l
WHERE l.batchId = ${batchId} AND ${rowWhereSql('l')}`;
}

/** The ledger-derived half of `BatchFacts` — from rows, or from the aggregate. */
type LedgerFacts = Pick<
  BatchFacts,
  | 'at'
  | 'rowCount'
  | 'units'
  | 'productCount'
  | 'logTypes'
  | 'stamps'
  | 'distinctStamps'
  | 'theStamp'
>;

/** Every row of the batch is in hand, so the figures are read straight off them. */
function ledgerFactsFromRows(
  rows: ReadonlyArray<{
    productId: number;
    delta: number;
    logType: unknown;
    changeTime: Date;
    orderRecordId: string | null;
  }>
): LedgerFacts {
  const stampSet = Array.from(new Set(rows.map((row) => row.orderRecordId)));
  const stampedIds = stampSet.filter((id): id is string => id !== null);
  return {
    at: rows.reduce((min, row) => (row.changeTime < min ? row.changeTime : min), rows[0].changeTime),
    rowCount: rows.length,
    units: rows.reduce((sum, row) => sum - row.delta, 0),
    productCount: new Set(rows.map((row) => row.productId)).size,
    logTypes: Array.from(new Set(rows.map((row) => String(row.logType)))),
    stamps: stampSet,
    distinctStamps: stampedIds.length,
    theStamp: stampedIds.length === 1 ? stampedIds[0] : null,
  };
}

/** The same facts, over the FULL ledger, without materialising a row (QA-1). */
function ledgerFactsFromAggregate(row: BatchAggregateSqlRow, fallbackAt: Date): LedgerFacts {
  return {
    at: row.minChangeTime ?? fallbackAt,
    rowCount: toNumber(row.rowCount),
    units: toNumber(row.units),
    productCount: toNumber(row.productCount),
    logTypes: (row.logTypes ?? '').split(',').filter((t) => t.length > 0),
    ...stampFactsOf(
      toNumber(row.distinctStamps),
      row.firstStamp,
      row.lastStamp,
      toNumber(row.unstampedRows)
    ),
  };
}

function attemptDetailsOf(value: unknown): AttemptDetails | null {
  if (!isObj(value)) return null;
  const out: AttemptDetails = {};
  if (value.intent === 'order' || value.intent === 'damage-loss' || value.intent === 'other') {
    out.intent = value.intent;
  }
  if (typeof value.overwriteReason === 'string') out.overwriteReason = value.overwriteReason;
  if (typeof value.rowCount === 'number') out.rowCount = value.rowCount;
  if (value.completedFulfillment === true) out.completedFulfillment = true;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The drill-down for one batch: its ledger rows, the audit event that wrote them
 * (labelled, because it carries the operator's own words), every attempt ever
 * recorded against it, the manual attributions, and the derivation when that is
 * what classified it. `null` when the batch has no population row at all — the
 * route answers 404.
 *
 * THIS READ HAS NO STATEMENT BUDGET. D7's AT-MOST-FIVE is the REPORT's bound,
 * because that one serves a whole window and a poll; this one serves a single
 * batch a person opened deliberately. It spends five statements on a batch inside
 * the row bound and six on one over it — the sixth being the exact aggregate that
 * keeps `batch` true (QA-1).
 */
export async function getBatchDetail(batchId: string, viewer: Viewer): Promise<BatchDetail | null> {
  const ledger = await prisma.inventory_logs.findMany({
    // Spread ORDER matters: rowWhere carries its own `batchId: { not: null }`, so the
    // scalar batch id must come AFTER the spread — the write path learned this at M2b
    // (pack 3e); the live drive caught this read-path twin (489 foreign rows + a bogus
    // R1b from foreign stamps).
    where: { ...rowWhere, batchId },
    orderBy: { id: 'asc' },
    // BOUNDED at the manual-attribution limit + 1 (OC-8). The extra row is what
    // makes the bound self-describing: it is enough to KNOW the batch is over the
    // limit (so `canAttribute` stays false, exactly as the core would say)
    // without handing the browser a pre-lane mass update's whole ledger.
    take: MANUAL_ATTRIBUTION_ROW_LIMIT + 1,
    select: {
      id: true,
      productId: true,
      delta: true,
      logType: true,
      changeTime: true,
      orderRecordId: true,
      products: { select: { name: true } },
    },
  });
  if (ledger.length === 0) return null;

  const ledgerRowsTruncated = ledger.length > MANUAL_ATTRIBUTION_ROW_LIMIT;
  const shownRows = ledgerRowsTruncated
    ? ledger.slice(0, MANUAL_ATTRIBUTION_ROW_LIMIT)
    : ledger;

  const [auditEvents, attempts, attributionEvents, recordingSince, aggregate] = await Promise.all([
    prisma.auditLog.findMany({
      where: { batchId },
      orderBy: { id: 'asc' },
      select: { id: true, actionType: true, entityId: true, details: true, createdAt: true },
    }),
    prisma.orderAttributionAttempt.findMany({
      where: { batchId },
      orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        attemptedAt: true,
        outcome: true,
        evidence: true,
        reason: true,
        source: true,
        actorUserId: true,
        orderRecordId: true,
        previousOrderRecordId: true,
        details: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { entityType: 'INVENTORY', entityId: batchId, actionType: ATTRIBUTION_ACTION_TYPE },
      orderBy: { id: 'asc' },
      select: { id: true, createdAt: true, userId: true, details: true },
    }),
    getRecordingSince(),
    // Only when the array was cut: inside the bound the rows in hand ARE the
    // batch, and paying for an aggregate to re-derive them would be a statement
    // spent to learn what we already read.
    ledgerRowsTruncated
      ? prisma.$queryRaw<BatchAggregateSqlRow[]>(batchAggregateSql(batchId))
      : Promise.resolve<BatchAggregateSqlRow[]>([]),
  ]);

  const latest = attempts[attempts.length - 1];
  const earliest = auditEvents[0];
  const earliestDetails = isObj(earliest?.details) ? earliest.details : {};

  // The row's figures are the WHOLE batch's (QA-1). An aggregate that came back
  // empty is not a batch of zero rows — the ledger read just returned some — so
  // the read rows stand in rather than reporting a batch that does not exist.
  const aggregateRow = aggregate[0];
  const ledgerFacts =
    aggregateRow === undefined
      ? ledgerFactsFromRows(ledger)
      : ledgerFactsFromAggregate(aggregateRow, ledger[0].changeTime);

  const facts: BatchFacts = {
    batchId,
    ...ledgerFacts,
    audit:
      earliest === undefined
        ? null
        : {
            id: earliest.id,
            actionType: earliest.actionType,
            entityId: earliest.entityId,
            details: earliestDetails,
          },
    // EVERY audit row filed under this batch id, id-ascending — the same array
    // the manual-attribution core reads (OC-2). Reading the action type off the
    // earliest row while reading the R0 shape keys across all of them was how
    // this surface came to offer a batch the core refuses.
    auditRows: auditEvents.map((event) => ({
      actionType: event.actionType,
      entityId: event.entityId,
      details: event.details,
    })),
    attempt:
      latest === undefined
        ? null
        : {
            id: latest.id,
            outcome: latest.outcome,
            evidence: latest.evidence,
            reason: latest.reason,
            source: latest.source,
            actorUserId: latest.actorUserId,
            orderRecordId: latest.orderRecordId,
          },
  };

  const batch = classifyBatch(facts, recordingSince);
  const orders = await loadOrders(batch.theStamp === null ? [] : [batch.theStamp]);
  const actors = await loadActors(
    Array.from(
      new Set(
        [
          batch.actorUserId,
          ...attempts.map((attempt) => attempt.actorUserId),
          ...attributionEvents.map((event) => event.userId),
        ].filter((id): id is number => id !== null && id !== undefined)
      )
    ),
    viewer
  );

  const orderReference = earliestDetails[AUDIT_REFERENCE_KEY];
  const intent = earliestDetails[AUDIT_INTENT_KEY];
  const selectedExternalOrderId = earliestDetails[AUDIT_SELECTED_KEY];

  return {
    batch: buildRow(batch, orders, actors, viewer),
    ledgerRowsTruncated,
    ledgerRows: shownRows.map((row) => ({
      id: row.id,
      productId: row.productId,
      productName: row.products?.name ?? 'unknown product',
      delta: row.delta,
      logType: String(row.logType),
      changeTime: row.changeTime.toISOString(),
      orderRecordId: row.orderRecordId,
    })),
    auditEvent:
      earliest === undefined
        ? null
        : {
            id: earliest.id,
            actionType: earliest.actionType,
            createdAt: earliest.createdAt.toISOString(),
            ...(typeof orderReference === 'string' ? { orderReference } : {}),
            ...(typeof intent === 'string' ? { intent } : {}),
            ...(typeof selectedExternalOrderId === 'string' ? { selectedExternalOrderId } : {}),
            label: AUDIT_EVENT_LABEL,
          },
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      attemptedAt: attempt.attemptedAt.toISOString(),
      outcome: attempt.outcome,
      evidence: attempt.evidence,
      reason: attempt.reason,
      source: attempt.source,
      actor: actorOf(attempt.actorUserId, actors, viewer),
      orderRecordId: attempt.orderRecordId,
      previousOrderRecordId: attempt.previousOrderRecordId,
      details: attemptDetailsOf(attempt.details),
    })),
    attributionEvents: attributionEvents.map((event) => {
      const details = isObj(event.details) ? event.details : {};
      return {
        id: event.id,
        createdAt: event.createdAt.toISOString(),
        actor: actorOf(event.userId ?? null, actors, viewer),
        details: {
          orderRecordId: typeof details.orderRecordId === 'string' ? details.orderRecordId : '',
          previousOrderRecordId:
            typeof details.previousOrderRecordId === 'string' ? details.previousOrderRecordId : null,
          reason: typeof details.reason === 'string' ? details.reason : null,
          rowCount: typeof details.rowCount === 'number' ? details.rowCount : 0,
        },
      };
    }),
    derived: batch.derived,
  };
}

// ---------------------------------------------------------------------------
// THE PICKER
// ---------------------------------------------------------------------------

/**
 * MySQL's LIKE metacharacters, escaped so a typed one matches ITSELF (QA-10).
 *
 * `startsWith` renders `LIKE '<q>%'`, so `%` and `_` in the operator's own text
 * were wildcards: `q=%` matched every order in the book and handed the picker
 * twenty of them, looking for all the world like a search result. The backslash
 * goes first — escaping it after the others would escape the escapes.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The Attribute… picker's search: `orderNumber` STARTS WITH what was typed
 * (index-served, and the LIKE metacharacters escaped so the search is for the
 * text itself), at most twenty rows, and an EXACT count of what the bound left
 * off — the count and the page come from one read view, so "N more" can never
 * contradict the rows above it (the labeling-queue idiom).
 */
export async function searchOrders(
  q: string,
  viewer: Viewer
): Promise<{
  orders: Array<{
    id: string;
    orderNumber: string;
    platform: string;
    internalStatus: string;
    externalCreatedAt: string | null;
    itemCount: number;
  }>;
  moreCount: number;
}> {
  const query = q.trim();
  if (query.length === 0) return { orders: [], moreCount: 0 };

  const where = {
    orderNumber: { startsWith: escapeLike(query) },
    ...(viewer.kind === 'member' ? { companyId: { in: viewer.companyIds } } : {}),
  };

  const [count, rows] = await prisma.$transaction([
    prisma.externalOrder.count({ where }),
    prisma.externalOrder.findMany({
      where,
      orderBy: [{ externalCreatedAt: 'desc' }, { id: 'desc' }],
      take: ORDER_SEARCH_LIMIT,
      select: { ...RECONCILIATION_ORDER_SELECT, _count: { select: { items: true } } },
    }),
  ]);

  const projected = (rows as unknown as Array<OrderProjection & { _count: { items: number } }>).map(
    (row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      platform: row.integration?.platform ?? 'unknown',
      internalStatus: row.internalStatus,
      externalCreatedAt: iso(row.externalCreatedAt),
      itemCount: row._count.items,
    })
  );

  return { orders: projected, moreCount: Math.max(count - projected.length, 0) };
}
