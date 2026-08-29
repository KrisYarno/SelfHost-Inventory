/**
 * @jest-environment node
 *
 * THE MATCH PRODUCER (reconciliation lane Part 2, A2; spec REV-8 §2.2 / D2,
 * pack CA2.1).
 *
 * The matcher is pure and pinned in its own suite; the two side-readers are
 * pinned in theirs. What is left for THIS one is the thing neither of them can
 * assert about itself: what a page of orders COSTS, in what order it is spent,
 * and that every id the caller asked about comes back a key of the answer.
 *
 * Three pins carry most of the weight:
 *
 *   * THREE statements, never one per order. A per-order producer would be the
 *     same code and a report page of a hundred and fifty reads.
 *   * The ASKED id is the key, on BOTH reads. MySQL matches the ledger's soft
 *     order reference case-insensitively, so a variant-spelled stamp finds its
 *     rows and comes back spelled the database's way — and a map keyed by the
 *     returned spelling would report an order with movement as having none.
 *   * `hundredths` is EXACT. It is read off `Decimal.toFixed(2)` rather than
 *     through `numericValue * 100`, because the float route makes two equal
 *     masses stop balancing; the pins below are the four decimal shapes that
 *     would show it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { mockDeep, mockReset } from 'jest-mock-extended';
import { Prisma, type PrismaClient } from '@prisma/client';

import { MATCH_DEFINITIONS } from '@/lib/reconciliation/match-keys';
import {
  MAX_MATCH_ORDERS,
  getOrderMatches,
  type MatchReader,
} from '@/lib/reconciliation/match-producer';
import type { ReconciliationItemRow } from '@/lib/reconciliation/items';
import type { OrderMatch } from '@/lib/reconciliation/match';
import { matchOrder } from '@/lib/reconciliation/match';

// FD-2: the propagation pin needs ONE throw that is not a refusal. The module's
// exports are non-configurable under ts-jest, so `spyOn` cannot hook them; the
// matcher is wrapped in a jest.fn that calls the real one everywhere else.
jest.mock('@/lib/reconciliation/match', () => {
  const actual = jest.requireActual('@/lib/reconciliation/match');
  return { ...actual, matchOrder: jest.fn(actual.matchOrder) };
});
const actualMatchOrder = jest.requireActual<typeof import('@/lib/reconciliation/match')>(
  '@/lib/reconciliation/match',
).matchOrder;
import type { DeductedSideSqlRow } from '@/lib/reconciliation/population';

const db = mockDeep<PrismaClient>();
const client = db as unknown as MatchReader;

// --------------------------------------------------------------------------
// Fixtures — rows exactly as the two reads return them.
// --------------------------------------------------------------------------

function itemRow(input: {
  id: string;
  orderId: string;
  productId?: number | null;
  quantity?: number;
  isMapped?: boolean;
}): ReconciliationItemRow {
  return {
    id: input.id,
    orderId: input.orderId,
    quantity: input.quantity ?? 1,
    fulfilledQty: 0,
    isMapped: input.isMapped ?? true,
    productLinkId: 'link-1',
    bundleComponentSnapshot: null,
    productLink: {
      internalProductId: input.productId === undefined ? 9 : input.productId,
      isBundle: false,
      bundleComponents: [],
    },
  } as unknown as ReconciliationItemRow;
}

function deductedRow(input: {
  orderRecordId: string;
  productId: number;
  out?: string;
  corrected?: string;
}): DeductedSideSqlRow {
  return {
    orderRecordId: input.orderRecordId,
    productId: input.productId,
    // The driver hands a SUM back as a Decimal; the producer converts.
    outUnits: new Prisma.Decimal(input.out ?? '0'),
    correctedUnits: new Prisma.Decimal(input.corrected ?? '0'),
  };
}

function productRow(input: {
  id: number;
  name?: string;
  baseName?: string | null;
  unit?: string | null;
  numericValue?: string | null;
}) {
  return {
    id: input.id,
    name: input.name ?? `Product ${input.id}`,
    baseName: input.baseName === undefined ? 'alpha' : input.baseName,
    unit: input.unit === undefined ? 'mg' : input.unit,
    numericValue:
      input.numericValue === undefined || input.numericValue === null
        ? null
        : new Prisma.Decimal(input.numericValue),
  };
}

/** Every statement this producer is allowed to spend (pack CA2.1). */
function statementCount(): number {
  return (
    db.externalOrderItem.findMany.mock.calls.length +
    db.$queryRaw.mock.calls.length +
    db.product.findMany.mock.calls.length
  );
}

function rawStatement(call = 0): { sql: string; values: unknown[] } {
  return db.$queryRaw.mock.calls[call][0] as unknown as { sql: string; values: unknown[] };
}

beforeEach(() => {
  mockReset(db);
  // FD2-5: a queued one-shot throw must never leak into the next test.
  (matchOrder as jest.MockedFunction<typeof matchOrder>).mockReset().mockImplementation(actualMatchOrder);
  db.externalOrderItem.findMany.mockResolvedValue([] as never);
  db.$queryRaw.mockResolvedValue([] as never);
  db.product.findMany.mockResolvedValue([] as never);
});

// --------------------------------------------------------------------------
// The budget
// --------------------------------------------------------------------------

describe('getOrderMatches — the statement budget', () => {
  it('spends EXACTLY three statements for a page of orders', async () => {
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-1', productId: 9, quantity: 2 }),
      itemRow({ id: 'i2', orderId: 'ord-2', productId: 9 }),
    ] as never);
    db.$queryRaw.mockResolvedValue([
      deductedRow({ orderRecordId: 'ord-1', productId: 9, out: '2' }),
    ] as never);
    db.product.findMany.mockResolvedValue([productRow({ id: 9 })] as never);

    const matches = await getOrderMatches(client, ['ord-1', 'ord-2']);

    expect(statementCount()).toBe(3);
    expect(matches.get('ord-1')?.class).toBe('exact');
  });

  it('an EMPTY id list spends ZERO statements and answers with an empty map', async () => {
    const matches = await getOrderMatches(client, []);

    expect(statementCount()).toBe(0);
    expect(matches.size).toBe(0);
  });

  it('spends TWO when neither side names a product — the lookup is skipped, not empty', async () => {
    // An unmapped line is a counter, never an ordered product, and the ledger
    // returned nothing: there is no id to look facts up for.
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-1', isMapped: false }),
    ] as never);

    await getOrderMatches(client, ['ord-1']);

    expect(statementCount()).toBe(2);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it('issues them in ORDER: the items, the ledger aggregate, then the products', async () => {
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-1', productId: 9 }),
    ] as never);
    db.product.findMany.mockResolvedValue([productRow({ id: 9 })] as never);

    await getOrderMatches(client, ['ord-1']);

    const items = db.externalOrderItem.findMany.mock.invocationCallOrder[0];
    const aggregate = db.$queryRaw.mock.invocationCallOrder[0];
    const products = db.product.findMany.mock.invocationCallOrder[0];
    expect(items).toBeLessThan(aggregate);
    expect(aggregate).toBeLessThan(products);
  });

  it('more than 200 orders is a RangeError, and it costs nothing', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `ord-${i}`);

    await expect(getOrderMatches(client, ids)).rejects.toThrow(RangeError);
    expect(statementCount()).toBe(0);
  });

  it('the cap is on the DEDUPED set — 201 ids naming 200 orders is a read', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `ord-${i}`).concat('ord-0');

    await getOrderMatches(client, ids);

    expect(statementCount()).toBe(2);
  });

  // ONE bound, three modules (G2-11). `items.ts` and `population.ts` cannot
  // import this one (they are below it in the graph), so their 200 is their own
  // literal — and the number the ROUTE admits is this constant, exported for it.
  // A pin that the three agree is the only thing standing between them.
  it('MAX_MATCH_ORDERS is 200 — the same bound the two readers enforce', async () => {
    expect(MAX_MATCH_ORDERS).toBe(200);
    await expect(
      getOrderMatches(client, Array.from({ length: MAX_MATCH_ORDERS + 1 }, (_, i) => `ord-${i}`)),
    ).rejects.toThrow(`getOrderMatches: at most ${MAX_MATCH_ORDERS} orders`);
  });
});

// --------------------------------------------------------------------------
// The two reads
// --------------------------------------------------------------------------

describe('getOrderMatches — the reads it issues', () => {
  it('the aggregate is the Prisma.sql OBJECT form and carries BOTH CASE arms', async () => {
    await getOrderMatches(client, ['ord-1']);

    const statement = rawStatement();
    // The OBJECT form, not the bare tagged template: the MCP build's dispatcher
    // reads `.sql` off the argument (pack cross-wave rule 3).
    expect(typeof statement.sql).toBe('string');
    expect(statement.sql).toContain('AS outUnits');
    expect(statement.sql).toContain('AS correctedUnits');
    expect(statement.sql).toContain('THEN -l.delta ELSE 0 END');
    expect(statement.sql).toContain("l.logType = 'CORRECTION' AND l.delta > 0");
    expect(statement.sql).toContain('GROUP BY l.orderRecordId, l.productId');
    expect(statement.values).toContainEqual('ord-1');
  });

  it('the product read asks for the union of BOTH sides, through the five columns it needs', async () => {
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-1', productId: 9 }),
    ] as never);
    db.$queryRaw.mockResolvedValue([
      deductedRow({ orderRecordId: 'ord-1', productId: 4, out: '1' }),
    ] as never);

    await getOrderMatches(client, ['ord-1']);

    expect(db.product.findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: [4, 9] } },
      select: { id: true, name: true, baseName: true, unit: true, numericValue: true },
    });
  });
});

// --------------------------------------------------------------------------
// The asked id is the key (the FD-1 idiom, on BOTH reads)
// --------------------------------------------------------------------------

describe('getOrderMatches — the result is keyed by the id that was ASKED', () => {
  it('every asked id is a key, EXCEPT an order the matcher refused', async () => {
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-1', productId: 9 }),
    ] as never);
    db.product.findMany.mockResolvedValue([productRow({ id: 9 })] as never);

    const matches = await getOrderMatches(client, ['ord-1', 'ord-empty']);

    expect(Array.from(matches.keys()).sort()).toEqual(['ord-1', 'ord-empty']);
    const empty = matches.get('ord-empty');
    expect(empty?.class).toBeNull();
    expect(empty?.reason).toBe('unmatchable');
  });

  it("a CASE-VARIANT stamp resolves on BOTH reads ('ORD-1' asked, 'ord-1' returned)", async () => {
    // MySQL matched the ids ci under utf8mb4_unicode_ci, so both reads answer
    // with the database's spelling. Keying on that would report an order with
    // movement as having none.
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-1', productId: 9, quantity: 2 }),
    ] as never);
    db.$queryRaw.mockResolvedValue([
      deductedRow({ orderRecordId: 'ord-1', productId: 9, out: '2' }),
    ] as never);
    db.product.findMany.mockResolvedValue([productRow({ id: 9 })] as never);

    const matches = await getOrderMatches(client, ['ORD-1']);

    const match = matches.get('ORD-1');
    expect(match?.class).toBe('exact');
    expect(match?.perProduct).toEqual([
      expect.objectContaining({ productId: 9, ordered: 2, deducted: 2, corrected: 0 }),
    ]);
  });
});

// --------------------------------------------------------------------------
// `hundredths` — exact, never a float
// --------------------------------------------------------------------------

describe('getOrderMatches — numericValue in integer hundredths', () => {
  it("'2.50' -> 250, '0.05' -> 5, '12.34' -> 1234, '0.29' -> 29, and '0.00' -> null", async () => {
    db.externalOrderItem.findMany.mockResolvedValue([
      itemRow({ id: 'i1', orderId: 'ord-h', productId: 1 }),
      itemRow({ id: 'i2', orderId: 'ord-h', productId: 3 }),
      itemRow({ id: 'i3', orderId: 'ord-h', productId: 5 }),
      itemRow({ id: 'i4', orderId: 'ord-h', productId: 6 }),
    ] as never);
    db.$queryRaw.mockResolvedValue([
      deductedRow({ orderRecordId: 'ord-h', productId: 2, out: '50' }),
      deductedRow({ orderRecordId: 'ord-h', productId: 4, out: '2' }),
      deductedRow({ orderRecordId: 'ord-h', productId: 7, out: '1' }),
    ] as never);
    db.product.findMany.mockResolvedValue([
      productRow({ id: 1, baseName: 'alpha', numericValue: '2.50' }),
      productRow({ id: 2, baseName: 'alpha', numericValue: '0.05' }),
      productRow({ id: 3, baseName: 'beta', numericValue: '12.34' }),
      productRow({ id: 4, baseName: 'beta', numericValue: '6.17' }),
      productRow({ id: 5, baseName: 'gamma', numericValue: '0.00' }),
      // 0.29 is one of the 271 two-place decimals `numericValue * 100` renders
      // as 28.999999999999996 — the float route trips the matcher's integer
      // guard here rather than silently unbalancing a swap in production.
      productRow({ id: 6, baseName: 'delta', numericValue: '0.29' }),
      productRow({ id: 7, baseName: 'delta', numericValue: '0.29' }),
    ] as never);

    const match = matches1(await getOrderMatches(client, ['ord-h']));

    // 1 x 2.50 mg missing balances 50 x 0.05 mg extra: 250 hundredths either way.
    expect(match.tolerance?.equivalentGroups[0]).toEqual({
      familyKey: 'alpha',
      unit: 'mg',
      massHundredths: 250,
      shortfall: [{ productId: 1, units: 1, hundredths: 250 }],
      extra: [{ productId: 2, units: 50, hundredths: 5 }],
    });
    // 1 x 12.34 mg missing balances 2 x 6.17 mg extra: 1234 hundredths either way.
    expect(match.tolerance?.equivalentGroups[1]).toEqual({
      familyKey: 'beta',
      unit: 'mg',
      massHundredths: 1234,
      shortfall: [{ productId: 3, units: 1, hundredths: 1234 }],
      extra: [{ productId: 4, units: 2, hundredths: 617 }],
    });
    expect(match.tolerance?.equivalentGroups[2]).toEqual({
      familyKey: 'delta',
      unit: 'mg',
      massHundredths: 29,
      shortfall: [{ productId: 6, units: 1, hundredths: 29 }],
      extra: [{ productId: 7, units: 1, hundredths: 29 }],
    });
    // A zero mass is not a mass: it cannot enter a group at all.
    expect(match.tolerance?.excludedProducts).toEqual([
      { productId: 5, reason: 'undecomposable', unit: 'mg' },
    ]);
    // The two balanced groups left; the undecomposable one is still missing.
    expect(match.class).toBe('missing-product');
  });
});

// --------------------------------------------------------------------------
// What the producer does NOT do
// --------------------------------------------------------------------------

describe('getOrderMatches — the facts it does not invent', () => {
  it("a deducted product missing from the products read is 'unknown product'", async () => {
    // The name is the MATCHER's synthesis (it holds the rule), never a string
    // this module makes up on the way past.
    db.$queryRaw.mockResolvedValue([
      deductedRow({ orderRecordId: 'ord-1', productId: 77, out: '3' }),
    ] as never);
    db.product.findMany.mockResolvedValue([] as never);

    const match = matches1(await getOrderMatches(client, ['ord-1']));

    expect(match.perProduct).toEqual([
      expect.objectContaining({ productId: 77, productName: 'unknown product', deducted: 3 }),
    ]);
    expect(match.deductedUnits).toBe(3);
  });

  // ONE BAD ORDER IS ONE MISSING KEY, never a failed page (OCa-6 / G2-3). The
  // matcher's integer guard is a claim about data nobody can render; a page of
  // fifty orders that 500s because one of them carries a negative quantity is a
  // surface nobody can use to find that order.
  describe('a matcher refusal is per ORDER', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('omits the refused order, keeps the rest, and logs the ID — never the rows', async () => {
      db.externalOrderItem.findMany.mockResolvedValue([
        itemRow({ id: 'i1', orderId: 'ord-bad', productId: 9, quantity: -1 }),
        itemRow({ id: 'i2', orderId: 'ord-good', productId: 9, quantity: 1 }),
      ] as never);
      db.product.findMany.mockResolvedValue([productRow({ id: 9 })] as never);

      const matches = await getOrderMatches(client, ['ord-bad', 'ord-good']);

      expect(Array.from(matches.keys())).toEqual(['ord-good']);
      expect(matches.get('ord-good')?.class).toBe('missing-product');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, context] = errorSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(message).toBe('[match-producer] matcher refused order');
      expect(context.orderId).toBe('ord-bad');
      expect(typeof context.message).toBe('string');
      // The log carries the order id plus the guard's own sentence (a product id
      // and the offending integer) — never the row objects (FD-4).
      expect(Object.keys(context).sort()).toEqual(['message', 'orderId']);
      expect(context.message).toMatch(/^matchOrder: /);
      expect(context.message).not.toMatch(/itemId|fulfilledQty|[{[]/);
    });

    it('catches ONLY a refusal — any other throw from the matcher propagates (FD-2)', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const mocked = matchOrder as jest.MockedFunction<typeof matchOrder>;
      mocked.mockImplementationOnce(() => {
        throw new TypeError('boom');
      });
      try {
        db.externalOrderItem.findMany.mockResolvedValue([] as never);
        db.$queryRaw.mockResolvedValue([] as never);
        db.product.findMany.mockResolvedValue([] as never);
        await expect(getOrderMatches(db, ['ord-1'])).rejects.toThrow(TypeError);
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  // A FABRICATED ZERO IS THE ONE ANSWER THIS MODULE MAY NOT GIVE (OCa-6). A SUM
  // that is not a number means the aggregate did not answer the question asked;
  // reporting it as "nothing left stock" would call every product missing.
  it('THROWS on a non-numeric SUM rather than reading it as zero', async () => {
    db.$queryRaw.mockResolvedValue([
      { orderRecordId: 'ord-1', productId: 9, outUnits: 'not a number', correctedUnits: 0 },
    ] as never);

    await expect(getOrderMatches(client, ['ord-1'])).rejects.toThrow(
      'match-producer: non-numeric SUM from the deducted-side aggregate',
    );
  });

  it('every result carries MATCH_DEFINITIONS by identity', async () => {
    const matches = await getOrderMatches(client, ['ord-1', 'ord-2']);

    matches.forEach((match) => expect(match.definitions).toBe(MATCH_DEFINITIONS));
  });
});

// --------------------------------------------------------------------------
// The read-path rule, textually (pack cross-wave rule 2)
// --------------------------------------------------------------------------

describe('match-producer.ts stays on the read path', () => {
  it('carries no Prisma write token and names no writer module, comments included', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../../lib/reconciliation/match-producer.ts'),
      'utf8',
    );
    const writeToken =
      /\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(|\$(executeRaw|executeRawUnsafe|queryRawUnsafe)\b/;
    expect(writeToken.test(src)).toBe(false);
    expect(src).not.toContain('attribute-batch');
    expect(src).not.toContain('lib/attribution/attempts');
  });
});

/** The one order's match — the single-order fixtures above read through here. */
function matches1(matches: Map<string, OrderMatch>): OrderMatch {
  const [first] = Array.from(matches.values());
  expect(first).toBeDefined();
  return first;
}
