/**
 * THE CANONICAL PRELOCK (Part 2, spec §2.7(3); pack CB0.1/CB0.4, plan P-2).
 *
 * Two statements, in this order, for the DEDUPED key set in canonical
 * (productId, locationId) ascending order:
 *
 *   1. ONE multi-row materialize `INSERT … ON DUPLICATE KEY UPDATE version =
 *      version` — the self-assignment changes nothing, so an existing row is
 *      X-locked without its `updatedAt` being bumped (the
 *      `idx_product_locations_updated` consumers must see no phantom activity);
 *   2. ONE returning `SELECT … FOR UPDATE` — kept deliberately, because it
 *      returns the values every covered writer's guard compares against.
 *
 * The suite drives the GLOBAL prisma mock's `__mockTx`, so it also exercises the
 * recording raw stubs this milestone installs (pack CB0.3) — the harness
 * contract itself is pinned in the last describe block, because a B1 order pin
 * is only worth what the recording underneath it is worth.
 *
 * The real-MySQL half (the INSERT's validity against the live DDL, `{0,0}` for a
 * never-stocked key, the EXPLAIN access path) is the B1c concurrency gate's.
 */

import { Prisma } from '@prisma/client';

import prisma from '@/lib/prisma';
import {
  MAX_PRELOCK_KEYS,
  prelockKey,
  prelockProductLocations,
} from '@/lib/inventory/prelock';

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

/** Whitespace-folded so a reformat of the template never moves a pin. */
function fold(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/** The `Prisma.sql` object a raw call was handed. */
function rawArg(fn: jest.Mock, call = 0): { sql: string; values: unknown[] } {
  return fn.mock.calls[call][0] as unknown as { sql: string; values: unknown[] };
}

/** What the mocked SELECT hands back — the materialized rows, in SQL order. */
function materialized(
  keys: Array<{ productId: number; locationId: number }>,
  over: Record<string, { quantity: number; version: number }> = {}
) {
  return keys.map((key) => {
    const seeded = over[prelockKey(key.productId, key.locationId)];
    return {
      productId: key.productId,
      locationId: key.locationId,
      quantity: seeded ? seeded.quantity : 0,
      version: seeded ? seeded.version : 0,
    };
  });
}

describe('prelockKey', () => {
  it('is `${productId}:${locationId}` — the one spelling every consumer uses', () => {
    expect(prelockKey(7, 1)).toBe('7:1');
    expect(prelockKey(12, 3)).toBe('12:3');
  });
});

describe('prelockProductLocations — the two statements', () => {
  it('spends exactly TWO raw calls, execute (materialize) then query (locking read)', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized([{ productId: 7, locationId: 1 }]));

    await prelockProductLocations(tx, [{ productId: 7, locationId: 1 }]);

    expect(rawCalls.map((c) => c.kind)).toEqual(['execute', 'query']);
    expect(rawCalls[0].at).toBeLessThan(rawCalls[1].at);
    expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('materializes with the explicit column list and the no-op ODKU', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized([{ productId: 7, locationId: 1 }]));

    await prelockProductLocations(tx, [{ productId: 7, locationId: 1 }]);

    const insert = fold(rawArg(mockTx.$executeRaw).sql);
    expect(insert).toContain(
      'INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)'
    );
    expect(insert).toContain('VALUES (?, ?, 0, 0, NOW())');
    expect(insert).toContain('ON DUPLICATE KEY UPDATE version = version');
  });

  it('locks and RETURNS the four columns every guard compares against', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized([{ productId: 7, locationId: 1 }]));

    await prelockProductLocations(tx, [{ productId: 7, locationId: 1 }]);

    const select = fold(rawArg(mockTx.$queryRaw).sql);
    expect(select).toContain('SELECT productId, locationId, quantity, version FROM product_locations');
    expect(select).toContain('WHERE (productId, locationId) IN ((?, ?))');
    expect(select).toContain('ORDER BY productId, locationId');
    expect(select).toContain('FOR UPDATE');
  });
});

describe('prelockProductLocations — the key set', () => {
  it('DEDUPES: two equal keys are one VALUES row and one IN tuple', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized([{ productId: 7, locationId: 1 }]));

    await prelockProductLocations(tx, [
      { productId: 7, locationId: 1 },
      { productId: 7, locationId: 1 },
    ]);

    const insert = rawArg(mockTx.$executeRaw);
    expect(insert.values).toEqual([7, 1]);
    expect(fold(insert.sql).match(/\(\?, \?, 0, 0, NOW\(\)\)/g)).toHaveLength(1);
    expect(rawArg(mockTx.$queryRaw).values).toEqual([7, 1]);
  });

  it('SORTS into canonical (productId, locationId) order in BOTH statements', async () => {
    const asked = [
      { productId: 9, locationId: 4 },
      { productId: 2, locationId: 7 },
      { productId: 9, locationId: 1 },
      { productId: 2, locationId: 3 },
    ];
    const canonical = [
      { productId: 2, locationId: 3 },
      { productId: 2, locationId: 7 },
      { productId: 9, locationId: 1 },
      { productId: 9, locationId: 4 },
    ];
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized(canonical));

    await prelockProductLocations(tx, asked);

    const flat = [2, 3, 2, 7, 9, 1, 9, 4];
    expect(rawArg(mockTx.$executeRaw).values).toEqual(flat);
    expect(rawArg(mockTx.$queryRaw).values).toEqual(flat);
    expect(fold(rawArg(mockTx.$queryRaw).sql)).toContain('ORDER BY productId, locationId');
  });

  it('empty keys → NO statement at all, and an empty map', async () => {
    const locked = await prelockProductLocations(tx, []);

    expect(locked.size).toBe(0);
    expect(rawCalls).toHaveLength(0);
    expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
  });

  it('QB-8: refuses a non-integer key with ZERO statements — the canonical sort must stay total', async () => {
    await expect(
      prelockProductLocations(tx, [
        { productId: 5, locationId: 1 },
        { productId: Number.NaN, locationId: 1 },
      ])
    ).rejects.toThrow(/non-integer key/);
    expect(rawCalls).toHaveLength(0);
  });

  it('exports MAX_PRELOCK_KEYS = 200 and refuses a bigger DEDUPED set with ZERO statements', async () => {
    expect(MAX_PRELOCK_KEYS).toBe(200);

    const tooMany: Array<{ productId: number; locationId: number }> = [];
    for (let i = 1; i <= MAX_PRELOCK_KEYS + 1; i++) tooMany.push({ productId: i, locationId: 1 });

    await expect(prelockProductLocations(tx, tooMany)).rejects.toThrow(RangeError);
    await expect(prelockProductLocations(tx, tooMany)).rejects.toThrow(
      'prelockProductLocations: at most 200 keys'
    );
    expect(rawCalls).toHaveLength(0);
  });

  it('counts the DEDUPED set against the cap — 201 asks naming 200 keys pass', async () => {
    const keys: Array<{ productId: number; locationId: number }> = [];
    for (let i = 1; i <= MAX_PRELOCK_KEYS; i++) keys.push({ productId: i, locationId: 1 });
    const asked = keys.concat([{ productId: 1, locationId: 1 }]);
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized(keys));

    const locked = await prelockProductLocations(tx, asked);

    expect(locked.size).toBe(MAX_PRELOCK_KEYS);
    expect(rawCalls.map((c) => c.kind)).toEqual(['execute', 'query']);
  });
});

describe('prelockProductLocations — the returned map', () => {
  it('is keyed by prelockKey and carries { quantity, version } from the returned rows', async () => {
    const keys = [
      { productId: 2, locationId: 3 },
      { productId: 9, locationId: 1 },
    ];
    rawBehavior.$queryRaw.mockResolvedValueOnce(
      materialized(keys, { '2:3': { quantity: 12, version: 4 } })
    );

    const locked = await prelockProductLocations(tx, keys);

    expect(locked.get('2:3')).toEqual({ quantity: 12, version: 4 });
    expect(locked.get('9:1')).toEqual({ quantity: 0, version: 0 });
  });

  it('answers for EVERY asked key — a missing row is impossible after materialize', async () => {
    const asked = [
      { productId: 9, locationId: 4 },
      { productId: 2, locationId: 7 },
      { productId: 9, locationId: 4 },
    ];
    rawBehavior.$queryRaw.mockResolvedValueOnce(
      materialized([
        { productId: 2, locationId: 7 },
        { productId: 9, locationId: 4 },
      ])
    );

    const locked = await prelockProductLocations(tx, asked);

    const missing = asked
      .map((key) => prelockKey(key.productId, key.locationId))
      .filter((key) => !locked.has(key));
    expect(missing).toEqual([]);
    expect(locked.size).toBe(2);
  });

  it('a never-stocked key reads { quantity: 0, version: 0 } — the materialized defaults', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce(materialized([{ productId: 77, locationId: 5 }]));

    const locked = await prelockProductLocations(tx, [{ productId: 77, locationId: 5 }]);

    expect(locked.get('77:5')).toEqual({ quantity: 0, version: 0 });
  });
});

// ---------------------------------------------------------------------------
// The harness itself (pack CB0.3 / P-7). Every B1 order pin rests on this.
// ---------------------------------------------------------------------------

describe('the recording raw stubs (pack CB0.3)', () => {
  it('defaults: $queryRaw → [], $executeRaw → 0, $executeRawUnsafe → 0', async () => {
    await expect(mockTx.$queryRaw(Prisma.sql`SELECT 1`)).resolves.toEqual([]);
    await expect(mockTx.$executeRaw(Prisma.sql`SELECT 1`)).resolves.toBe(0);
    await expect(mockTx.$executeRawUnsafe('SAVEPOINT sp1')).resolves.toBe(0);

    expect(rawCalls.map((c) => c.kind)).toEqual(['query', 'execute', 'executeUnsafe']);
    expect(rawCalls.map((c) => c.sql)).toEqual(['SELECT 1', 'SELECT 1', 'SAVEPOINT sp1']);
  });

  it('clears __rawCalls between tests', () => {
    expect(rawCalls).toHaveLength(0);
  });

  it('exposes ONE fn per method to both the client and __mockTx', () => {
    expect(db.$queryRaw).toBe(mockTx.$queryRaw);
    expect(db.$executeRaw).toBe(mockTx.$executeRaw);
    expect(db.$executeRawUnsafe).toBe(mockTx.$executeRawUnsafe);
  });

  it('RECORDS EVEN WHEN A TEST OVERRIDES THE BEHAVIOUR (REV-14 PKb-8)', async () => {
    rawBehavior.$queryRaw.mockResolvedValueOnce([{ productId: 1, locationId: 1 }]);

    await expect(mockTx.$queryRaw(Prisma.sql`SELECT productId FROM product_locations`)).resolves.toEqual(
      [{ productId: 1, locationId: 1 }]
    );
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].kind).toBe('query');
    expect(fold(rawCalls[0].sql)).toContain('SELECT productId FROM product_locations');
  });

  it('re-seeds the defaults after that override', async () => {
    await expect(mockTx.$queryRaw(Prisma.sql`SELECT 1`)).resolves.toEqual([]);
  });
});
