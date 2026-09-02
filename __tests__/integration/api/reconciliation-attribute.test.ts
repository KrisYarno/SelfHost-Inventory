/**
 * @jest-environment node
 *
 * MANUAL ATTRIBUTION — POST /api/reconciliation/attribution/[batchId]
 * (reconciliation lane, pack C2b.2/C2b.3/C2b.4; spec REV-7 D4 / §5).
 *
 * The REAL route drives the REAL core (`lib/reconciliation/attribute-batch.ts`)
 * over a hand-driven transaction client, so every pin below covers the whole
 * write path at once: the guard order, the frozen refusal ladder, the guarded
 * `updateMany`, the two records written inside the same transaction, and the
 * envelope each refusal renders on the wire.
 *
 * WHY THE TRANSACTION IS TRACED. D4's contract is not only "what does it answer"
 * but "what does it touch": the core locks this batch's rows, reads two things,
 * writes ONE statement, and never goes near `external_orders`, `products`,
 * `fulfilledQty` or `internalStatus`. A test that only asserted status codes
 * would pass on a core that also stocked the order out. So the tx records an
 * ordered STATEMENT TRACE and the happy path pins it exactly.
 *
 * The refusal messages are quoted VERBATIM (pack C2b.1): they are the sentences
 * an admin reads, and the UI renders them unmodified.
 */

jest.mock('@/lib/api-utils', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/api-utils'),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
  requireCSRF: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/rateLimit', () => {
  const actual = jest.requireActual('@/lib/rateLimit');
  return { __esModule: true, ...actual, enforceRateLimit: jest.fn(() => ({})) };
});

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep } = require('jest-mock-extended');
  return { __esModule: true, default: mockDeep() };
});

import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireAdmin, requireCSRF } from '@/lib/api-utils';
import { enforceRateLimit } from '@/lib/rateLimit';
import { POST } from '@/app/api/reconciliation/attribution/[batchId]/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireAdmin = requireAdmin as jest.Mock;
const mockRequireCSRF = requireCSRF as jest.Mock;
const mockEnforceRateLimit = enforceRateLimit as jest.Mock;

const LEDGER_BATCH = 'ledger-batch-1';
const MINTED_AUDIT_BATCH_MATCHER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One locked population row, as the FOR UPDATE select returns it. */
type LockedRow = { id: number; productId: number; logType: string; orderRecordId: string | null };

/** An audit row under the LEDGER batchId, as the core selects it. */
type AuditRow = {
  id: number;
  actionType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
};

function rows(over: Partial<LockedRow> = {}, count = 2): LockedRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 501 + i,
    productId: 9 + i,
    logType: 'SALE',
    orderRecordId: null,
    ...over,
  }));
}

const DEDUCT_EVENT: AuditRow = {
  id: 3,
  actionType: 'INVENTORY_DEDUCT',
  entityId: '9',
  details: { intent: 'order' },
};

/**
 * A RESTORATION event, as the ledger read selects it (pack CB2a.2): filed
 * against the reversed batch as its ENTITY, under one of the three restoring
 * action types.
 */
type RestorationEvent = {
  id: number;
  actionType: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

function fulfillmentEvent(orderId: string | null): AuditRow {
  return {
    id: 4,
    actionType: 'EXTERNAL_ORDER_FULFILLMENT',
    entityId: orderId,
    details: orderId === null ? {} : { orderId },
  };
}

interface TxFixture {
  /** The locked population rows, in id order. */
  locked?: LockedRow[];
  /** Audit rows under the ledger batchId. */
  auditEvents?: AuditRow[];
  /**
   * The RESTORATION ledger's events for this batch (pack CB2a.2). The same
   * delegate as `auditEvents` under a DIFFERENT where-clause, so the fixture
   * branches on it; empty by default, which is what every pre-B2 batch reads.
   */
  restorationEvents?: RestorationEvent[];
  /** The latest attempt row, or null. */
  latestAttempt?: { evidence: string | null } | null;
  /** The target order the route locks FOR UPDATE — null = it no longer exists. */
  order?: { id: string; orderNumber: string } | null;
  /**
   * The caller's stated PREVIOUS order, when the lock finds it. Advisory: the
   * route asks for it in the same statement and carries on without it (pack
   * CB1b.4), so it is absent from the returned rows unless a test says otherwise.
   */
  previousOrder?: { id: string; orderNumber: string };
  /** What the guarded updateMany reports. Defaults to the locked row count. */
  updatedCount?: number;
}

/**
 * A transaction client that RECORDS what was asked of it, in order.
 *
 * The two raw statements are told apart by their SQL, which doubles as a pin on
 * the frozen lock order (`external_orders` orders, then this batch's rows).
 */
function makeTx(fixture: TxFixture) {
  const locked = fixture.locked ?? rows();
  const trace: string[] = [];
  const tx = mockDeep<Prisma.TransactionClient>();

  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes('external_orders')) {
      trace.push('lock orders FOR UPDATE');
      const order = fixture.order === undefined ? { id: 'ord-9', orderNumber: '#1009' } : fixture.order;
      const rows = order === null ? [] : [order];
      if (fixture.previousOrder) rows.push(fixture.previousOrder);
      return rows;
    }
    trace.push('lock batch rows FOR UPDATE');
    return locked;
  });
  // ONE delegate, TWO reads: the batch's EVIDENCE (`where.batchId`) and the
  // RESTORATION ledger (`where.entityId` + the three restoring action types).
  // The fixture branches on the where-clause rather than answering both with
  // the same rows, which would feed deduction events to the ledger validator.
  (tx.auditLog.findMany as unknown as jest.Mock).mockImplementation(
    async (args: { where?: { batchId?: string; entityId?: string } }) => {
      trace.push('auditLog.findMany');
      if (args?.where?.entityId !== undefined) {
        return fixture.restorationEvents ?? [];
      }
      return fixture.auditEvents ?? [DEDUCT_EVENT];
    },
  );
  (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('orderAttributionAttempt.findFirst');
    return fixture.latestAttempt ?? null;
  });
  (tx.inventory_logs.updateMany as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('inventory_logs.updateMany');
    return { count: fixture.updatedCount ?? locked.length };
  });
  (tx.orderAttributionAttempt.create as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('orderAttributionAttempt.create');
    return { id: 77 };
  });
  (tx.auditLog.create as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('auditLog.create');
    return { id: 88 };
  });

  (db.$transaction as unknown as jest.Mock).mockImplementation(
    async (cb: (client: Prisma.TransactionClient) => Promise<unknown>) => cb(tx),
  );

  return { tx, trace };
}

function attributeRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/reconciliation/attribution/${LEDGER_BATCH}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' },
  });
}

async function attribute(body: unknown): Promise<Response> {
  return (await POST(attributeRequest(body), { params: { batchId: LEDGER_BATCH } })) as Response;
}

/** The default body: the client saw the batch unattributed and picked ord-9. */
const CLEAN_BODY = { orderRecordId: 'ord-9', expectPreviousOrderRecordId: null };

beforeEach(() => {
  mockReset(db);
  mockRequireAdmin.mockClear();
  mockRequireAdmin.mockResolvedValue({ user: { id: 1, isAdmin: true } });
  mockRequireCSRF.mockClear();
  mockRequireCSRF.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockClear();
  mockEnforceRateLimit.mockReturnValue({});
});

// ---------------------------------------------------------------------------
// The route surface
// ---------------------------------------------------------------------------

describe('POST /api/reconciliation/attribution/[batchId] — the route surface', () => {
  it('guards in the frozen order: admin, then the rate limit, then CSRF', async () => {
    makeTx({});
    await attribute(CLEAN_BODY);

    expect(mockRequireAdmin).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit.mock.calls[0][1]).toBe('reconciliation-attribute:POST');
    expect(mockEnforceRateLimit.mock.calls[0][2]).toEqual({ identifier: 1, limit: 30 });
    expect(mockRequireCSRF).toHaveBeenCalledTimes(1);

    const adminOrder = mockRequireAdmin.mock.invocationCallOrder[0];
    const limitOrder = mockEnforceRateLimit.mock.invocationCallOrder[0];
    const csrfOrder = mockRequireCSRF.mock.invocationCallOrder[0];
    expect(adminOrder).toBeLessThan(limitOrder);
    expect(limitOrder).toBeLessThan(csrfOrder);
  });

  it('400s when expectPreviousOrderRecordId is missing (the stale-client guard is REQUIRED)', async () => {
    makeTx({});
    const res = await attribute({ orderRecordId: 'ord-9' });
    expect(res.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('400s on an empty orderRecordId and on a reason over 500 characters', async () => {
    makeTx({});
    expect((await attribute({ orderRecordId: '', expectPreviousOrderRecordId: null })).status).toBe(
      400,
    );
    expect(
      (
        await attribute({
          orderRecordId: 'ord-9',
          expectPreviousOrderRecordId: 'ord-1',
          reason: 'x'.repeat(501),
        })
      ).status,
    ).toBe(400);
  });

  it('404s when the target order no longer exists (locked FOR UPDATE inside the tx)', async () => {
    const { trace } = makeTx({ order: null });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown order', code: 'NOT_FOUND' });
    // The order lock is the FIRST statement — the batch is never even read.
    expect(trace).toEqual(['lock orders FOR UPDATE']);
  });

  // CR-1: the READ side now refuses to offer an R2b completion whose named order
  // is gone (`fulfillmentTargetMissing`, no lock, no control), so this 404 stops
  // being the thing an admin discovers by clicking. It stays EXACTLY as it is —
  // it is the backstop for the window between the report read and the submit,
  // and for any client that submits an id the UI never offered.
  it('the 404 remains the BACKSTOP behind the suppressed control (CR-1)', async () => {
    const { tx, trace } = makeTx({
      order: null,
      locked: rows(),
      auditEvents: [fulfillmentEvent('ord-9')],
    });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown order', code: 'NOT_FOUND' });
    // Nothing was locked, read or written beyond the target lookup itself.
    expect(trace).toEqual(['lock orders FOR UPDATE']);
    expect(tx.inventory_logs.updateMany).not.toHaveBeenCalled();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('carries the literal recordChange( in the handler (the coverage gate reads source)', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'app/api/reconciliation/attribution/[batchId]/route.ts'),
      'utf8',
    );
    expect(source).toContain('recordChange(');
    expect(source).toContain('@/lib/change-tracking');
  });
});

// ---------------------------------------------------------------------------
// The refusal ladder, in the frozen D4 order
// ---------------------------------------------------------------------------

describe('the refusal ladder (spec D4, evaluated in this order)', () => {
  it('1. NOT_ATTRIBUTABLE — the batch has no population rows at all', async () => {
    const { trace } = makeTx({ locked: [] });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch is not an attributable outbound batch (transfer, count, correction, positive adjust or a pre-lane mass update)',
      code: 'NOT_ATTRIBUTABLE',
      batchId: LEDGER_BATCH,
    });
    // The empty guard fires BEFORE the audit read.
    expect(trace).toEqual(['lock orders FOR UPDATE', 'lock batch rows FOR UPDATE']);
  });

  it('2. NOT_ATTRIBUTABLE — R0: a pre-0b-1 mass-update session', async () => {
    makeTx({
      locked: rows({ logType: 'ADJUSTMENT' }),
      auditEvents: [
        { id: 1, actionType: 'INVENTORY_BULK_UPDATE', entityId: null, details: { rows: 40 } },
      ],
    });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_ATTRIBUTABLE');
  });

  it('3. TOO_MANY_ROWS — 51 rows names n and the product count', async () => {
    makeTx({ locked: rows({}, 51) });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch has 51 outbound rows across 51 products — above the 50-row manual attribution limit',
      code: 'TOO_MANY_ROWS',
      rowCount: 51,
      productCount: 51,
      limit: 50,
    });
  });

  it('4. MIXED_STAMPS — different ids are reported, never averaged', async () => {
    makeTx({
      locked: [
        { id: 501, productId: 9, logType: 'SALE', orderRecordId: 'ord-1' },
        { id: 502, productId: 10, logType: 'SALE', orderRecordId: 'ord-2' },
      ],
    });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-1' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This batch's rows carry different order ids (2) — reported, never averaged; repair the ledger first",
      code: 'MIXED_STAMPS',
      orderRecordIds: ['ord-1', 'ord-2'],
    });
  });

  it('5. BATCH_MOVED — the client saw it unattributed, someone stamped it', async () => {
    makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Someone attributed this batch while you were looking (now ord-1) — refresh and try again',
      code: 'BATCH_MOVED',
      currentOrderRecordId: 'ord-1',
      expected: null,
    });
  });

  it('5. BATCH_MOVED — the client saw a stamp, the batch is now unattributed', async () => {
    makeTx({ locked: rows() });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-1' });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Someone attributed this batch while you were looking (now unattributed) — refresh and try again',
      code: 'BATCH_MOVED',
      currentOrderRecordId: null,
      expected: 'ord-1',
    });
  });

  it('5. BATCH_MOVED — the client saw X, the batch now carries Y', async () => {
    makeTx({ locked: rows({ orderRecordId: 'ord-2' }) });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-1' });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'BATCH_MOVED',
      currentOrderRecordId: 'ord-2',
      expected: 'ord-1',
    });
  });

  it('5. BATCH_MOVED is evaluated BEFORE the reason rule (a racer is never asked for a reason)', async () => {
    const { trace } = makeTx({ locked: rows({ orderRecordId: 'ord-2' }) });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: null });

    expect((await res.json()).code).toBe('BATCH_MOVED');
    // Nothing beyond the shared preamble ran: no restoration read, no write.
    // (The attempt read is the preamble's own last statement — pack CB2a.1.)
    expect(trace).toEqual([
      'lock orders FOR UPDATE',
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
    ]);
  });

  // OC-6: one id on some rows and none on the others. The guarded write names the
  // id it locked, so it can move the stamped half or the unstamped half — never
  // the batch. It used to reach step 9 and surface as the count mismatch, whose
  // sentence ("the batch moved") describes a RACE and sends the admin to refresh
  // a page that will show them exactly the same thing.
  it('5b. PARTIALLY_STAMPED — some rows carry the id and some carry none', async () => {
    const { tx, trace } = makeTx({
      locked: [
        { id: 501, productId: 9, logType: 'SALE', orderRecordId: 'ord-1' },
        { id: 502, productId: 10, logType: 'SALE', orderRecordId: null },
        { id: 503, productId: 11, logType: 'SALE', orderRecordId: null },
      ],
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch is only partly stamped (1 of 3 rows) — repair the ledger before attributing; a guarded update cannot move it uniformly',
      code: 'PARTIALLY_STAMPED',
      stamped: 1,
      unstamped: 2,
    });
    // BEFORE the same-id short circuit and before the write: nothing beyond the
    // shared preamble ran.
    expect(trace).toEqual([
      'lock orders FOR UPDATE',
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
    ]);
    expect(tx.inventory_logs.updateMany).not.toHaveBeenCalled();
  });

  it('5b. the stale-client guard still comes FIRST on a partly stamped batch', async () => {
    makeTx({
      locked: [
        { id: 501, productId: 9, logType: 'SALE', orderRecordId: 'ord-1' },
        { id: 502, productId: 10, logType: 'SALE', orderRecordId: null },
      ],
    });
    // The client saw it unattributed; it is not.
    const res = await attribute(CLEAN_BODY);

    expect((await res.json()).code).toBe('BATCH_MOVED');
  });

  it('5b. asking for the id the stamped half already carries is still a refusal', async () => {
    makeTx({
      locked: [
        { id: 501, productId: 9, logType: 'SALE', orderRecordId: 'ord-9' },
        { id: 502, productId: 10, logType: 'SALE', orderRecordId: null },
      ],
    });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-9' });

    // NOT `changed:false` — half this batch is still unattributed.
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PARTIALLY_STAMPED');
  });

  // 6b (pack CB2a.1): the restoration ledger. Once a batch's units have been put
  // back or relocated, the guarded write below would move ONLY the population
  // rows — the CORRECTION/TRANSFER rows carry their own batch id and would keep
  // the OLD stamp, so one batch's truth would end up split across two orders.
  it('6b. BATCH_RESTORED — a prior CORRECTION event refuses the re-attribution, with NO stamp change', async () => {
    const { tx, trace } = makeTx({
      locked: rows({ orderRecordId: 'ord-1' }),
      restorationEvents: [
        {
          id: 41,
          actionType: 'INVENTORY_CORRECTION',
          details: {
            rows: [
              { productId: 9, locationId: 3, delta: 4 },
              { productId: 10, locationId: 3, delta: 2 },
            ],
          },
          createdAt: new Date('2026-09-02T14:31:22.000Z'),
        },
      ],
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch has already been put back (6 units) — it can no longer be re-attributed or moved',
      code: 'BATCH_RESTORED',
      restoredUnits: 6,
    });
    expect(trace).toEqual([
      'lock orders FOR UPDATE',
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
      'auditLog.findMany',
    ]);
    expect(tx.inventory_logs.updateMany).not.toHaveBeenCalled();
  });

  it('6b. BATCH_RESTORED outranks the FULFILLMENT rules', async () => {
    makeTx({
      locked: rows({ orderRecordId: 'ord-1' }),
      auditEvents: [fulfillmentEvent('ord-1')],
      restorationEvents: [
        {
          id: 42,
          actionType: 'INVENTORY_BATCH_REVERSE',
          details: { rows: [{ productId: 9, locationId: 3, delta: 7 }] },
          createdAt: new Date('2026-09-02T14:31:22.000Z'),
        },
      ],
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BATCH_RESTORED');
  });

  it('6b. ALREADY_MOVED — a prior MOVE event names the location and the minute', async () => {
    const { tx } = makeTx({
      locked: rows({ orderRecordId: 'ord-1' }),
      restorationEvents: [
        {
          id: 43,
          actionType: 'INVENTORY_BATCH_MOVE',
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [
              { productId: 9, locationId: 7, delta: -4 },
              { productId: 9, locationId: 3, delta: 4 },
            ],
          },
          createdAt: new Date('2026-09-02T14:31:22.000Z'),
        },
      ],
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch was moved to location 7 on 2026-09-02 14:31 UTC — it can no longer be re-attributed or moved again',
      code: 'ALREADY_MOVED',
      physicalLocationId: 7,
      at: '2026-09-02T14:31:22.000Z',
    });
    expect(tx.inventory_logs.updateMany).not.toHaveBeenCalled();
  });

  it('6b. the same-id short circuit still answers FIRST — the ledger is never read', async () => {
    const { trace } = makeTx({
      locked: rows({ orderRecordId: 'ord-9' }),
      restorationEvents: [
        {
          id: 44,
          actionType: 'INVENTORY_CORRECTION',
          details: { rows: [{ productId: 9, locationId: 3, delta: 4 }] },
          createdAt: new Date('2026-09-02T14:31:22.000Z'),
        },
      ],
    });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-9' });

    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
    expect(trace).toEqual([
      'lock orders FOR UPDATE',
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
    ]);
  });

  it('7. FULFILLED_BATCH — a STAMPED batch whose evidence is a fulfillment event', async () => {
    makeTx({
      locked: rows({ orderRecordId: 'ord-1' }),
      auditEvents: [fulfillmentEvent('ord-1')],
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'wrong order',
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Fulfilled against #ord-1 — change it via unfulfill/refulfill, not here',
      code: 'FULFILLED_BATCH',
      orderRecordId: 'ord-1',
      orderNumber: null,
    });
  });

  it('7. FULFILLED_BATCH — a STAMPED batch whose LATEST attempt is evidence fulfillment', async () => {
    makeTx({
      locked: rows({ orderRecordId: 'ord-1' }),
      auditEvents: [DEDUCT_EVENT],
      latestAttempt: { evidence: 'fulfillment' },
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'wrong order',
    });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FULFILLED_BATCH');
  });

  it('7. R2B_OTHER_TARGET — an unstamped fulfillment batch may only complete ITS stamp', async () => {
    makeTx({ locked: rows(), auditEvents: [fulfillmentEvent('ord-7')] });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch was fulfilled against another order (ord-7); a manual attribution may only complete that stamp',
      code: 'R2B_OTHER_TARGET',
      fulfillmentOrderRecordId: 'ord-7',
    });
  });

  // QA-7: the SAME refusal, on a batch whose fulfillment event names nothing at
  // all. "fulfilled against another order (null)" told the admin the event named
  // an order called null; the branch says what actually happened and where the
  // repair lives.
  it('7b. R2B_OTHER_TARGET — an event that names NO order says so, and names the repair (QA-7)', async () => {
    makeTx({ locked: rows(), auditEvents: [fulfillmentEvent(null)] });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch was fulfilled but the event does not name the order — repair via unfulfill/refulfill',
      code: 'R2B_OTHER_TARGET',
      fulfillmentOrderRecordId: null,
    });
  });

  it('8. REASON_REQUIRED — re-stamping an attributed batch needs one (400, bare AppError)', async () => {
    makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-1' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Re-attributing a stamped batch needs a reason',
      code: 'REASON_REQUIRED',
    });
  });

  it('8. a whitespace-only reason is no reason', async () => {
    makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: '   ',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('REASON_REQUIRED');
  });

  it('9. CONFLICT — the guarded updateMany moved fewer rows than it locked', async () => {
    makeTx({ updatedCount: 1 });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'the batch moved (updated 1 of 2 rows)',
      code: 'CONFLICT',
    });
  });

  it('a refusal writes NOTHING — no attempt row, no audit row', async () => {
    const { tx } = makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    await attribute(CLEAN_BODY);

    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.inventory_logs.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The same-id short circuit
// ---------------------------------------------------------------------------

describe('already attributed to the same order', () => {
  it('answers changed:false and issues no WRITE', async () => {
    const { tx, trace } = makeTx({ locked: rows({ orderRecordId: 'ord-9' }) });
    const res = await attribute({ orderRecordId: 'ord-9', expectPreviousOrderRecordId: 'ord-9' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: false,
      orderRecordId: 'ord-9',
      previousOrderRecordId: 'ord-9',
      rowCount: 2,
      completedFulfillment: false,
    });

    expect(trace).toEqual([
      'lock orders FOR UPDATE',
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
    ]);
    expect(tx.inventory_logs.updateMany).not.toHaveBeenCalled();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

describe('the write path', () => {
  it('attributes an unstamped batch and answers the §5 envelope', async () => {
    makeTx({});
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'changed',
      'completedFulfillment',
      'orderRecordId',
      'previousOrderRecordId',
      'rowCount',
    ]);
    expect(body).toEqual({
      changed: true,
      orderRecordId: 'ord-9',
      previousOrderRecordId: null,
      rowCount: 2,
      completedFulfillment: false,
    });
  });

  it('touches exactly the statements D4 allows, in order', async () => {
    const { tx, trace } = makeTx({});
    await attribute(CLEAN_BODY);

    expect(trace).toEqual([
      'lock orders FOR UPDATE',
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
      // The RESTORATION ledger (pack CB2a.2) — the same delegate, the other
      // filter, between the preamble and the guarded write.
      'auditLog.findMany',
      'inventory_logs.updateMany',
      'orderAttributionAttempt.create',
      'auditLog.create',
    ]);
    // Attribution ONLY: the order's own state is never written.
    expect(tx.externalOrder.update).not.toHaveBeenCalled();
    expect(tx.externalOrderItem.update).not.toHaveBeenCalled();
    expect(tx.externalOrderItem.updateMany).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('guards the UPDATE with the population predicate AND the id it locked', async () => {
    const { tx } = makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(tx.inventory_logs.updateMany).toHaveBeenCalledWith({
      where: {
        logType: { in: ['SALE', 'ADJUSTMENT'] },
        delta: { lt: 0 },
        batchId: LEDGER_BATCH,
        orderRecordId: 'ord-1',
      },
      data: { orderRecordId: 'ord-9' },
    });
  });

  it('THE BATCH ID SURVIVES THE POPULATION SPREAD (it must not become `batchId IS NOT NULL`)', async () => {
    const { tx } = makeTx({});
    await attribute(CLEAN_BODY);

    // `rowWhere` carries its own `batchId: { not: null }` clause. Spread over
    // this batch's id it would widen the guarded write to EVERY batch in the
    // ledger — so the id is applied AFTER the predicate, and this pin says so
    // in the one place a re-spelling would be caught.
    const where = (tx.inventory_logs.updateMany as unknown as jest.Mock).mock.calls[0][0].where;
    expect(where.batchId).toBe(LEDGER_BATCH);
    expect(typeof where.batchId).toBe('string');
  });

  it('locks this batch only, with the population fragment, FOR UPDATE', async () => {
    const { tx } = makeTx({});
    await attribute(CLEAN_BODY);

    const batchSelect = (tx.$queryRaw as unknown as jest.Mock).mock
      .calls[1][0] as unknown as Prisma.Sql;
    expect(batchSelect.sql).toContain('FOR UPDATE');
    expect(batchSelect.sql).toContain('l.logType IN');
    expect(batchSelect.sql).toContain('l.delta <');
    expect(batchSelect.sql).toContain('l.batchId IS NOT NULL');
    expect(batchSelect.sql).toContain('ORDER BY l.id');
    expect(batchSelect.values).toContain(LEDGER_BATCH);
  });

  // Reconciliation Part 2 (spec §2.7(1), pack CB1b.4): the `FOR SHARE` single-
  // target read this pin used to describe is GONE. The shared order lock takes
  // both orders this correction touches, X, in ONE statement, ordered by id so
  // two admins moving batches between the same pair acquire in the same order.
  it('locks the TARGET ORDER first, with the two-column write-path projection', async () => {
    const { tx } = makeTx({});
    await attribute(CLEAN_BODY);

    const orderLock = (tx.$queryRaw as unknown as jest.Mock).mock
      .calls[0][0] as unknown as Prisma.Sql;
    expect(orderLock.sql).toContain('FOR UPDATE');
    expect(orderLock.sql).toContain('ORDER BY id');
    expect(orderLock.sql).toContain('external_orders');
    expect(orderLock.sql).toContain('orderNumber');
    // No previous order stated: the union is the target alone.
    expect(orderLock.values).toEqual(['ord-9']);
  });

  it('asks for the TARGET and the STATED PREVIOUS order in the SAME statement', async () => {
    const { tx, trace } = makeTx({
      locked: rows({ orderRecordId: 'ord-1' }),
      previousOrder: { id: 'ord-1', orderNumber: '#1001' },
    });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(200);
    const orderLock = (tx.$queryRaw as unknown as jest.Mock).mock
      .calls[0][0] as unknown as Prisma.Sql;
    expect(orderLock.values).toEqual(['ord-9', 'ord-1']);
    // Still ONE statement — the batch rows follow it, as before.
    expect(trace[0]).toBe('lock orders FOR UPDATE');
    expect(trace[1]).toBe('lock batch rows FOR UPDATE');
  });

  it('a vanished PREVIOUS order is ADVISORY — absent from the lock, never a refusal', async () => {
    // The order the batch was stamped with has since been deleted. The move is
    // still legal: the `BATCH_MOVED` ladder reads the LEDGER's stamp, not the
    // order table, and an advisory id that resolves to nothing is simply not
    // locked.
    const { tx } = makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      changed: true,
      orderRecordId: 'ord-9',
      previousOrderRecordId: 'ord-1',
    });
    expect((tx.inventory_logs.updateMany as unknown as jest.Mock).mock.calls[0][0].data).toEqual({
      orderRecordId: 'ord-9',
    });
  });

  // The lock's own missing-required answer is a 409 `ORDER_GONE`; on this route
  // the target is the ONLY required id, so it means exactly what this handler's
  // 404 has always meant. A 409 is unreachable here.
  it('maps the lock’s ORDER_GONE to the route’s 404, never a 409', async () => {
    makeTx({ order: null });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown order', code: 'NOT_FOUND' });
  });

  it('records the attempt as attributed/manual with the first locked row', async () => {
    const { tx } = makeTx({});
    await attribute(CLEAN_BODY);

    expect(tx.orderAttributionAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        batchId: LEDGER_BATCH,
        ledgerRowId: 501,
        outcome: 'attributed',
        evidence: 'manual',
        reason: null,
        source: 'manual',
        actorUserId: 1,
        orderRecordId: 'ord-9',
        previousOrderRecordId: null,
        details: { rowCount: 2 },
      }),
    });
  });

  it('audits INVENTORY_ATTRIBUTE under a NEWLY MINTED batchId, entity = the LEDGER batch', async () => {
    const { tx } = makeTx({});
    await attribute(CLEAN_BODY);

    const audited = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(audited.actionType).toBe('INVENTORY_ATTRIBUTE');
    expect(audited.entityType).toBe('INVENTORY');
    expect(audited.entityId).toBe(LEDGER_BATCH);
    expect(audited.action).toBe(`Attributed outbound batch ${LEDGER_BATCH} to order #1009`);
    expect(audited.affectedCount).toBe(2);
    // The audit batchId is the ROUTE's own — never the ledger's, or the
    // derivation would read this event as the deduction's own.
    expect(audited.batchId).not.toBe(LEDGER_BATCH);
    expect(audited.batchId).toMatch(MINTED_AUDIT_BATCH_MATCHER);
  });

  it('an OVERWRITE records both ids, the reason, and answers previousOrderRecordId', async () => {
    const { tx } = makeTx({ locked: rows({ orderRecordId: 'ord-1' }) });
    const res = await attribute({
      orderRecordId: 'ord-9',
      expectPreviousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      orderRecordId: 'ord-9',
      previousOrderRecordId: 'ord-1',
      rowCount: 2,
      completedFulfillment: false,
    });

    expect(
      (tx.orderAttributionAttempt.create as unknown as jest.Mock).mock.calls[0][0].data,
    ).toMatchObject({
      orderRecordId: 'ord-9',
      previousOrderRecordId: 'ord-1',
      details: { rowCount: 2, overwriteReason: 'the packer picked the wrong order' },
    });

    const audited = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(audited.details).toEqual({
      orderRecordId: 'ord-9',
      previousOrderRecordId: 'ord-1',
      reason: 'the packer picked the wrong order',
      rowCount: 2,
    });
  });

  it('R2b STAMP COMPLETION — the fulfillment event names the target: 200 + completedFulfillment', async () => {
    const { tx } = makeTx({ locked: rows(), auditEvents: [fulfillmentEvent('ord-9')] });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      changed: true,
      orderRecordId: 'ord-9',
      previousOrderRecordId: null,
      rowCount: 2,
      completedFulfillment: true,
    });

    expect(
      (tx.orderAttributionAttempt.create as unknown as jest.Mock).mock.calls[0][0].data.details,
    ).toEqual({ rowCount: 2, completedFulfillment: true });
  });

  // CR-2: `external_orders.id` is `utf8mb4_unicode_ci`, so the order lock
  // matches CASE-INSENSITIVELY — `ORD-9` finds the row stored as `ord-9`. The
  // route used to lock through that comparison and then pass the CALLER'S
  // SPELLING onward, so the ledger was stamped `ORD-9`, the attempt row recorded
  // `ORD-9`, and the next report — whose order map and stamp set are JavaScript,
  // where the two strings are simply different — said "order missing". The
  // canonical value is the one the lock READ BACK, and it is what travels.
  //
  // (The identity contract itself — binary columns vs. an ASCII constraint, and
  // repairing existing variant spellings — is REGISTERED, not this fix.)
  it('CANONICALIZES the target to the id the ORDER LOCK read back, never the caller spelling (CR-2)', async () => {
    const { tx } = makeTx({});
    const res = await attribute({
      orderRecordId: 'ORD-9',
      expectPreviousOrderRecordId: null,
    });

    expect(res.status).toBe(200);
    // The lock is still asked with what the caller typed — the collation is what
    // resolves it, and asking with a normalised guess would be inventing an id.
    const orderLock = (tx.$queryRaw as unknown as jest.Mock).mock
      .calls[0][0] as unknown as Prisma.Sql;
    expect(orderLock.values).toEqual(['ORD-9']);

    // Everything DOWNSTREAM of the lock carries the canonical id.
    expect(await res.json()).toMatchObject({ orderRecordId: 'ord-9' });
    expect(
      (tx.inventory_logs.updateMany as unknown as jest.Mock).mock.calls[0][0].data,
    ).toEqual({ orderRecordId: 'ord-9' });
    expect(
      (tx.orderAttributionAttempt.create as unknown as jest.Mock).mock.calls[0][0].data,
    ).toMatchObject({ orderRecordId: 'ord-9' });
    expect(
      (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data.details,
    ).toMatchObject({ orderRecordId: 'ord-9' });
  });

  it('a case-variant target still COMPLETES an R2b stamp, because both sides are canonical (CR-2)', async () => {
    const { tx } = makeTx({ locked: rows(), auditEvents: [fulfillmentEvent('ord-9')] });
    const res = await attribute({
      orderRecordId: 'Ord-9',
      expectPreviousOrderRecordId: null,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      orderRecordId: 'ord-9',
      completedFulfillment: true,
    });
    expect(
      (tx.inventory_logs.updateMany as unknown as jest.Mock).mock.calls[0][0].data,
    ).toEqual({ orderRecordId: 'ord-9' });
  });

  it('R2b completion reads the event ENTITY when details carry no orderId', async () => {
    makeTx({
      locked: rows(),
      auditEvents: [
        { id: 4, actionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT', entityId: 'ord-9', details: {} },
      ],
    });
    const res = await attribute(CLEAN_BODY);

    expect(res.status).toBe(200);
    expect((await res.json()).completedFulfillment).toBe(true);
  });
});
