/**
 * @jest-environment node
 *
 * THE WRONG-LOCATION MOVE — POST /api/inventory/batches/[batchId]/move
 * (reconciliation Part 2, pack CB2c.2; spec §2.6 / §2.7).
 *
 * The REAL route drives the REAL core over a hand-driven transaction client, so
 * every pin here covers the whole path at once: the guard order and the body,
 * the ONE-row discovery, the trust boundary (which runs BEFORE any refusal that
 * could describe the batch), the bound with the MOVE's own sentence, what gets
 * locked, the destination proved on both sides of the transaction, and the
 * envelope each refusal renders on the wire through the ONE shared mapper.
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
import { prelockKey } from '@/lib/inventory/prelock';
import { enforceRateLimit } from '@/lib/rateLimit';
import { POST } from '@/app/api/inventory/batches/[batchId]/move/route';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;
const mockRequireCSRF = requireCSRF as jest.Mock;
const mockEnforceRateLimit = enforceRateLimit as jest.Mock;

/** A v4 uuid — `BatchIdParamSchema` refuses anything else before a read. */
const BATCH = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEDGER = 3;
const PHYSICAL = 7;

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

function row(over: Partial<LockedRow> = {}): LockedRow {
  return {
    id: 501,
    productId: 9,
    locationId: LEDGER,
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
   * What `location.findUnique` answers, call by call (the belt reads twice). An
   * `Error` entry makes that read REJECT — the belt's own probe failing (F4).
   */
  locations?: Array<{ id: number } | null | Error>;
  /** `prelockKey` -> what the LOCKED `product_locations` row holds. */
  stock?: Record<string, number>;
  /** Thrown by the FIRST ledger insert — the belt's FK stand-in. */
  writeError?: Error;
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
  let locationReads = 0;
  let writes = 0;

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
  (db.location.findUnique as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('location.findUnique');
    const answers = fixture.locations;
    const answer = answers === undefined ? { id: PHYSICAL } : (answers[locationReads] ?? null);
    locationReads += 1;
    if (answer instanceof Error) throw answer;
    return answer;
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
      const keys: Array<{ productId: number; locationId: number }> = [];
      for (let i = 0; i + 1 < query.values.length; i += 2) {
        keys.push({
          productId: query.values[i] as number,
          locationId: query.values[i + 1] as number,
        });
      }
      return keys.map((key) => ({
        productId: key.productId,
        locationId: key.locationId,
        quantity: fixture.stock?.[prelockKey(key.productId, key.locationId)] ?? 1000,
        version: 1,
      }));
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
  (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('orderAttributionAttempt.findFirst');
    return fixture.latestAttempt ?? null;
  });
  (tx.inventory_logs.create as unknown as jest.Mock).mockImplementation(
    async (args: { data: Record<string, unknown> }) => {
      trace.push('inventory_logs.create');
      writes += 1;
      if (fixture.writeError && writes === 1) throw fixture.writeError;
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

  return { tx, trace, locationReads: () => locationReads };
}

async function move(
  body: unknown = { physicalLocationId: PHYSICAL },
  batchId = BATCH,
): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/inventory/batches/${batchId}/move`, {
    method: 'POST',
    headers: { 'x-csrf-token': 'x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

describe('POST .../move — the guards and the body', () => {
  it('guards in the frozen order: approved, the rate limit, then CSRF', async () => {
    makeDb();
    await move();

    expect(mockRequireApproved).toHaveBeenCalledTimes(1);
    expect(mockEnforceRateLimit.mock.calls[0][1]).toBe('batches:move');
    expect(mockEnforceRateLimit.mock.calls[0][2]).toEqual({ identifier: 1, limit: 30 });
    expect(mockRequireCSRF).toHaveBeenCalledTimes(1);

    expect(mockRequireApproved.mock.invocationCallOrder[0]).toBeLessThan(
      mockEnforceRateLimit.mock.invocationCallOrder[0],
    );
    expect(mockEnforceRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockRequireCSRF.mock.invocationCallOrder[0],
    );
  });

  it('is NOT admin-only — an approved actor moves their own batch', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ userId: 7 })] });

    expect((await move()).status).toBe(200);
  });

  it('400s a non-uuid batch id through the house ZodError arm, before any read', async () => {
    const { trace } = makeDb();
    const res = await move({ physicalLocationId: PHYSICAL }, 'concurrency-gate-recon-batch-01');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: expect.stringContaining('uuid'),
      code: 'VALIDATION_ERROR',
    });
    expect(trace).toEqual([]);
  });

  it('400s a body with no location the same way, before any read', async () => {
    const { trace } = makeDb();
    const res = await move({});

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(trace).toEqual([]);
  });

  it('400s a non-integer location — the schema takes ONE field and proves it', async () => {
    makeDb();
    expect((await move({ physicalLocationId: 2.5 })).status).toBe(400);
    expect((await move({ physicalLocationId: -1 })).status).toBe(400);
    expect((await move({ physicalLocationId: 'main' })).status).toBe(400);
  });

  it('applies the rate-limit headers to the 200', async () => {
    mockEnforceRateLimit.mockReturnValue({ 'X-RateLimit-Remaining': '29' });
    makeDb();

    expect((await move()).headers.get('X-RateLimit-Remaining')).toBe('29');
  });
});

// ---------------------------------------------------------------------------
// Discovery and the trust boundary
// ---------------------------------------------------------------------------

describe('POST .../move — discovery is ONE aggregate row', () => {
  it('asks for the seven scalars over the population predicate, and nothing else', async () => {
    makeDb();
    await move();

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
    const res = await move();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
    expect(trace).toEqual(['discovery aggregate']);
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe('POST .../move — the trust boundary (step 4)', () => {
  it('a STAMPED batch checks per-company membership, and a miss is the SAME 404', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ orderRecordId: 'ord-9' })], membership: null });

    const res = await move();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('a MEMBER of the order’s company moves it', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ orderRecordId: 'ord-9', userId: 99 })], membership: { userId: 7 } });

    expect((await move()).status).toBe(200);
    expect(db.userCompany.findFirst).toHaveBeenCalledTimes(1);
  });

  // F11 (GX-3): the ADVISORY arm admits an ADMIN **or** the batch's PROVABLE
  // ACTOR — the same columns the unstamped arm reads, asked of a stamp whose
  // order is gone.
  it('an ADVISORY stamp refuses a NON-ACTOR non-admin with the same 404', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    const { trace } = makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 8 })],
      orderCompany: null,
    });

    const res = await move();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
    expect(trace).toEqual(['discovery aggregate', 'externalOrder.findUnique']);
  });

  it('an ADVISORY stamp admits the batch’s PROVABLE ACTOR', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 7 })],
      orderCompany: null,
    });

    const res = await move();
    expect(res.status).toBe(200);
    expect(db.userCompany.findFirst).not.toHaveBeenCalled();
  });

  it('an ADVISORY stamp refuses a PARTIAL actor set (a row with no actor at all)', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [
        row({ orderRecordId: 'ord-9', userId: 7 }),
        row({ id: 502, orderRecordId: 'ord-9', userId: null }),
      ],
      orderCompany: null,
    });

    expect((await move()).status).toBe(404);
  });

  it('an ADVISORY stamp locks NO order for an admin, and still stamps the TRANSFER legs', async () => {
    const { tx, trace } = makeDb({
      locked: [row({ orderRecordId: 'ord-9' })],
      orderCompany: null,
    });

    const res = await move();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orderRecordId: 'ord-9' });
    expect(trace).not.toContain('lock orders FOR UPDATE');
    expect((tx.inventory_logs.create as unknown as jest.Mock).mock.calls[0][0].data)
      .toMatchObject({ orderRecordId: 'ord-9', logType: 'TRANSFER' });
  });

  it('an UNSTAMPED batch refuses a non-actor non-admin with 403 UNATTRIBUTED, off the aggregate', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    const { trace } = makeDb({ locked: [row({ userId: 8 })] });

    const res = await move();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'This batch is not attributed to an order — only the person who recorded it or an admin can change it',
      code: 'UNATTRIBUTED',
    });
    expect(trace).toEqual(['discovery aggregate']);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  // S4-6: AUTHORISATION BEFORE ANY DATA-BEARING REFUSAL. TOO_MANY_ROWS names the
  // batch's size and its product count — facts about a batch this caller is not
  // allowed to touch.
  it('refuses an unauthorised caller BEFORE the bound, even on an over-sized batch', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ userId: 8 })],
      discovery: { rowCount: BigInt(5100), productCount: BigInt(12) },
    });

    const res = await move();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('UNATTRIBUTED');
  });

  it('the PROVABLE actor of an unstamped batch gets a 200', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({ locked: [row({ userId: 7 }), row({ id: 502, userId: 7 })] });

    expect((await move()).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The bound, the lock and the destination
// ---------------------------------------------------------------------------

describe('POST .../move — the bound and what gets locked', () => {
  it('TOO_MANY_ROWS off the aggregate, with ZERO rows pulled and the MOVE sentence', async () => {
    const { trace } = makeDb({
      locked: [row()],
      discovery: { rowCount: BigInt(51), productCount: BigInt(12) },
    });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This batch has 51 rows across 12 products — above the 50-row limit for a move',
      code: 'TOO_MANY_ROWS',
      rowCount: 51,
      productCount: 12,
      limit: 50,
    });
    expect(trace).toEqual(['discovery aggregate']);
  });

  it('the bound is ABSOLUTE — an admin is refused too', async () => {
    makeDb({ locked: [row()], discovery: { rowCount: BigInt(99), productCount: BigInt(1) } });
    expect((await move()).status).toBe(409);
  });

  it('a MIXED batch locks NO order and lets the preamble answer from the locked rows', async () => {
    const { trace } = makeDb({
      locked: [row({ orderRecordId: 'ord-1' }), row({ id: 502, orderRecordId: 'ord-2' })],
    });

    const res = await move();
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

    expect(await (await move()).json()).toEqual({
      error: expect.stringContaining('different order ids (2)'),
      code: 'MIXED_STAMPS',
      count: 2,
    });
  });

  it('a STAMPED batch locks its order as statement 1 of the transaction', async () => {
    const { trace } = makeDb({ locked: [row({ orderRecordId: 'ord-9' })] });
    await move();

    // An admin short-circuits the membership read; the destination is proved
    // BEFORE the transaction opens, and the order lock is still statement 1
    // INSIDE it.
    expect(trace[0]).toBe('discovery aggregate');
    expect(trace[1]).toBe('externalOrder.findUnique');
    expect(trace[2]).toBe('location.findUnique');
    expect(trace[3]).toBe('lock orders FOR UPDATE');
    expect(trace[4]).toBe('lock batch rows FOR UPDATE');
  });

  it('spends the LANE’s transaction budget, not Prisma’s default', async () => {
    makeDb();
    await move();

    // The LITERAL, never the imported constant: a suite that mocks
    // `@/lib/inventory` sees the constant as `undefined` and an identity
    // assertion passes vacuously.
    expect((db.$transaction as unknown as jest.Mock).mock.calls[0][1]).toEqual({
      maxWait: 5000,
      timeout: 30000,
    });
  });

  it('ORDER_GONE from the lock becomes the SAME 404', async () => {
    makeDb({ locked: [row({ orderRecordId: 'ord-9' })], lockedOrder: null });

    const res = await move();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Resource not found', code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// F10 (GX-2): the DEADLOCK RETRY, pinned. The S4-4 gap-lock residual applies to
// this route exactly as it does to the reverse, so the whole transaction is
// wrapped in `withDeadlockRetry` — and the operation's batch id is minted
// OUTSIDE it, so a retried act writes under ONE id rather than splitting itself
// across two.
// ---------------------------------------------------------------------------

describe('POST .../move — withDeadlockRetry', () => {
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

    const res = await move();
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(2);

    // Two TRANSFER legs per attempt, all four under the same batch id.
    const written = (tx.inventory_logs.create as unknown as jest.Mock).mock.calls.map(
      (call) => call[0].data.batchId,
    );
    expect(written).toHaveLength(4);
    expect(new Set(written).size).toBe(1);
    const events = (tx.auditLog.create as unknown as jest.Mock).mock.calls.map(
      (call) => call[0].data.batchId,
    );
    expect(new Set(events)).toEqual(new Set(written));
    expect((await res.json()).batchId).toBe(written[0]);
  });

  it('does NOT retry a typed refusal — ORDER_GONE runs the transaction ONCE', async () => {
    makeDb({ locked: [row({ orderRecordId: 'ord-9' })], lockedOrder: null });

    expect((await move()).status).toBe(404);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('POST .../move — the destination is PROVED, twice (PK-11)', () => {
  it('an unknown location is a 400 BEFORE the transaction, never an FK 500', async () => {
    const { trace } = makeDb({ locations: [null] });

    const res = await move();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Location 7 not found',
      code: 'LOCATION_NOT_FOUND',
    });
    expect(trace).toContain('location.findUnique');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('the proof reads the location the BODY named, and asks for its id only', async () => {
    makeDb();
    await move({ physicalLocationId: 12 });

    expect((db.location.findUnique as unknown as jest.Mock).mock.calls[0][0]).toEqual({
      where: { id: 12 },
      select: { id: true },
    });
  });

  // THE BELT, ARM 1 (PK-11): an admin deleted the location between the proof and
  // the prelock's materialize INSERT. Shape-agnostic on purpose — the shape
  // Prisma gives a raw FK violation is pinned nowhere in this repo.
  it('a throw from inside the transaction with the location GONE is the 400, not a 500', async () => {
    const { trace } = makeDb({
      locations: [{ id: PHYSICAL }, null],
      writeError: new Error('Foreign key constraint violated: `fk_pl_location`'),
    });

    const res = await move();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Location 7 not found',
      code: 'LOCATION_NOT_FOUND',
    });
    // Read twice: once before the transaction, once after the rollback.
    expect(trace.filter((step) => step === 'location.findUnique')).toHaveLength(2);
  });

  // THE BELT, ARM 2: the location is still there, so this was somebody's
  // refusal — rethrown into the outer catch, which is the mapper's.
  it('a REFUSAL inside the transaction still renders its own envelope, never a 500', async () => {
    const { trace } = makeDb({
      locked: [row({ productId: 9, delta: -4 })],
      stock: { [prelockKey(9, PHYSICAL)]: 1 },
    });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Location 7 has 1 of product 9 on the books — 4 needed to move this batch',
      code: 'INSUFFICIENT_AT_SOURCE',
      productId: 9,
      locationId: PHYSICAL,
      onBook: 1,
      needed: 4,
    });
    // THE EXTRA READ, COUNTED: the belt re-reads on the refusal path too.
    expect(trace.filter((step) => step === 'location.findUnique')).toHaveLength(2);
  });

  // THE BELT, ARM 4 (F4/OC-4): the belt's OWN read can fail. A probe that throws
  // proves nothing about the location, so what the outer catch must see is the
  // ORIGINAL error — never the probe's, which would turn a 400 refusal into a
  // 500 about a database blip.
  it('a probe that ITSELF fails rethrows the ORIGINAL error, so the refusal still renders', async () => {
    const { trace } = makeDb({
      locked: [row({ locationId: LEDGER })],
      locations: [{ id: LEDGER }, new Error('ECONNRESET while reading locations')],
    });

    const res = await move({ physicalLocationId: LEDGER });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Location 3 is already this batch's ledger location — choose a different one",
      code: 'SAME_LOCATION',
      locationId: LEDGER,
    });
    expect(trace.filter((step) => step === 'location.findUnique')).toHaveLength(2);
  });

  it('a clean 200 reads the location exactly ONCE', async () => {
    const { trace } = makeDb();
    expect((await move()).status).toBe(200);
    expect(trace.filter((step) => step === 'location.findUnique')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The core's refusals, through the ONE mapper
// ---------------------------------------------------------------------------

describe('POST .../move — the core’s refusals', () => {
  it('SAME_LOCATION is a 400 that names the location to change', async () => {
    makeDb({ locked: [row({ locationId: LEDGER })], locations: [{ id: LEDGER }, { id: LEDGER }] });

    const res = await move({ physicalLocationId: LEDGER });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Location 3 is already this batch's ledger location — choose a different one",
      code: 'SAME_LOCATION',
      locationId: LEDGER,
    });
  });

  it('MULTI_LOCATION names every location the batch spans', async () => {
    makeDb({ locked: [row({ locationId: 3 }), row({ id: 502, locationId: 5 })] });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This batch spans 2 locations (3, 5) and cannot be moved as one',
      code: 'MULTI_LOCATION',
      locationIds: [3, 5],
    });
  });

  it('FULFILLED_BATCH sends the operator to unfulfill + refulfil', async () => {
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

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Fulfilled against #ord-5 — change it via unfulfill/refulfill, not here',
      code: 'FULFILLED_BATCH',
      orderRecordId: 'ord-5',
      orderNumber: null,
    });
  });

  it('BATCH_RESTORED carries the units already put back', async () => {
    makeDb({
      locked: [row({ delta: -4 })],
      restorationEvents: [
        {
          id: 41,
          actionType: 'INVENTORY_CORRECTION',
          details: { rows: [{ productId: 9, locationId: LEDGER, delta: 4 }] },
          createdAt: new Date('2026-09-02T10:00:00.000Z'),
        },
      ],
    });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch has already been put back (4 units) — it can no longer be re-attributed or moved',
      code: 'BATCH_RESTORED',
      restoredUnits: 4,
    });
  });

  it('ALREADY_MOVED names the location and the minute of the first move', async () => {
    makeDb({
      locked: [row({ delta: -4 })],
      restorationEvents: [
        {
          id: 43,
          actionType: 'INVENTORY_BATCH_MOVE',
          details: {
            ledgerLocationId: LEDGER,
            physicalLocationId: 8,
            rows: [
              { productId: 9, locationId: 8, delta: -4 },
              { productId: 9, locationId: LEDGER, delta: 4 },
            ],
          },
          createdAt: new Date('2026-09-02T14:31:22.000Z'),
        },
      ],
    });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'This batch was moved to location 8 on 2026-09-02 14:31 UTC — it can no longer be re-attributed or moved again',
      code: 'ALREADY_MOVED',
      physicalLocationId: 8,
      at: '2026-09-02T14:31:22.000Z',
    });
  });

  it('BATCH_MOVED REDACTS the id for a non-admin', async () => {
    mockRequireApproved.mockResolvedValue({ user: { id: 7, isAdmin: false } });
    makeDb({
      locked: [row({ orderRecordId: 'ord-9', userId: 7 })],
      discovery: { stampCount: BigInt(0), firstStamp: null },
    });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Someone attributed this batch while you were looking — refresh and try again',
      code: 'BATCH_MOVED',
      expected: null,
    });
  });

  it('NULL_LOCATION_ROW names the row to repair', async () => {
    makeDb({ locked: [row(), row({ id: 502, locationId: null })] });

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Ledger row 502 names no location — this batch cannot be reversed or moved until it is repaired',
      code: 'NULL_LOCATION_ROW',
      rowId: 502,
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

    const res = await move();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        'Restoration event 41 is malformed — the batch cannot be reversed or moved until it is repaired',
      code: 'RESTORATION_LEDGER_CORRUPT',
    });
  });
});

// ---------------------------------------------------------------------------
// The 200 and its event
// ---------------------------------------------------------------------------

describe('POST .../move — the answer and the audit event', () => {
  it('answers the frozen envelope, with the pair the server actually wrote', async () => {
    makeDb({
      locked: [
        row({ id: 501, productId: 9, delta: -4 }),
        row({ id: 502, productId: 10, delta: -2 }),
      ],
    });

    const res = await move();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'batchId',
        'ledgerLocationId',
        'message',
        'movedBatchId',
        'orderRecordId',
        'pairs',
        'physicalLocationId',
        'rows',
      ].sort(),
    );
    expect(body.movedBatchId).toBe(BATCH);
    expect(body.batchId).toMatch(UUID);
    expect(body.batchId).not.toBe(BATCH);
    expect(body.ledgerLocationId).toBe(LEDGER);
    expect(body.physicalLocationId).toBe(PHYSICAL);
    expect(body.pairs).toEqual([
      { productId: 9, units: 4, transferId: expect.stringMatching(UUID) },
      { productId: 10, units: 2, transferId: expect.stringMatching(UUID) },
    ]);
    expect(body.rows).toEqual([
      { productId: 9, locationId: PHYSICAL, delta: -4 },
      { productId: 9, locationId: LEDGER, delta: 4 },
      { productId: 10, locationId: PHYSICAL, delta: -2 },
      { productId: 10, locationId: LEDGER, delta: 2 },
    ]);
    expect(body.message).toBe('moved 6 units from location 3 to 7');
  });

  it('the event names the MOVED batch as its entity and the NEW batch as its own', async () => {
    const { tx } = makeDb({ locked: [row({ orderRecordId: 'ord-9', delta: -4 })] });
    const body = await (await move()).json();

    const event = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(event.actionType).toBe('INVENTORY_BATCH_MOVE');
    expect(event.entityType).toBe('INVENTORY');
    expect(event.entityId).toBe(BATCH);
    expect(event.batchId).toBe(body.batchId);
    expect(event.companyId).toBe('co-1');
    // The LEGS, never the pairs: two per product.
    expect(event.affectedCount).toBe(2);
    expect(event.action).toBe(
      `Moved batch ${BATCH}: 4 units reclassified from location 3 to 7`,
    );
    expect(event.details).toMatchObject({
      movedBatchId: BATCH,
      ledgerLocationId: LEDGER,
      physicalLocationId: PHYSICAL,
      pairs: [{ productId: 9, units: 4, transferId: expect.stringMatching(UUID) }],
      rows: [
        { productId: 9, locationId: PHYSICAL, delta: -4 },
        { productId: 9, locationId: LEDGER, delta: 4 },
      ],
      orderRecordId: 'ord-9',
    });
  });

  it('an UNSTAMPED batch files the event with NO companyId', async () => {
    const { tx } = makeDb({ locked: [row()] });
    await move();

    const event = (tx.auditLog.create as unknown as jest.Mock).mock.calls[0][0].data;
    expect(event.companyId).toBeNull();
  });

  it('writes NO attribution attempt row', async () => {
    const { tx } = makeDb();
    await move();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });
});
