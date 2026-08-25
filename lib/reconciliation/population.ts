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
