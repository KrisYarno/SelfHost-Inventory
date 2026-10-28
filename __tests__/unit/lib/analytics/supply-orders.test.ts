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
    inventory_logs: { findMany: jest.fn() },
  },
}));

import prisma from '@/lib/prisma';
import { getSupplyOrdersAnalytics } from '@/lib/analytics/supply-orders';
// The seam S18 pin (reconciliation pack C5.4): the receipts grain has ONE
// definition home, and this suite proves the roll-up ships that exact string
// rather than a second copy that can drift away from it.
import { RECEIPT_EVENT_DEFINITION } from '@/lib/reports/movement';

const m = prisma as unknown as {
  inboundShipment: { findMany: jest.Mock; count: jest.Mock };
  inventoryException: { findMany: jest.Mock };
  stagingItem: { findMany: jest.Mock };
  inventory_logs: { findMany: jest.Mock };
};

const WINDOW = { from: '2026-08-01', to: '2026-08-31' };

function setup(fixture: {
  headers?: Array<{ status: string; feesCents: number | null }>;
  legacyCount?: number;
  /** `resolvedAt` is never SELECTED — it rides in the fixture only to prove the
   *  producer ignores the settlement instant (the net is as of now). */
  exceptions?: Array<{
    kind: string;
    subject: unknown;
    resolution?: string | null;
    resolvedAt?: Date;
  }>;
  lines?: Array<{ id: number; status: string }>;
  receipts?: Array<{
    delta: number;
    stagingItemId: number | null;
    inboundShipmentId: string | null;
    receiptCostCents: number | null;
  }>;
}) {
  m.inboundShipment.findMany.mockResolvedValue(fixture.headers ?? []);
  m.inboundShipment.count.mockResolvedValue(fixture.legacyCount ?? 0);
  m.inventoryException.findMany.mockResolvedValue(fixture.exceptions ?? []);
  m.stagingItem.findMany.mockResolvedValue(fixture.lines ?? []);
  m.inventory_logs.findMany.mockResolvedValue(fixture.receipts ?? []);
}

const recv = (subject: Record<string, unknown>, resolution: string | null = null) => ({
  kind: 'recv-discrepancy',
  subject,
  resolution,
});
const loss = (subject: Record<string, unknown>, resolution: string | null = null) => ({
  kind: 'labeling-loss',
  subject,
  resolution,
});

/** One stocked batch as the producer selects it (D10's ledger time basis). */
const stocked = (
  over: Partial<{
    delta: number;
    stagingItemId: number | null;
    inboundShipmentId: string | null;
    receiptCostCents: number | null;
  }> = {},
) => ({
  delta: 10,
  stagingItemId: 501,
  inboundShipmentId: 'ship-1',
  receiptCostCents: 1_000,
  ...over,
});

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

// ---------------------------------------------------------------------------
// D10 — the RECEIPTS roll-up, on the LEDGER time basis (reconciliation pack C5.4)
// ---------------------------------------------------------------------------

describe('the receipts roll-up (D10)', () => {
  it('reads STOCK_IN rows that NAME a supply-order line, by changeTime', async () => {
    setup({});

    await getSupplyOrdersAnalytics(WINDOW);

    const call = m.inventory_logs.findMany.mock.calls[0][0];
    expect(call.where.logType).toBe('STOCK_IN');
    // A stock-in with no line is not a receipt against an order — it is a manual
    // correction or a pre-overhaul receipt, and folding it in would credit the
    // receiving bench with work no supply order asked for.
    expect(call.where.stagingItemId).toEqual({ not: null });
    // The LEDGER time basis (D10): when the units were STOCKED, never the order
    // date the fee population uses.
    expect(call.where.changeTime.gte).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(call.where.changeTime.lt).toEqual(new Date('2026-09-01T00:00:00.000Z'));
  });

  it('counts ONE receipt event per stock-in batch (D12), with distinct lines and orders', async () => {
    setup({
      receipts: [
        // Two batches of the SAME line, on the same order: two events, one line.
        stocked({ delta: 4, stagingItemId: 501, inboundShipmentId: 'ship-1', receiptCostCents: 400 }),
        stocked({ delta: 6, stagingItemId: 501, inboundShipmentId: 'ship-1', receiptCostCents: 600 }),
        // A second line on a second order.
        stocked({ delta: 5, stagingItemId: 502, inboundShipmentId: 'ship-2', receiptCostCents: 500 }),
      ],
    });

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.batches).toBe(3);
    expect(receipts.linesVerified).toBe(2);
    expect(receipts.orders).toBe(2);
    expect(receipts.unitsStocked).toBe(15);
    expect(receipts.receiptCostCents.valueCents).toBe(1_500);
    expect(receipts.receiptCostCents.contributingRows).toBe(3);
    expect(receipts.receiptCostCents.reason).toBeNull();
  });

  it('a batch stocked outside any order counts as an event but not as an order', async () => {
    setup({
      receipts: [
        stocked({ inboundShipmentId: null }),
        stocked({ stagingItemId: 502, inboundShipmentId: 'ship-1' }),
      ],
    });

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.batches).toBe(2);
    expect(receipts.orders).toBe(1);
    expect(receipts.linesVerified).toBe(2);
  });

  it('a batch with NO receipt cost contributes nothing — it is not a zero', async () => {
    setup({
      receipts: [
        stocked({ receiptCostCents: null }),
        stocked({ stagingItemId: 502, receiptCostCents: 2_500 }),
      ],
    });

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.receiptCostCents.valueCents).toBe(2_500);
    expect(receipts.receiptCostCents.contributingRows).toBe(1);
    expect(receipts.receiptCostCents.coverage).toContain('1 of 2 receipt events');
    // The unpriced count, said out loud (R-2): a reader must be able to see the
    // hole without subtracting two numbers in their head.
    expect(receipts.receiptCostCents.coverage).toContain('1 record no figure at all');
  });

  it('batches that ALL booked a zero cost produce a KNOWN ZERO, never null', async () => {
    setup({ receipts: [stocked({ receiptCostCents: 0 })] });

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.receiptCostCents.valueCents).toBe(0);
    expect(receipts.receiptCostCents.contributingRows).toBe(1);
    expect(receipts.receiptCostCents.reason).toBeNull();
  });

  it('NO receipt at all is null + a reason, never $0.00 (the counts stay honest zeros)', async () => {
    setup({});

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.batches).toBe(0);
    expect(receipts.orders).toBe(0);
    expect(receipts.linesVerified).toBe(0);
    expect(receipts.unitsStocked).toBe(0);
    expect(receipts.receiptCostCents.valueCents).toBeNull();
    expect(receipts.receiptCostCents.reason).toBe(
      'no stock-in batch against a supply-order line was seen in this window',
    );
  });

  it('rows seen but none priced reads DIFFERENTLY from no rows at all', async () => {
    setup({ receipts: [stocked({ receiptCostCents: null }), stocked({ receiptCostCents: null })] });

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.receiptCostCents.valueCents).toBeNull();
    expect(receipts.receiptCostCents.reason).toBe(
      '2 stock-in batches were stocked in this window; none records a receipt cost',
    );
  });

  it('the coverage names the LEDGER basis and the stock-ins deliberately left out', async () => {
    setup({});

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    expect(receipts.receiptCostCents.coverage).toContain('changeTime');
    expect(receipts.receiptCostCents.coverage).toContain(
      'Stock-in rows that name no supply-order line (pre-overhaul receipts and manual ' +
        'stock-ins) are outside this population.',
    );
  });

  it('the receipts definition IS movement.ts\'s RECEIPT_EVENT_DEFINITION (seam S18)', async () => {
    setup({});

    const { receipts } = await getSupplyOrdersAnalytics(WINDOW);

    // ONE definition home for the grain: the roll-up imports the string, so the
    // two surfaces cannot end up meaning different things by "a receipt".
    expect(receipts.definition).toBe(RECEIPT_EVENT_DEFINITION);
    // A2 C10: the shared definition carries no internal design reference.
    expect(receipts.definition).toBe(
      'a receipt event = one stock-in batch; a five-batch delivery is five events',
    );
  });
});

// ---------------------------------------------------------------------------
// D10 — supplierShortageCostNet: gross MINUS what the supplier made good
// ---------------------------------------------------------------------------

describe('supplierShortageCostNet (D10)', () => {
  it('reads the resolution alongside the subject, in the SAME read', async () => {
    setup({});

    await getSupplyOrdersAnalytics(WINDOW);

    expect(m.inventoryException.findMany.mock.calls[0][0].select).toEqual({
      kind: true,
      subject: true,
      resolution: true,
    });
  });

  it('subtracts the loss of every row settled supplier-credited or reshipped', async () => {
    setup({
      exceptions: [
        recv({ lossCents: 10_000 }, 'supplier-credited'),
        recv({ lossCents: 2_500 }, 'reshipped'),
        recv({ lossCents: 4_000 }, null),
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.valueCents).toBe(16_500);
    expect(metrics.supplierShortageCostNet.valueCents).toBe(4_000);
    // The net speaks about the SAME priced rows the gross does.
    expect(metrics.supplierShortageCostNet.contributingRows).toBe(3);
    expect(metrics.supplierShortageCostNet.reason).toBeNull();
  });

  it('every OTHER resolution is left in the net — only the two make-goods come off', async () => {
    setup({
      exceptions: [
        recv({ lossCents: 1_000 }, 'accepted-loss'),
        recv({ lossCents: 2_000 }, 'recount-corrected'),
        recv({ lossCents: 4_000 }, 'additional-delivery'),
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCostNet.valueCents).toBe(7_000);
    expect(metrics.supplierShortageCostNet.valueCents).toBe(
      metrics.supplierShortageCost.valueCents,
    );
  });

  it('AS OF NOW: a settlement that happened long after the window still nets', async () => {
    setup({
      exceptions: [
        // The row was last seen in the window; the credit note landed in
        // September. Settling does not move lastSeenAt, so the window still
        // holds this row — and TODAY's answer is that it was made good.
        { ...recv({ lossCents: 9_000 }, 'supplier-credited'), resolvedAt: new Date('2026-09-14') },
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.valueCents).toBe(9_000);
    expect(metrics.supplierShortageCostNet.valueCents).toBe(0);
    // Nothing about resolution narrows the READ — the whole point of "as of now"
    // is that August's net changes when September settles it.
    const where = m.inventoryException.findMany.mock.calls[0][0].where;
    expect(where.resolution).toBeUndefined();
    expect(where.resolvedAt).toBeUndefined();
  });

  it('a settled row carrying NO loss figure subtracts nothing (there is nothing to subtract)', async () => {
    setup({
      exceptions: [
        recv({ lossCents: 5_000 }, null),
        recv({ stagingItemId: 7, expectedQty: 4, countedQty: 4 }, 'supplier-credited'),
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCostNet.valueCents).toBe(5_000);
    expect(metrics.supplierShortageCostNet.contributingRows).toBe(1);
  });

  it('the removed-line exclusion applies IDENTICALLY to the net', async () => {
    setup({
      exceptions: [
        // A credited shortage on a line that later left the order: neither the
        // gross nor the net may speak about it.
        recv({ stagingItemId: 11, lossCents: 6_000 }, 'supplier-credited'),
        recv({ stagingItemId: 12, lossCents: 2_000 }, null),
      ],
      lines: [
        { id: 11, status: 'DISCARDED' },
        { id: 12, status: 'VERIFIED' },
      ],
    });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.valueCents).toBe(2_000);
    expect(metrics.supplierShortageCostNet.valueCents).toBe(2_000);
    expect(metrics.supplierShortageCostNet.contributingRows).toBe(1);
    expect(metrics.supplierShortageCostNet.coverage).toContain(
      '1 further recv-discrepancy row(s) belong to removed lines and are excluded.',
    );
  });

  it('a labeling-loss row is never netted — the supplier settled nothing there', async () => {
    setup({ exceptions: [loss({ lossCents: 3_000 }, 'supplier-credited')] });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.labelingLossCost.valueCents).toBe(3_000);
    expect(metrics.supplierShortageCostNet.valueCents).toBeNull();
  });

  it('null-not-0: no priced discrepancy row means the net is unknown, with the gross reason', async () => {
    setup({ exceptions: [recv({ stagingItemId: 7, expectedQty: 10, countedQty: 8 }, null)] });

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCost.valueCents).toBeNull();
    expect(metrics.supplierShortageCostNet.valueCents).toBeNull();
    expect(metrics.supplierShortageCostNet.reason).toBe(
      metrics.supplierShortageCost.reason,
    );
  });

  it('the definition says AS OF NOW, verbatim', async () => {
    setup({});

    const { metrics } = await getSupplyOrdersAnalytics(WINDOW);

    expect(metrics.supplierShortageCostNet.definition).toContain(
      'net is AS OF NOW (a settlement in September changes August\'s net) — settlements do ' +
        'not move lastSeenAt',
    );
    expect(metrics.supplierShortageCostNet.definition).toBe(
      'GROSS supplier shortage MINUS the loss of every recv-discrepancy row resolved ' +
        'supplier-credited or reshipped — what the shortages in this window have cost ' +
        'after the supplier made good. net is AS OF NOW (a settlement in September ' +
        'changes August\'s net) — settlements do not move lastSeenAt.',
    );
  });
});
