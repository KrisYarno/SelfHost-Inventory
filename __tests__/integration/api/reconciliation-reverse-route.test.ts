/**
 * @jest-environment node
 *
 * THE ATOMIC REVERSE — POST /api/inventory/batches/[batchId]/reverse
 * (reconciliation Part 2, pack CB2b.2; spec §2.5 / §2.7).
 *
 * The REAL route drives the REAL core over a hand-driven transaction client, so
 * every pin here covers the whole path at once: the guard order, the ONE-row
 * discovery, the trust boundary (which runs BEFORE any refusal that could
 * describe the batch), the bound, what gets locked, and the envelope each
 * refusal renders on the wire through the ONE shared mapper.
 *
 * THE 404 IS ONE SENTENCE, ON PURPOSE. "No such batch", "not a member of that
 * order's company" and "that stamp is advisory and you are not an admin" answer
 * identically: an approved non-member must not be able to tell them apart.
 *
 * The refusal messages are quoted VERBATIM — they are what an operator reads.
 */

jest.mock('@/lib/api-utils', () => ({
  __esModule: true,
  ...jest.requireActual('@/lib/api-utils'),
  requireApproved: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
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

import { NextRequest } from 'next/server';
import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '@/lib/prisma';
import { requireApproved, requireCSRF } from '@/lib/api-utils';
import { enforceRateLimit } from '@/lib/rateLimit';
import { POST } from '@/app/api/inventory/batches/[batchId]/reverse/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;
const mockRequireCSRF = requireCSRF as jest.Mock;
const mockEnforceRateLimit = enforceRateLimit as jest.Mock;

/** A v4 uuid — `BatchIdParamSchema` refuses anything else before a read. */
const BATCH = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type LockedRow = {
  id: number;
  productId: number;
  locationId: number | null;
  delta: number;
  userId: number | null;
  logType: string;
  orderRecordId: string | null;
};

type AuditRow = {
  id: number;
  actionType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
};

type RestorationEvent = {
  id: number;
  actionType: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

const DEDUCT_EVENT: AuditRow = {
  id: 3,
  actionType: 'INVENTORY_DEDUCT',
  entityId: '9',
  details: { intent: 'order' },
};

/**
 * A PRIOR MOVE of the default batch: product 9 relocated from the ledger
 * location 3 to the physical location 7, as its two TRANSFER legs recorded it.
 */
const MOVE_EVENT: RestorationEvent = {
  id: 40,
  actionType: 'INVENTORY_BATCH_MOVE',
  details: {
    ledgerLocationId: 3,
    physicalLocationId: 7,
    rows: [
      { productId: 9, locationId: 7, delta: -4 },
      { productId: 9, locationId: 3, delta: 4 },
    ],
  },
  createdAt: new Date('2026-09-02T09:00:00.000Z'),
};

function row(over: Partial<LockedRow> = {}): LockedRow {
  return {
    id: 501,
    productId: 9,
    locationId: 3,
    delta: -4,
    userId: 1,
    logType: 'SALE',
    orderRecordId: null,
    ...over,
  };
}

interface Fixture {
  /** The aggregate the discovery read returns. Defaults follow `locked`. */
  discovery?: Partial<Record<string, unknown>>;
  locked?: LockedRow[];
  auditEvents?: AuditRow[];
  restorationEvents?: RestorationEvent[];
  latestAttempt?: { evidence: string | null } | null;
  /** `externalOrder.findUnique` — null = the stamp is ADVISORY. */
  orderCompany?: { companyId: string } | null;
  /** The order the lock reads back; null = it vanished mid-flight. */
  lockedOrder?: { id: string; orderNumber: string } | null;
  /** `userCompany.findFirst` — undefined = not a member. */
  membership?: { userId: number } | null;
  /**
   * `location.findUnique` on the MOVED-TO location (rung 10b). Undefined = the
   * location exists; null = an admin deleted it after the move.
   */
  restoreLocation?: { id: number } | null;
}

function aggregate(locked: LockedRow[], over: Record<string, unknown> = {}) {
  const stamps = new Set(
    locked.map((r) => r.orderRecordId).filter((s): s is string => s !== null),
  );
  const actors = new Set(locked.map((r) => r.userId).filter((u): u is number => u !== null));
  const sorted = Array.from(stamps).sort();
  const sortedActors = Array.from(actors).sort((a, b) => a - b);
  return {
    // BigInt, as MySQL actually hands COUNT back.
    rowCount: BigInt(locked.length),
    productCount: BigInt(new Set(locked.map((r) => r.productId)).size),
    stampCount: BigInt(stamps.size),
    firstStamp: sorted[0] ?? null,
    actorRows: BigInt(locked.filter((r) => r.userId !== null).length),
    actorCount: BigInt(actors.size),
    firstActor: sortedActors[0] ?? null,
    ...over,
  };
}

/** The client + a transaction client that RECORDS what was asked, in order. */
function makeDb(fixture: Fixture = {}) {
  const locked = fixture.locked ?? [row()];
  const trace: string[] = [];
  const tx = mockDeep<Prisma.TransactionClient>();

  (db.$queryRaw as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('discovery aggregate');
    return [aggregate(locked, fixture.discovery ?? {})];
  });
  (db.externalOrder.findUnique as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('externalOrder.findUnique');
    return fixture.orderCompany === undefined ? { companyId: 'co-1' } : fixture.orderCompany;
  });
  (db.userCompany.findFirst as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('userCompany.findFirst');
    return fixture.membership ?? null;
  });

  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes('external_orders')) {
      trace.push('lock orders FOR UPDATE');
      const order =
        fixture.lockedOrder === undefined ? { id: 'ord-9', orderNumber: '#1009' } : fixture.lockedOrder;
      return order === null ? [] : [order];
    }
    if (query.sql.includes('product_locations')) {
      trace.push('prelock SELECT FOR UPDATE');
      return [];
    }
    trace.push('lock batch rows FOR UPDATE');
    return locked;
  });
  (tx.$executeRaw as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('prelock materialize');
    return 0;
  });
  (tx.auditLog.findMany as unknown as jest.Mock).mockImplementation(
    async (args: { where?: { entityId?: string } }) => {
      if (args?.where?.entityId !== undefined) {
        trace.push('restoration ledger read');
        return fixture.restorationEvents ?? [];
      }
      trace.push('auditLog.findMany');
      return fixture.auditEvents ?? [DEDUCT_EVENT];
    },
  );
  // ALWAYS DEFINED (F17). A bare `mockDeep` resolves `undefined`, which is not
  // `null` — the rung-10b proof would pass vacuously and its 409 would be
  // unreachable from any test in this file.
  (tx.location.findUnique as unknown as jest.Mock).mockImplementation(
    async (args: { where: { id: number } }) => {
      trace.push('location.findUnique');
      return fixture.restoreLocation === undefined ? { id: args.where.id } : fixture.restoreLocation;
    },
  );
  (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('orderAttributionAttempt.findFirst');
    return fixture.latestAttempt ?? null;
  });
  (tx.inventory_logs.create as unknown as jest.Mock).mockImplementation(
    async (args: { data: Record<string, unknown> }) => {
      trace.push('inventory_logs.create');
      return { id: 900, ...args.data };
    },
  );
  (tx.product_locations.upsert as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('product_locations.upsert');
    return { version: 2 };
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

async function reverse(batchId = BATCH): Promise<Response> {
  const request = new NextRequest(
    `http://localhost/api/inventory/batches/${batchId}/reverse`,
    { method: 'POST', headers: { 'x-csrf-token': 'x' } },
  );
  return (await POST(request, { params: { batchId } })) as Response;
}

beforeEach(() => {
  mockReset(db);
  mockRequireApproved.mockClear();
  mockRequireApproved.mockResolvedValue({ user: { id: 1, isAdmin: true } });
  mockRequireCSRF.mockClear();
  mockRequireCSRF.mockResolvedValue(undefined);
  mockEnforceRateLimit.mockClear();
  mockEnforceRateLimit.mockReturnValue({});
});

// ---------------------------------------------------------------------------
// The route surface
// ---------------------------------------------------------------------------

describe('POST .../reverse — the guards', () => {
  it('guards in the frozen order: approved, the rate limit, then CSRF', async () => {
    makeDb();
    await reverse();

    expect(mockRequireApproved).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit.mock.calls[0][1]).toBe('batches:reverse');
    expect(mockEnforceRateLimit.mock.calls[0][2]).toEqual({ identifier: 1, limit: 30 });
    expect(mockRequireCSRF).toHaveBeenCalledTimes(1);

    expect(mockRequireApproved.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnforceRateLimit.mock.invocationCallOrder[0],
    );
    expect(mockEnforceRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockRequireCSRF.mock.invocationCallOrder[0],
    );
  });

  it('is NOT admin-only — an approved actor reverses their own batch', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ userId: 7 })] });

    const res = await reverse();
    expect(res.status).toBe(200);
  });

  it('400s a non-uuid batch id through the house ZodError arm, before any read', async () => {
    const { trace } = makeDb();
    const res = await reverse('concurrency-gate-recon-batch-01');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: expect.stringContaining('uuid'),
      code: 'VALIDATION_ERROR',
    });
    expect(trace).toEqual([]);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('applies the rate-limit headers to the 200', async () => {
    mockEnforceRateLimit.mockReturnValue({ 'X-RateLimit-Remaining': '29' });
    makeDb();

    const res = await reverse();
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('29');
  });
});

// ---------------------------------------------------------------------------
// Discovery and the trust boundary
// ---------------------------------------------------------------------------

describe('POST .../reverse — discovery is ONE aggregate row', () => {
  it('asks for the seven scalars over the population predicate, and nothing else', async () => {
    makeDb();
    await reverse();

    const query = (db.$queryRaw as unknown as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain('COUNT(*) AS rowCount');
    expect(query.sql).toContain('COUNT(DISTINCT productId) AS productCount');
    expect(query.sql).toContain('COUNT(DISTINCT orderRecordId) AS stampCount');
    expect(query.sql).toContain('MIN(orderRecordId) AS firstStamp');
    expect(query.sql).toContain('COUNT(userId) AS actorRows');
    expect(query.sql).toContain('COUNT(DISTINCT userId) AS actorCount');
    expect(query.sql).toContain('MIN(userId) AS firstActor');
    expect(query.sql).toContain('FROM inventory_logs l');
    // The population, RENDERED — never re-spelled, never a GROUP BY.
    expect(query.sql).toContain('l.logType IN (?,?)');
    expect(query.sql).toContain('l.delta < 0');
    expect(query.sql).toContain('l.batchId IS NOT NULL');
    expect(query.sql).not.toMatch(/GROUP BY/i);
    expect(query.values).toEqual([BATCH, 'SALE', 'ADJUSTMENT']);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('404s "Resource not found" when the id names no population rows', async () => {
    const { trace } = makeDb({ locked: [] });
    const res = await reverse();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
    expect(trace).toEqual(['discovery aggregate']);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST .../reverse — the trust boundary (step 4)', () => {
  it('a STAMPED batch checks per-company membership, and a miss is the SAME 404', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ orderRecordId: 'ord-9' })], membership: null });

    const res = await reverse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a MEMBER of the order’s company reverses it', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ orderRecordId: 'ord-9', userId: 99 })], membership: { userId: 7 } });

    const res = await reverse();
    expect(res.status).toBe(200);
    expect(db.userCompany.findFirst).toHaveBeenCalledTimes(1);
  });

  // F11 (GX-3): the ADVISORY arm admits an ADMIN **or** the batch's PROVABLE
  // ACTOR. A stamp whose order was deleted derives no membership, but the actor
  // columns the aggregate already carries prove the same thing CX6-20 proves for
  // an unstamped batch — and refusing the person who recorded it strands them.
  it('an ADVISORY stamp refuses a NON-ACTOR non-admin with the same 404', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    const { trace } = makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 8 })],
      orderCompany: null,
    });

    const res = await reverse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
    expect(trace).toEqual(['discovery aggregate', 'externalOrder.findUnique']);
  });

  it('an ADVISORY stamp admits the batch’s PROVABLE ACTOR', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 7 }), row({ id: 502, orderRecordId: 'ord-9', userId: 7 })],
      orderCompany: null,
    });

    const res = await reverse();
    expect(res.status).toBe(200);
    // No membership was derivable and none was asked for.
    expect(db.userCompany.findFirst).not.toHaveBeenCalled();
  });

  it('an ADVISORY stamp refuses a PARTIAL actor set (a row with no actor at all)', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 7 }), row({ id: 502, orderRecordId: 'ord-9', userId: null })],
      orderCompany: null,
    });

    expect((await reverse()).status).toBe(404);
  });

  it('an ADVISORY stamp locks NO order for an admin, and still stamps the CORRECTION rows', async () => {
    const { tx, trace } = makeDb({
      locked: [row({ orderRecordId: 'ord-9' })],
      orderCompany: null,
    });

    const res = await reverse();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orderRecordId: 'ord-9' });
    // NO `lock orders FOR UPDATE` in the trace: the empty id set is total.
    expect(trace).not.toContain('lock orders FOR UPDATE');
    expect((tx.inventory_logs.create as unknown as jest.Mock).mock.calls[0][0].data)
      .toMatchObject({ orderRecordId: 'ord-9', logType: 'CORRECTION' });
  });

  it('an UNSTAMPED batch refuses a non-actor non-admin with 403 UNATTRIBUTED, off the aggregate', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    const { trace } = makeDb({ locked: [row({ userId: 8 })] });

    const res = await reverse();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'This batch is not attributed to an order — only the person who recorded it or an admin can change it',
      code: 'UNATTRIBUTED',
    });
    // Nothing was locked: the aggregate answered.
    expect(trace).toEqual(['discovery aggregate']);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a row with NO actor at all defeats the provable-actor test (actorRows < rowCount)', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ userId: 7 }), row({ id: 502, userId: null })] });

    expect((await reverse()).status).toBe(403);
  });

  // S4-6: AUTHORISATION BEFORE ANY DATA-BEARING REFUSAL. TOO_MANY_ROWS names the
  // batch's size and its product count — facts about a batch this caller is not
  // allowed to touch. The order of the two checks IS the trust boundary.
  it('refuses an unauthorised caller BEFORE the bound, even on an over-sized batch', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ userId: 8 })],
      discovery: { rowCount: BigInt(5100), productCount: BigInt(12) },
    });

    const res = await reverse();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('UNATTRIBUTED');
  });

  it('a NON-MEMBER of a stamped over-sized batch gets the 404, never the row count', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-9' })],
      membership: null,
      discovery: { rowCount: BigInt(5100), productCount: BigInt(12) },
    });

    const res = await reverse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
  });

  it('the PROVABLE actor of an unstamped batch gets a 200', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ userId: 7 }), row({ id: 502, userId: 7 })] });

    expect((await reverse()).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The bound, the lock and the refusal envelopes
// ---------------------------------------------------------------------------

describe('POST .../reverse — the bound and what gets locked', () => {
  it('TOO_MANY_ROWS off the aggregate, with ZERO rows pulled and the reverse sentence', async () => {
    const { trace } = makeDb({
      locked: [row()],
      discovery: { rowCount: BigInt(51), productCount: BigInt(12) },
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This batch has 51 rows across 12 products — above the 50-row limit for a reverse',
      code: 'TOO_MANY_ROWS',
      rowCount: 51,
      productCount: 12,
      limit: 50,
    });
    expect(trace).toEqual(['discovery aggregate']);
  });

  it('the bound is ABSOLUTE — an admin is refused too', async () => {
    makeDb({ locked: [row()], discovery: { rowCount: BigInt(99), productCount: BigInt(1) } });
    expect((await reverse()).status).toBe(409);
  });

  it('a MIXED batch locks NO order and lets the preamble answer from the locked rows', async () => {
    const { trace } = makeDb({
      locked: [row({ orderRecordId: 'ord-1' }), row({ id: 502, orderRecordId: 'ord-2' })],
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "This batch's rows carry different order ids (2) — reported, never averaged; repair the ledger first",
      code: 'MIXED_STAMPS',
      orderRecordIds: ['ord-1', 'ord-2'],
    });
    expect(trace).not.toContain('lock orders FOR UPDATE');
  });

  it('a NON-ADMIN sees the redacted MIXED_STAMPS envelope (the count only)', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-1' }), row({ id: 502, orderRecordId: 'ord-2' })],
      membership: { userId: 7 },
    });

    const res = await reverse();
    expect(await res.json()).toEqual({
      error: expect.stringContaining('different order ids (2)'),
      code: 'MIXED_STAMPS',
      count: 2,
    });
  });

  it('a STAMPED batch locks its order as statement 1 of the transaction', async () => {
    const { trace } = makeDb({ locked: [row({ orderRecordId: 'ord-9' })] });
    await reverse();

    expect(trace[0]).toBe('discovery aggregate');
    expect(trace[1]).toBe('externalOrder.findUnique');
    expect(trace[2]).toBe('lock orders FOR UPDATE');
    expect(trace[3]).toBe('lock batch rows FOR UPDATE');
  });

  it('spends the LANE’s transaction budget, not Prisma’s default', async () => {
    makeDb();
    await reverse();

    expect((db.$transaction as unknown as jest.Mock).mock.calls[0][1]).toEqual({
      maxWait: 5000,
      timeout: 30000,
    });
  });

  it('ORDER_GONE from the lock becomes the SAME 404', async () => {
    makeDb({ locked: [row({ orderRecordId: 'ord-9' })], lockedOrder: null });

    const res = await reverse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// F10 (GX-2): the DEADLOCK RETRY, pinned. The S4-4 residual is real — the batch
// `FOR UPDATE` next-key-locks the gap after the batch's last row — so this route
// wraps the whole transaction in `withDeadlockRetry`. Two things have to hold:
// a retried attempt answers 200, and the operation's batch id is minted OUTSIDE
// the retry, so both attempts write under the SAME id (a fresh mint per attempt
// would leave the first attempt's rolled-back id in the event of a retry that
// half-committed, and split one act across two batches).
// ---------------------------------------------------------------------------

describe('POST .../reverse — withDeadlockRetry', () => {
  /** Make the first `$transaction` do the work and then deadlock at commit. */
  function deadlockOnce() {
    const runTx = (db.$transaction as unknown as jest.Mock).getMockImplementation()!;
    let attempts = 0;
    (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: unknown) => {
      attempts += 1;
      if (attempts === 1) {
        await runTx(cb);
        throw Object.assign(new Error('Deadlock found when trying to get lock'), {
          code: 'P2034',
        });
      }
      return runTx(cb);
    });
  }

  it('retries a P2034 and answers 200, under ONE operation batch id', async () => {
    const { tx } = makeDb();
    deadlockOnce();

    const res = await reverse();
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);

    const written = (tx.inventory_logs.create as unknown as jest.Mock).mock.calls.map(
      (call) => call[0].data.batchId,
    );
    expect(written).toHaveLength(2);
    expect(new Set(written).size).toBe(1);
    // The event carries the same id, and so does the answer.
    const events = (tx.auditLog.create as unknown as jest.Mock).mock.calls.map(
      (call) => call[0].data.batchId,
    );
    expect(new Set(events)).toEqual(new Set(written));
    expect((await res.json()).batchId).toBe(written[0]);
  });

  it('does NOT retry a typed refusal — ORDER_GONE runs the transaction ONCE', async () => {
    makeDb({ locked: [row({ orderRecordId: 'ord-9' })], lockedOrder: null });

    expect((await reverse()).status).toBe(404);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('POST .../reverse — the core’s refusals, through the ONE mapper', () => {
  it('BATCH_MOVED names the current id for an ADMIN', async () => {
    makeDb({
      locked: [row({ orderRecordId: 'ord-9' })],
      discovery: { stampCount: BigInt(0), firstStamp: null },
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Someone attributed this batch while you were looking (now ord-9) — refresh and try again',
      code: 'BATCH_MOVED',
      currentOrderRecordId: 'ord-9',
      expected: null,
    });
  });

  it('BATCH_MOVED REDACTS the id for a non-admin', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 7 })],
      discovery: { stampCount: BigInt(0), firstStamp: null },
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Someone attributed this batch while you were looking — refresh and try again',
      code: 'BATCH_MOVED',
      expected: null,
    });
  });

  it('NULL_LOCATION_ROW names the row to repair', async () => {
    makeDb({ locked: [row(), row({ id: 502, locationId: null })] });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Ledger row 502 names no location — this batch cannot be reversed or moved until it is repaired',
      code: 'NULL_LOCATION_ROW',
      rowId: 502,
    });
  });

  it('FULFILLED_BATCH sends the operator to unfulfill', async () => {
    makeDb({
      locked: [row()],
      auditEvents: [
        {
          id: 4,
          actionType: 'EXTERNAL_ORDER_FULFILLMENT',
          entityId: 'ord-5',
          details: { orderId: 'ord-5' },
        },
      ],
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Fulfilled against #ord-5 — change it via unfulfill/refulfill, not here',
      code: 'FULFILLED_BATCH',
      orderRecordId: 'ord-5',
      orderNumber: null,
    });
  });

  it('ALREADY_REVERSED carries both numbers', async () => {
    makeDb({
      locked: [row({ delta: -4 })],
      restorationEvents: [
        {
          id: 41,
          actionType: 'INVENTORY_CORRECTION',
          details: { rows: [{ productId: 9, locationId: 3, delta: 4 }] },
          createdAt: new Date('2026-09-02T10:00:00.000Z'),
        },
      ],
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This batch was already reversed — 4 of 4 units were put back',
      code: 'ALREADY_REVERSED',
      previouslyRestored: 4,
      totalUnits: 4,
    });
  });

  it('RESTORATION_LEDGER_CORRUPT rides apiHandler as a bare AppError', async () => {
    makeDb({
      locked: [row()],
      restorationEvents: [
        {
          id: 41,
          actionType: 'INVENTORY_CORRECTION',
          details: { rows: 'not an array' },
          createdAt: new Date('2026-09-02T10:00:00.000Z'),
        },
      ],
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Restoration event 41 is malformed — the batch cannot be reversed or moved until it is repaired',
      code: 'RESTORATION_LEDGER_CORRUPT',
    });
  });

  // F17 (F8/OC-8 ON THE WIRE). The rung-10b proof was pinned in the core's own
  // suite; this is the sentence an operator actually reads, through
  // `refusalResponse` (which does not know this refusal), the rethrow, and
  // `apiHandler`. Its sibling proves the pin is not vacuous: the SAME fixture
  // with the location present reverses, at the moved-to location.
  it('RESTORE_LOCATION_MISSING 409s when the moved-to location is gone', async () => {
    const { trace } = makeDb({
      locked: [row({ productId: 9, locationId: 3, delta: -4 })],
      restorationEvents: [MOVE_EVENT],
      restoreLocation: null,
    });

    const res = await reverse();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'The location this batch was moved to (7) no longer exists — repair the move before reversing',
      code: 'RESTORE_LOCATION_MISSING',
    });
    // The proof runs BEFORE the prelock — nothing was locked or written.
    expect(trace).toContain('location.findUnique');
    expect(trace).not.toContain('prelock SELECT FOR UPDATE');
    expect(trace).not.toContain('inventory_logs.create');
  });

  it('restores at the MOVED-TO location when it is still there', async () => {
    makeDb({
      locked: [row({ productId: 9, locationId: 3, delta: -4 })],
      restorationEvents: [MOVE_EVENT],
      restoreLocation: { id: 7 },
    });

    const res = await reverse();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.physicalLocationId).toBe(7);
    expect(body.rows).toEqual([{ productId: 9, locationId: 7, delta: 4 }]);
    expect(body.restoredUnits).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The 200 and its event
// ---------------------------------------------------------------------------

describe('POST .../reverse — the answer and the audit event', () => {
  it('answers the frozen envelope, with the units this call restored', async () => {
    makeDb({
      locked: [
        row({ id: 501, productId: 9, locationId: 3, delta: -4 }),
        row({ id: 502, productId: 10, locationId: 3, delta: -2 }),
      ],
    });

    const res = await reverse();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'batchId',
        'message',
        'orderRecordId',
        'physicalLocationId',
        'previouslyRestored',
        'restoredUnits',
        'reversedBatchId',
        'rows',
        'totalUnits',
      ].sort(),
    );
    expect(body.reversedBatchId).toBe(BATCH);
    expect(body.batchId).toMatch(UUID);
    expect(body.batchId).not.toBe(BATCH);
    expect(body.rows).toEqual([
      { productId: 9, locationId: 3, delta: 4 },
      { productId: 10, locationId: 3, delta: 2 },
    ]);
    expect(body.restoredUnits).toBe(6);
    expect(body.previouslyRestored).toBe(0);
    expect(body.totalUnits).toBe(6);
    expect(body.physicalLocationId).toBeNull();
    expect(body.message).toBe('reversed 6 of 6 units');
  });

  it('the RESTORED-EARLIER suffix rides the message AND the audit action', async () => {
    const { tx } = makeDb({
      locked: [row({ delta: -10 })],
      restorationEvents: [
        {
          id: 41,
          actionType: 'INVENTORY_CORRECTION',
          details: { rows: [{ productId: 9, locationId: 3, delta: 4 }] },
          createdAt: new Date('2026-09-02T10:00:00.000Z'),
        },
      ],
    });

    const body = await (await reverse()).json();
    expect(body.message).toBe('reversed 6 of 10 units (4 restored earlier)');

    const event = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(event.action).toBe(
      `Reversed batch ${BATCH}: restored 6 of 10 units (4 restored earlier)`,
    );
  });

  it('the event names the REVERSED batch as its entity and the NEW batch as its own', async () => {
    const { tx } = makeDb({ locked: [row({ orderRecordId: 'ord-9' })] });
    const body = await (await reverse()).json();

    const event = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(event.actionType).toBe('INVENTORY_BATCH_REVERSE');
    expect(event.entityType).toBe('INVENTORY');
    expect(event.entityId).toBe(BATCH);
    expect(event.batchId).toBe(body.batchId);
    expect(event.companyId).toBe('co-1');
    expect(event.affectedCount).toBe(1);
    expect(event.details).toMatchObject({
      reversedBatchId: BATCH,
      rows: [{ productId: 9, locationId: 3, delta: 4 }],
      restoredUnits: 4,
      previouslyRestored: 0,
      totalUnits: 4,
      orderRecordId: 'ord-9',
      physicalLocationId: null,
    });
  });

  it('an UNSTAMPED batch files the event with NO companyId', async () => {
    const { tx } = makeDb({ locked: [row()] });
    await reverse();

    const event = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(event.companyId).toBeNull();
  });

  it('writes NO attribution attempt row', async () => {
    const { tx } = makeDb();
    await reverse();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });
});
