/**
 * @jest-environment node
 *
 * THE ATTRIBUTION REPORT PRODUCER (reconciliation lane, pack C2a.4; spec REV-7
 * §2.2 / D6 / D7 / D9 / §5).
 *
 * The producer is driven against a mocked Prisma, so what these pins can prove
 * is (a) the SHAPE of the one read it issues, (b) the classification, filtering,
 * paging and projection it performs in TypeScript over the rows that read
 * returns, and (c) how many statements it takes to do it.
 *
 * WHAT A MOCKED PRISMA CANNOT PROVE, said out loud rather than faked: that MySQL
 * returns one row per batch, that the earliest audit row is the one joined and
 * that the latest attempt is `(attemptedAt DESC, id DESC)`. Those live in the
 * SQL text, so they are pinned AS TEXT here (the fan-out fixture is a shape pin
 * on the join, not a fixture that could fan out), and real-MySQL parity for this
 * lane's row sets is the concurrency gate's scenario 8b.
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma, type PrismaClient } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { attributeBatch } from '@/lib/reconciliation/attribute-batch';
import { ATTRIBUTABLE_DEFINITION } from '@/lib/reconciliation/population';
import { DERIVED_SENTENCES } from '@/lib/reconciliation/derive';
import { MATCH_CLASS_KEYS, MATCH_DEFINITIONS } from '@/lib/reconciliation/match-keys';
import {
  ATTRIBUTION_CLASS_KEYS,
  __resetForTests,
  getAttributionReport,
  getBatchDetail,
  getRecordingSince,
  searchOrders,
  type AttributionInput,
  type AttributionReport,
  type Viewer,
} from '@/lib/reconciliation/attribution';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const ADMIN: Viewer = { kind: 'admin' };
const MEMBER: Viewer = { kind: 'member', companyIds: ['co-mine'] };

/** The single row shape the batch-summary read returns (one row per batch). */
type SqlRow = {
  nonAttributableBatches: number;
  noBatchRows: number;
  orderNumberMatches: number;
  batchId: string | null;
  minChangeTime: Date | null;
  rowCount: number | null;
  units: number | null;
  productCount: number | null;
  logTypes: string | null;
  distinctStamps: number | null;
  firstStamp: string | null;
  lastStamp: string | null;
  unstampedRows: number | null;
  auditId: number | null;
  auditActionType: string | null;
  auditEntityId: string | null;
  auditOrderAttributionSource: string | null;
  auditIntent: string | null;
  auditSelectedExternalOrderId: string | null;
  auditOrderId: string | null;
  auditHasOrderReference: number;
  auditHasRows: number;
  auditHasRowsOmitted: number;
  /** The batch's fulfillment event, read batch-wide rather than off `ae` (QA-6). */
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

function summaryRow(over: Partial<SqlRow> = {}): SqlRow {
  return {
    nonAttributableBatches: 0,
    noBatchRows: 0,
    orderNumberMatches: 0,
    batchId: 'batch-1',
    minChangeTime: new Date('2026-08-10T12:00:00.000Z'),
    rowCount: 2,
    units: 5,
    productCount: 2,
    logTypes: 'SALE',
    distinctStamps: 0,
    firstStamp: null,
    lastStamp: null,
    unstampedRows: 2,
    auditId: null,
    auditActionType: null,
    auditEntityId: null,
    auditOrderAttributionSource: null,
    auditIntent: null,
    auditSelectedExternalOrderId: null,
    auditOrderId: null,
    auditHasOrderReference: 0,
    auditHasRows: 0,
    auditHasRowsOmitted: 0,
    fulfillmentAuditId: null,
    fulfillmentActionType: null,
    fulfillmentEntityId: null,
    fulfillmentOrderId: null,
    attemptId: null,
    attemptOutcome: null,
    attemptEvidence: null,
    attemptReason: null,
    attemptSource: null,
    attemptActorUserId: null,
    attemptOrderRecordId: null,
    ...over,
  };
}

/** A stamped batch whose latest attempt says an operator picked the order. */
function selectedRow(over: Partial<SqlRow> = {}): SqlRow {
  return summaryRow({
    distinctStamps: 1,
    firstStamp: 'ord-1',
    lastStamp: 'ord-1',
    unstampedRows: 0,
    attemptId: 10,
    attemptOutcome: 'attributed',
    attemptEvidence: 'selected',
    attemptSource: 'live-deduct',
    attemptActorUserId: 7,
    attemptOrderRecordId: 'ord-1',
    ...over,
  });
}

function orderRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ord-1',
    orderNumber: '#1001',
    internalStatus: 'pending',
    externalCreatedAt: new Date('2026-08-09T00:00:00.000Z'),
    companyId: 'co-mine',
    integration: { platform: 'WOOCOMMERCE' },
    ...over,
  };
}

/**
 * The match's three reads, as fixtures (Part 2, pack CA2.2). One mapped line of
 * one product, one unit out against `ord-1`, and the product's decomposition —
 * i.e. an `exact` order, which is the shape a page mostly carries.
 */
function itemRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'item-1',
    orderId: 'ord-1',
    quantity: 1,
    fulfilledQty: 0,
    isMapped: true,
    productLinkId: 'link-1',
    productLink: { internalProductId: 9, isBundle: false, bundleComponents: [] },
    bundleComponentSnapshot: null,
    ...over,
  };
}

/** The driver hands a SUM back as a Decimal; the producer converts. */
function deductedSideRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    orderRecordId: 'ord-1',
    productId: 9,
    outUnits: new Prisma.Decimal('1'),
    correctedUnits: new Prisma.Decimal('0'),
    ...over,
  };
}

function productRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 9,
    name: 'Widget',
    baseName: 'widget',
    unit: 'mg',
    numericValue: new Prisma.Decimal('5.00'),
    ...over,
  };
}

const INPUT: AttributionInput = { from: '2026-08-01', to: '2026-08-31', limit: 50 };

/**
 * Every prisma call the report read is allowed to make (D7's budget).
 *
 * WIDENED FIRST, before A2's number was measured (pack CA2.2): the match
 * producer's two DELEGATE reads are statements like any other, and a recorder
 * that could not see them would have reported a budget that was simply false.
 */
function statementCount(): number {
  return (
    db.$queryRaw.mock.calls.length +
    db.user.findMany.mock.calls.length +
    db.externalOrder.findMany.mock.calls.length +
    db.orderAttributionAttempt.findFirst.mock.calls.length +
    db.externalOrderItem.findMany.mock.calls.length +
    db.product.findMany.mock.calls.length
  );
}

/**
 * ONE RAW CHANNEL, TWO STATEMENTS (pack CA2.3). The batch summary (or, in the
 * drill-down, the batch aggregate) and the match's deducted-side aggregate both
 * arrive through `$queryRaw`, so a single `mockResolvedValue` would feed summary
 * rows to the matcher — whose integer guard would then throw, which is the
 * symptom of a missing dispatcher and never a reason to make the producer
 * tolerant of rows it was not sent.
 *
 * The branch is selected on `AS outUnits`, the deducted-side builder's own
 * alias: neither of the other two statements has one.
 */
function mockSummary(rows: unknown[], deducted: unknown[] = []): void {
  db.$queryRaw.mockImplementation(((query: Prisma.Sql) =>
    Promise.resolve(query.sql.includes('AS outUnits') ? deducted : rows)) as never);
}

function rawSql(call = 0): string {
  const arg = db.$queryRaw.mock.calls[call][0] as unknown as { sql: string };
  return arg.sql;
}

beforeEach(() => {
  mockReset(db);
  __resetForTests();
  mockSummary([]);
  db.orderAttributionAttempt.findFirst.mockResolvedValue(null as never);
  db.user.findMany.mockResolvedValue([] as never);
  db.externalOrder.findMany.mockResolvedValue([] as never);
  // The match producer's two delegate reads: empty by default, so a fixture
  // that says nothing about the match gets an order with no lines and no
  // movement — the matcher's unmatchable result — rather than an undefined row.
  db.externalOrderItem.findMany.mockResolvedValue([] as never);
  db.product.findMany.mockResolvedValue([] as never);
});

// ---------------------------------------------------------------------------
// The window (day keys; `to` INCLUSIVE end-of-day UTC)
// ---------------------------------------------------------------------------

describe('the window', () => {
  it('echoes the day keys and binds [from 00:00Z, to+1d 00:00Z)', async () => {
    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.window).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    const values = (db.$queryRaw.mock.calls[0][0] as unknown as { values: unknown[] }).values;
    const dates = values.filter((v): v is Date => v instanceof Date).map((d) => d.toISOString());
    expect(dates).toContain('2026-08-01T00:00:00.000Z');
    expect(dates).toContain('2026-09-01T00:00:00.000Z');
  });

  it('a row at 23:59:59.999Z on `to` is INSIDE the window (inclusive end of day)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const values = (db.$queryRaw.mock.calls[0][0] as unknown as { values: unknown[] }).values;
    const dates = values.filter((v): v is Date => v instanceof Date);
    const end = dates.find((d) => d.toISOString() === '2026-09-01T00:00:00.000Z');
    expect(end).toBeDefined();
    // The half-open upper bound sits AFTER the last millisecond of `to`.
    expect(new Date('2026-08-31T23:59:59.999Z').getTime()).toBeLessThan(end!.getTime());
  });
});

// ---------------------------------------------------------------------------
// The read shape (CX-7): ONE statement, one row per batch, no fan-out
// ---------------------------------------------------------------------------

describe('the read shape', () => {
  it('issues ONE batch-summary statement carrying the population fragment verbatim', async () => {
    await getAttributionReport(INPUT, ADMIN);

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = rawSql();
    expect(sql).toContain("l.logType IN (?,?)");
    expect(sql).toContain('l.delta < 0');
    expect(sql).toContain('l.batchId IS NOT NULL');
  });

  it('groups the ledger FIRST and windows on MIN(changeTime)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    expect(sql).toContain('GROUP BY l.batchId');
    expect(sql).toContain('HAVING MIN(l.changeTime) >= ?');
  });

  it('joins the EARLIEST audit row by id and the LATEST attempt by (attemptedAt, id) — never MAX(id)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    expect(sql).toContain('ORDER BY a2.id ASC LIMIT 1');
    expect(sql).toContain('ORDER BY p2.attemptedAt DESC, p2.id DESC LIMIT 1');
    expect(sql).not.toContain('MAX(id)');
    expect(sql).not.toContain('MAX(a2.id)');
    expect(sql).not.toContain('MAX(p2.id)');
  });

  it('the fan-out fixture: both joins are 1:1 id equalities, never a batchId join', async () => {
    // Two audit rows and two attempts on one batch cannot multiply units,
    // because neither join is on batchId at all: each is `ON <t>.id = (scalar)`.
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    expect(sql).toContain('LEFT JOIN audit_logs ae ON ae.id = (');
    expect(sql).toContain('LEFT JOIN order_attribution_attempts ap ON ap.id = (');
    expect(sql).not.toContain('LEFT JOIN audit_logs ae ON ae.batchId');
    expect(sql).not.toContain('LEFT JOIN order_attribution_attempts ap ON ap.batchId');
  });

  // QA-6 (the OC-1 class recurring): the EARLIEST audit row is not the batch's
  // only audit row, so the fulfillment fact has to be read BATCH-WIDE — the way
  // the drill-down and the manual-attribution core read it.
  it('reads the fulfillment event BATCH-WIDE, by its own scalar subquery (QA-6)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();

    expect(sql).toContain(
      'SELECT f2.id FROM audit_logs f2 WHERE f2.batchId = b.batchId AND f2.actionType IN (?,?) ORDER BY f2.id ASC LIMIT 1',
    );
    const values = (db.$queryRaw.mock.calls[0][0] as unknown as { values: unknown[] }).values;
    expect(values).toContainEqual('EXTERNAL_ORDER_FULFILLMENT');
    expect(values).toContainEqual('EXTERNAL_ORDER_PARTIAL_FULFILLMENT');
    // Still ONE statement: the fulfillment row rides the same read as the rest.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('carries NO id list — the window is the bound, never an enumeration of batches', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const statement = db.$queryRaw.mock.calls[0][0] as unknown as {
      sql: string;
      values: unknown[];
    };
    expect(statement.sql).not.toContain('b.batchId IN (');
    // The candidate preselection below is a SUBQUERY, not an enumeration: no
    // batch id is ever materialised into SQL. Everything this statement binds is
    // a window bound, a logType of the population predicate, or a fulfillment
    // action type — the closed vocabularies, never a row identity.
    expect(statement.sql).toContain('l.batchId IN (SELECT DISTINCT l2.batchId');
    const bound = new Set(
      statement.values.filter((value): value is string => typeof value === 'string'),
    );
    expect(Array.from(bound).sort()).toEqual([
      'ADJUSTMENT',
      'EXTERNAL_ORDER_FULFILLMENT',
      'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
      'SALE',
    ]);
  });

  it('FD-3: the MEMBER + orderNumber path binds only the vocabularies, the companies and the number — still never a row identity', async () => {
    await getAttributionReport({ ...INPUT, orderNumber: '1009' }, MEMBER);
    const statement = db.$queryRaw.mock.calls[0][0] as unknown as { sql: string; values: unknown[] };
    expect(statement.sql).not.toContain('b.batchId IN (');
    const bound = statement.values.filter((v): v is string => typeof v === 'string');
    const allowed = new Set([
      'ADJUSTMENT',
      'EXTERNAL_ORDER_FULFILLMENT',
      'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
      'SALE',
      '1009',
      ...MEMBER.companyIds,
    ]);
    expect(bound.filter((v) => !allowed.has(v))).toEqual([]);
  });

  // CR-5: the HAVING alone made this read GROUP THE WHOLE POPULATION and then
  // throw away every batch outside the window — a 14-day report paid for the
  // entire ledger's history. The overview's candidate preselection (OC-3, then
  // QA-3) is the exact shape that bounds the scan without truncating a selected
  // batch: it names the batches with at least one population row at or after
  // `start`, and every row of a named batch is still grouped, so no batch can
  // lose a row and mis-report its MIN(changeTime), its stamps or its units.
  it('preselects candidate batches from population rows in the window (CR-5)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();

    expect(sql).toContain(
      'l.batchId IN (SELECT DISTINCT l2.batchId FROM inventory_logs l2 WHERE',
    );
    // The subquery carries the POPULATION predicate too — a transfer leg at the
    // window's edge must not nominate a batch this report cannot speak about.
    expect(sql).toContain('l2.logType IN (?,?)');
    expect(sql).toContain('l2.delta < 0');
    expect(sql).toContain('l2.changeTime >= ?');
    // The HAVING stays: preselection WIDENS, and the exactness check is still
    // the batch's own time axis.
    expect(sql).toContain('HAVING MIN(l.changeTime) >= ?');
    expect(sql).toContain('MIN(l.changeTime) < ?');
    // Still ONE statement.
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('the preselection has NO upper bound — no ledger row exists after now (QA-3)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    const subquery = sql.slice(
      sql.indexOf('SELECT DISTINCT l2.batchId'),
      sql.indexOf('GROUP BY l.batchId'),
    );
    expect(subquery).toContain('l2.changeTime >= ?');
    expect(subquery).not.toContain('l2.changeTime <');
  });

  it('never selects the audit `details` blob — only the typed facts the rules read (D6)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    expect(sql).not.toContain('ae.details AS');
    expect(sql).toContain("JSON_EXTRACT(ae.details, '$.orderAttributionSource')");
    expect(sql).toContain("JSON_EXTRACT(ae.details, '$.intent')");
  });

  // MEASURED at A2, not asserted from the plan (P-5): the recorder above was
  // widened FIRST, then this ran. Seven is the whole cost of a stamped page —
  // recordingSince, the batch summary, the orders, the actors, and the match's
  // three: the items, the deducted-side aggregate and the product facts.
  it('spends AT MOST eight statements — seven on a plain admin read', async () => {
    mockSummary([selectedRow()], [deductedSideRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
    db.externalOrderItem.findMany.mockResolvedValue([itemRow()] as never);
    db.product.findMany.mockResolvedValue([productRow()] as never);

    await getAttributionReport(INPUT, ADMIN);

    expect(statementCount()).toBe(7);
    expect(statementCount()).toBeLessThanOrEqual(8);
  });

  // The producer's own contract, seen from the page: the product lookup is
  // SKIPPED when neither side names a product, so an order with no items and no
  // movement is six, not a seventh statement that looks nothing up.
  it('a stamped order with nothing on either side costs SIX — the product read is skipped', async () => {
    mockSummary([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    await getAttributionReport(INPUT, ADMIN);

    expect(statementCount()).toBe(6);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it('the order-number filter rides IN the batch-summary statement (still at most eight)', async () => {
    mockSummary([selectedRow()], [deductedSideRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
    db.externalOrderItem.findMany.mockResolvedValue([itemRow()] as never);
    db.product.findMany.mockResolvedValue([productRow()] as never);

    await getAttributionReport({ ...INPUT, orderNumber: '#1001' }, ADMIN);

    // RE-MEASURED at A2 (P-5): TWO raw statements now share the channel — the
    // batch summary, which still carries the filter, and the match's
    // deducted-side aggregate. The filter itself still buys nothing.
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(rawSql()).toContain('FROM external_orders f WHERE f.orderNumber = ?');
    expect(rawSql(1)).toContain('AS outUnits');
    expect(statementCount()).toBeLessThanOrEqual(8);
  });
});

// ---------------------------------------------------------------------------
// Classification — recorded attempt wins, else the derivation
// ---------------------------------------------------------------------------

describe('classification', () => {
  it('a recorded attempt wins over the derivation', async () => {
    mockSummary([
      summaryRow({
        auditId: 3,
        auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
        auditEntityId: 'ord-9',
        attemptId: 11,
        attemptOutcome: 'declined',
        attemptReason: 'unmatched',
        attemptSource: 'live-deduct',
        attemptActorUserId: 7,
      }),
    ]);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].how.classKey).toBe('declined·unmatched');
    expect(report.rows[0].how.ruleId).toBeUndefined();
    expect(report.rows[0].source).toBe('live-deduct');
    expect(report.rows[0].actor).toEqual({ id: 7, username: 'kris' });
  });

  it('no attempt row derives the class and carries the ruleId + the rule sentence', async () => {
    mockSummary([
      summaryRow({ distinctStamps: 1, firstStamp: 'ord-1', lastStamp: 'ord-1', unstampedRows: 0 }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].how.classKey).toBe('attributed·derived');
    expect(report.rows[0].how.ruleId).toBe('R3');
    expect(report.rows[0].how.sentence).toBe(DERIVED_SENTENCES.R3);
    expect(report.rows[0].source).toBe('derived');
    expect(report.rows[0].actor).toBeNull();
  });

  it('annotates a post-lane gap (recording was live and nothing recorded)', async () => {
    db.orderAttributionAttempt.findFirst.mockResolvedValue({
      attemptedAt: new Date('2026-08-01T00:00:00.000Z'),
    } as never);
    mockSummary([summaryRow()]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].how.postLaneGap).toBe(true);
    expect(report.rows[0].how.sentence).toBe(
      'unknown — recording was live and this batch has no attempt row',
    );
  });

  it('an attempt row outside the closed vocabulary falls back to the derivation', async () => {
    mockSummary([
      summaryRow({
        distinctStamps: 1,
        firstStamp: 'ord-1',
        lastStamp: 'ord-1',
        unstampedRows: 0,
        attemptId: 12,
        attemptOutcome: 'teleported',
        attemptSource: 'live-deduct',
      }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].how.classKey).toBe('attributed·derived');
    expect(report.rows[0].source).toBe('derived');
  });

  it('an R0 mass-update batch is excluded from the rows and counted as an exclusion', async () => {
    mockSummary([
      summaryRow({
        batchId: 'bulk-1',
        logTypes: 'ADJUSTMENT',
        auditId: 4,
        auditActionType: 'INVENTORY_BULK_UPDATE',
        auditHasRows: 1,
      }),
      selectedRow({ batchId: 'batch-2', minChangeTime: new Date('2026-08-09T12:00:00.000Z') }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows.map((r) => r.batchId)).toEqual(['batch-2']);
    expect(report.totals.exclusions.historicalMassUpdate).toBe(1);
    expect(report.totals.attributable).toBe(1);
    expect(report.coverage.batchesInWindow).toBe(2);
  });

  it('units and product counts come from the batch summary (never multiplied)', async () => {
    mockSummary([summaryRow({ units: 12, productCount: 3, rowCount: 4 })]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].units).toBe(12);
    expect(report.rows[0].productCount).toBe(3);
    expect(report.rows[0].logTypes).toEqual(['SALE']);
  });
});

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

describe('totals', () => {
  it('byClass carries every class key, zero-filled', async () => {
    const report = await getAttributionReport(INPUT, ADMIN);
    expect(Object.keys(report.totals.byClass).sort()).toEqual([...ATTRIBUTION_CLASS_KEYS].sort());
    expect(Object.values(report.totals.byClass).every((v) => v === 0)).toBe(true);
  });

  it('byClass is computed BEFORE the active class filter (the other chips stay truthful)', async () => {
    mockSummary([
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-10T12:00:00.000Z') }),
      summaryRow({ batchId: 'b', minChangeTime: new Date('2026-08-09T12:00:00.000Z') }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport({ ...INPUT, classKey: 'none·unknown' }, ADMIN);

    expect(report.rows.map((r) => r.batchId)).toEqual(['b']);
    expect(report.totals.byClass['attributed·selected']).toBe(1);
    expect(report.totals.byClass['none·unknown']).toBe(1);
    expect(report.count).toBe(1);
    expect(report.totals.attributable).toBe(2);
  });

  it('carries the exclusions the same statement counted', async () => {
    mockSummary([
      summaryRow({ nonAttributableBatches: 17, noBatchRows: 240 }),
    ]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.totals.exclusions).toEqual({
      nonAttributable: 17,
      historicalMassUpdate: 0,
      noBatchRows: 240,
    });
  });

  it('an EMPTY window still reports its exclusions (the coverage row survives no batches)', async () => {
    mockSummary([
      summaryRow({ batchId: null, minChangeTime: null, nonAttributableBatches: 3, noBatchRows: 9 }),
    ]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows).toEqual([]);
    expect(report.count).toBe(0);
    expect(report.totals.exclusions.nonAttributable).toBe(3);
    expect(report.totals.exclusions.noBatchRows).toBe(9);
    expect(report.coverage.batchesInWindow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Paging — the keyset cursor and the ONE authoritative bound
// ---------------------------------------------------------------------------

describe('paging', () => {
  const five = () =>
    [1, 2, 3, 4, 5].map((n) =>
      summaryRow({
        batchId: `b${n}`,
        minChangeTime: new Date(`2026-08-${20 - n}T12:00:00.000Z`),
      }),
    );

  it('page 1 bounds itself out loud and hands back a cursor', async () => {
    mockSummary(five());

    const report = await getAttributionReport({ ...INPUT, limit: 2 }, ADMIN);

    expect(report.rows.map((r) => r.batchId)).toEqual(['b1', 'b2']);
    expect(report.count).toBe(5);
    expect(report.moreCount).toBe(3);
    expect(report.coverage.rowsReturned).toBe(2);
    expect(report.nextCursor).not.toBeNull();
  });

  it('the cursor round-trips and moreCount is EXACT on page 2', async () => {
    mockSummary(five());
    const page1 = await getAttributionReport({ ...INPUT, limit: 2 }, ADMIN);

    mockSummary(five());
    const page2 = await getAttributionReport(
      { ...INPUT, limit: 2, cursor: page1.nextCursor! },
      ADMIN,
    );

    expect(page2.rows.map((r) => r.batchId)).toEqual(['b3', 'b4']);
    expect(page2.count).toBe(5);
    expect(page2.moreCount).toBe(1);

    mockSummary(five());
    const page3 = await getAttributionReport(
      { ...INPUT, limit: 2, cursor: page2.nextCursor! },
      ADMIN,
    );
    expect(page3.rows.map((r) => r.batchId)).toEqual(['b5']);
    expect(page3.moreCount).toBe(0);
    expect(page3.nextCursor).toBeNull();
  });

  it('a class-filtered page drops nothing at the boundary', async () => {
    const rows = [
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-19T12:00:00.000Z') }),
      summaryRow({ batchId: 'b', minChangeTime: new Date('2026-08-18T12:00:00.000Z') }),
      selectedRow({ batchId: 'c', minChangeTime: new Date('2026-08-17T12:00:00.000Z') }),
      summaryRow({ batchId: 'd', minChangeTime: new Date('2026-08-16T12:00:00.000Z') }),
      selectedRow({ batchId: 'e', minChangeTime: new Date('2026-08-15T12:00:00.000Z') }),
    ];
    mockSummary(rows);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const page1 = await getAttributionReport(
      { ...INPUT, limit: 2, classKey: 'attributed·selected' },
      ADMIN,
    );
    expect(page1.rows.map((r) => r.batchId)).toEqual(['a', 'c']);
    expect(page1.count).toBe(3);
    expect(page1.moreCount).toBe(1);

    mockSummary(rows);
    const page2 = await getAttributionReport(
      { ...INPUT, limit: 2, classKey: 'attributed·selected', cursor: page1.nextCursor! },
      ADMIN,
    );
    expect(page2.rows.map((r) => r.batchId)).toEqual(['e']);
    expect(page2.moreCount).toBe(0);
  });

  it('refuses a cursor it did not mint', async () => {
    await expect(
      getAttributionReport({ ...INPUT, cursor: 'not-a-cursor' }, ADMIN),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});

// ---------------------------------------------------------------------------
// Viewer semantics — BOTH ways (D6 / D9)
// ---------------------------------------------------------------------------

describe('viewer semantics', () => {
  it('ADMIN: every order projected, actor named, scope said out loud', async () => {
    mockSummary([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow({ companyId: 'co-theirs' })] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].order).toEqual({
      id: 'ord-1',
      orderNumber: '#1001',
      internalStatus: 'pending',
      platform: 'WOOCOMMERCE',
      externalCreatedAt: '2026-08-09T00:00:00.000Z',
    });
    expect(report.rows[0].actor).toEqual({ id: 7, username: 'kris' });
    expect(report.coverage.orderFilterScope).toBe('all orders');
  });

  it('MEMBER: order fields only inside the membership, no actor identity anywhere', async () => {
    mockSummary([
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-11T12:00:00.000Z') }),
      selectedRow({
        batchId: 'b',
        minChangeTime: new Date('2026-08-10T12:00:00.000Z'),
        firstStamp: 'ord-2',
        lastStamp: 'ord-2',
        attemptOrderRecordId: 'ord-2',
      }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([
      orderRow(),
      orderRow({ id: 'ord-2', orderNumber: '#2002', companyId: 'co-theirs' }),
    ] as never);

    const report = await getAttributionReport(INPUT, MEMBER);

    expect(report.rows[0].order).toMatchObject({ orderNumber: '#1001' });
    expect(report.rows[1].order).toEqual({
      orderRedacted: true,
      reason: 'order belongs to a company you are not a member of',
    });
    expect(report.rows.every((r) => r.actor === null)).toBe(true);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(report.coverage.orderFilterScope).toBe('your companies only');
  });

  it("MEMBER: a non-member's order number matches ZERO rows and says so", async () => {
    mockSummary([
      summaryRow({ batchId: null, minChangeTime: null, orderNumberMatches: 0 }),
    ]);

    const report = await getAttributionReport({ ...INPUT, orderNumber: '#9999' }, MEMBER);

    expect(report.rows).toEqual([]);
    expect(report.count).toBe(0);
    expect(report.coverage.notes).toContain('no order matching that number in your companies');
  });

  it('the member order filter is scoped to the membership in SQL', async () => {
    await getAttributionReport({ ...INPUT, orderNumber: '#1001' }, MEMBER);
    const sql = rawSql();
    expect(sql).toContain('f.companyId IN (?)');
  });

  it('companyId never reaches the wire, in either viewer', async () => {
    mockSummary([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const admin = await getAttributionReport(INPUT, ADMIN);
    expect(JSON.stringify(admin)).not.toContain('companyId');

    mockSummary([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    const member = await getAttributionReport(INPUT, MEMBER);
    expect(JSON.stringify(member)).not.toContain('companyId');
  });

  it('a stamped batch whose order was DELETED renders orderMissing (never redaction)', async () => {
    mockSummary([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].order).toEqual({ orderMissing: true });
  });

  it('orders are fetched ONCE for the returned page only', async () => {
    mockSummary([
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-12T12:00:00.000Z') }),
      selectedRow({
        batchId: 'b',
        minChangeTime: new Date('2026-08-11T12:00:00.000Z'),
        firstStamp: 'ord-2',
        lastStamp: 'ord-2',
      }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    await getAttributionReport({ ...INPUT, limit: 1 }, ADMIN);

    expect(db.externalOrder.findMany).toHaveBeenCalledTimes(1);
    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['ord-1'] } },
    });
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Coverage — the bounds and the exclusions, said out loud
// ---------------------------------------------------------------------------

describe('coverage', () => {
  it('always discloses the R0 batch this report cannot see', async () => {
    const report = await getAttributionReport(INPUT, ADMIN);
    expect(report.coverage.notes).toContain(
      'a pre-0b-1 mass update whose summary event was never written is invisible to R0 and appears here as an unknown-class batch with a large row count',
    );
  });

  it('counts the tripwires and the ledger-unstamped share', async () => {
    mockSummary([
      // mixed stamps
      summaryRow({
        batchId: 'mixed',
        minChangeTime: new Date('2026-08-14T12:00:00.000Z'),
        distinctStamps: 2,
        firstStamp: 'ord-1',
        lastStamp: 'ord-2',
        unstampedRows: 0,
      }),
      // the stamp disagrees with the latest attempt
      selectedRow({
        batchId: 'disagrees',
        minChangeTime: new Date('2026-08-13T12:00:00.000Z'),
        attemptOrderRecordId: 'ord-elsewhere',
      }),
      // R2b — fulfilled, never stamped
      summaryRow({
        batchId: 'r2b',
        minChangeTime: new Date('2026-08-12T12:00:00.000Z'),
        auditId: 5,
        auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
        auditOrderId: 'ord-3',
      }),
    ]);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.coverage.needsALook).toEqual({
      stampDisagreesWithLatestAttempt: 1,
      mixedStamps: 1,
    });
    expect(report.coverage.ledgerUnstamped).toBe(1);
    expect(report.coverage.derivedShare).toBe(0.667);
  });

  it('derivedShare is NULL (with a reason) when nothing attributable is in the window', async () => {
    const report = await getAttributionReport(INPUT, ADMIN);
    expect(report.coverage.derivedShare).toBeNull();
    expect(report.coverage.notes).toContain(
      'no attributable batch in this window, so the derived share has no denominator',
    );
  });

  it('reports the recording boundary as an ISO instant', async () => {
    db.orderAttributionAttempt.findFirst.mockResolvedValue({
      attemptedAt: new Date('2026-08-25T09:00:00.000Z'),
    } as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.coverage.recordingSince).toBe('2026-08-25T09:00:00.000Z');
  });

  it('definitions ride with the numbers', async () => {
    const report = await getAttributionReport(INPUT, ADMIN);
    expect(report.definitions.population).toBe(ATTRIBUTABLE_DEFINITION);
    expect(typeof report.definitions.moreCount).toBe('string');
    expect(typeof report.definitions.derived).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// THE ORDER MATCH (Part 2, spec REV-8 §2.0 / §5; pack CA2.2, seam S-A10)
// ---------------------------------------------------------------------------

describe('the order match', () => {
  /** A page whose stamped order really does have a line, a movement and facts. */
  function wireMatch(rows: SqlRow[], deducted: unknown[] = [deductedSideRow()]) {
    mockSummary(rows, deducted);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
    db.externalOrderItem.findMany.mockResolvedValue([itemRow()] as never);
    db.product.findMany.mockResolvedValue([productRow()] as never);
  }

  it("a stamped row carries its ORDER's match, and no reason", async () => {
    wireMatch([selectedRow()]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].matchUnavailable).toBeNull();
    expect(report.rows[0].match).toMatchObject({
      class: 'exact',
      flagged: false,
      kinds: [],
      perProduct: [expect.objectContaining({ productId: 9, ordered: 1, deducted: 1 })],
    });
  });

  // The FIVE reasons, through the PRODUCER — one owner (S-A10), so the row's
  // pair and the stamp set the producer is asked about can never disagree. The
  // fifth (`match-error`, pack REV-7) is pinned below with the refusal.
  it("an UNSTAMPED batch reads 'unstamped', and the producer is never asked", async () => {
    wireMatch([summaryRow()]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].match).toBeNull();
    expect(report.rows[0].matchUnavailable).toBe('unstamped');
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("a batch whose rows name TWO orders reads 'mixed-stamps'", async () => {
    wireMatch([
      summaryRow({ distinctStamps: 2, firstStamp: 'ord-1', lastStamp: 'ord-2', unstampedRows: 0 }),
    ]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].match).toBeNull();
    expect(report.rows[0].matchUnavailable).toBe('mixed-stamps');
  });

  it("a stamp naming an order this database no longer holds reads 'order-missing'", async () => {
    wireMatch([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].match).toBeNull();
    expect(report.rows[0].matchUnavailable).toBe('order-missing');
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
  });

  // UNREACHABLE through either GET route (both hardcode the admin viewer) and
  // live from P2-C's tool — pinned now, through the same producer, so the
  // member's answer is a named reason rather than a blank nobody can read.
  it("a MEMBER's foreign order reads 'order-redacted', and its lines are never read", async () => {
    wireMatch([selectedRow()]);
    db.externalOrder.findMany.mockResolvedValue([orderRow({ companyId: 'co-theirs' })] as never);

    const report = await getAttributionReport(INPUT, MEMBER);

    expect(report.rows[0].match).toBeNull();
    expect(report.rows[0].matchUnavailable).toBe('order-redacted');
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
  });

  it('exactly one of the pair is non-null on every row of the page', async () => {
    wireMatch([selectedRow(), summaryRow({ batchId: 'batch-2' })]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows).toHaveLength(2);
    for (const row of report.rows) {
      expect((row.match === null) !== (row.matchUnavailable === null)).toBe(true);
    }
  });

  it('byClass counts ORDERS, not rows: two batches of one order are ONE exact', async () => {
    // Both batches carry the same stamp, so the page holds two rows and one
    // order — and the chip above the table claims to be counting orders.
    wireMatch([selectedRow(), selectedRow({ batchId: 'batch-2' })]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows).toHaveLength(2);
    expect(report.matches.orders).toBe(1);
    expect(report.matches.byClass.exact).toBe(1);
    expect(report.coverage.matchedOrders).toBe(1);
    // ...and the order was read ONCE, not once per row.
    expect(db.externalOrderItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('unavailable counts ROWS, and the scope says "this page" on the wire', async () => {
    wireMatch([
      summaryRow({ batchId: 'batch-1' }),
      summaryRow({ batchId: 'batch-2' }),
      summaryRow({
        batchId: 'batch-3',
        distinctStamps: 2,
        firstStamp: 'ord-1',
        lastStamp: 'ord-2',
        unstampedRows: 0,
      }),
    ]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.matches.scope).toBe('this page');
    expect(report.matches.orders).toBe(0);
    expect(report.matches.unavailable).toEqual({
      unstamped: 2,
      'mixed-stamps': 1,
      'order-missing': 0,
      'order-redacted': 0,
      'match-error': 0,
    });
    expect(report.coverage.matchUnavailableRows).toBe(3);
    expect(Object.values(report.matches.byClass).every((n) => n === 0)).toBe(true);
  });

  // ONE BAD ORDER IS ONE ROW (OCa-6 / G2-3). The producer omits the key rather
  // than letting the matcher's guard escape, and the row that asked for it says
  // so by name — the pair stays exactly-one-of, and the page still renders.
  it("a stamp the matcher REFUSED reads 'match-error', and the page still renders", async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      wireMatch([selectedRow()]);
      // A negative ordered quantity: data no figure on this surface could be
      // derived from, and the only thing the matcher throws on.
      db.externalOrderItem.findMany.mockResolvedValue([itemRow({ quantity: -1 })] as never);

      const report = await getAttributionReport(INPUT, ADMIN);

      expect(report.rows).toHaveLength(1);
      expect(report.rows[0].match).toBeNull();
      expect(report.rows[0].matchUnavailable).toBe('match-error');
      expect(report.matches.unavailable['match-error']).toBe(1);
      expect(report.coverage.matchUnavailableRows).toBe(1);
      // P2 FD-1: a refused order was NOT compared — it must not sit on both sides.
      expect(report.matches.orders).toBe(0);
      expect(report.coverage.matchedOrders).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // OCa-10 / G2-4: `MATCH_DEFINITIONS` is ~1.8 KB and the envelope already
  // carries it ONCE. A copy per row made a fifty-row page carry it fifty-one
  // times, saying nothing the reader could not already read.
  it('no wire row carries a `definitions` key — the envelope holds the one copy', async () => {
    wireMatch([selectedRow()]);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].match).not.toBeNull();
    expect(Object.keys(report.rows[0].match as object)).not.toContain('definitions');
    // ...and the sentences are still on the envelope, where they are read from.
    expect(report.definitions.exact).toBe(MATCH_DEFINITIONS.exact);
  });

  it('every MATCH_CLASS_KEY is a key of byClass, at zero when unseen', async () => {
    wireMatch([selectedRow()]);
    const report = await getAttributionReport(INPUT, ADMIN);
    expect(Object.keys(report.matches.byClass).sort()).toEqual([...MATCH_CLASS_KEYS].sort());
  });

  // The match vocabulary rides with the numbers that use it — and the merge is
  // last, so a shared key would silently REPLACE a lane sentence with a class
  // sentence. The two sets are pinned disjoint by naming the lane's own keys.
  it('definitions carry every match definition, with no key collision', async () => {
    const LANE_DEFINITION_KEYS = [
      'population',
      'window',
      'batchesInWindow',
      'attributable',
      'nonAttributable',
      'noBatchRows',
      'historicalMassUpdate',
      'derived',
      'derivedShare',
      'moreCount',
      'needsALook',
      'recordingSince',
      'canAttribute',
      'fulfillmentTargetMissing',
      // G2-2: the two match TOTALS live in coverage, so their sentences live
      // with the lane's own — `MATCH_DEFINITIONS` defines classes and reasons,
      // and neither of these is either.
      'matchedOrders',
      'matchUnavailableRows',
    ];

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(LANE_DEFINITION_KEYS.filter((key) => key in MATCH_DEFINITIONS)).toEqual([]);
    expect(Object.keys(report.definitions).sort()).toEqual(
      [...LANE_DEFINITION_KEYS, ...Object.keys(MATCH_DEFINITIONS)].sort(),
    );
    for (const [key, sentence] of Object.entries(MATCH_DEFINITIONS)) {
      expect(report.definitions[key]).toBe(sentence);
    }
    // ...and the lane's own sentences survived the merge.
    expect(report.definitions.population).toBe(ATTRIBUTABLE_DEFINITION);
  });
});

// ---------------------------------------------------------------------------
// canAttribute / attributeLock / fulfilledAgainst (D4's UI predicate)
// ---------------------------------------------------------------------------

describe('the manual-attribution predicate', () => {
  /**
   * The order book this page's batched lookup finds. `ord-7` is here by default
   * because the R2b fixtures below LOCK to it: a lock names an order the picker
   * will submit, so from CR-1 onward the row is only allowed to offer one when
   * that order still exists.
   */
  const ORDER_BOOK = [orderRow(), orderRow({ id: 'ord-7', orderNumber: '#1007' })];

  async function oneRow(
    over: Partial<SqlRow>,
    orders: Array<Record<string, unknown>> = ORDER_BOOK,
  ): Promise<AttributionReport> {
    mockSummary([summaryRow(over)]);
    db.externalOrder.findMany.mockResolvedValue(orders as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
    return getAttributionReport(INPUT, ADMIN);
  }

  it('an ordinary unstamped batch can be attributed', async () => {
    const report = await oneRow({});
    expect(report.rows[0].canAttribute).toBe(true);
    expect(report.rows[0].attributeLock).toBeNull();
    expect(report.rows[0].fulfilledAgainst).toBeNull();
    expect(report.rows[0].fulfillmentTargetMissing).toBe(false);
  });

  it('a STAMPED fulfillment cannot — it names the order to change it through', async () => {
    const report = await oneRow({
      distinctStamps: 1,
      firstStamp: 'ord-1',
      lastStamp: 'ord-1',
      unstampedRows: 0,
      attemptId: 9,
      attemptOutcome: 'attributed',
      attemptEvidence: 'fulfillment',
      attemptSource: 'fulfillment',
      attemptOrderRecordId: 'ord-1',
    });
    expect(report.rows[0].canAttribute).toBe(false);
    expect(report.rows[0].fulfilledAgainst).toEqual({
      orderRecordId: 'ord-1',
      orderNumber: '#1001',
    });
  });

  it('an R2b batch can be attributed, LOCKED to the fulfillment event order', async () => {
    const report = await oneRow({
      auditId: 6,
      auditActionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
      auditEntityId: 'ord-7',
    });
    expect(report.rows[0].how.ruleId).toBe('R2b');
    expect(report.rows[0].how.ledgerUnstamped).toBe(true);
    expect(report.rows[0].canAttribute).toBe(true);
    expect(report.rows[0].attributeLock).toEqual({
      orderRecordId: 'ord-7',
      reason: 'r2b-completion',
    });
    expect(report.rows[0].fulfillmentTargetMissing).toBe(false);
  });

  // CR-1: the lock names an id the picker submits and the POST looks up FOR
  // SHARE. The order id is a SOFT reference, so a sync can delete the order a
  // historical fulfillment event named — and the row went on offering
  // "Attribute…", locking the admin to that id, with a guaranteed 404 at the end
  // of it. The report loads its orders for the STAMPS; the fulfillment target
  // now rides that same batched lookup, and a target that is gone is SAID rather
  // than offered.
  it('an R2b batch whose target order was DELETED offers nothing, and says why (CR-1)', async () => {
    const report = await oneRow(
      {
        auditId: 6,
        auditActionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
        auditEntityId: 'ord-7',
      },
      [orderRow()], // ord-1 exists; ord-7 does not
    );

    expect(report.rows[0].how.ruleId).toBe('R2b');
    expect(report.rows[0].fulfillmentTargetMissing).toBe(true);
    expect(report.rows[0].canAttribute).toBe(false);
    expect(report.rows[0].attributeLock).toBeNull();
  });

  it('the fulfillment target rides the SAME batched order lookup as the stamps (CR-1)', async () => {
    await oneRow({
      auditId: 6,
      auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
      auditOrderId: 'ord-7',
    });

    // Still ONE findMany for the page — the id joins the list, it does not buy
    // a statement of its own.
    expect(db.externalOrder.findMany).toHaveBeenCalledTimes(1);
    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['ord-7'] } },
    });
  });

  it('a STAMPED fulfillment is unaffected — the missing-target fact is about the R2b LOCK (CR-1)', async () => {
    const report = await oneRow(
      {
        distinctStamps: 1,
        firstStamp: 'ord-1',
        lastStamp: 'ord-1',
        unstampedRows: 0,
        auditId: 6,
        auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
        auditOrderId: 'ord-1',
      },
      [], // even the stamp's own order is gone
    );

    // The stamp says so through `order`, which is the fact that belongs to it.
    expect(report.rows[0].order).toEqual({ orderMissing: true });
    expect(report.rows[0].fulfillmentTargetMissing).toBe(false);
    expect(report.rows[0].canAttribute).toBe(false);
  });

  it('more than fifty rows, or mixed stamps, cannot', async () => {
    const big = await oneRow({ rowCount: 51 });
    expect(big.rows[0].canAttribute).toBe(false);

    const mixed = await oneRow({
      distinctStamps: 2,
      firstStamp: 'ord-1',
      lastStamp: 'ord-2',
      unstampedRows: 0,
    });
    expect(mixed.rows[0].canAttribute).toBe(false);
  });

  // OC-1: the fulfillment FACT is the ledger's own event OR the latest attempt's
  // evidence — the way the manual-attribution core reads it. Keying the row on
  // the attempt alone re-opened the control on batches the core refuses.
  it('a MANUAL attempt over a fulfillment event STILL cannot be re-attributed (the post-R2b re-read)', async () => {
    const report = await oneRow({
      distinctStamps: 1,
      firstStamp: 'ord-1',
      lastStamp: 'ord-1',
      unstampedRows: 0,
      auditId: 6,
      auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
      auditOrderId: 'ord-1',
      attemptId: 21,
      attemptOutcome: 'attributed',
      attemptEvidence: 'manual',
      attemptSource: 'manual',
      attemptActorUserId: 7,
      attemptOrderRecordId: 'ord-1',
    });

    // The RECORDED class still wins — this is about the affordance, not the chip.
    expect(report.rows[0].how.classKey).toBe('attributed·manual');
    expect(report.rows[0].canAttribute).toBe(false);
    expect(report.rows[0].fulfilledAgainst).toEqual({
      orderRecordId: 'ord-1',
      orderNumber: '#1001',
    });
  });

  it('an UNSTAMPED fulfillment batch is LOCKED to the event order even when an attempt was recorded', async () => {
    const report = await oneRow({
      auditId: 6,
      auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
      auditEntityId: 'ord-7',
      attemptId: 22,
      attemptOutcome: 'declined',
      attemptReason: 'unmatched',
      attemptSource: 'live-deduct',
      attemptActorUserId: 7,
    });

    expect(report.rows[0].how.classKey).toBe('declined·unmatched');
    expect(report.rows[0].how.ruleId).toBeUndefined();
    // The core would accept ONLY ord-7 here (R2b completion), so the lock comes
    // from the fact — never from `ruleId === 'R2b'`, which a recorded attempt
    // erases.
    expect(report.rows[0].canAttribute).toBe(true);
    expect(report.rows[0].attributeLock).toEqual({
      orderRecordId: 'ord-7',
      reason: 'r2b-completion',
    });
  });

  // QA-6: TWO audit rows, and the fulfillment is the SECOND one. The list read
  // joins the EARLIEST row, so this batch used to arrive with no fulfillment fact
  // at all — the control lit, the core refused, exactly the OC-1 class again.
  it('a batch whose fulfillment event is NOT its earliest audit row is still a fulfillment (QA-6)', async () => {
    const report = await oneRow({
      distinctStamps: 1,
      firstStamp: 'ord-1',
      lastStamp: 'ord-1',
      unstampedRows: 0,
      auditId: 6,
      auditActionType: 'INVENTORY_DEDUCT',
      fulfillmentAuditId: 7,
      fulfillmentActionType: 'EXTERNAL_ORDER_FULFILLMENT',
      fulfillmentEntityId: 'ord-1',
      fulfillmentOrderId: 'ord-1',
    });

    expect(report.rows[0].canAttribute).toBe(false);
    expect(report.rows[0].fulfilledAgainst).toEqual({
      orderRecordId: 'ord-1',
      orderNumber: '#1001',
    });
  });

  it('the batch-wide read LOCKS an unstamped second-row fulfillment to its order (QA-6)', async () => {
    const report = await oneRow({
      auditId: 6,
      auditActionType: 'INVENTORY_DEDUCT',
      fulfillmentAuditId: 7,
      fulfillmentActionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
      fulfillmentEntityId: 'ord-7',
      fulfillmentOrderId: null,
    });

    expect(report.rows[0].attributeLock).toEqual({
      orderRecordId: 'ord-7',
      reason: 'r2b-completion',
    });
  });

  // QA-7: fulfilled, unstamped, and the event names NOTHING. The core answers
  // every order the picker could offer with R2B_OTHER_TARGET, so the control that
  // opens the picker is a button that can only 409.
  it('a fulfillment event naming NO order cannot be attributed at all (QA-7)', async () => {
    const report = await oneRow({
      auditId: 6,
      auditActionType: 'EXTERNAL_ORDER_FULFILLMENT',
      auditEntityId: null,
      auditOrderId: null,
    });

    expect(report.rows[0].attributeLock).toBeNull();
    expect(report.rows[0].canAttribute).toBe(false);
  });

  // OC-6: one id on some rows and none on the others. The guarded write names the
  // id it locked, so it can move half of this batch and no more.
  it('a PARTLY STAMPED batch cannot be attributed (a guarded update cannot move it uniformly)', async () => {
    const report = await oneRow({
      rowCount: 4,
      distinctStamps: 1,
      firstStamp: 'ord-1',
      lastStamp: 'ord-1',
      unstampedRows: 2,
    });

    expect(report.rows[0].canAttribute).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRecordingSince — memoize the boundary, NEVER the absence of one
// ---------------------------------------------------------------------------

describe('getRecordingSince', () => {
  it('re-reads while recording has not started (a null is never memoized)', async () => {
    db.orderAttributionAttempt.findFirst.mockResolvedValue(null as never);

    expect(await getRecordingSince()).toBeNull();
    expect(await getRecordingSince()).toBeNull();

    expect(db.orderAttributionAttempt.findFirst).toHaveBeenCalledTimes(2);
  });

  it('memoizes a real boundary and reads the FIRST row by id', async () => {
    db.orderAttributionAttempt.findFirst.mockResolvedValue({
      attemptedAt: new Date('2026-08-25T09:00:00.000Z'),
    } as never);

    const first = await getRecordingSince();
    const second = await getRecordingSince();

    expect(first).toEqual(second);
    expect(db.orderAttributionAttempt.findFirst).toHaveBeenCalledTimes(1);
    expect(db.orderAttributionAttempt.findFirst.mock.calls[0][0]).toMatchObject({
      orderBy: { id: 'asc' },
      select: { attemptedAt: true },
    });
  });

  it('__resetForTests clears the memo', async () => {
    db.orderAttributionAttempt.findFirst.mockResolvedValue({
      attemptedAt: new Date('2026-08-25T09:00:00.000Z'),
    } as never);
    await getRecordingSince();
    __resetForTests();
    await getRecordingSince();
    expect(db.orderAttributionAttempt.findFirst).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getBatchDetail
// ---------------------------------------------------------------------------

describe('getBatchDetail', () => {

  it('FD-1: a CASE-VARIANT stamp still finds its order — the map answers for the id ASKED (MySQL matched it ci; a JS-exact miss would assert orderMissing about an order that exists)', async () => {
    wireDetail({});
    db.inventory_logs.findMany.mockResolvedValue([{ ...ledgerRow, orderRecordId: 'ORD-1' }] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never); // canonical id 'ord-1'
    const detail = await getBatchDetail('detail-batch-1', ADMIN);
    expect(detail?.batch.order).not.toBeNull();
    expect((detail?.batch.order as { orderMissing?: boolean }).orderMissing).toBeUndefined();
  });

  it('THE BATCH ID SURVIVES THE POPULATION SPREAD in the detail ledger read (the M2b step-9 class, read-path twin — found live: 489 foreign rows + a bogus R1b)', async () => {
    wireDetail({});
    await getBatchDetail('detail-batch-1', ADMIN);
    const call = db.inventory_logs.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where.batchId).toBe('detail-batch-1');
  });
  const ledgerRow = {
    id: 501,
    productId: 9,
    delta: -3,
    logType: 'SALE',
    changeTime: new Date('2026-08-10T12:00:00.000Z'),
    orderRecordId: 'ord-1',
    products: { name: 'Widget' },
  };

  function wireDetail(over: { attempts?: unknown[]; audits?: unknown[]; attribution?: unknown[] } = {}) {
    db.inventory_logs.findMany.mockResolvedValue([ledgerRow] as never);
    db.auditLog.findMany.mockImplementation(((args: { where?: { actionType?: string } }) =>
      Promise.resolve(
        args?.where?.actionType === 'INVENTORY_ATTRIBUTE'
          ? (over.attribution ?? [])
          : (over.audits ?? []),
      )) as never);
    db.orderAttributionAttempt.findMany.mockResolvedValue((over.attempts ?? []) as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
  }

  it('returns null for a batch with no population rows (the route answers 404)', async () => {
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    expect(await getBatchDetail('nope', ADMIN)).toBeNull();
  });

  it('assembles the ledger rows, the labelled audit event, the attempts and the derivation', async () => {
    wireDetail({
      audits: [
        {
          id: 3,
          actionType: 'INVENTORY_DEDUCT',
          entityId: '9',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          details: { orderReference: '1001', intent: 'order', selectedExternalOrderId: 'ord-1' },
        },
      ],
      attribution: [
        {
          id: 40,
          createdAt: new Date('2026-08-20T12:00:00.000Z'),
          userId: 7,
          details: {
            orderRecordId: 'ord-1',
            previousOrderRecordId: null,
            reason: null,
            rowCount: 1,
          },
        },
      ],
    });

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail).not.toBeNull();
    expect(detail!.batch.batchId).toBe('batch-1');
    expect(detail!.batch.units).toBe(3);
    expect(detail!.ledgerRows).toEqual([
      {
        id: 501,
        productId: 9,
        productName: 'Widget',
        delta: -3,
        logType: 'SALE',
        changeTime: '2026-08-10T12:00:00.000Z',
        orderRecordId: 'ord-1',
      },
    ]);
    expect(detail!.auditEvent).toEqual({
      id: 3,
      actionType: 'INVENTORY_DEDUCT',
      createdAt: '2026-08-10T12:00:00.000Z',
      orderReference: '1001',
      intent: 'order',
      selectedExternalOrderId: 'ord-1',
      label: 'from the audit event (free text, admin-visible on /admin/logs)',
    });
    expect(detail!.derived?.ruleId).toBe('R3a');
    expect(detail!.attributionEvents[0]).toMatchObject({
      id: 40,
      actor: { id: 7, username: 'kris' },
      details: { orderRecordId: 'ord-1', rowCount: 1 },
    });
  });

  // CR-4: the attempt array is READ NEWEST-FIRST and BOUNDED, so what the cap
  // keeps is the recent history and the latest row is structurally attempts[0].
  // Reading the latest as `attempts[attempts.length - 1]` off a capped
  // oldest-first read would have classified the batch by its OLDEST attempt the
  // moment the history crossed the bound.
  it('the recorded attempt history rides NEWEST-FIRST, and the newest drives the class', async () => {
    wireDetail({
      attempts: [
        {
          id: 2,
          attemptedAt: new Date('2026-08-11T12:00:00.000Z'),
          outcome: 'attributed',
          evidence: 'manual',
          reason: null,
          source: 'manual',
          actorUserId: 7,
          orderRecordId: 'ord-1',
          previousOrderRecordId: null,
          details: { rowCount: 1 },
        },
        {
          id: 1,
          attemptedAt: new Date('2026-08-10T12:00:00.000Z'),
          outcome: 'declined',
          evidence: null,
          reason: 'unmatched',
          source: 'live-deduct',
          actorUserId: 7,
          orderRecordId: null,
          previousOrderRecordId: null,
          details: null,
        },
      ],
    });

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.attempts.map((attempt) => attempt.id)).toEqual([2, 1]);
    expect(detail!.batch.how.classKey).toBe('attributed·manual');
    expect(detail!.derived).toBeNull();

    // The READ itself is newest-first — that is what makes the sentence above a
    // structural property rather than a hope about array length.
    expect(db.orderAttributionAttempt.findMany.mock.calls[0][0]).toMatchObject({
      where: { batchId: 'batch-1' },
      orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
    expect(detail!.attemptsTruncated).toBe(false);
    expect(detail!.attemptsCount).toBe(2);
  });

  // CR-4: attempts are APPEND-ONLY and manual attributions accumulate, so both
  // arrays used to grow without bound — one detail response, one actor lookup
  // and one browser render that got larger with every legitimate re-attribution.
  it('bounds the attempt history at twenty and SAYS when it cut (CR-4)', async () => {
    const attempts = Array.from({ length: 21 }, (_, i) => ({
      id: 100 - i,
      attemptedAt: new Date(Date.UTC(2026, 7, 21 - i, 12)),
      outcome: 'declined',
      evidence: null,
      reason: 'unmatched',
      source: 'live-deduct',
      actorUserId: 7,
      orderRecordId: null,
      previousOrderRecordId: null,
      details: null,
    }));
    wireDetail({ attempts });
    db.orderAttributionAttempt.count.mockResolvedValue(137 as never);

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.attempts).toHaveLength(20);
    // The NEWEST twenty, newest first.
    expect(detail!.attempts[0].id).toBe(100);
    expect(detail!.attemptsTruncated).toBe(true);
    // The total is bought ONLY over the bound (the QA-1 aggregate's idiom).
    expect(detail!.attemptsCount).toBe(137);
    expect(db.orderAttributionAttempt.count.mock.calls[0][0]).toMatchObject({
      where: { batchId: 'batch-1' },
    });
  });

  it('bounds the manual-attribution history the same way (CR-4)', async () => {
    const events = Array.from({ length: 21 }, (_, i) => ({
      id: 200 - i,
      createdAt: new Date(Date.UTC(2026, 7, 21 - i, 12)),
      userId: 7,
      details: { orderRecordId: 'ord-1', previousOrderRecordId: null, reason: null, rowCount: 1 },
    }));
    wireDetail({ attribution: events });
    db.auditLog.count.mockResolvedValue(44 as never);

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.attributionEvents).toHaveLength(20);
    expect(detail!.attributionEvents[0].id).toBe(200);
    expect(detail!.attributionEventsTruncated).toBe(true);
    expect(detail!.attributionEventsCount).toBe(44);
    expect(db.auditLog.findMany.mock.calls.some((call) => {
      const args = call[0] as { where?: { actionType?: string }; orderBy?: unknown; take?: number };
      return (
        args?.where?.actionType === 'INVENTORY_ATTRIBUTE' &&
        args.take === 21 &&
        JSON.stringify(args.orderBy) === JSON.stringify([{ createdAt: 'desc' }, { id: 'desc' }])
      );
    })).toBe(true);
  });

  it('inside the bounds, the counts are the arrays and cost NO extra statement (CR-4)', async () => {
    wireDetail({});

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.attemptsTruncated).toBe(false);
    expect(detail!.attemptsCount).toBe(0);
    expect(detail!.attributionEventsTruncated).toBe(false);
    expect(detail!.attributionEventsCount).toBe(0);
    expect(db.orderAttributionAttempt.count).not.toHaveBeenCalled();
    expect(db.auditLog.count).not.toHaveBeenCalled();
  });

  // OC-2: the drill-down's R0 used to read the action type off the EARLIEST audit
  // row while reading the shape keys across all of them — so a batch whose bulk
  // event is not its first one was "attributable" here and refused by the core.
  it('R0 reads EVERY audit row filed under the batch id — the array the core reads (OC-2)', async () => {
    wireDetail({
      audits: [
        {
          id: 1,
          actionType: 'INVENTORY_ADJUSTMENT',
          entityId: null,
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          details: { rows: 40 },
        },
        {
          id: 2,
          actionType: 'INVENTORY_BULK_UPDATE',
          entityId: null,
          createdAt: new Date('2026-08-10T12:00:01.000Z'),
          details: {},
        },
      ],
    });
    db.inventory_logs.findMany.mockResolvedValue([
      { ...ledgerRow, logType: 'ADJUSTMENT', orderRecordId: null },
    ] as never);

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.batch.canAttribute).toBe(false);
  });

  // OC-8: a mass update's whole ledger used to travel to the browser.
  it('bounds the ledger read at the manual limit + 1, and SAYS when it cut', async () => {
    wireDetail({});
    db.inventory_logs.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({ ...ledgerRow, id: 500 + i })) as never,
    );

    const detail = await getBatchDetail('batch-1', ADMIN);

    const call = db.inventory_logs.findMany.mock.calls[0][0] as { take?: number };
    expect(call.take).toBe(51);
    expect(detail!.ledgerRowsTruncated).toBe(true);
    expect(detail!.ledgerRows).toHaveLength(50);
    // Over the bound, so the control stays off — which is what the core says too.
    expect(detail!.batch.canAttribute).toBe(false);
  });

  it('a batch INSIDE the bound is not truncated and keeps every row', async () => {
    wireDetail({});
    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.ledgerRowsTruncated).toBe(false);
    expect(detail!.ledgerRows).toHaveLength(1);
    // ...and it costs no AGGREGATE statement: the array IS the whole ledger.
    // RE-MEASURED at A2 (P-5): the raw channel is no longer idle here — the
    // match's deducted-side aggregate rides it — so the pin names the statement
    // that must NOT be there instead of counting the channel.
    const raw = db.$queryRaw.mock.calls.map((call) => (call[0] as unknown as { sql: string }).sql);
    expect(raw.filter((sql) => sql.includes('GROUP_CONCAT(DISTINCT l.logType'))).toEqual([]);
    expect(raw.filter((sql) => sql.includes('AS outUnits'))).toHaveLength(1);
  });

  // QA-1: the bound belongs to the ARRAY. `batch` is the report row, and one
  // computed off the first fifty rows of a five-hundred-row batch reports a units
  // figure, a class and an order that are simply false. Over the bound the row is
  // computed from ONE batch-scoped aggregate over the FULL ledger.
  function truncatedLedger() {
    db.inventory_logs.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({
        ...ledgerRow,
        id: 500 + i,
        delta: -1,
        orderRecordId: null,
      })) as never,
    );
  }

  it('over the bound, `batch` is EXACT — ONE batch-scoped aggregate over the whole ledger (QA-1)', async () => {
    wireDetail({});
    truncatedLedger();
    mockSummary([
      {
        rowCount: 500,
        units: 1200,
        productCount: 37,
        minChangeTime: new Date('2026-08-01T00:00:00.000Z'),
        logTypes: 'ADJUSTMENT,SALE',
        distinctStamps: 0,
        firstStamp: null,
        lastStamp: null,
        unstampedRows: 500,
      },
    ]);

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(detail!.ledgerRowsTruncated).toBe(true);
    expect(detail!.ledgerRows).toHaveLength(50);
    expect(detail!.batch.units).toBe(1200);
    expect(detail!.batch.productCount).toBe(37);
    expect(detail!.batch.at).toBe('2026-08-01T00:00:00.000Z');
    expect(detail!.batch.logTypes).toEqual(['ADJUSTMENT', 'SALE']);
    // 500 rows is over the manual limit, and the aggregate is what knows it.
    expect(detail!.batch.canAttribute).toBe(false);
  });

  it('the aggregate reads the ONE population predicate, scoped to this batch id (QA-1)', async () => {
    wireDetail({});
    truncatedLedger();
    await getBatchDetail('detail-batch-1', ADMIN);

    const statement = db.$queryRaw.mock.calls[0][0] as unknown as {
      sql: string;
      values: unknown[];
    };
    expect(statement.sql).toContain('l.batchId = ?');
    expect(statement.sql).toContain('l.logType IN (?,?)');
    expect(statement.sql).toContain('l.delta < 0');
    expect(statement.sql).toContain('GROUP_CONCAT(DISTINCT l.logType');
    expect(statement.values).toContainEqual('detail-batch-1');
  });

  it("over the bound, the STAMPS are the whole ledger's — a batch stamped from row 100 says so (QA-1)", async () => {
    wireDetail({});
    truncatedLedger();
    mockSummary([
      {
        rowCount: 500,
        units: 500,
        productCount: 2,
        minChangeTime: new Date('2026-08-01T00:00:00.000Z'),
        logTypes: 'SALE',
        distinctStamps: 1,
        firstStamp: 'ord-1',
        lastStamp: 'ord-1',
        unstampedRows: 0,
      },
    ]);

    const detail = await getBatchDetail('batch-1', ADMIN);

    // The fifty rows on screen carry no stamp; the ledger does, and the row says so.
    expect(detail!.ledgerRows.every((row) => row.orderRecordId === null)).toBe(true);
    expect(detail!.batch.order).toMatchObject({ id: 'ord-1', orderNumber: '#1001' });
  });

  it('a MEMBER sees no actor identity on the batch or its attempts', async () => {
    wireDetail({
      attempts: [
        {
          id: 2,
          attemptedAt: new Date('2026-08-11T12:00:00.000Z'),
          outcome: 'attributed',
          evidence: 'manual',
          reason: null,
          source: 'manual',
          actorUserId: 7,
          orderRecordId: 'ord-1',
          previousOrderRecordId: null,
          details: null,
        },
      ],
    });

    const detail = await getBatchDetail('batch-1', MEMBER);

    expect(detail!.batch.actor).toBeNull();
    expect(detail!.attempts[0].actor).toBeNull();
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  // CR-1, on the drill-down: this surface builds its row through the SAME
  // buildRow, so the missing-target branch has to be reachable here too — and
  // its order lookup has to hydrate the fulfillment target, not just the stamp.
  function wireR2bDetail(orders: Array<Record<string, unknown>>) {
    wireDetail({
      audits: [
        {
          id: 6,
          actionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
          entityId: 'ord-7',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          details: { orderId: 'ord-7' },
        },
      ],
    });
    db.inventory_logs.findMany.mockResolvedValue([
      { ...ledgerRow, orderRecordId: null },
    ] as never);
    db.externalOrder.findMany.mockResolvedValue(orders as never);
  }

  it('the drill-down LOCKS an R2b batch whose target still exists (CR-1)', async () => {
    wireR2bDetail([orderRow({ id: 'ord-7', orderNumber: '#1007' })]);

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['ord-7'] } },
    });
    expect(detail!.batch.canAttribute).toBe(true);
    expect(detail!.batch.attributeLock).toEqual({
      orderRecordId: 'ord-7',
      reason: 'r2b-completion',
    });
    expect(detail!.batch.fulfillmentTargetMissing).toBe(false);
  });

  it('the drill-down offers nothing when that target was DELETED (CR-1)', async () => {
    wireR2bDetail([]);

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.batch.fulfillmentTargetMissing).toBe(true);
    expect(detail!.batch.canAttribute).toBe(false);
    expect(detail!.batch.attributeLock).toBeNull();
  });

  // -------------------------------------------------------------------------
  // The "This order" panel (Part 2, pack CA2.2)
  // -------------------------------------------------------------------------

  /** Every statement one drill-down spends, including the match's three. */
  function detailStatementCount(): number {
    return (
      statementCount() +
      db.inventory_logs.findMany.mock.calls.length +
      db.auditLog.findMany.mock.calls.length +
      db.auditLog.count.mock.calls.length +
      db.orderAttributionAttempt.findMany.mock.calls.length +
      db.orderAttributionAttempt.count.mock.calls.length
    );
  }

  it("carries the order's match, taken off the row so the two can never disagree", async () => {
    wireDetail({});
    mockSummary([], [deductedSideRow()]);
    db.externalOrderItem.findMany.mockResolvedValue([itemRow()] as never);
    db.product.findMany.mockResolvedValue([productRow()] as never);

    const detail = await getBatchDetail('detail-batch-1', ADMIN);

    expect(detail!.orderMatchUnavailable).toBeNull();
    expect(detail!.orderMatch).toBe(detail!.batch.match);
    expect(detail!.orderMatch).toMatchObject({
      class: 'exact',
      unmappedLines: 0,
      unmappedUnits: 0,
    });
    // MEASURED at A2 (P-5): the six a stamped admin read already spent (the
    // ledger, the audit rows, the attempts, the manual attributions,
    // recordingSince and the order lookup) plus the match's three.
    expect(detailStatementCount()).toBe(9);
  });

  // The drill-down's twin of the report pin: the panel says the row could not be
  // matched rather than the sheet failing to open at all (OCa-6).
  it("a REFUSED order reads 'match-error' on the detail too, and the sheet still opens", async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      wireDetail({});
      mockSummary([], [deductedSideRow()]);
      db.externalOrderItem.findMany.mockResolvedValue([itemRow({ quantity: -1 })] as never);
      db.product.findMany.mockResolvedValue([productRow()] as never);

      const detail = await getBatchDetail('detail-batch-1', ADMIN);

      expect(detail).not.toBeNull();
      expect(detail!.orderMatch).toBeNull();
      expect(detail!.orderMatchUnavailable).toBe('match-error');
      expect(detail!.batch.matchUnavailable).toBe('match-error');
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('the detail match carries no `definitions` key either (OCa-10)', async () => {
    wireDetail({});
    mockSummary([], [deductedSideRow()]);
    db.externalOrderItem.findMany.mockResolvedValue([itemRow()] as never);
    db.product.findMany.mockResolvedValue([productRow()] as never);

    const detail = await getBatchDetail('detail-batch-1', ADMIN);

    expect(Object.keys(detail!.orderMatch as object)).not.toContain('definitions');
  });

  it('an UNAVAILABLE row spends NOTHING on the match — no items, no aggregate, no products', async () => {
    wireDetail({});
    db.inventory_logs.findMany.mockResolvedValue([
      { ...ledgerRow, orderRecordId: null },
    ] as never);

    const detail = await getBatchDetail('detail-batch-1', ADMIN);

    expect(detail!.orderMatch).toBeNull();
    expect(detail!.orderMatchUnavailable).toBe('unstamped');
    expect(db.externalOrderItem.findMany).not.toHaveBeenCalled();
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    // FIVE, not six: an unstamped batch with no fulfillment target has no order
    // id to hydrate either, so the order lookup returns without a statement of
    // its own. Three of the four missing statements are the match's.
    expect(detailStatementCount()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// R0 parity across the THREE call sites (OC-2)
// ---------------------------------------------------------------------------

/**
 * ONE audit array, three readers: the report row, the drill-down and the
 * manual-attribution core. They now share `batchEvidence`, and this is the pin
 * that says so from the outside.
 *
 * The array is a SINGLE event on purpose: the list read carries the earliest
 * audit row and no other (D7's one statement, D6's no-details rule), so a
 * one-event batch is the only shape all three can literally be handed. The
 * multi-event divergence the helper also closes is pinned on the drill-down
 * above, against the core's own reading.
 */
describe('R0 parity across the three call sites', () => {
  it('the list, the drill-down and the core all refuse the SAME pre-lane mass update', async () => {
    // 1. THE LIST
    mockSummary([
      summaryRow({
        logTypes: 'ADJUSTMENT',
        auditId: 1,
        auditActionType: 'INVENTORY_BULK_UPDATE',
        auditHasRows: 1,
      }),
    ]);
    const report = await getAttributionReport(INPUT, ADMIN);
    expect(report.rows).toEqual([]);
    expect(report.totals.exclusions.historicalMassUpdate).toBe(1);

    // 2. THE DRILL-DOWN
    db.inventory_logs.findMany.mockResolvedValue([
      {
        id: 501,
        productId: 9,
        delta: -3,
        logType: 'ADJUSTMENT',
        changeTime: new Date('2026-08-10T12:00:00.000Z'),
        orderRecordId: null,
        products: { name: 'Widget' },
      },
    ] as never);
    db.auditLog.findMany.mockImplementation(((args: { where?: { actionType?: string } }) =>
      Promise.resolve(
        args?.where?.actionType === 'INVENTORY_ATTRIBUTE'
          ? []
          : [
              {
                id: 1,
                actionType: 'INVENTORY_BULK_UPDATE',
                entityId: null,
                createdAt: new Date('2026-08-10T12:00:00.000Z'),
                details: { rows: 40 },
              },
            ],
      )) as never);
    db.orderAttributionAttempt.findMany.mockResolvedValue([] as never);
    const detail = await getBatchDetail('batch-1', ADMIN);
    expect(detail!.batch.canAttribute).toBe(false);

    // 3. THE CORE
    const tx = mockDeep<Prisma.TransactionClient>();
    (tx.$queryRaw as unknown as jest.Mock).mockResolvedValue([
      { id: 501, productId: 9, logType: 'ADJUSTMENT', orderRecordId: null },
    ]);
    (tx.auditLog.findMany as unknown as jest.Mock).mockResolvedValue([
      { id: 1, actionType: 'INVENTORY_BULK_UPDATE', entityId: null, details: { rows: 40 } },
    ]);
    await expect(
      attributeBatch(
        tx,
        {
          batchId: 'batch-1',
          orderRecordId: 'ord-1',
          expectPreviousOrderRecordId: null,
          reason: null,
          actorUserId: 1,
        },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'NOT_ATTRIBUTABLE' });
  });
});

// ---------------------------------------------------------------------------
// searchOrders
// ---------------------------------------------------------------------------

describe('searchOrders', () => {
  beforeEach(() => {
    db.$transaction.mockImplementation(((ops: unknown) =>
      Promise.all(ops as Promise<unknown>[])) as never);
  });

  it('an empty query asks the database nothing', async () => {
    expect(await searchOrders('   ', ADMIN)).toEqual({ orders: [], moreCount: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('matches on orderNumber startsWith, bounded at twenty, with an EXACT moreCount', async () => {
    db.externalOrder.count.mockResolvedValue(23 as never);
    db.externalOrder.findMany.mockResolvedValue([
      { ...orderRow(), _count: { items: 4 } },
    ] as never);

    const result = await searchOrders(' 100 ', ADMIN);

    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { orderNumber: { startsWith: '100' } },
      take: 20,
    });
    expect(result.orders).toEqual([
      {
        id: 'ord-1',
        orderNumber: '#1001',
        platform: 'WOOCOMMERCE',
        internalStatus: 'pending',
        externalCreatedAt: '2026-08-09T00:00:00.000Z',
        itemCount: 4,
      },
    ]);
    expect(result.moreCount).toBe(22);
  });

  // QA-10: `startsWith` renders a LIKE, so a typed `%` was a wildcard and `q=%`
  // matched EVERY order in the book — the picker's twenty-row page then looked
  // like a search result. The wildcards are escaped, so they match themselves.
  it('escapes the LIKE wildcards, so `%` searches for a literal per cent (QA-10)', async () => {
    db.externalOrder.count.mockResolvedValue(0 as never);
    db.externalOrder.findMany.mockResolvedValue([] as never);

    await searchOrders('%', ADMIN);

    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { orderNumber: { startsWith: '\\%' } },
    });
    // The COUNT reads the SAME where — the bound and the page are one view.
    expect(db.externalOrder.count.mock.calls[0][0]).toMatchObject({
      where: { orderNumber: { startsWith: '\\%' } },
    });
  });

  it('escapes `_` and the escape character itself (QA-10)', async () => {
    db.externalOrder.count.mockResolvedValue(0 as never);
    db.externalOrder.findMany.mockResolvedValue([] as never);

    await searchOrders('a_b\\c', ADMIN);

    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { orderNumber: { startsWith: 'a\\_b\\\\c' } },
    });
  });

  it('a member searches only inside the membership', async () => {
    db.externalOrder.count.mockResolvedValue(0 as never);
    db.externalOrder.findMany.mockResolvedValue([] as never);

    await searchOrders('100', MEMBER);

    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { companyId: { in: ['co-mine'] } },
    });
  });
});
