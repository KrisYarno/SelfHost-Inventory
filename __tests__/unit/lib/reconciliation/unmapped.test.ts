/**
 * @jest-environment node
 *
 * UNMAPPED AGING (reconciliation lane, pack C2c.2; spec REV-7 §4.4 / D7).
 *
 * External order lines nobody has mapped to a product yet, GROUPED by
 * `(integrationId, externalProductId, externalVariantId)` — because that triple
 * is what a person maps, and a list at ITEM grain would ask them to map the
 * same thing forty times.
 *
 * TWO KINDS OF PIN, and the difference is stated rather than blurred:
 *
 *   TEXT PINS. The grouping, the group-level `olderThanDays`, the six-part
 *   ORDER BY and the keyset ladder live in SQL, and a mocked Prisma cannot
 *   execute them. They are pinned AS TEXT — including the negative pin that no
 *   comparison is made against the NULLABLE variant column directly, which is
 *   the exact CX-8 failure: `externalVariantId > NULL` evaluates UNKNOWN and
 *   silently drops rows.
 *
 *   BEHAVIOURAL PINS. The `$queryRaw` mock reads the SIX bound tuple values off
 *   the statement and serves a fixture through a comparator that mirrors what
 *   the ladder claims. That proves the producer minted and bound the right
 *   tuple — both null flags included — and that paging over the fixture emits
 *   every group exactly once. The comparator's SEMANTICS are the test's; real
 *   MySQL parity for this statement is the wave-close drive.
 */

import { Prisma } from '@prisma/client';
import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { listUnmapped, type UnmappedGroup } from '@/lib/reconciliation/unmapped';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** A grouped row exactly as the CTE hands it back. */
type GroupRow = {
  integrationId: string;
  externalProductId: string;
  externalVariantId: string | null;
  integrationName: string;
  platform: string;
  sku: string | null;
  name: string;
  itemCount: number;
  oldest: Date | null;
};

function group(over: Partial<GroupRow> = {}): GroupRow {
  return {
    integrationId: 'int-1',
    externalProductId: 'P1',
    externalVariantId: 'V1',
    integrationName: 'Acme Store',
    platform: 'WOOCOMMERCE',
    sku: 'SKU-1',
    name: 'Widget',
    itemCount: 3,
    oldest: new Date('2026-08-18T00:00:00.000Z'),
    ...over,
  };
}

/**
 * The fixture, ALREADY in the order the six-part tuple claims: non-null oldest
 * first (oldest first), then integration, then product, then NON-null variants
 * before the null one, then variant. The null-variant group sits where a page
 * boundary will land on it.
 */
const FIXTURE: GroupRow[] = [
  group({ externalProductId: 'P0', externalVariantId: 'V0', oldest: new Date('2026-05-01T00:00:00.000Z') }),
  group({ externalProductId: 'P2', externalVariantId: 'V9', oldest: new Date('2026-08-01T00:00:00.000Z') }),
  group({ externalProductId: 'P2', externalVariantId: null, oldest: new Date('2026-08-01T00:00:00.000Z') }),
  group({ externalProductId: 'P3', externalVariantId: 'V3', oldest: new Date('2026-08-19T00:00:00.000Z') }),
  group({ integrationId: 'int-2', externalProductId: 'P4', externalVariantId: null, oldest: null, sku: null }),
];

type Tuple = [number, number, string, string, number, string];

function tupleOf(row: GroupRow): Tuple {
  return [
    row.oldest === null ? 1 : 0,
    row.oldest === null ? 0 : row.oldest.getTime(),
    row.integrationId,
    row.externalProductId,
    row.externalVariantId === null ? 1 : 0,
    row.externalVariantId ?? '',
  ];
}

function after(row: GroupRow, cursor: Tuple): boolean {
  const t = tupleOf(row);
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] !== cursor[i]) return t[i] > cursor[i];
  }
  return false;
}

/**
 * The last SEVEN bound values of the page statement are the keyset ladder's
 * final branch (the whole tuple) followed by the row bound — which is itself
 * the pin that the ladder ends with a six-part comparison.
 */
function boundTuple(query: Prisma.Sql): Tuple | null {
  const values = query.values as unknown[];
  if (values.length < 7) return null;
  const tail = values.slice(values.length - 7, values.length - 1);
  return [
    Number(tail[0]),
    tail[1] instanceof Date ? (tail[1] as Date).getTime() : Number(tail[1]),
    String(tail[2]),
    String(tail[3]),
    Number(tail[4]),
    String(tail[5]),
  ];
}

function boundLimit(query: Prisma.Sql): number {
  const values = query.values as unknown[];
  return Number(values[values.length - 1]);
}

const AGE_BUCKET_KEYS: UnmappedGroup['bucket'][] = ['0-7', '8-30', '31-90', '90+'];

/** Serve the fixture: the page statement pages it, the other one counts it. */
function serve(rows: GroupRow[] = FIXTURE) {
  (db.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes('AS total')) {
      const buckets = [0, 0, 0, 0];
      let unknown = 0;
      for (const row of rows) {
        if (row.oldest === null) {
          unknown += 1;
          continue;
        }
        const age = Math.floor((NOW.getTime() - row.oldest.getTime()) / DAY);
        buckets[age <= 7 ? 0 : age <= 30 ? 1 : age <= 90 ? 2 : 3] += 1;
      }
      return [
        {
          total: rows.length,
          unknownGroups: unknown,
          bucket0: buckets[0],
          bucket1: buckets[1],
          bucket2: buckets[2],
          bucket3: buckets[3],
        },
      ];
    }
    const cursor = boundTuple(query);
    const page = (cursor === null ? rows : rows.filter((row) => after(row, cursor))).slice(
      0,
      boundLimit(query),
    );
    return page;
  });
}

beforeEach(() => {
  mockReset(db);
  jest.useFakeTimers().setSystemTime(NOW);
  serve();
});

afterEach(() => {
  jest.useRealTimers();
});

async function pageSql(): Promise<string> {
  await listUnmapped({ limit: 50 });
  const calls = (db.$queryRaw as unknown as jest.Mock).mock.calls;
  const page = calls.map((c) => c[0] as Prisma.Sql).find((q) => !q.sql.includes('AS total'));
  return (page as Prisma.Sql).sql;
}

// ---------------------------------------------------------------------------
// TEXT PINS — what a mocked Prisma cannot execute
// ---------------------------------------------------------------------------

describe('the grouped CTE (TEXT pins)', () => {
  it('drives from the unmapped items and joins for what the item table lacks', async () => {
    const sql = await pageSql();
    expect(sql).toContain('FROM external_order_items i');
    expect(sql).toContain('JOIN external_orders o ON o.id = i.orderId');
    expect(sql).toContain('JOIN integrations g ON g.id = o.integrationId');
    expect(sql).toContain('WHERE i.isMapped = 0');
  });

  it('groups by the THREE identity columns only — ONLY_FULL_GROUP_BY-legal', async () => {
    const sql = await pageSql();
    expect(sql).toContain(
      'GROUP BY o.integrationId, i.externalProductId, i.externalVariantId',
    );
    // Everything else selected is aggregated, or MySQL would refuse the statement.
    for (const aggregated of [
      'MIN(g.name) AS integrationName',
      'MIN(g.platform) AS platform',
      'MIN(i.sku) AS sku',
      'MIN(i.name) AS name',
      'COUNT(*) AS itemCount',
      'MIN(o.externalCreatedAt) AS oldest',
    ]) {
      expect(sql).toContain(aggregated);
    }
  });

  it('orders by the SIX-part tuple, both null flags first in their pair', async () => {
    const sql = await pageSql();
    expect(sql).toContain(
      "ORDER BY (oldest IS NULL) ASC, COALESCE(oldest, CAST('1970-01-01 00:00:00' AS DATETIME(3))) ASC, " +
        "integrationId ASC, externalProductId ASC, (externalVariantId IS NULL) ASC, COALESCE(externalVariantId, '') ASC",
    );
  });

  it('NEVER compares the nullable columns directly (the CX-8 trap)', async () => {
    // Driven WITH a cursor on purpose: the keyset ladder is the only place a
    // comparison exists at all, so checking a first page would pass vacuously.
    const first = await listUnmapped({ limit: 3 });
    await listUnmapped({ limit: 3, cursor: first.nextCursor as string });
    const sql = ((db.$queryRaw as unknown as jest.Mock).mock.calls
      .map((c) => c[0] as Prisma.Sql)
      .filter((q) => !q.sql.includes('AS total'))
      .pop() as Prisma.Sql).sql;
    expect(sql).toContain(' > ?');
    // A bare `externalVariantId > ?` past a NULL-variant group evaluates UNKNOWN
    // and drops its siblings without a word. Every comparison goes through the
    // COALESCE + flag pair instead.
    expect(sql).not.toMatch(/[^(]externalVariantId\s*[<>=]/);
    expect(sql).not.toMatch(/[^(,]oldest\s*[<>]\s*\?/);
  });

  it('pages the GROUPS: the row bound is limit + 1, applied to the grouped select', async () => {
    await listUnmapped({ limit: 3 });
    const page = (db.$queryRaw as unknown as jest.Mock).mock.calls
      .map((c) => c[0] as Prisma.Sql)
      .find((q) => !q.sql.includes('AS total')) as Prisma.Sql;
    expect(page.sql).toContain('FROM grouped');
    expect(page.sql.trimEnd().endsWith('LIMIT ?')).toBe(true);
    expect(boundLimit(page)).toBe(4);
  });

  it('olderThanDays filters the GROUPED aggregate in the outer query, never a row', async () => {
    await listUnmapped({ limit: 10, olderThanDays: 30 });
    const calls = (db.$queryRaw as unknown as jest.Mock).mock.calls.map((c) => c[0] as Prisma.Sql);
    for (const query of calls) {
      // The CTE's own WHERE stays the driving filter alone...
      expect(query.sql).toContain('WHERE i.isMapped = 0\n  GROUP BY');
      // ...and the age cut sits on the aggregate, outside the CTE.
      expect(query.sql).toContain('oldest <= ?');
      expect(query.values).toContainEqual(new Date(NOW.getTime() - 30 * DAY));
    }
  });

  it('counts and buckets are GLOBAL within the window — one statement, no paging', async () => {
    await listUnmapped({ limit: 1 });
    const totals = (db.$queryRaw as unknown as jest.Mock).mock.calls
      .map((c) => c[0] as Prisma.Sql)
      .find((q) => q.sql.includes('AS total')) as Prisma.Sql;
    expect(totals.sql).toContain('COUNT(*) AS total');
    expect(totals.sql).not.toContain('LIMIT');
  });

  it('is exactly TWO statements: the page and the totals', async () => {
    await listUnmapped({ limit: 10 });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The group view
// ---------------------------------------------------------------------------

describe('the group view', () => {
  it('carries the identity, the count, the age and the honest deep link', async () => {
    const { groups } = await listUnmapped({ limit: 50 });
    expect(groups[0]).toEqual({
      integrationId: 'int-1',
      integrationName: 'Acme Store',
      platform: 'WOOCOMMERCE',
      externalProductId: 'P0',
      externalVariantId: 'V0',
      sku: 'SKU-1',
      name: 'Widget',
      itemCount: 3,
      oldestOrderCreatedAt: '2026-05-01T00:00:00.000Z',
      ageDays: 111,
      ageReason: null,
      bucket: '90+',
      link: {
        href: '/admin/product-mappings/int-1/map?externalProductId=P0&externalVariantId=V0&sku=SKU-1',
        warning: 'loads the live store catalog',
      },
    });
  });

  it('an order with no external creation date has an UNKNOWN age, with the reason', async () => {
    const { groups } = await listUnmapped({ limit: 50 });
    const unknown = groups[groups.length - 1];
    expect(unknown.oldestOrderCreatedAt).toBeNull();
    expect(unknown.ageDays).toBeNull();
    expect(unknown.ageReason).toBe('the order carries no external creation date');
    expect(unknown.bucket).toBe('unknown');
  });

  it('the deep link carries the empty string for a missing variant or sku', async () => {
    const { groups } = await listUnmapped({ limit: 50 });
    const unknown = groups[groups.length - 1];
    expect(unknown.link.href).toBe(
      '/admin/product-mappings/int-2/map?externalProductId=P4&externalVariantId=&sku=',
    );
  });

  // M2c dev-10, carried into M4b: these three values are STORE-SUPPLIED text.
  // A `&` in a SKU ends the query parameter early and the map page reads a
  // truncated sku; a `#` throws away everything after it. Interpolating them
  // raw made the deep link a function of what somebody typed into WooCommerce.
  it('ENCODES the three deep-link values — a & or a # in a sku cannot break the query string', async () => {
    serve([
      group({
        integrationId: 'int-3',
        externalProductId: 'P&5',
        externalVariantId: 'V#7 x',
        sku: 'A&B#C D/E?F=G',
      }),
    ]);
    const { groups } = await listUnmapped({ limit: 50 });

    expect(groups[0].link.href).toBe(
      '/admin/product-mappings/int-3/map?externalProductId=P%265&externalVariantId=V%237%20x&sku=A%26B%23C%20D%2FE%3FF%3DG',
    );
    // The identity fields themselves are untouched — encoding is the LINK's
    // business, and the tab still renders the sku a person would recognise.
    expect(groups[0].sku).toBe('A&B#C D/E?F=G');
    expect(groups[0].externalVariantId).toBe('V#7 x');

    // Round-tripping is the actual claim: what the map page parses back out of
    // the query string is what the producer put in.
    const query = new URLSearchParams(groups[0].link.href.split('?')[1]);
    expect(query.get('externalProductId')).toBe('P&5');
    expect(query.get('externalVariantId')).toBe('V#7 x');
    expect(query.get('sku')).toBe('A&B#C D/E?F=G');
  });

  it('buckets the ages at 7 / 30 / 90 days', async () => {
    // Oldest first, the order the statement returns them in.
    serve([
      group({ externalProductId: 'F', oldest: new Date(NOW.getTime() - 91 * DAY) }),
      group({ externalProductId: 'E', oldest: new Date(NOW.getTime() - 90 * DAY) }),
      group({ externalProductId: 'D', oldest: new Date(NOW.getTime() - 31 * DAY) }),
      group({ externalProductId: 'C', oldest: new Date(NOW.getTime() - 30 * DAY) }),
      group({ externalProductId: 'B', oldest: new Date(NOW.getTime() - 8 * DAY) }),
      group({ externalProductId: 'A', oldest: new Date(NOW.getTime() - 7 * DAY) }),
    ]);
    const { groups } = await listUnmapped({ limit: 50 });
    expect(groups.map((g) => g.bucket)).toEqual(['90+', '31-90', '31-90', '8-30', '8-30', '0-7']);
  });
});

// ---------------------------------------------------------------------------
// Buckets and bounds
// ---------------------------------------------------------------------------

describe('buckets and bounds', () => {
  it('the buckets sum to the count', async () => {
    const { buckets, count } = await listUnmapped({ limit: 2 });
    expect(count).toBe(FIXTURE.length);
    expect(
      AGE_BUCKET_KEYS.reduce((sum, key) => sum + buckets[key], 0) + buckets.unknown,
    ).toBe(count);
  });

  it('unknown age is its OWN bucket and never merges into 90+', async () => {
    const { buckets } = await listUnmapped({ limit: 50 });
    expect(buckets.unknown).toBe(1);
    expect(buckets['90+']).toBe(1);
    expect(Object.keys(buckets).sort()).toEqual(['0-7', '31-90', '8-30', '90+', 'unknown']);
  });

  it('moreCount is count minus consumed minus returned, on every page', async () => {
    const first = await listUnmapped({ limit: 2 });
    expect(first.count).toBe(5);
    expect(first.moreCount).toBe(3);
    const second = await listUnmapped({ limit: 2, cursor: first.nextCursor as string });
    expect(second.moreCount).toBe(1);
    const third = await listUnmapped({ limit: 2, cursor: second.nextCursor as string });
    expect(third.moreCount).toBe(0);
    expect(third.nextCursor).toBeNull();
  });

  it('a cursor this producer did not mint is a 400', async () => {
    await expect(listUnmapped({ limit: 10, cursor: 'nope' })).rejects.toThrow('invalid cursor');
  });
});

// ---------------------------------------------------------------------------
// The group-level keyset (CX-8)
// ---------------------------------------------------------------------------

describe('the GROUP-level keyset', () => {
  it('mints a cursor from the GROUP identity, both null flags included', async () => {
    // Page 1 ends ON the null-variant group: the tuple it binds next must carry
    // `variantIsNull = 1` and the COALESCEd empty string, never a NULL.
    const first = await listUnmapped({ limit: 3 });
    expect(first.groups.map((g) => g.externalVariantId)).toEqual(['V0', 'V9', null]);

    await listUnmapped({ limit: 3, cursor: first.nextCursor as string });
    const page = (db.$queryRaw as unknown as jest.Mock).mock.calls
      .map((c) => c[0] as Prisma.Sql)
      .filter((q) => !q.sql.includes('AS total'))
      .pop() as Prisma.Sql;
    expect(boundTuple(page)).toEqual([
      0,
      new Date('2026-08-01T00:00:00.000Z').getTime(),
      'int-1',
      'P2',
      1,
      '',
    ]);
  });

  it("a NULL-variant group at the boundary does not swallow the rest of the list", async () => {
    const first = await listUnmapped({ limit: 3 });
    const second = await listUnmapped({ limit: 3, cursor: first.nextCursor as string });
    expect(second.groups.map((g) => g.externalProductId)).toEqual(['P3', 'P4']);
  });

  it('every group is emitted EXACTLY once across pages, in tuple order', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Awaited<ReturnType<typeof listUnmapped>> = await listUnmapped({
        limit: 2,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...result.groups.map((g) => `${g.integrationId}/${g.externalProductId}/${g.externalVariantId ?? '-'}`));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual([
      'int-1/P0/V0',
      'int-1/P2/V9',
      'int-1/P2/-',
      'int-1/P3/V3',
      'int-2/P4/-',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a page that exhausts the list mints no cursor', async () => {
    const page = await listUnmapped({ limit: 50 });
    expect(page.groups).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });
});
