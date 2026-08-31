/**
 * THE ORDER LOCK (Part 2, spec §2.7(1); pack CB0.2/CB0.4, plan P-2).
 *
 * `lockFirst` is the FIRST statement of every transaction that touches an
 * order's stock — one `SELECT … FOR UPDATE` over the deduped union of the
 * required and advisory ids, `ORDER BY id` so the acquisition order is total.
 * Everything else the lane locks (ledger rows, `product_locations`, the
 * exception register) comes after it, in that frozen order.
 *
 * Three properties this suite exists to keep honest:
 *
 *   - the map answers for the id that was ASKED (the `loadOrders` idiom,
 *     `attribution.ts:1087-1110`): MySQL matches ids case-INSENSITIVELY, so a
 *     variant-cased ask must not be reported as a vanished order;
 *   - REQUIRED means 409 `ORDER_GONE`; ADVISORY means simply absent — a deleted
 *     previous order must never brick a re-attribution;
 *   - `withOrderLock` is TOTAL on the id set: an empty union runs a plain
 *     `$transaction` with ZERO locking statements (the helper's own branch, not
 *     a rule every caller has to remember — OCp2-4).
 *
 * Order is pinned the way every B1 suite pins it: `__rawCalls` orders raw
 * statements among themselves, `mock.invocationCallOrder` orders them against
 * the Prisma delegates (pack CB0.3).
 */

import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import { AppError } from '@/lib/error-handling';
import { ORDER_GONE, lockFirst, withOrderLock, type LockedOrder } from '@/lib/inventory/order-lock';

type RawCall = { kind: string; sql: string; at: number };

const {
  __mockTx: mockTx,
  __rawCalls: rawCalls,
  __rawBehavior: rawBehavior,
} = jest.requireMock('@/lib/prisma') as {
  __mockTx: Record<string, any>;
  __rawCalls: RawCall[];
  __rawBehavior: Record<string, jest.Mock>;
};

const db = prisma as unknown as Record<string, any>;
const tx = mockTx as unknown as Prisma.TransactionClient;

function fold(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function rawArg(fn: jest.Mock, call = 0): { sql: string; values: unknown[] } {
  return fn.mock.calls[call][0] as unknown as { sql: string; values: unknown[] };
}

const ORDER_A = { id: 'ORD-1', orderNumber: '1001' };
const ORDER_B = { id: 'ORD-2', orderNumber: '1002' };

// The global mock's DELEGATES (and `$transaction`) are not cleared by the setup
// file — the raw trio and its log are. This suite counts both, so it clears the
// rest itself; implementations and the harness defaults survive `clearAllMocks`.
beforeEach(() => {
  jest.clearAllMocks();
});

describe('ORDER_GONE', () => {
  it('is the wire contract the routes compare against', () => {
    expect(ORDER_GONE).toBe('ORDER_GONE');
  });
});

describe('lockFirst — the one statement', () => {
  it('locks the union in ONE `SELECT … ORDER BY id FOR UPDATE`', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A, ORDER_B]);

    await lockFirst(tx, { required: ['ORD-1'], advisory: ['ORD-2'] });

    expect(rawCalls.map((c) => c.kind)).toEqual(['query']);
    const select = fold(rawArg(mockTx.$queryRaw).sql);
    expect(select).toContain('SELECT id, orderNumber FROM external_orders');
    expect(select).toContain('WHERE id IN (?,?)');
    expect(select).toContain('ORDER BY id');
    expect(select).toContain('FOR UPDATE');
    expect(rawArg(mockTx.$queryRaw).values).toEqual(['ORD-1', 'ORD-2']);
  });

  it('FOLDS + DEDUPES: two spellings of one id are ONE id in the SQL', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A]);

    const locked = await lockFirst(tx, { required: ['ORD-1', 'ord-1'] });

    expect(rawArg(mockTx.$queryRaw).values).toEqual(['ORD-1']);
    expect(locked.size).toBe(2);
    expect(locked.get('ORD-1')).toEqual(ORDER_A);
    // BOTH asked spellings key the SAME object — one row, one lock, one answer.
    expect(locked.get('ord-1')).toBe(locked.get('ORD-1'));
  });

  it('keys by the ASKED id even when MySQL matched a different spelling', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A]);

    const locked = await lockFirst(tx, { required: ['ord-1'] });

    expect(locked.get('ord-1')).toEqual({ id: 'ORD-1', orderNumber: '1001' });
  });

  it('carries the values the DB spelled, not the ones the caller asked with', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A]);

    const locked = await lockFirst(tx, { required: ['OrD-1'] });

    expect(locked.get('OrD-1')).toEqual({ id: 'ORD-1', orderNumber: '1001' });
  });

  it('empty union → NO statement, empty map', async () => {
    const locked = await lockFirst(tx, { required: [] });

    expect(locked.size).toBe(0);
    expect(rawCalls).toHaveLength(0);
    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('lockFirst — required vs advisory', () => {
  it('a missing ADVISORY id is simply absent from the map — never a throw', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A]);

    const locked = await lockFirst(tx, { required: ['ORD-1'], advisory: ['ORD-GONE'] });

    expect(locked.has('ORD-1')).toBe(true);
    expect(locked.has('ORD-GONE')).toBe(false);
  });

  it('a missing REQUIRED id throws ORDER_GONE, 409, naming the ASKED id', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([]);

    const failure = await lockFirst(tx, { required: ['ORD-404'] }).catch((err) => err);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe(ORDER_GONE);
    expect(failure.statusCode).toBe(409);
    expect(failure.message).toBe('order ORD-404 no longer exists');
  });

  it('names the FIRST missing required id', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_B]);

    const failure = await lockFirst(tx, { required: ['ORD-1', 'ORD-2', 'ORD-3'] }).catch((e) => e);

    expect(failure.message).toBe('order ORD-1 no longer exists');
  });

  it('does not throw when the only missing id is advisory and required is empty', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([]);

    const locked = await lockFirst(tx, { required: [], advisory: ['ORD-GONE'] });

    expect(locked.size).toBe(0);
    expect(rawCalls.map((c) => c.kind)).toEqual(['query']);
  });
});

describe('withOrderLock', () => {
  it('makes the lock STATEMENT 1 — before every delegate call in the callback', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A]);
    db.inventory_logs.create.mockResolvedValueOnce({ id: 1 });

    let seen: Map<string, LockedOrder> | null = null;
    const result = await withOrderLock(prisma, { required: ['ORD-1'] }, async (_tx, orders) => {
      seen = orders;
      await _tx.inventory_logs.create({ data: {} as any });
      return 'done';
    });

    expect(result).toBe('done');
    expect(seen).not.toBeNull();
    expect((seen as unknown as Map<string, LockedOrder>).get('ORD-1')).toEqual(ORDER_A);
    // The SELECT is the FIRST raw statement…
    expect(rawCalls[0].kind).toBe('query');
    expect(fold(rawCalls[0].sql)).toContain('SELECT id, orderNumber FROM external_orders');
    // …and it precedes every delegate write (jest's global invocation order).
    expect(mockTx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.inventory_logs.create.mock.invocationCallOrder[0]
    );
  });

  it('is TOTAL on the empty union: a plain $transaction, ZERO locking statements', async () => {
    let seen: Map<string, LockedOrder> | null = null;
    const result = await withOrderLock(prisma, { required: [] }, async (_tx, orders) => {
      seen = orders;
      return 42;
    });

    expect(result).toBe(42);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(rawCalls).toHaveLength(0);
    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
    expect(seen).not.toBeNull();
    expect((seen as unknown as Map<string, LockedOrder>).size).toBe(0);
  });

  it('passes txOptions to $transaction VERBATIM (unfulfill carries { timeout: 30000 })', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([ORDER_A]);

    await withOrderLock(prisma, { required: ['ORD-1'] }, async () => null, { timeout: 30000 });

    expect(db.$transaction.mock.calls[0][1]).toEqual({ timeout: 30000 });
  });

  it('leaves $transaction options undefined when the caller passed none', async () => {
    await withOrderLock(prisma, { required: [] }, async () => null);

    expect(db.$transaction.mock.calls[0][1]).toBeUndefined();
  });

  it('propagates ORDER_GONE out of the transaction', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([]);
    const fn = jest.fn(async () => null);

    const failure = await withOrderLock(prisma, { required: ['ORD-404'] }, fn).catch((e) => e);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe(ORDER_GONE);
    expect(fn).not.toHaveBeenCalled();
  });
});
