// @jest-environment node
/**
 * Facelift F2-1 (plan 2026-11-19-facelift-f2, REV 1 as amended by REV 2 A9/A10
 * and REV 3 B5)
 * — `GET /api/products/optimized`: the stock filter, the all-locations total,
 * the "here" quantity and the bounds.
 *
 * The real handler and the REAL `apiHandler` (so an AppError maps to its status
 * as in production); prisma is mocked and only `requireApproved` is stubbed.
 *
 *   - `stock` (all | in-stock | low | out) and `hereLocationId` (a positive
 *     integer) are validated; anything else is a 400 VALIDATION_ERROR.
 *   - Each product gains `totalQuantity` (null iff NO stock row), `hereQuantity`
 *     (the `hereLocationId` row, or null) and `stockState` (lib/stock-threshold's
 *     `stockState`, on the total, under the product's effective threshold).
 *   - The response echoes `hereLocationId`, `stock` (REV 3 B5; `all` when absent)
 *     and the CLAMPED `page` / `pageSize`.
 *   - `stock !== all` reads EVERY match (same where, same orderBy) and pages the
 *     kept rows itself; `stock === all` keeps the DB-paginated path.
 *   - `currentQuantity`, search, sort, no root `quantity`, and the SHOW contract
 *     (provisional products listed; no approvalStatus in the where) are kept.
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    product: { findMany: jest.fn(), count: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return { __esModule: true, ...actual, requireApproved: jest.fn() };
});

import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { requireApproved } from '@/lib/api-utils';
import { GET } from '@/app/api/products/optimized/route';

const m = prisma as unknown as {
  product: { findMany: jest.Mock; count: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
};

const ALL_ROWS_INCLUDE = {
  product_locations: { select: { quantity: true, locationId: true } },
};

type Row = {
  id: number;
  name: string;
  quantity: number; // the retired loc-1 mirror, as a prod row carries it
  lowStockThreshold: number | null;
  approvalStatus: 'APPROVED' | 'PENDING_REVIEW';
  product_locations: { quantity: number; locationId: number }[];
};

const row = (
  id: number,
  locs: [locationId: number, quantity: number][],
  extra: Partial<Row> = {},
): Row => ({
  id,
  name: `P${id}`,
  quantity: 949,
  lowStockThreshold: null,
  approvalStatus: 'APPROVED',
  product_locations: locs.map(([locationId, quantity]) => ({ quantity, locationId })),
  ...extra,
});

async function get(query = '') {
  const resp = await GET(new NextRequest(`http://t/api/products/optimized${query}`));
  return { status: resp.status, body: await resp.json() };
}

/** The products of a response, by id. */
const byId = (body: any) => new Map<number, any>(body.products.map((p: any) => [p.id, p]));

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 7, isAdmin: false } });
  // No lowStockDefaultThreshold row -> the system default is 10.
  m.systemSetting.findUnique.mockResolvedValue(null);
  m.product.findMany.mockResolvedValue([]);
  m.product.count.mockResolvedValue(0);
});

describe('F2-1 — the params and their validation', () => {
  // apiHandler logs every AppError; the 400s below are the point, not noise.
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    (console.error as jest.Mock).mockRestore();
  });

  it.each(['bogus', '', 'LOW', 'in_stock', 'all '])('stock=%p -> 400 "Invalid stock filter"', async (v) => {
    const { status, body } = await get(`?stock=${encodeURIComponent(v)}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid stock filter', code: 'VALIDATION_ERROR' });
    expect(m.product.findMany).not.toHaveBeenCalled();
  });

  it.each(['abc', '', '0', '-1', '1.5', '2x', ' 2', '9007199254740993'])(
    'hereLocationId=%p -> 400 "Invalid location"',
    async (v) => {
      const { status, body } = await get(`?hereLocationId=${encodeURIComponent(v)}`);
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'Invalid location', code: 'VALIDATION_ERROR' });
      expect(m.product.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(['all', 'in-stock', 'low', 'out'])('stock=%s is accepted', async (v) => {
    const { status } = await get(`?stock=${v}`);
    expect(status).toBe(200);
  });

  it('echoes hereLocationId (a number), and null when it is absent', async () => {
    expect((await get('?hereLocationId=2')).body.hereLocationId).toBe(2);
    expect((await get('')).body.hereLocationId).toBeNull();
  });

  // REV 3 B5: the answer names the filter it describes, beside hereLocationId.
  it('echoes stock: "all" when absent, and each accepted value on both paths', async () => {
    const plain = (await get('')).body;
    expect(plain.stock).toBe('all');
    expect(Object.keys(plain).slice(-2)).toEqual(['hereLocationId', 'stock']);
    for (const v of ['all', 'in-stock', 'low', 'out']) {
      expect((await get(`?stock=${v}&hereLocationId=3`)).body).toMatchObject({ stock: v, hereLocationId: 3 });
    }
  });

  it('requireApproved still gates the route', async () => {
    await get('');
    expect(requireApproved).toHaveBeenCalledTimes(1);
  });
});

describe('F2-1 — totalQuantity, hereQuantity, currentQuantity', () => {
  beforeEach(() => {
    m.product.findMany.mockResolvedValue([
      row(1, [[1, 4], [2, 6]]),
      row(2, []), // NO stock row
      row(3, [[2, 0]]), // one 0 row (e.g. created by setting a minimum)
    ]);
    m.product.count.mockResolvedValue(3);
  });

  it('totalQuantity is the sum of the rows; null iff there is NO row; a 0 row reads 0', async () => {
    const p = byId((await get('')).body);
    expect(p.get(1).totalQuantity).toBe(10);
    expect(p.get(2).totalQuantity).toBeNull();
    expect(p.get(3).totalQuantity).toBe(0);
  });

  it('hereQuantity reads the hereLocationId row; null for a missing row; null with no hereLocationId', async () => {
    const here = byId((await get('?hereLocationId=2')).body);
    expect(here.get(1).hereQuantity).toBe(6);
    expect(here.get(2).hereQuantity).toBeNull();
    expect(here.get(3).hereQuantity).toBe(0);

    const none = byId((await get('')).body);
    for (const id of [1, 2, 3]) expect(none.get(id).hereQuantity).toBeNull();
  });

  it('currentQuantity is unchanged: the sum without locationId; hereLocationId does NOT change it', async () => {
    const plain = byId((await get('')).body);
    const withHere = byId((await get('?hereLocationId=2')).body);
    expect([1, 2, 3].map((id) => plain.get(id).currentQuantity)).toEqual([10, 0, 0]);
    expect([1, 2, 3].map((id) => withHere.get(id).currentQuantity)).toEqual([10, 0, 0]);
  });

  it('currentQuantity with the legacy locationId: the matching row, or 0 — beside totalQuantity', async () => {
    const p = byId((await get('?locationId=2')).body);
    expect(p.get(1)).toMatchObject({ currentQuantity: 6, totalQuantity: 10 });
    expect(p.get(2)).toMatchObject({ currentQuantity: 0, totalQuantity: null });
    expect(p.get(3)).toMatchObject({ currentQuantity: 0, totalQuantity: 0 });

    const other = byId((await get('?locationId=9')).body);
    expect(other.get(1)).toMatchObject({ currentQuantity: 0, totalQuantity: 10 });
  });

  it('A9: the include ALWAYS reads every row (quantity + locationId), never narrowed by locationId', async () => {
    for (const q of ['', '?locationId=2', '?hereLocationId=2', '?stock=low', '?stock=out&locationId=2']) {
      m.product.findMany.mockClear();
      await get(q);
      expect(m.product.findMany.mock.calls[0][0].include).toEqual(ALL_ROWS_INCLUDE);
    }
  });

  it('no `quantity` and no `product_locations` at the product root', async () => {
    for (const q of ['', '?stock=all', '?stock=in-stock']) {
      const { body } = await get(q);
      for (const p of body.products) {
        expect(Object.prototype.hasOwnProperty.call(p, 'quantity')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(p, 'product_locations')).toBe(false);
      }
    }
  });
});

describe('F2-1 — stockState, on the total, under the effective threshold', () => {
  it('every state: ok, low, out, below-zero, no-record (system default 10)', async () => {
    m.product.findMany.mockResolvedValue([
      row(1, [[1, 50]]), // ok
      row(2, [[1, 4], [2, 6]]), // 10 total -> low (inclusive)
      row(3, [[1, 0]]), // out
      row(4, [[1, 5], [2, -8]]), // -3 total -> below-zero
      row(5, []), // no-record
    ]);
    m.product.count.mockResolvedValue(5);
    const p = byId((await get('')).body);
    expect([1, 2, 3, 4, 5].map((id) => p.get(id).stockState)).toEqual([
      'ok',
      'low',
      'out',
      'below-zero',
      'no-record',
    ]);
  });

  it('a product threshold of 0 is disabled: never low', async () => {
    m.product.findMany.mockResolvedValue([row(1, [[1, 3]], { lowStockThreshold: 0 })]);
    m.product.count.mockResolvedValue(1);
    expect((await get('')).body.products[0].stockState).toBe('ok');
  });

  it('an inherited (null) threshold uses the system default; an explicit one overrides it', async () => {
    m.systemSetting.findUnique.mockResolvedValue({ value: '20' });
    m.product.findMany.mockResolvedValue([
      row(1, [[1, 15]]), // inherits 20 -> low
      row(2, [[1, 15]], { lowStockThreshold: 5 }), // explicit 5 -> ok
      row(3, [[1, 21]]), // inherits 20 -> ok
    ]);
    m.product.count.mockResolvedValue(3);
    const p = byId((await get('')).body);
    expect([1, 2, 3].map((id) => p.get(id).stockState)).toEqual(['low', 'ok', 'ok']);
  });

  it('the state is judged on the TOTAL, not on the here row', async () => {
    m.product.findMany.mockResolvedValue([row(1, [[1, 2], [2, 40]])]);
    m.product.count.mockResolvedValue(1);
    const p = (await get('?hereLocationId=1')).body.products[0];
    expect(p).toMatchObject({ totalQuantity: 42, hereQuantity: 2, stockState: 'ok' });
  });
});

describe('F2-1 — the filtered path (stock !== all)', () => {
  // DB order (the mock returns rows in the order the route asked for).
  const CATALOGUE = [
    row(1, [[1, 50]]), // ok
    row(2, [[1, 5]]), // low
    row(3, [[1, 0]]), // out
    row(4, [[1, -2]]), // below-zero
    row(5, []), // no-record
    row(6, [[1, 7]], { approvalStatus: 'PENDING_REVIEW' }), // low, provisional
    row(7, [[1, 3]], { lowStockThreshold: 0 }), // ok (disabled)
    row(8, [[1, 1]]), // low
  ];

  beforeEach(() => {
    m.product.findMany.mockResolvedValue(CATALOGUE);
  });

  const ids = (body: any) => body.products.map((p: any) => p.id);

  it('in-stock keeps totalQuantity > 0', async () => {
    const { body } = await get('?stock=in-stock');
    expect(ids(body)).toEqual([1, 2, 6, 7, 8]);
    expect(body.total).toBe(5);
  });

  it('low keeps state low (a provisional product included; a disabled threshold excluded)', async () => {
    const { body } = await get('?stock=low');
    expect(ids(body)).toEqual([2, 6, 8]);
    expect(body.total).toBe(3);
  });

  it('out keeps out, below-zero and no-record', async () => {
    const { body } = await get('?stock=out');
    expect(ids(body)).toEqual([3, 4, 5]);
    expect(body.total).toBe(3);
  });

  it('reads ALL matches with the same where and orderBy — no take, no skip, no count', async () => {
    await get('?stock=low&search=Wid&sortBy=name&sortOrder=desc&page=2&pageSize=2');
    expect(m.product.findMany).toHaveBeenCalledTimes(1);
    const args = m.product.findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty('take');
    expect(args).not.toHaveProperty('skip');
    expect(args.where).toEqual({
      deletedAt: null,
      OR: [
        { name: { contains: 'Wid' } },
        { baseName: { contains: 'Wid' } },
        { variant: { contains: 'Wid' } },
      ],
    });
    expect(args.orderBy).toEqual([{ name: 'desc' }, { name: 'asc' }]);
    expect(m.product.count).not.toHaveBeenCalled();
  });

  it('total and paging across a page boundary', async () => {
    const p1 = (await get('?stock=in-stock&pageSize=2&page=1')).body;
    const p2 = (await get('?stock=in-stock&pageSize=2&page=2')).body;
    const p3 = (await get('?stock=in-stock&pageSize=2&page=3')).body;
    const p4 = (await get('?stock=in-stock&pageSize=2&page=4')).body;
    expect([ids(p1), ids(p2), ids(p3), ids(p4)]).toEqual([[1, 2], [6, 7], [8], []]);
    for (const b of [p1, p2, p3, p4]) {
      expect(b).toMatchObject({ total: 5, pageSize: 2, totalPages: 3 });
    }
    expect([p1.page, p2.page, p3.page, p4.page]).toEqual([1, 2, 3, 4]);
  });

  it('the filtered rows carry the same fields as the default path', async () => {
    const { body } = await get('?stock=low&hereLocationId=1&locationId=1');
    expect(body.hereLocationId).toBe(1);
    expect(body.products[0]).toMatchObject({
      id: 2,
      currentQuantity: 5,
      totalQuantity: 5,
      hereQuantity: 5,
      stockState: 'low',
    });
  });

  it('a filter with no match: total 0, no rows, totalPages 0', async () => {
    m.product.findMany.mockResolvedValue([row(1, [[1, 50]])]);
    const { body } = await get('?stock=out');
    expect(body).toMatchObject({ products: [], total: 0, totalPages: 0 });
  });
});

describe('F2-1 — the default path (stock absent or all) stays DB-paginated', () => {
  it('take/skip/count as today, with the new fields for that page', async () => {
    m.product.findMany.mockResolvedValue([row(31, [[1, 2]])]);
    m.product.count.mockResolvedValue(31);
    for (const q of ['?page=4&pageSize=10', '?page=4&pageSize=10&stock=all']) {
      m.product.findMany.mockClear();
      m.product.count.mockClear();
      const { body } = await get(q);
      const args = m.product.findMany.mock.calls[0][0];
      expect(args).toMatchObject({ take: 10, skip: 30 });
      expect(m.product.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
      expect(body).toMatchObject({ total: 31, page: 4, pageSize: 10, totalPages: 4, hereLocationId: null });
      expect(body.products[0]).toMatchObject({ id: 31, totalQuantity: 2, hereQuantity: null, stockState: 'low' });
    }
  });

  it('the default sort is unchanged (baseName, numericValue, variant, then name)', async () => {
    await get('');
    expect(m.product.findMany.mock.calls[0][0].orderBy).toEqual([
      { baseName: 'asc' },
      { numericValue: 'asc' },
      { variant: 'asc' },
      { name: 'asc' },
    ]);
  });

  it('SHOW contract: no approvalStatus in either where; a provisional product is listed', async () => {
    m.product.findMany.mockResolvedValue([row(6, [[1, 7]], { approvalStatus: 'PENDING_REVIEW' })]);
    m.product.count.mockResolvedValue(1);
    const { body } = await get('');
    expect(m.product.findMany.mock.calls[0][0].where).not.toHaveProperty('approvalStatus');
    expect(m.product.count.mock.calls[0][0].where).not.toHaveProperty('approvalStatus');
    expect(body.products[0]).toMatchObject({ id: 6, approvalStatus: 'PENDING_REVIEW' });
  });
});

describe('A10 — the bounds; the response echoes the clamped values', () => {
  beforeEach(() => {
    m.product.count.mockResolvedValue(1200);
  });

  it.each([
    ['?pageSize=1000', 500],
    ['?pageSize=501', 500],
    ['?pageSize=500', 500],
    ['?pageSize=0', 1],
    ['?pageSize=-5', 1],
    ['?pageSize=abc', 25],
    ['', 25],
  ])('%s -> pageSize %i', async (q, expected) => {
    const { body } = await get(q);
    expect(m.product.findMany.mock.calls[0][0].take).toBe(expected);
    expect(body.pageSize).toBe(expected);
    expect(body.totalPages).toBe(Math.ceil(1200 / expected));
  });

  it.each([
    ['?page=0', 1],
    ['?page=-3', 1],
    ['?page=abc', 1],
    ['', 1],
    ['?page=3', 3],
  ])('%s -> page %i', async (q, expected) => {
    const { body } = await get(`${q}${q ? '&' : '?'}pageSize=10`);
    expect(m.product.findMany.mock.calls[0][0].skip).toBe((expected - 1) * 10);
    expect(body.page).toBe(expected);
  });

  it('the filtered path is clamped the same way', async () => {
    m.product.findMany.mockResolvedValue(Array.from({ length: 600 }, (_, i) => row(i + 1, [[1, 50]])));
    const { body } = await get('?stock=in-stock&pageSize=1000&page=0');
    expect(body).toMatchObject({ total: 600, page: 1, pageSize: 500, totalPages: 2 });
    expect(body.products).toHaveLength(500);
  });
});
