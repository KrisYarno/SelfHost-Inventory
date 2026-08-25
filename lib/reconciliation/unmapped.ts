/**
 * UNMAPPED AGING (reconciliation lane, spec REV-7 §4.4 / D7; pack C2c.2).
 *
 * External order lines that carry no product mapping, GROUPED by the triple a
 * person actually maps — `(integrationId, externalProductId,
 * externalVariantId)` — with the item count and the age of the OLDEST order
 * that still wants it. The page grain IS the group grain: an item-grain cursor
 * over a grouped page would either re-emit a group or drop one, depending on
 * where the boundary fell.
 *
 * THE KEYSET IS THE WHOLE POINT (CX-8). `externalVariantId` is NULLABLE, and a
 * bare `externalVariantId > :cursor` evaluates UNKNOWN the moment the cursor
 * came from a NULL-variant group — which silently drops that group's siblings
 * and reports a `moreCount` the rows contradict. So the ordering tuple and the
 * keyset ladder are the SAME six NON-NULL expressions, null flags included:
 * `(oldestIsNull, COALESCE(oldest, epoch), integrationId, externalProductId,
 * variantIsNull, COALESCE(externalVariantId, ''))`. Nothing NULL is ever
 * compared, and nothing NULL is ever bound.
 *
 * `olderThanDays` FILTERS THE AGGREGATE, in the outer query, never the rows
 * inside the CTE: a row-level cutoff would silently shrink the item counts of
 * every group whose newest line is recent, and then report the shrunken number
 * as "how many lines are waiting".
 *
 * WHAT IT COSTS, said out loud: the new `(isMapped, orderId)` index serves the
 * driving filter and the join to orders, NOT the grouping — a filesort over the
 * unmapped items (~4.9k on the fresh dump) is expected here, and the measured
 * wall-time belongs to the wave close rather than to this comment.
 *
 * Next-free by contract.
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { AppError } from '@/lib/error-handling';

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/**
 * The age bands, as a TABLE: the SQL sums and the TypeScript bucketing are both
 * rendered from it, so a re-banding cannot move one and leave the other. Each
 * entry is the INCLUSIVE last day of its band; the final band is open-ended.
 */
const AGE_BUCKETS = [
  { key: '0-7', throughDays: 7 },
  { key: '8-30', throughDays: 30 },
  { key: '31-90', throughDays: 90 },
  { key: '90+', throughDays: null },
] as const;

/** The bands, plus the one for a group whose age nobody can compute. */
export type UnmappedBucket = (typeof AGE_BUCKETS)[number]['key'] | 'unknown';

export type UnmappedGroup = {
  integrationId: string;
  integrationName: string;
  platform: string;
  externalProductId: string;
  externalVariantId: string | null;
  sku: string | null;
  name: string;
  itemCount: number;
  oldestOrderCreatedAt: string | null;
  ageDays: number | null;
  ageReason: string | null;
  bucket: UnmappedBucket;
  link: { href: string; warning: 'loads the live store catalog' };
};

export type UnmappedInput = {
  olderThanDays?: number;
  /** At most 200 — the route refuses more. */
  limit: number;
  /** Opaque: base64url of the six-part group tuple plus the consumed count. */
  cursor?: string;
};

export type UnmappedPage = {
  groups: UnmappedGroup[];
  buckets: Record<UnmappedBucket, number>;
  count: number;
  moreCount: number;
  nextCursor: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The age nobody can compute, and why (R-2: never a 0 standing in for it). */
const NO_AGE_REASON = 'the order carries no external creation date';

/** The link's honest warning: following it talks to the live store. */
const CATALOG_WARNING = 'loads the live store catalog' as const;

// ---------------------------------------------------------------------------
// The one grouping (both statements read it)
// ---------------------------------------------------------------------------

/**
 * Grouped ONLY by the three identity columns — every other selected column is
 * aggregated, which is what makes the statement legal under
 * `ONLY_FULL_GROUP_BY`. `external_order_items` carries no `integrationId` and
 * no order date, so the two joins are not decoration: they are where the group
 * key and the age come from.
 */
const GROUPED_CTE = Prisma.sql`WITH grouped AS (
  SELECT
    o.integrationId AS integrationId,
    i.externalProductId AS externalProductId,
    i.externalVariantId AS externalVariantId,
    MIN(g.name) AS integrationName,
    MIN(g.platform) AS platform,
    MIN(i.sku) AS sku,
    MIN(i.name) AS name,
    COUNT(*) AS itemCount,
    MIN(o.externalCreatedAt) AS oldest
  FROM external_order_items i
  JOIN external_orders o ON o.id = i.orderId
  JOIN integrations g ON g.id = o.integrationId
  WHERE i.isMapped = 0
  GROUP BY o.integrationId, i.externalProductId, i.externalVariantId
)`;

/**
 * The SIX ordering expressions, in order. Every one of them is NON-NULL by
 * construction: the two nullable columns ride as a flag plus a COALESCE, and
 * the flag comes FIRST in each pair so the coalesced sentinel can never be
 * confused with a real value.
 */
const KEYSET: ReadonlyArray<Prisma.Sql> = [
  Prisma.sql`(oldest IS NULL)`,
  Prisma.sql`COALESCE(oldest, CAST('1970-01-01 00:00:00' AS DATETIME(3)))`,
  Prisma.sql`integrationId`,
  Prisma.sql`externalProductId`,
  Prisma.sql`(externalVariantId IS NULL)`,
  Prisma.sql`COALESCE(externalVariantId, '')`,
];

type KeysetValues = [number, Date, string, string, number, string];

function orderBySql(): Prisma.Sql {
  return Prisma.join(
    KEYSET.map((expr) => Prisma.sql`${expr} ASC`),
    ', '
  );
}

/**
 * "Strictly after this tuple", as an OR-ladder over the SAME six expressions
 * the ORDER BY uses. Written as a ladder rather than a row constructor because
 * MySQL cannot use an index for `(a,b,c) > (?,?,?)` here anyway, and the ladder
 * is what makes the null-flag pairs legible.
 */
function keysetSql(values: KeysetValues): Prisma.Sql {
  const branches = KEYSET.map((expr, k) => {
    const equalities = KEYSET.slice(0, k).map((prior, j) => Prisma.sql`${prior} = ${values[j]}`);
    return Prisma.sql`(${Prisma.join([...equalities, Prisma.sql`${expr} > ${values[k]}`], ' AND ')})`;
  });
  return Prisma.sql`(${Prisma.join(branches, ' OR ')})`;
}

/** `FLOOR((now - oldest) / one day)` — the same arithmetic the row view does. */
function ageDaysSql(now: Date): Prisma.Sql {
  return Prisma.sql`FLOOR(TIMESTAMPDIFF(SECOND, oldest, ${now}) / 86400)`;
}

/** One SUM per band, rendered from the band table (never a second spelling). */
function bucketSumsSql(now: Date): Prisma.Sql {
  const sums = AGE_BUCKETS.map((bucket, i) => {
    const previous = i === 0 ? null : AGE_BUCKETS[i - 1].throughDays;
    const lower =
      previous === null ? Prisma.empty : Prisma.sql` AND ${ageDaysSql(now)} > ${previous}`;
    const upper =
      bucket.throughDays === null
        ? Prisma.empty
        : Prisma.sql` AND ${ageDaysSql(now)} <= ${bucket.throughDays}`;
    return Prisma.sql`SUM(CASE WHEN oldest IS NOT NULL${lower}${upper} THEN 1 ELSE 0 END) AS ${Prisma.raw(
      `bucket${i}`
    )}`;
  });
  return Prisma.join(sums, ', ');
}

/** The outer filters, or nothing at all. */
function whereSql(parts: Prisma.Sql[]): Prisma.Sql {
  return parts.length === 0 ? Prisma.empty : Prisma.sql`
WHERE ${Prisma.join(parts, ' AND ')}`;
}

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

type Cursor = {
  /** 1 when the group's oldest order carries no date. */
  n: number;
  /** The coalesced ordering instant, ISO. */
  o: string;
  g: string;
  p: string;
  /** 1 when the group has no variant. */
  v: number;
  x: string;
  /** Groups consumed through the page that issued this cursor. */
  c: number;
};

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('invalid cursor', 'VALIDATION_ERROR', 400);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Cursor).n !== 'number' ||
    typeof (parsed as Cursor).o !== 'string' ||
    Number.isNaN(new Date((parsed as Cursor).o).getTime()) ||
    typeof (parsed as Cursor).g !== 'string' ||
    typeof (parsed as Cursor).p !== 'string' ||
    typeof (parsed as Cursor).v !== 'number' ||
    typeof (parsed as Cursor).x !== 'string' ||
    typeof (parsed as Cursor).c !== 'number' ||
    !Number.isFinite((parsed as Cursor).c) ||
    (parsed as Cursor).c < 0
  ) {
    throw new AppError('invalid cursor', 'VALIDATION_ERROR', 400);
  }
  return parsed as Cursor;
}

const EPOCH_KEY = new Date('1970-01-01T00:00:00.000Z');

function cursorValues(cursor: Cursor): KeysetValues {
  return [cursor.n, new Date(cursor.o), cursor.g, cursor.p, cursor.v, cursor.x];
}

function cursorOf(row: GroupSqlRow, consumed: number): Cursor {
  return {
    n: row.oldest === null ? 1 : 0,
    o: (row.oldest ?? EPOCH_KEY).toISOString(),
    g: row.integrationId,
    p: row.externalProductId,
    v: row.externalVariantId === null ? 1 : 0,
    x: row.externalVariantId ?? '',
    c: consumed,
  };
}

// ---------------------------------------------------------------------------
// THE READ
// ---------------------------------------------------------------------------

type GroupSqlRow = {
  integrationId: string;
  externalProductId: string;
  externalVariantId: string | null;
  integrationName: string | null;
  platform: string | null;
  sku: string | null;
  name: string | null;
  itemCount: unknown;
  oldest: Date | null;
};

type TotalsSqlRow = {
  total: unknown;
  unknownGroups: unknown;
  bucket0: unknown;
  bucket1: unknown;
  bucket2: unknown;
  bucket3: unknown;
};

/** MySQL hands COUNT/SUM back as BigInt or DECIMAL. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  if (value === null || value === undefined) return 0;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

export async function listUnmapped(input: UnmappedInput): Promise<UnmappedPage> {
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const now = new Date();

  // The age cut sits on the GROUPED aggregate, so a group is in or out as a
  // whole. A group whose oldest order carries no date has no computable age and
  // is therefore not something this filter can assert anything about.
  const olderThan =
    input.olderThanDays === undefined
      ? []
      : [Prisma.sql`oldest <= ${new Date(now.getTime() - input.olderThanDays * DAY_MS)}`];

  const pageRows = await prisma.$queryRaw<GroupSqlRow[]>(Prisma.sql`${GROUPED_CTE}
SELECT integrationId, externalProductId, externalVariantId, integrationName, platform, sku, name, itemCount, oldest
FROM grouped${whereSql([
    ...olderThan,
    ...(cursor === null ? [] : [keysetSql(cursorValues(cursor))]),
  ])}
ORDER BY ${orderBySql()}
LIMIT ${input.limit + 1}`);

  const totalsRows = await prisma.$queryRaw<TotalsSqlRow[]>(Prisma.sql`${GROUPED_CTE}
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN oldest IS NULL THEN 1 ELSE 0 END) AS unknownGroups,
  ${bucketSumsSql(now)}
FROM grouped${whereSql(olderThan)}`);

  // One row over `limit` is what says there IS another page; `count` is what
  // says how many. They come from two statements and are therefore not one
  // snapshot — the cursor follows the page, the bound follows the count.
  const hasMore = pageRows.length > input.limit;
  const rows = hasMore ? pageRows.slice(0, input.limit) : pageRows;

  const totals = totalsRows[0];
  const count = toNumber(totals?.total);
  const consumed = cursor?.c ?? 0;
  const last = rows[rows.length - 1];

  return {
    groups: rows.map((row) => buildGroup(row, now)),
    buckets: {
      '0-7': toNumber(totals?.bucket0),
      '8-30': toNumber(totals?.bucket1),
      '31-90': toNumber(totals?.bucket2),
      '90+': toNumber(totals?.bucket3),
      unknown: toNumber(totals?.unknownGroups),
    },
    count,
    moreCount: Math.max(count - consumed - rows.length, 0),
    nextCursor:
      hasMore && last !== undefined ? encodeCursor(cursorOf(last, consumed + rows.length)) : null,
  };
}

// ---------------------------------------------------------------------------
// Row -> view
// ---------------------------------------------------------------------------

function bucketOf(ageDays: number): UnmappedBucket {
  for (const bucket of AGE_BUCKETS) {
    if (bucket.throughDays === null || ageDays <= bucket.throughDays) return bucket.key;
  }
  // Unreachable: the last band is open-ended. Kept so the table stays the only
  // place the bands are decided.
  return AGE_BUCKETS[AGE_BUCKETS.length - 1].key;
}

function buildGroup(row: GroupSqlRow, now: Date): UnmappedGroup {
  const ageDays =
    row.oldest === null ? null : Math.floor((now.getTime() - row.oldest.getTime()) / DAY_MS);

  return {
    integrationId: row.integrationId,
    // The joins are inner and both columns are NOT NULL, so these fallbacks are
    // defensive only — never a placeholder for a value we simply did not read.
    integrationName: row.integrationName ?? 'unknown integration',
    platform: row.platform ?? 'unknown',
    externalProductId: row.externalProductId,
    externalVariantId: row.externalVariantId,
    sku: row.sku,
    name: row.name ?? 'unnamed line',
    itemCount: toNumber(row.itemCount),
    oldestOrderCreatedAt: row.oldest === null ? null : row.oldest.toISOString(),
    ageDays,
    ageReason: ageDays === null ? NO_AGE_REASON : null,
    bucket: ageDays === null ? 'unknown' : bucketOf(ageDays),
    link: {
      href: `/admin/product-mappings/${row.integrationId}/map?externalProductId=${row.externalProductId}&externalVariantId=${row.externalVariantId ?? ''}&sku=${row.sku ?? ''}`,
      warning: CATALOG_WARNING,
    },
  };
}
