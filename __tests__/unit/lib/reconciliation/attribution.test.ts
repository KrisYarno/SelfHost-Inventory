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

import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { ATTRIBUTABLE_DEFINITION } from '@/lib/reconciliation/population';
import { DERIVED_SENTENCES } from '@/lib/reconciliation/derive';
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

const INPUT: AttributionInput = { from: '2026-08-01', to: '2026-08-31', limit: 50 };

/** Every prisma call the report read is allowed to make (D7's budget). */
function statementCount(): number {
  return (
    db.$queryRaw.mock.calls.length +
    db.user.findMany.mock.calls.length +
    db.externalOrder.findMany.mock.calls.length +
    db.orderAttributionAttempt.findFirst.mock.calls.length
  );
}

function rawSql(call = 0): string {
  const arg = db.$queryRaw.mock.calls[call][0] as unknown as { sql: string };
  return arg.sql;
}

beforeEach(() => {
  mockReset(db);
  __resetForTests();
  db.$queryRaw.mockResolvedValue([] as never);
  db.orderAttributionAttempt.findFirst.mockResolvedValue(null as never);
  db.user.findMany.mockResolvedValue([] as never);
  db.externalOrder.findMany.mockResolvedValue([] as never);
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

  it('carries NO id list — the window is the bound, never an enumeration of batches', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    expect(sql).not.toContain('b.batchId IN (');
    expect(sql).not.toContain('l.batchId IN (');
  });

  it('never selects the audit `details` blob — only the typed facts the rules read (D6)', async () => {
    await getAttributionReport(INPUT, ADMIN);
    const sql = rawSql();
    expect(sql).not.toContain('ae.details AS');
    expect(sql).toContain("JSON_EXTRACT(ae.details, '$.orderAttributionSource')");
    expect(sql).toContain("JSON_EXTRACT(ae.details, '$.intent')");
  });

  it('spends AT MOST five statements — four on a plain admin read', async () => {
    db.$queryRaw.mockResolvedValue([selectedRow()] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    await getAttributionReport(INPUT, ADMIN);

    expect(statementCount()).toBe(4);
    expect(statementCount()).toBeLessThanOrEqual(5);
  });

  it('the order-number filter rides IN the same statement (still at most five)', async () => {
    db.$queryRaw.mockResolvedValue([selectedRow()] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    await getAttributionReport({ ...INPUT, orderNumber: '#1001' }, ADMIN);

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(rawSql()).toContain('FROM external_orders f WHERE f.orderNumber = ?');
    expect(statementCount()).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Classification — recorded attempt wins, else the derivation
// ---------------------------------------------------------------------------

describe('classification', () => {
  it('a recorded attempt wins over the derivation', async () => {
    db.$queryRaw.mockResolvedValue([
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
    ] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].how.classKey).toBe('declined·unmatched');
    expect(report.rows[0].how.ruleId).toBeUndefined();
    expect(report.rows[0].source).toBe('live-deduct');
    expect(report.rows[0].actor).toEqual({ id: 7, username: 'kris' });
  });

  it('no attempt row derives the class and carries the ruleId + the rule sentence', async () => {
    db.$queryRaw.mockResolvedValue([
      summaryRow({ distinctStamps: 1, firstStamp: 'ord-1', lastStamp: 'ord-1', unstampedRows: 0 }),
    ] as never);
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
    db.$queryRaw.mockResolvedValue([summaryRow()] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].how.postLaneGap).toBe(true);
    expect(report.rows[0].how.sentence).toBe(
      'unknown — recording was live and this batch has no attempt row',
    );
  });

  it('an attempt row outside the closed vocabulary falls back to the derivation', async () => {
    db.$queryRaw.mockResolvedValue([
      summaryRow({
        distinctStamps: 1,
        firstStamp: 'ord-1',
        lastStamp: 'ord-1',
        unstampedRows: 0,
        attemptId: 12,
        attemptOutcome: 'teleported',
        attemptSource: 'live-deduct',
      }),
    ] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].how.classKey).toBe('attributed·derived');
    expect(report.rows[0].source).toBe('derived');
  });

  it('an R0 mass-update batch is excluded from the rows and counted as an exclusion', async () => {
    db.$queryRaw.mockResolvedValue([
      summaryRow({
        batchId: 'bulk-1',
        logTypes: 'ADJUSTMENT',
        auditId: 4,
        auditActionType: 'INVENTORY_BULK_UPDATE',
        auditHasRows: 1,
      }),
      selectedRow({ batchId: 'batch-2', minChangeTime: new Date('2026-08-09T12:00:00.000Z') }),
    ] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows.map((r) => r.batchId)).toEqual(['batch-2']);
    expect(report.totals.exclusions.historicalMassUpdate).toBe(1);
    expect(report.totals.attributable).toBe(1);
    expect(report.coverage.batchesInWindow).toBe(2);
  });

  it('units and product counts come from the batch summary (never multiplied)', async () => {
    db.$queryRaw.mockResolvedValue([summaryRow({ units: 12, productCount: 3, rowCount: 4 })] as never);

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
    db.$queryRaw.mockResolvedValue([
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-10T12:00:00.000Z') }),
      summaryRow({ batchId: 'b', minChangeTime: new Date('2026-08-09T12:00:00.000Z') }),
    ] as never);
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
    db.$queryRaw.mockResolvedValue([
      summaryRow({ nonAttributableBatches: 17, noBatchRows: 240 }),
    ] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.totals.exclusions).toEqual({
      nonAttributable: 17,
      historicalMassUpdate: 0,
      noBatchRows: 240,
    });
  });

  it('an EMPTY window still reports its exclusions (the coverage row survives no batches)', async () => {
    db.$queryRaw.mockResolvedValue([
      summaryRow({ batchId: null, minChangeTime: null, nonAttributableBatches: 3, noBatchRows: 9 }),
    ] as never);

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
    db.$queryRaw.mockResolvedValue(five() as never);

    const report = await getAttributionReport({ ...INPUT, limit: 2 }, ADMIN);

    expect(report.rows.map((r) => r.batchId)).toEqual(['b1', 'b2']);
    expect(report.count).toBe(5);
    expect(report.moreCount).toBe(3);
    expect(report.coverage.rowsReturned).toBe(2);
    expect(report.nextCursor).not.toBeNull();
  });

  it('the cursor round-trips and moreCount is EXACT on page 2', async () => {
    db.$queryRaw.mockResolvedValue(five() as never);
    const page1 = await getAttributionReport({ ...INPUT, limit: 2 }, ADMIN);

    db.$queryRaw.mockResolvedValue(five() as never);
    const page2 = await getAttributionReport(
      { ...INPUT, limit: 2, cursor: page1.nextCursor! },
      ADMIN,
    );

    expect(page2.rows.map((r) => r.batchId)).toEqual(['b3', 'b4']);
    expect(page2.count).toBe(5);
    expect(page2.moreCount).toBe(1);

    db.$queryRaw.mockResolvedValue(five() as never);
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
    db.$queryRaw.mockResolvedValue(rows as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const page1 = await getAttributionReport(
      { ...INPUT, limit: 2, classKey: 'attributed·selected' },
      ADMIN,
    );
    expect(page1.rows.map((r) => r.batchId)).toEqual(['a', 'c']);
    expect(page1.count).toBe(3);
    expect(page1.moreCount).toBe(1);

    db.$queryRaw.mockResolvedValue(rows as never);
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
    db.$queryRaw.mockResolvedValue([selectedRow()] as never);
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
    db.$queryRaw.mockResolvedValue([
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-11T12:00:00.000Z') }),
      selectedRow({
        batchId: 'b',
        minChangeTime: new Date('2026-08-10T12:00:00.000Z'),
        firstStamp: 'ord-2',
        lastStamp: 'ord-2',
        attemptOrderRecordId: 'ord-2',
      }),
    ] as never);
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
    db.$queryRaw.mockResolvedValue([
      summaryRow({ batchId: null, minChangeTime: null, orderNumberMatches: 0 }),
    ] as never);

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
    db.$queryRaw.mockResolvedValue([selectedRow()] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const admin = await getAttributionReport(INPUT, ADMIN);
    expect(JSON.stringify(admin)).not.toContain('companyId');

    db.$queryRaw.mockResolvedValue([selectedRow()] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    const member = await getAttributionReport(INPUT, MEMBER);
    expect(JSON.stringify(member)).not.toContain('companyId');
  });

  it('a stamped batch whose order was DELETED renders orderMissing (never redaction)', async () => {
    db.$queryRaw.mockResolvedValue([selectedRow()] as never);
    db.externalOrder.findMany.mockResolvedValue([] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);

    const report = await getAttributionReport(INPUT, ADMIN);

    expect(report.rows[0].order).toEqual({ orderMissing: true });
  });

  it('orders are fetched ONCE for the returned page only', async () => {
    db.$queryRaw.mockResolvedValue([
      selectedRow({ batchId: 'a', minChangeTime: new Date('2026-08-12T12:00:00.000Z') }),
      selectedRow({
        batchId: 'b',
        minChangeTime: new Date('2026-08-11T12:00:00.000Z'),
        firstStamp: 'ord-2',
        lastStamp: 'ord-2',
      }),
    ] as never);
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
    db.$queryRaw.mockResolvedValue([
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
    ] as never);
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
// canAttribute / attributeLock / fulfilledAgainst (D4's UI predicate)
// ---------------------------------------------------------------------------

describe('the manual-attribution predicate', () => {
  async function oneRow(over: Partial<SqlRow>): Promise<AttributionReport> {
    db.$queryRaw.mockResolvedValue([summaryRow(over)] as never);
    db.externalOrder.findMany.mockResolvedValue([orderRow()] as never);
    db.user.findMany.mockResolvedValue([{ id: 7, username: 'kris' }] as never);
    return getAttributionReport(INPUT, ADMIN);
  }

  it('an ordinary unstamped batch can be attributed', async () => {
    const report = await oneRow({});
    expect(report.rows[0].canAttribute).toBe(true);
    expect(report.rows[0].attributeLock).toBeNull();
    expect(report.rows[0].fulfilledAgainst).toBeNull();
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

  it('the recorded attempt history rides, newest LAST, and drives the class', async () => {
    wireDetail({
      attempts: [
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
      ],
    });

    const detail = await getBatchDetail('batch-1', ADMIN);

    expect(detail!.attempts).toHaveLength(2);
    expect(detail!.batch.how.classKey).toBe('attributed·manual');
    expect(detail!.derived).toBeNull();
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

  it('a member searches only inside the membership', async () => {
    db.externalOrder.count.mockResolvedValue(0 as never);
    db.externalOrder.findMany.mockResolvedValue([] as never);

    await searchOrders('100', MEMBER);

    expect(db.externalOrder.findMany.mock.calls[0][0]).toMatchObject({
      where: { companyId: { in: ['co-mine'] } },
    });
  });
});
