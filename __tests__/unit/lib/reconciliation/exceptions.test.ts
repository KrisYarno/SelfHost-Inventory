/**
 * @jest-environment node
 *
 * THE EXCEPTIONS FINDER (reconciliation lane, pack C2c.1; spec REV-7 §2.5 /
 * §4.3 / D5 / D7).
 *
 * The finder is a READ over `inventory_exceptions` with a CLOSED per-kind
 * renderer table in front of it: every row leaves here as a sentence, a money
 * decision and a link decision, so the tab renders strings and never re-derives
 * anything. These pins cover (a) the seven renderers verbatim, (b) the
 * defensive rendering for a subject nobody can read, (c) the two D5 special
 * cases (a null shipment id, a removed line), and (d) the query itself —
 * severity is translated to a `kind IN (…)` predicate BEFORE the count, never
 * filtered afterwards, because a post-filtered count is a lie.
 *
 * The producer runs against a mocked Prisma, so what a `where` object contains
 * is provable here; that MySQL uses the `(kind, resolvedAt)` index for it is
 * not, and belongs to the wave-close drive.
 */

import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import {
  EXCEPTION_KINDS,
  EXCEPTION_SEVERITY,
  LABELING_LOSS_SEVERITY,
  type ExceptionKind,
} from '@/lib/exceptions/kinds';
import {
  countOpenExceptions,
  listExceptions,
  type ExceptionRowView,
  type ExceptionsInput,
} from '@/lib/reconciliation/exceptions';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** One stored row, as the delegate hands it back. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    key: 'recv-discrepancy:501',
    kind: 'recv-discrepancy',
    subject: { stagingItemId: 501, shipmentId: 'ship-1', countedQty: 8, expectedQty: 10, shortUnits: 2 },
    firstSeenAt: new Date('2026-08-10T00:00:00.000Z'),
    lastSeenAt: new Date('2026-08-18T00:00:00.000Z'),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    note: null,
    ...over,
  };
}

const INPUT: ExceptionsInput = { limit: 50 };

function seed(rows: ReturnType<typeof row>[], count = rows.length) {
  (db.inventoryException.count as unknown as jest.Mock).mockResolvedValue(count);
  (db.inventoryException.findMany as unknown as jest.Mock).mockResolvedValue(rows);
}

/** The page read is ONE array transaction; the mock resolves it as one. */
beforeEach(() => {
  mockReset(db);
  jest.useFakeTimers().setSystemTime(NOW);
  (db.$transaction as unknown as jest.Mock).mockImplementation((arg: unknown) =>
    Promise.all(arg as Promise<unknown>[]),
  );
  (db.stagingItem.findMany as unknown as jest.Mock).mockResolvedValue([]);
  (db.user.findMany as unknown as jest.Mock).mockResolvedValue([]);
  seed([row()]);
});

afterEach(() => {
  jest.useRealTimers();
});

async function firstRow(over: Record<string, unknown>): Promise<ExceptionRowView> {
  seed([row(over)]);
  const page = await listExceptions(INPUT);
  return page.rows[0];
}

// ---------------------------------------------------------------------------
// The severity map (pack C2c.1; spec §2.5)
// ---------------------------------------------------------------------------

describe('EXCEPTION_SEVERITY — the closed severity map', () => {
  it('carries every kind in the closed vocabulary and nothing else', () => {
    expect(Object.keys(EXCEPTION_SEVERITY).sort()).toEqual([...EXCEPTION_KINDS].sort());
  });

  it('is spec §2.5 verbatim', () => {
    expect(EXCEPTION_SEVERITY).toEqual({
      'recv-discrepancy': 'medium',
      'labeling-loss': 'medium',
      'cost-differs': 'low',
      'pending-with-stock': 'high',
      'unattributed-outstock': 'low',
      'unmapped-lines': 'medium',
      'gap-order': 'high',
    });
  });

  it("labeling-loss's severity IS the overhaul's constant, not a second opinion", () => {
    // The overhaul froze this one value at its own checkpoint; this lane fills
    // in the other six. Two literals would let them drift apart silently.
    expect(EXCEPTION_SEVERITY['labeling-loss']).toBe(LABELING_LOSS_SEVERITY);
  });
});

// ---------------------------------------------------------------------------
// The renderer table (pack C2c.1)
// ---------------------------------------------------------------------------

describe('the per-kind renderer table — all seven kinds', () => {
  it('recv-discrepancy: counted vs expected, the shortage money, the order line', async () => {
    const view = await firstRow({
      subject: {
        stagingItemId: 501,
        shipmentId: 'ship-1',
        countedQty: 8,
        expectedQty: 10,
        shortUnits: 2,
        lossCents: 1250,
      },
    });
    expect(view.subjectSummary).toBe('8 counted vs 10 expected — 2 short');
    expect(view.money).toEqual({ cents: 1250, label: 'supplier shortage' });
    expect(view.link).toEqual({ href: '/receiving/ship-1?line=501', label: 'Open the order line' });
    expect(view.severity).toBe('medium');
  });

  it('recv-discrepancy: an unexpected arrival has NO order to compare against', async () => {
    const view = await firstRow({
      subject: {
        stagingItemId: 502,
        shipmentId: 'ship-1',
        countedQty: 4,
        expectedQty: null,
        overUnits: 4,
        surplusValueCents: 900,
      },
    });
    expect(view.subjectSummary).toBe('4 counted vs no order expected — 4 over');
    expect(view.money).toEqual({ cents: 900, label: 'surplus value' });
  });

  it('recv-discrepancy: no money on the subject is NOT 0 — it is unpriced', async () => {
    const view = await firstRow({
      subject: { stagingItemId: 503, shipmentId: 'ship-1', countedQty: 8, expectedQty: 10 },
    });
    expect(view.subjectSummary).toBe('8 counted vs 10 expected');
    expect(view.money).toEqual({ cents: null, reason: 'Not priced' });
  });

  it('labeling-loss: the units, the reason, and the money the bench lost', async () => {
    const view = await firstRow({
      kind: 'labeling-loss',
      key: 'labeling-loss:601',
      subject: { stagingItemId: 601, shipmentId: 'ship-2', units: 3, reason: 'mislabelled', lossCents: 450 },
    });
    expect(view.subjectSummary).toBe('3 unit(s) lost at labeling — mislabelled');
    expect(view.money).toEqual({ cents: 450, label: 'labeling loss' });
    expect(view.link).toEqual({ href: '/receiving/ship-2?line=601', label: 'Open the order line' });
    expect(view.severity).toBe('medium');
  });

  it('labeling-loss: a null lossCents is unpriced, never a $0.00 write-off', async () => {
    const view = await firstRow({
      kind: 'labeling-loss',
      subject: { stagingItemId: 601, shipmentId: 'ship-2', units: 3, reason: 'damaged', lossCents: null },
    });
    expect(view.money).toEqual({ cents: null, reason: 'Not priced' });
  });

  it('pending-with-stock: units against a pending product, no money, product review', async () => {
    const view = await firstRow({
      kind: 'pending-with-stock',
      key: 'pending-with-stock:77',
      subject: { productId: 77, stagingItemId: 610, units: 12 },
    });
    expect(view.subjectSummary).toBe('12 unit(s) stocked against a pending product');
    expect(view.money).toEqual({ cents: null, reason: 'no money on this kind' });
    expect(view.link).toEqual({ href: '/admin/product-review', label: 'Open product review' });
    expect(view.severity).toBe('high');
  });

  it('cost-differs: receipt vs standing, formatted as money, read-only in Part 1', async () => {
    const view = await firstRow({
      kind: 'cost-differs',
      key: 'cost-differs:620',
      subject: { productId: 77, stagingItemId: 620, currentCents: 1999, receiptCents: 2450 },
    });
    expect(view.subjectSummary).toBe('receipt $24.50 vs standing $19.99');
    expect(view.money).toEqual({
      cents: null,
      reason: "settled by the admin's cost decision — resolution semantics registered",
    });
    expect(view.link).toEqual({ href: null, copy: 'read-only in Part 1' });
    expect(view.severity).toBe('low');
  });

  it('cost-differs: a product with no standing cost says unset, never $0.00', async () => {
    const view = await firstRow({
      kind: 'cost-differs',
      subject: { productId: 77, stagingItemId: 620, currentCents: null, receiptCents: 2450 },
    });
    expect(view.subjectSummary).toBe('receipt $24.50 vs standing unset');
  });

  it.each(['unattributed-outstock', 'unmapped-lines', 'gap-order'] as ExceptionKind[])(
    '%s has no writer yet and says so, with the raw subject keys',
    async (kind) => {
      const view = await firstRow({ kind, key: `${kind}:1`, subject: { batchId: 'b1', units: 4 } });
      expect(view.subjectSummary).toBe(
        `(${kind}) — no summary renderer yet; raw subject keys: batchId, units`,
      );
      expect(view.money).toEqual({ cents: null, reason: 'no money renderer for this kind yet' });
      expect(view.link).toEqual({ href: null, copy: 'no destination yet (Part 2)' });
      expect(view.severity).toBe(EXCEPTION_SEVERITY[kind]);
    },
  );

  it('the table is CLOSED: every kind in the vocabulary renders', async () => {
    seed(EXCEPTION_KINDS.map((kind, i) => row({ id: i + 1, kind, key: `${kind}:${i}`, subject: {} })));
    const page = await listExceptions(INPUT);
    expect(page.rows).toHaveLength(EXCEPTION_KINDS.length);
    for (const view of page.rows) {
      expect(typeof view.subjectSummary).toBe('string');
      expect(view.subjectSummary.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The defensive rendering (OCk-9)
// ---------------------------------------------------------------------------

describe('a subject nobody can read never throws', () => {
  it('null subject: says the subject is not an object', async () => {
    const view = await firstRow({ subject: null });
    expect(view.subjectSummary).toBe(
      '(recv-discrepancy) — no summary renderer yet; subject is not an object',
    );
  });

  it("a string subject is not an object either (typeof 'str' is not the test)", async () => {
    const view = await firstRow({ subject: 'str' });
    expect(view.subjectSummary).toBe(
      '(recv-discrepancy) — no summary renderer yet; subject is not an object',
    );
  });

  it('an EMPTY object names no keys rather than rendering an empty list', async () => {
    const view = await firstRow({ subject: {} });
    expect(view.subjectSummary).toBe(
      '(recv-discrepancy) — no summary renderer yet; raw subject keys: none',
    );
  });

  it('an ARRAY subject is not an object (Object.keys would have said 0, 1, 2)', async () => {
    const view = await firstRow({ subject: [1, 2] });
    expect(view.subjectSummary).toBe(
      '(recv-discrepancy) — no summary renderer yet; subject is not an object',
    );
  });

  it('a kind outside the closed vocabulary renders defensively at the lowest severity', async () => {
    // Only a hand-written row can produce this (one writer, closed type), and a
    // fabricated `high` would page somebody about a row no code writes.
    const view = await firstRow({ kind: 'not-a-kind', subject: { a: 1 } });
    expect(view.subjectSummary).toBe('(not-a-kind) — no summary renderer yet; raw subject keys: a');
    expect(view.severity).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// The two D5 special cases
// ---------------------------------------------------------------------------

describe('the D5 link rules', () => {
  it('a subject with no shipment id has nothing to open, and says why', async () => {
    const view = await firstRow({
      subject: { stagingItemId: 504, shipmentId: null, countedQty: 1, expectedQty: 1 },
    });
    expect(view.link).toEqual({
      href: null,
      copy: "no order to open (the line's order id was not recorded)",
    });
  });

  it('a DISCARDED line renders "removed line" — the row outlived the line it names', async () => {
    (db.stagingItem.findMany as unknown as jest.Mock).mockResolvedValue([{ id: 505 }]);
    const view = await firstRow({
      subject: { stagingItemId: 505, shipmentId: 'ship-1', countedQty: 1, expectedQty: 1 },
    });
    expect(view.link).toEqual({ href: null, copy: 'removed line' });
  });

  it('the removed-line join asks only about the page, and only about DISCARDED', async () => {
    (db.stagingItem.findMany as unknown as jest.Mock).mockResolvedValue([]);
    seed([
      row({ id: 1, subject: { stagingItemId: 501, shipmentId: 's', countedQty: 1, expectedQty: 1 } }),
      row({ id: 2, kind: 'labeling-loss', subject: { stagingItemId: 601, units: 1, reason: 'x', shipmentId: 's' } }),
    ]);
    await listExceptions(INPUT);
    expect(db.stagingItem.findMany).toHaveBeenCalledTimes(1);
    expect((db.stagingItem.findMany as unknown as jest.Mock).mock.calls[0][0]).toEqual({
      where: { id: { in: [501, 601] }, status: 'DISCARDED' },
      select: { id: true },
    });
  });

  it('a page whose subjects name no line asks the staging table nothing', async () => {
    seed([row({ kind: 'gap-order', subject: { orderId: 'o1' } })]);
    await listExceptions(INPUT);
    expect(db.stagingItem.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The query: filters, severity translation, paging
// ---------------------------------------------------------------------------

function lastArgs(mock: jest.Mock): Record<string, unknown> {
  return mock.mock.calls[mock.mock.calls.length - 1][0] as Record<string, unknown>;
}

function whereOf(mock: jest.Mock): Record<string, unknown> {
  return lastArgs(mock).where as Record<string, unknown>;
}

describe('the query the finder issues', () => {
  it('defaults to the OPEN half and pages by (lastSeenAt, id) DESC', async () => {
    await listExceptions({ limit: 25 });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({ resolvedAt: null });
    const args = lastArgs(db.inventoryException.findMany as unknown as jest.Mock);
    expect(args.orderBy).toEqual([{ lastSeenAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(25);
  });

  it("resolved: 'resolved' asks for the settled half", async () => {
    await listExceptions({ limit: 10, resolved: 'resolved' });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({
      resolvedAt: { not: null },
    });
  });

  it("resolved: 'all' constrains the settlement state not at all", async () => {
    await listExceptions({ limit: 10, resolved: 'all' });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({});
  });

  it('severity is translated to kind IN (…) at QUERY time, so the count stays truthful', async () => {
    await listExceptions({ limit: 10, severity: 'medium' });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({
      resolvedAt: null,
      kind: { in: ['recv-discrepancy', 'labeling-loss', 'unmapped-lines'] },
    });
  });

  it('a kind AND a severity that agree narrow to the kind', async () => {
    await listExceptions({ limit: 10, kind: 'cost-differs', severity: 'low' });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({
      resolvedAt: null,
      kind: 'cost-differs',
    });
  });

  it('a kind and a severity that CONTRADICT match nothing rather than ignoring one', async () => {
    await listExceptions({ limit: 10, kind: 'cost-differs', severity: 'high' });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({
      resolvedAt: null,
      kind: { in: [] },
    });
  });

  it('olderThanDays cuts on lastSeenAt — the axis the age column reports', async () => {
    await listExceptions({ limit: 10, olderThanDays: 30 });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({
      resolvedAt: null,
      lastSeenAt: { lte: new Date(NOW.getTime() - 30 * DAY) },
    });
  });

  it('the count is of the WHOLE filtered set — the keyset rides the page read only', async () => {
    seed([row()], 3);
    const cursorPage = await listExceptions({ limit: 1 });
    const cursor = cursorPage.nextCursor;
    expect(cursor).not.toBeNull();

    seed([row({ id: 2 })], 3);
    await listExceptions({ limit: 1, cursor: cursor as string });
    expect(whereOf(db.inventoryException.count as unknown as jest.Mock)).toEqual({ resolvedAt: null });
    const pageWhere = whereOf(db.inventoryException.findMany as unknown as jest.Mock);
    expect(pageWhere).toEqual({
      resolvedAt: null,
      OR: [
        { lastSeenAt: { lt: new Date('2026-08-18T00:00:00.000Z') } },
        { lastSeenAt: new Date('2026-08-18T00:00:00.000Z'), id: { lt: 1 } },
      ],
    });
  });
});

describe('bounds said out loud', () => {
  it('moreCount is count minus what the cursor consumed minus what this page returned', async () => {
    seed([row({ id: 9 })], 7);
    const first = await listExceptions({ limit: 1 });
    expect(first.count).toBe(7);
    expect(first.moreCount).toBe(6);

    seed([row({ id: 8 })], 7);
    const second = await listExceptions({ limit: 1, cursor: first.nextCursor as string });
    expect(second.moreCount).toBe(5);
  });

  it('the last page mints no cursor', async () => {
    seed([row()], 1);
    const page = await listExceptions({ limit: 50 });
    expect(page.moreCount).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('a cursor this producer did not mint is a 400, never a silent first page', async () => {
    await expect(listExceptions({ limit: 10, cursor: 'not-a-cursor' })).rejects.toThrow(
      'invalid cursor',
    );
  });
});

// ---------------------------------------------------------------------------
// The row view
// ---------------------------------------------------------------------------

describe('the row view', () => {
  it('reports age on the lastSeenAt axis — the same one olderThanDays filters', async () => {
    const view = await firstRow({ lastSeenAt: new Date('2026-08-18T00:00:00.000Z') });
    expect(view.ageDays).toBe(2);
  });

  it('carries the settlement, the note, and the ISO instants', async () => {
    (db.user.findMany as unknown as jest.Mock).mockResolvedValue([{ id: 4, username: 'kris' }]);
    const view = await firstRow({
      resolvedAt: new Date('2026-08-19T09:00:00.000Z'),
      resolvedBy: 4,
      resolution: 'supplier-credited',
      note: 'credit note 8817',
    });
    expect(view.resolvedAt).toBe('2026-08-19T09:00:00.000Z');
    expect(view.resolvedBy).toEqual({ id: 4, username: 'kris' });
    expect(view.resolution).toBe('supplier-credited');
    expect(view.note).toBe('credit note 8817');
    expect(view.firstSeenAt).toBe('2026-08-10T00:00:00.000Z');
    expect(view.lastSeenAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('resolvedBy is ONE batched lookup for the page, never one per row', async () => {
    (db.user.findMany as unknown as jest.Mock).mockResolvedValue([
      { id: 4, username: 'kris' },
      { id: 5, username: 'sam' },
    ]);
    seed([
      row({ id: 1, resolvedBy: 4 }),
      row({ id: 2, resolvedBy: 5 }),
      row({ id: 3, resolvedBy: 4 }),
    ]);
    const page = await listExceptions(INPUT);
    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    expect((db.user.findMany as unknown as jest.Mock).mock.calls[0][0]).toEqual({
      where: { id: { in: [4, 5] } },
      select: { id: true, username: true },
    });
    expect(page.rows.map((r) => r.resolvedBy?.username)).toEqual(['kris', 'sam', 'kris']);
  });

  it('a resolver whose user row is gone is null, never a fabricated name', async () => {
    (db.user.findMany as unknown as jest.Mock).mockResolvedValue([]);
    const view = await firstRow({ resolvedBy: 99, resolvedAt: new Date('2026-08-19T09:00:00.000Z') });
    expect(view.resolvedBy).toBeNull();
  });

  it('an unresolved row asks for no actor at all', async () => {
    await listExceptions(INPUT);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('never echoes the raw subject onto the wire', async () => {
    const view = await firstRow({ subject: { stagingItemId: 1, countedQty: 1, expectedQty: 1, shipmentId: null } });
    expect(Object.keys(view).sort()).toEqual(
      [
        'ageDays',
        'firstSeenAt',
        'id',
        'key',
        'kind',
        'lastSeenAt',
        'link',
        'money',
        'note',
        'resolution',
        'resolvedAt',
        'resolvedBy',
        'severity',
        'subjectSummary',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The Overview's counter lives here too (pack C2c.3: overview never names the
// delegate — this module owns it for the lane's reads)
// ---------------------------------------------------------------------------

describe('countOpenExceptions', () => {
  it('counts the open half in ONE statement', async () => {
    (db.inventoryException.count as unknown as jest.Mock).mockResolvedValue(12);
    await expect(countOpenExceptions()).resolves.toBe(12);
    expect(db.inventoryException.count).toHaveBeenCalledTimes(1);
    expect((db.inventoryException.count as unknown as jest.Mock).mock.calls[0][0]).toEqual({
      where: { resolvedAt: null },
    });
  });
});
