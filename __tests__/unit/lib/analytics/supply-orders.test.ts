/**
 * @jest-environment node
 *
 * M3b — `lib/analytics/supply-orders.ts`, the SUPPLY-ORDER ANALYTICS PRODUCER
 * (spec §8, pack C3b/PK2-13, seam S18).
 *
 * Four numbers on the analytics hub — fees in the window, gross supplier
 * shortage, labeling loss, over-delivery surplus — and the truthful-data rule
 * that decides every one of them:
 *
 *   `valueCents` is NULL **only** when nothing contributed (`contributingRows
 *   === 0`), and then it carries a `reason`. Rows that contribute a known ZERO
 *   produce `0`. "Nobody lost anything" and "we cannot say" are different
 *   answers and the card must be able to tell them apart.
 *
 * Every metric also carries its own `definition` (what the number MEANS) and
 * `coverage` (numerator/denominator plus what is deliberately outside it),
 * because a figure whose basis is not stated is a figure nobody can act on.
 */

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    inboundShipment: { findMany: jest.fn(), count: jest.fn() },
    inventoryException: { findMany: jest.fn() },
    stagingItem: { findMany: jest.fn() },
  },
}));

import prisma from '@/lib/prisma';
import { getSupplyOrdersAnalytics } from '@/lib/analytics/supply-orders';

const m = prisma as unknown as {
  inboundShipment: { findMany: jest.Mock; count: jest.Mock };
  inventoryException: { findMany: jest.Mock };
  stagingItem: { findMany: jest.Mock };
};

const WINDOW = { from: '2026-08-01', to: '2026-08-31' };

function setup(fixture: {
  headers?: Array<{ status: string; feesCents: number | null }>;
  legacyCount?: number;
  exceptions?: Array<{ kind: string; subject: unknown }>;
  lines?: Array<{ id: number; status: string }>;
}) {
  m.inboundShipment.findMany.mockResolvedValue(fixture.headers ?? []);
  m.inboundShipment.count.mockResolvedValue(fixture.legacyCount ?? 0);
  m.inventoryException.findMany.mockResolvedValue(fixture.exceptions ?? []);
  m.stagingItem.findMany.mockResolvedValue(fixture.lines ?? []);
}

const recv = (subject: Record<string, unknown>) => ({ kind: 'recv-discrepancy', subject });
const loss = (subject: Record<string, unknown>) => ({ kind: 'labeling-loss', subject });

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

describe('getSupplyOrdersAnalytics — the window boundaries', () => {
  it('reads [from UTC midnight, the day AFTER `to` at UTC midnight)', async () => {
    setup({});

    await getSupplyOrdersAnalytics(WINDOW);

    const headerWhere = m.inboundShipment.findMany.mock.calls[0][0].where;
    expect(headerWhere.orderedAt.gte).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(headerWhere.orderedAt.lt).toEqual(new Date('2026-09-01T00:00:00.000Z'));

    const exceptionWhere = m.inventoryException.findMany.mock.calls[0][0].where;
    expect(exceptionWhere.lastSeenAt.gte).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(exceptionWhere.lastSeenAt.lt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });

  it('a ONE-DAY window still spans a whole day', async () => {
    setup({});

    await getSupplyOrdersAnalytics({ from: '2026-08-17', to: '2026-08-17' });

    const where = m.inboundShipment.findMany.mock.calls[0][0].where;
    expect(where.orderedAt.gte).toEqual(new Date('2026-08-17T00:00:00.000Z'));
    expect(where.orderedAt.lt).toEqual(new Date('2026-08-18T00:00:00.000Z'));
  });

  it('crosses a month end without arithmetic drift', async () => {
    setup({});

    await getSupplyOrdersAnalytics({ from: '2026-02-27', to: '2026-02-28' });

    const where = m.inboundShipment.findMany.mock.calls[0][0].where;
    expect(where.orderedAt.lt).toEqual(new Date('2026-03-01T00:00:00.000Z'));
  });

  it('echoes the window it was asked for', async () => {
    setup({});
    const result = await getSupplyOrdersAnalytics(WINDOW);
    expect(result.window).toEqual(WINDOW);
  });

  it('reads exceptions by lastSeenAt over BOTH kinds, open AND resolved', async () => {
    setup({});

    await getSupplyOrdersAnalytics(WINDOW);

    const where = m.inventoryException.findMany.mock.calls[0][0].where;
    expect(where.kind).toEqual({ in: ['recv-discrepancy', 'labeling-loss'] });
    // No resolvedAt filter: a settled shortage still cost what it cost.
    expect(where.resolvedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The ordered-date population
// ---------------------------------------------------------------------------

describe('getSupplyOrdersAnalytics — orders and fees', () => {
  it('counts non-cancelled orders by status and sums their fees', async () => {
    setup({
      headers: [
        { status: 'ORDERED', feesCents: 1_200 },
        { status: 'RECEIVING', feesCents: 800 },
        { status: 'RECEIVING', feesCents: 0 },
      ],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.orders.count).toBe(3);
    expect(result.orders.byStatus).toEqual({ ORDERED: 1, RECEIVING: 2 });
    expect(result.metrics.fees.valueCents).toBe(2_000);
    expect(result.metrics.fees.contributingRows).toBe(3);
    expect(result.metrics.fees.reason).toBeNull();
  });

  it('EXCLUDES cancelled orders in SQL, never in JS', async () => {
    setup({});

    await getSupplyOrdersAnalytics(WINDOW);

    const where = m.inboundShipment.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: 'CANCELLED' });
  });

  it('a header with NO recorded fee contributes nothing — it is not a zero', async () => {
    setup({
      headers: [
        { status: 'CLOSED', feesCents: null },
        { status: 'CLOSED', feesCents: 500 },
      ],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.fees.valueCents).toBe(500);
    expect(result.metrics.fees.contributingRows).toBe(1);
    expect(result.metrics.fees.coverage).toContain('1 of 2');
  });

  it('orders that ALL record a zero fee produce a KNOWN ZERO, never null', async () => {
    setup({ headers: [{ status: 'ORDERED', feesCents: 0 }] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.fees.valueCents).toBe(0);
    expect(result.metrics.fees.contributingRows).toBe(1);
    expect(result.metrics.fees.reason).toBeNull();
  });

  it('NO orders at all produces null + a reason, never $0.00', async () => {
    setup({});

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.orders.count).toBe(0);
    expect(result.orders.byStatus).toEqual({});
    expect(result.metrics.fees.valueCents).toBeNull();
    expect(result.metrics.fees.contributingRows).toBe(0);
    expect(result.metrics.fees.reason).toBeTruthy();
  });

  it('LEGACY headers are counted SEPARATELY and named as excluded, never in the denominator', async () => {
    setup({
      headers: [{ status: 'ORDERED', feesCents: 100 }],
      legacyCount: 4,
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    // The legacy count is read by createdAt with orderedAt NULL — a different
    // population, deliberately not mixed into the ordered-date one.
    const legacyWhere = m.inboundShipment.count.mock.calls[0][0].where;
    expect(legacyWhere.orderedAt).toBeNull();
    expect(legacyWhere.createdAt.gte).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(legacyWhere.createdAt.lt).toEqual(new Date('2026-09-01T00:00:00.000Z'));

    expect(result.metrics.fees.contributingRows).toBe(1);
    expect(result.metrics.fees.coverage).toContain('1 of 1');
    expect(result.metrics.fees.coverage).toContain('4');
    expect(result.metrics.fees.coverage).toMatch(/legacy/i);
  });
});

// ---------------------------------------------------------------------------
// The three exception metrics
// ---------------------------------------------------------------------------

describe('getSupplyOrdersAnalytics — the exception metrics', () => {
  it('folds the CURRENT subject money per kind', async () => {
    setup({
      exceptions: [
        recv({ lossCents: 10_000, surplusValueCents: 0 }),
        recv({ lossCents: 0, surplusValueCents: 2_500 }),
        loss({ lossCents: 4_000 }),
      ],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.supplierShortageCost.valueCents).toBe(10_000);
    expect(result.metrics.supplierShortageCost.contributingRows).toBe(2);
    expect(result.metrics.surplusValue.valueCents).toBe(2_500);
    expect(result.metrics.surplusValue.contributingRows).toBe(2);
    expect(result.metrics.labelingLossCost.valueCents).toBe(4_000);
    expect(result.metrics.labelingLossCost.contributingRows).toBe(1);
  });

  it('a discrepancy row that lost NOTHING is a known zero, not an absence', async () => {
    setup({ exceptions: [recv({ lossCents: 0, surplusValueCents: 0 })] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.supplierShortageCost.valueCents).toBe(0);
    expect(result.metrics.supplierShortageCost.contributingRows).toBe(1);
    expect(result.metrics.supplierShortageCost.reason).toBeNull();
  });

  it('NO rows at all is null + a reason for all three', async () => {
    setup({});

    const result = await getSupplyOrdersAnalytics(WINDOW);

    for (const metric of [
      result.metrics.supplierShortageCost,
      result.metrics.labelingLossCost,
      result.metrics.surplusValue,
    ]) {
      expect(metric.valueCents).toBeNull();
      expect(metric.contributingRows).toBe(0);
      expect(metric.reason).toBeTruthy();
    }
  });

  it('a W1-era subject with no money fields contributes NOTHING rather than a fabricated 0', async () => {
    setup({
      exceptions: [
        recv({ stagingItemId: 1, expectedQty: 10, countedQty: 8 }),
        recv({ lossCents: 2_000 }),
      ],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.supplierShortageCost.valueCents).toBe(2_000);
    expect(result.metrics.supplierShortageCost.contributingRows).toBe(1);
    expect(result.metrics.supplierShortageCost.coverage).toContain('1 of 2');
  });

  it('tolerates a subject handed back as JSON TEXT by the connector', async () => {
    setup({ exceptions: [loss({}), { kind: 'labeling-loss', subject: '{"lossCents":900}' }] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.labelingLossCost.valueCents).toBe(900);
    expect(result.metrics.labelingLossCost.contributingRows).toBe(1);
  });

  it('a non-numeric money field is not folded', async () => {
    setup({ exceptions: [loss({ lossCents: 'lots' })] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.labelingLossCost.valueCents).toBeNull();
    expect(result.metrics.labelingLossCost.contributingRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The strings that ride every number (spec §8)
// ---------------------------------------------------------------------------

describe('getSupplyOrdersAnalytics — definitions and coverage', () => {
  it('every metric carries a non-empty definition and coverage string', async () => {
    setup({
      headers: [{ status: 'ORDERED', feesCents: 100 }],
      exceptions: [recv({ lossCents: 1 }), loss({ lossCents: 1 })],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    for (const metric of Object.values(result.metrics)) {
      expect(metric.definition.trim().length).toBeGreaterThan(0);
      expect(metric.coverage.trim().length).toBeGreaterThan(0);
      // Numerator/denominator, stated (pack C3b).
      expect(metric.coverage).toMatch(/\d+ of \d+/);
      // The legacy-money omission, stated on every one of them.
      expect(metric.coverage).toMatch(/legacy/i);
    }
  });

  it('each definition names its own basis', async () => {
    setup({});

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.fees.definition).toMatch(/orderedAt/);
    expect(metrics.supplierShortageCost.definition).toMatch(/recv-discrepancy/);
    expect(metrics.labelingLossCost.definition).toMatch(/labeling-loss/);
    expect(metrics.surplusValue.definition).toMatch(/recv-discrepancy/);
  });

  it('the shortage definition says GROSS — credits and reshipments are NOT subtracted', async () => {
    setup({});

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.definition).toMatch(/gross/i);
    expect(metrics.supplierShortageCost.definition).toMatch(/not subtracted/i);
  });

  it('the exception coverage strings name lastSeenAt as their window basis', async () => {
    setup({});

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.coverage).toMatch(/lastSeenAt/);
    expect(metrics.labelingLossCost.coverage).toMatch(/lastSeenAt/);
    expect(metrics.surplusValue.coverage).toMatch(/lastSeenAt/);
  });
});

// ---------------------------------------------------------------------------
// REV-10 clause 8 — an UNPRICED labeling loss is unknown, not $0.00
// ---------------------------------------------------------------------------

describe('nullable labeling-loss money (CR-5/CR-6)', () => {
  it('a null lossCents is EXCLUDED from the numerator and COUNTED in coverage', async () => {
    setup({ exceptions: [loss({ lossCents: null }), loss({ lossCents: 3_000 })] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    // 3000, not 3000 + 0: the unpriced row's money is unknown, and adding a 0
    // for it would understate the bench's real loss while looking precise.
    expect(result.metrics.labelingLossCost.valueCents).toBe(3_000);
    expect(result.metrics.labelingLossCost.contributingRows).toBe(1);
    expect(result.metrics.labelingLossCost.coverage).toContain('1 of 2 labeling-loss rows');
  });

  it('a real zero still contributes (a known 0 is not an absence)', async () => {
    setup({ exceptions: [loss({ lossCents: 0 })] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.labelingLossCost.valueCents).toBe(0);
    expect(result.metrics.labelingLossCost.contributingRows).toBe(1);
    expect(result.metrics.labelingLossCost.reason).toBeNull();
  });

  it('the reason is DENOMINATOR-AWARE: rows seen but none priced', async () => {
    setup({ exceptions: [loss({ lossCents: null }), loss({ lossCents: null })] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.labelingLossCost.valueCents).toBeNull();
    expect(result.metrics.labelingLossCost.reason).toBe(
      "2 labeling-loss rows remain in this window's population (0 further belong to removed " +
        'lines); none carries a loss figure',
    );
  });

  it('the reason is DENOMINATOR-AWARE: no rows at all', async () => {
    setup({});

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.labelingLossCost.reason).toBe(
      'no labeling-loss row was seen in this window',
    );
    expect(result.metrics.supplierShortageCost.reason).toBe(
      'no receiving-discrepancy row was seen in this window',
    );
  });

  it('the shortage reason distinguishes the two emptinesses too', async () => {
    setup({ exceptions: [recv({ stagingItemId: 1, expectedQty: 10, countedQty: 8 })] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.supplierShortageCost.reason).toBe(
      "1 recv-discrepancy rows remain in this window's population (0 further belong to removed " +
        'lines); none carries a loss figure',
    );
    expect(result.metrics.surplusValue.reason).toBe(
      "1 recv-discrepancy rows remain in this window's population (0 further belong to removed " +
        'lines); none carries a surplus figure',
    );
  });

  it('the FEES reason distinguishes them as well', async () => {
    setup({ headers: [{ status: 'CLOSED', feesCents: null }] });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.fees.reason).toBe(
      '1 non-cancelled supply orders were ordered in this window; none records a fee amount',
    );
  });
});

// ---------------------------------------------------------------------------
// FD2-1 — a row whose LINE was REMOVED from the order
// ---------------------------------------------------------------------------

describe('rows naming a line that left the order (FD2-1)', () => {
  it('resolves every row against its line in ONE read, by id', async () => {
    setup({
      exceptions: [
        recv({ stagingItemId: 11, lossCents: 5_000 }),
        loss({ stagingItemId: 12, lossCents: 1_000 }),
        // The same line twice — one query, one id.
        recv({ stagingItemId: 11, surplusValueCents: 100 }),
      ],
      lines: [
        { id: 11, status: 'VERIFIED' },
        { id: 12, status: 'LABELING' },
      ],
    });

    await getSupplyOrdersAnalytics(WINDOW);

    expect(m.stagingItem.findMany).toHaveBeenCalledTimes(1);
    expect(m.stagingItem.findMany).toHaveBeenCalledWith({
      where: { id: { in: [11, 12] } },
      select: { id: true, status: true },
    });
  });

  it('asks for NO lines when no subject names one', async () => {
    setup({ exceptions: [recv({ lossCents: 5_000 })] });

    await getSupplyOrdersAnalytics(WINDOW);

    expect(m.stagingItem.findMany).not.toHaveBeenCalled();
  });

  it('a DISCARDED line contributes NOTHING to shortage or surplus', async () => {
    setup({
      exceptions: [
        recv({ stagingItemId: 11, lossCents: 5_000, surplusValueCents: 500 }),
        recv({ stagingItemId: 12, lossCents: 2_000, surplusValueCents: 300 }),
      ],
      lines: [
        // Removed from the order: it was never delivered short, because it was
        // never on the order at all once it went.
        { id: 11, status: 'DISCARDED' },
        { id: 12, status: 'VERIFIED' },
      ],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.supplierShortageCost.valueCents).toBe(2_000);
    expect(result.metrics.supplierShortageCost.contributingRows).toBe(1);
    expect(result.metrics.surplusValue.valueCents).toBe(300);
    expect(result.metrics.surplusValue.contributingRows).toBe(1);
  });

  it('names the excluded rows in the coverage of every exception metric', async () => {
    setup({
      exceptions: [
        recv({ stagingItemId: 11, lossCents: 5_000, surplusValueCents: 500 }),
        recv({ stagingItemId: 12, lossCents: 2_000, surplusValueCents: 300 }),
        loss({ stagingItemId: 11, lossCents: 900 }),
      ],
      lines: [
        { id: 11, status: 'DISCARDED' },
        { id: 12, status: 'VERIFIED' },
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    // The denominator is the population the number SPEAKS about, and the
    // excluded rows are counted beside it rather than folded into it.
    expect(metrics.supplierShortageCost.coverage).toContain('1 of 1 recv-discrepancy rows');
    expect(metrics.supplierShortageCost.coverage).toContain(
      '1 further recv-discrepancy row(s) belong to removed lines and are excluded.',
    );
    expect(metrics.surplusValue.coverage).toContain(
      '1 further recv-discrepancy row(s) belong to removed lines and are excluded.',
    );
    expect(metrics.labelingLossCost.coverage).toContain(
      '1 further labeling-loss row(s) belong to removed lines and are excluded.',
    );
  });

  it('says ZERO excluded when every line is still on its order', async () => {
    setup({
      exceptions: [recv({ stagingItemId: 12, lossCents: 2_000 })],
      lines: [{ id: 12, status: 'COMPLETE' }],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.valueCents).toBe(2_000);
    expect(metrics.supplierShortageCost.coverage).toContain(
      '0 further recv-discrepancy row(s) belong to removed lines and are excluded.',
    );
  });

  it('a labeling-loss row on a removed line is excluded too', async () => {
    setup({
      exceptions: [
        loss({ stagingItemId: 11, lossCents: 900 }),
        loss({ stagingItemId: 12, lossCents: 100 }),
      ],
      lines: [
        { id: 11, status: 'DISCARDED' },
        { id: 12, status: 'LABELING' },
      ],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.labelingLossCost.valueCents).toBe(100);
    expect(result.metrics.labelingLossCost.contributingRows).toBe(1);
    expect(result.metrics.labelingLossCost.coverage).toContain('1 of 1 labeling-loss rows');
  });

  it('the reason SAYS the rows were seen and excluded, never "no row was seen"', async () => {
    setup({
      exceptions: [
        recv({ stagingItemId: 11, lossCents: 0, surplusValueCents: 0 }),
        loss({ stagingItemId: 11, lossCents: 900 }),
      ],
      lines: [{ id: 11, status: 'DISCARDED' }],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.valueCents).toBeNull();
    expect(metrics.supplierShortageCost.reason).toBe(
      '1 recv-discrepancy row(s) were seen in this window; every one belongs to a line removed from its order',
    );
    expect(metrics.surplusValue.reason).toBe(
      '1 recv-discrepancy row(s) were seen in this window; every one belongs to a line removed from its order',
    );
    expect(metrics.labelingLossCost.reason).toBe(
      '1 labeling-loss row(s) were seen in this window; every one belongs to a line removed from its order',
    );
  });

  it('FD3-4: the UNPRICED reason names the removed rows too, so it never understates', async () => {
    setup({
      exceptions: [
        // One row still on its order, carrying no money at all...
        recv({ stagingItemId: 12, expectedQty: 10, countedQty: 8 }),
        // ...and two whose lines have left it.
        recv({ stagingItemId: 11, lossCents: 5_000 }),
        recv({ stagingItemId: 13, lossCents: 900 }),
      ],
      lines: [
        { id: 11, status: 'DISCARDED' },
        { id: 12, status: 'VERIFIED' },
        { id: 13, status: 'DISCARDED' },
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    // "1 row, none priced" alone would send the reader looking at one row in a
    // window that actually held three. The denominator this sentence speaks
    // about is the population AFTER the removals, and it says so.
    expect(metrics.supplierShortageCost.valueCents).toBeNull();
    expect(metrics.supplierShortageCost.reason).toBe(
      "1 recv-discrepancy rows remain in this window's population (2 further belong to removed " +
        'lines); none carries a loss figure',
    );
    expect(metrics.surplusValue.reason).toBe(
      "1 recv-discrepancy rows remain in this window's population (2 further belong to removed " +
        'lines); none carries a surplus figure',
    );
  });

  it('a subject naming NO line is never excluded — an unknown line is not a removed one', async () => {
    setup({
      exceptions: [recv({ lossCents: 4_000 }), recv({ stagingItemId: 11, lossCents: 5_000 })],
      lines: [{ id: 11, status: 'DISCARDED' }],
    });

    const result = await getSupplyOrdersAnalytics(WINDOW);

    expect(result.metrics.supplierShortageCost.valueCents).toBe(4_000);
    expect(result.metrics.supplierShortageCost.contributingRows).toBe(1);
  });
});
