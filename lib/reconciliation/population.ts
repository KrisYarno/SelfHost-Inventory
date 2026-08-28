/**
 * THE POPULATION (reconciliation lane, spec REV-7 §2.0; pack C2a.1, plan P-4).
 *
 * "Which ledger rows is this report even about?" is answered ONCE, here, and
 * every consumer — the attribution report, the derivation, the assistant tool,
 * the Overview line and the manual-attribution core — renders its filter from
 * this module rather than re-spelling the predicate. A second spelling is a
 * second definition, and two definitions of the population produce two truthful
 * reports that disagree.
 *
 * The same rule now covers the batch's own EVIDENCE (`batchEvidence`, below):
 * R0, whether a fulfillment moved this stock, and which order that event named.
 * Those three facts had three assemblies — the report row, the drill-down and
 * the manual-attribution core — and the disagreement showed up as an
 * Attribute… control the core refuses (OC-1/OC-2).
 *
 * THE PREDICATE IS A DATA TABLE, NOT TWO STRINGS. The lane needs the same rule
 * in two dialects: a Prisma `where` for the ORM reads and a raw SQL fragment for
 * the totals CTE and the manual-attribution core's row lock. Writing them as two
 * literals and asserting "they mean the same thing" is not something a test can
 * check — so both are RENDERED from `ATTRIBUTABLE_PREDICATE`, and the unit suite
 * renders a CHANGED table through both to prove neither carries its own copy.
 * Real-MySQL row-set parity between the two is the concurrency gate's scenario
 * 8b; this module's job is to make that parity structural rather than hopeful.
 *
 * R0 — WHAT THE PREDICATE ALONE CANNOT EXCLUDE. Before Phase 0b-1, a mass
 * update wrote its ADJUSTMENT rows under ONE batchId with a single
 * INVENTORY_BULK_UPDATE summary. Those rows satisfy the predicate in every
 * respect and are not deductions anybody could attribute to an order, so they
 * are removed at BATCH grain by `isAttributableBatch`, which is a verbatim port
 * of the diagnostics discriminator — the frozen historical rule, pinned against
 * the JS original in the unit suite.
 *
 * Next-free by contract, and TEXTUALLY WRITE-FREE (pack R-4): this module is on
 * the assistant's read path, where the zero-business-writes invariant forbids so
 * much as a Prisma write-method token appearing in the source — comments
 * included. The manual-attribution core is referred to BY NAME here, never by
 * the method it calls.
 */

import { Prisma, type inventory_logs_logType } from '@prisma/client';

/** The shape of the predicate table — the one source both renderers read. */
export type PopulationPredicate = {
  logTypes: ReadonlyArray<inventory_logs_logType>;
  deltaBelow: number;
  batchIdRequired: boolean;
};

/**
 * THE population: SALE/ADJUSTMENT rows that took stock OUT and carry a batch id.
 *
 * Frozen because it is a definition, not a setting. Changing it changes what
 * every coverage figure in the lane counts, so it changes in one place with the
 * definition string below it.
 */
const ATTRIBUTABLE_LOG_TYPES: ReadonlyArray<inventory_logs_logType> = Object.freeze([
  // Typed as the ledger's own enum, so a population naming a log type this
  // database does not have would not compile.
  'SALE',
  'ADJUSTMENT',
]);

export const ATTRIBUTABLE_PREDICATE = Object.freeze({
  logTypes: ATTRIBUTABLE_LOG_TYPES,
  deltaBelow: 0,
  batchIdRequired: true,
});

/**
 * The sentence that rides with every figure computed over this population
 * (truthful-data north star: a rate without its definition is a rumour).
 */
export const ATTRIBUTABLE_DEFINITION =
  'a SUBSET of physical outbound (isPhysicalOutboundRow in metrics-contract includes COUNT/CORRECTION; this population is SALE/ADJUSTMENT deducts with a batch id), grouped by batchId, minus pre-0b-1 mass-update sessions (R0)';

/** A bare SQL identifier — the alias is interpolated RAW, so it is checked. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(alias: string): string {
  if (!IDENTIFIER.test(alias)) {
    throw new Error(`population: table alias must be a bare SQL identifier, got "${alias}"`);
  }
  return alias;
}

function numberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`population: predicate bound must be a finite number, got "${value}"`);
  }
  return String(value);
}

/**
 * Render the Prisma dialect of a predicate table. Exported so the unit suite can
 * feed it a MUTATED table and prove the renderer follows the table rather than a
 * literal of its own.
 */
export function renderRowWhere(predicate: PopulationPredicate): Prisma.inventory_logsWhereInput {
  return {
    logType: { in: [...predicate.logTypes] },
    delta: { lt: predicate.deltaBelow },
    ...(predicate.batchIdRequired ? { batchId: { not: null } } : {}),
  };
}

/**
 * Render the raw-SQL dialect of a predicate table, over the caller's alias.
 * Exported for the same reason as `renderRowWhere` — see the module header.
 */
export function renderRowWhereSql(predicate: PopulationPredicate, alias = 'l'): Prisma.Sql {
  const a = assertIdentifier(alias);
  const conjuncts: Prisma.Sql[] = [
    // The log types are BOUND values, never inlined text.
    Prisma.sql`${Prisma.raw(a)}.logType IN (${Prisma.join([...predicate.logTypes])})`,
    Prisma.sql`${Prisma.raw(a)}.delta < ${Prisma.raw(numberLiteral(predicate.deltaBelow))}`,
  ];
  if (predicate.batchIdRequired) {
    conjuncts.push(Prisma.sql`${Prisma.raw(a)}.batchId IS NOT NULL`);
  }
  return Prisma.join(conjuncts, ' AND ');
}

/**
 * The Prisma renderer — used verbatim by every `findMany`/`count`/`groupBy` on
 * inventory_logs in this lane, and by the manual-attribution core's guarded
 * write (pack R-3: nobody re-spells the predicate).
 */
export const rowWhere: Prisma.inventory_logsWhereInput = renderRowWhere(ATTRIBUTABLE_PREDICATE);

/**
 * The raw renderer — a `Prisma.sql` fragment over `inventory_logs <alias>`, for
 * the batch-summary CTE and for the manual-attribution core's row lock.
 */
export function rowWhereSql(alias = 'l'): Prisma.Sql {
  return renderRowWhereSql(ATTRIBUTABLE_PREDICATE, alias);
}

/**
 * A row of the deducted side, exactly as MySQL returns it. The two sums arrive
 * as whatever the driver decides a SUM is (a Decimal, a string, a number), so
 * they are `unknown` here and the CONSUMER converts — a builder that promised
 * `number` would be promising something it cannot check.
 */
export type DeductedSideSqlRow = {
  orderRecordId: string;
  productId: number;
  outUnits: unknown;
  correctedUnits: unknown;
};

/** At most this many orders per aggregate; symmetric with `readOrderItems`. */
const MAX_DEDUCTED_SIDE_ORDERS = 200;

/**
 * THE DEDUCTED SIDE (Part 2, spec REV-8 §2.2; pack CA1.5) — one plain read,
 * per (order, product): `out` = what the POPULATION took out for that order,
 * `corrected` = what positive CORRECTION rows gave back. The matcher nets them.
 *
 * It lives here, beside the population, because `out` is defined BY the
 * population: the `CASE` arm renders `rowWhereSql('l')` rather than re-spelling
 * three conjuncts, so the day the predicate table changes, this aggregate
 * changes with it. TRANSFER legs enter neither side by construction — not in
 * the population, and not a positive CORRECTION.
 *
 * ONE mode, PLAIN (no `FOR SHARE`): inside a writer this is fresh because the
 * writer holds the order's lock as its first statement (cut A).
 *
 * The ids are BOUND. `[]` and more than 200 are caller errors rather than a
 * quietly empty result, and `[]` would render `IN ()`, which is not valid SQL.
 */
export function deductedSideSql(orderIds: readonly string[]): Prisma.Sql {
  if (orderIds.length === 0) {
    throw new RangeError('deductedSideSql: at least one order id is required');
  }
  if (orderIds.length > MAX_DEDUCTED_SIDE_ORDERS) {
    throw new RangeError(`deductedSideSql: at most ${MAX_DEDUCTED_SIDE_ORDERS} orders`);
  }
  const population = rowWhereSql('l');
  return Prisma.sql`
    SELECT l.orderRecordId AS orderRecordId, l.productId AS productId,
           COALESCE(SUM(CASE WHEN ${population} THEN -l.delta ELSE 0 END), 0) AS outUnits,
           COALESCE(SUM(CASE WHEN l.logType = 'CORRECTION' AND l.delta > 0 THEN l.delta ELSE 0 END), 0) AS correctedUnits
    FROM inventory_logs l
    WHERE l.orderRecordId IN (${Prisma.join([...orderIds])})
      AND ((${population}) OR (l.logType = 'CORRECTION' AND l.delta > 0))
    GROUP BY l.orderRecordId, l.productId
  `;
}

/** What R0 reads off an audit row: the type, and whether the shape keys exist. */
export type PopulationAuditEvent = { actionType: string; details: unknown };

/** The diagnostics discriminator's input, as its JSDoc declares it. */
type MassUpdateBatchInput = {
  auditActionTypes?: Set<string> | string[];
  logTypes?: Set<string> | string[];
  hasRowsShape?: boolean;
  hasRowsOmitted?: boolean;
};

/** Its output: the verdict plus WHICH branch produced it. */
type MassUpdateBatchClass = {
  isMassUpdate: boolean;
  isMassUpdateRowsOmitted: boolean;
  evidence: string[];
};

const toSet = (v: Set<string> | string[] | undefined): Set<string> =>
  v instanceof Set ? v : new Set(v || []);

/**
 * A VERBATIM TS port of `classifyMassUpdateBatch`
 * (scripts/diagnostics/inventory-accuracy/lib/mass-update.js:47-68). The
 * diagnostics module is JS-only by contract (it runs standalone against a
 * StagingProduction restore and imports no app code), and this lane must not
 * import a script into the app's read path — so the rule is ported, and the unit
 * suite runs BOTH implementations over the same fixtures and asserts they agree
 * on every field. Drift fails there, not in production.
 *
 * Exported ONLY for that parity pin.
 *
 * THE `count-logtype` BRANCH IS UNREACHABLE HERE and is kept anyway, because
 * this is a port, not a rewrite: a COUNT row fails `rowWhere` and never joins a
 * population batch, so `logTypes` as assembled by `isAttributableBatch` cannot
 * contain COUNT.
 */
export function classifyMassUpdateBatch(batch: MassUpdateBatchInput): MassUpdateBatchClass {
  const auditActionTypes = toSet(batch.auditActionTypes);
  const logTypes = toSet(batch.logTypes);
  const bulk = auditActionTypes.has('INVENTORY_BULK_UPDATE');
  const hasSale = logTypes.has('SALE');
  const hasRowsShape = batch.hasRowsShape === true;
  const hasRowsOmitted = batch.hasRowsOmitted === true;

  const evidence: string[] = [];
  const auditShape = bulk && hasRowsShape && !hasSale;
  const auditShapeRowsOmitted = bulk && !hasRowsShape && hasRowsOmitted && !hasSale;
  const countLogType = logTypes.has('COUNT');
  if (auditShape) evidence.push('audit-rows-shape');
  if (auditShapeRowsOmitted) evidence.push('audit-rows-omitted');
  if (countLogType) evidence.push('count-logtype');

  return {
    isMassUpdate: auditShape || countLogType,
    isMassUpdateRowsOmitted: auditShapeRowsOmitted && !countLogType,
    evidence,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * R0 at population time: is this batch one the report may speak about?
 *
 * FALSE for a pre-0b-1 mass-update session — identified by the audit shape, at
 * batch grain, on the same evidence the diagnostics suite uses (OCk-10: the
 * adapter to the three outputs is frozen — `!(isMassUpdate ||
 * isMassUpdateRowsOmitted)`, so the DEGRADED >500-row identification excludes
 * the batch exactly as the full one does).
 *
 * A mass update whose summary event was never written (recordIngestion is
 * best-effort by design) is invisible to this rule and derives none/unknown with
 * a large row count — that residual is disclosed as a coverage sentence, not
 * guessed at here.
 *
 * @param rows the batch's POPULATION rows only (already through `rowWhere`)
 * @param auditEvents the audit rows whose batchId is this batch's
 */
export function isAttributableBatch(
  rows: ReadonlyArray<{ logType: string }>,
  auditEvents: ReadonlyArray<PopulationAuditEvent>
): boolean {
  const c = classifyMassUpdateBatch({
    auditActionTypes: new Set(auditEvents.map((e) => e.actionType)),
    logTypes: new Set(rows.map((r) => r.logType)),
    hasRowsShape: auditEvents.some((e) => isObj(e.details) && 'rows' in e.details),
    hasRowsOmitted: auditEvents.some((e) => isObj(e.details) && 'rowsOmitted' in e.details),
  });
  return !(c.isMassUpdate || c.isMassUpdateRowsOmitted);
}

// ---------------------------------------------------------------------------
// THE BATCH'S OWN EVIDENCE — read ONCE, for every consumer (OC-1 / OC-2)
// ---------------------------------------------------------------------------

/**
 * An `audit_logs` row filed under a LEDGER batchId, reduced to what a
 * batch-grain rule reads: what happened, which entity it happened to, and the
 * writer's blob.
 */
export type BatchAuditRow = {
  actionType: string;
  entityId?: string | null;
  details?: unknown;
};

/**
 * What a batch's audit rows say about it.
 *
 * ONE ASSEMBLY, because three call sites used to build their own — the report
 * row, the drill-down and the manual-attribution core — and they disagreed. A
 * UI that reads the fulfillment differently from the core is a button that 409s
 * (OC-1), and an R0 read that walks a different set of audit rows than the core
 * does is a batch the report offers and the core refuses (OC-2).
 */
export type BatchEvidence = {
  /** R0: may the report speak about this batch at all? */
  attributable: boolean;
  /** The FIRST fulfillment event filed under this batch id, or null. */
  fulfillmentEvent: BatchAuditRow | null;
  /** The order that event NAMES — `details.orderId`, else its own entity. */
  fulfillmentOrderId: string | null;
  /** The deduction's own event: the first row of the array (G1p-8). */
  earliest: BatchAuditRow | null;
};

/**
 * The two events that mean "a fulfillment moved this stock". Spelled HERE, once,
 * beside the population itself: the write path and the read path used to keep
 * private copies, which is exactly how they drifted.
 *
 * EXPORTED as an ARRAY because the attribution report's one statement needs the
 * same two names in SQL (QA-6): the list read reaches for the batch's
 * fulfillment event by scalar subquery, and a hand-typed `IN (…)` beside this
 * set would be the third copy of the rule this module exists to prevent.
 */
export const FULFILLMENT_ACTION_TYPE_LIST: ReadonlyArray<string> = Object.freeze([
  'EXTERNAL_ORDER_FULFILLMENT',
  'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
]);

const FULFILLMENT_ACTION_TYPES: ReadonlySet<string> = new Set(FULFILLMENT_ACTION_TYPE_LIST);

/** A non-empty string, or nothing — the writers omit keys they cannot fill. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read a batch's audit rows once, into the facts every consumer needs.
 *
 * An event naming NEITHER an order id nor an entity cannot be completed against
 * anything, and `fulfillmentOrderId` is `null` rather than a guess.
 *
 * @param auditEvents the batch's audit rows, ID-ASCENDING (`earliest` is [0])
 * @param rows the batch's POPULATION rows — R0 reads their log types
 */
export function batchEvidence(
  auditEvents: ReadonlyArray<BatchAuditRow>,
  rows: ReadonlyArray<{ logType: string }>
): BatchEvidence {
  const fulfillmentEvent =
    auditEvents.find((e) => FULFILLMENT_ACTION_TYPES.has(e.actionType)) ?? null;
  const details =
    fulfillmentEvent !== null && isObj(fulfillmentEvent.details) ? fulfillmentEvent.details : {};

  return {
    attributable: isAttributableBatch(
      rows,
      auditEvents.map((e) => ({ actionType: e.actionType, details: e.details }))
    ),
    fulfillmentEvent,
    fulfillmentOrderId:
      fulfillmentEvent === null
        ? null
        : (text(details.orderId) ?? text(fulfillmentEvent.entityId) ?? null),
    earliest: auditEvents[0] ?? null,
  };
}
