/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/queries.ts` — THE ONE OWNER of the
 * polymorphic read shape (plan P-8, contract pack C2c.3; seams S16/S17).
 *
 * ONE dataset, TWO models. `orderedAt IS NULL` is a LEGACY (W1) receipt and
 * anything else is a supply order, and the whole point of this module is that
 * the discriminator is computed in exactly one place. A legacy header renders
 * through the EXPORTED legacy mapper VERBATIM (S16) — not through a
 * "compatible" re-implementation, because a second implementation of a settled
 * history shape is a silent rewrite of the past.
 *
 * Prisma is mocked: what these tests pin is WHICH statements are issued, in what
 * shape, and how the rows are folded. The queue's raw SQL is asserted as SQL,
 * because the bound and the three filters ARE the contract there (a bound
 * applied in JS after an unbounded SELECT is the failure mode PK2-5 exists to
 * prevent).
 */

import { StagingItemStatus, InboundShipmentStatus } from '@prisma/client';

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: {
    inboundShipment: { findMany: jest.fn(), findUnique: jest.fn() },
    stagingItem: { findMany: jest.fn() },
    inventoryException: { findMany: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}));

import prismaClient from '@/lib/prisma';
import {
  modelOf,
  listSupplyOrders,
  getSupplyOrderDetail,
  listLabelingQueue,
  listLegacyLines,
  LABELING_QUEUE_LIMIT,
  type SupplyOrderSummaryNewFlow,
} from '@/lib/supply-orders/queries';
import { toShipmentDetail, toShipmentSummary } from '@/lib/shipments/queries';

/** The mocked client, typed as what these tests actually drive. */
const mockPrisma = prismaClient as unknown as {
  inboundShipment: { findMany: jest.Mock; findUnique: jest.Mock };
  stagingItem: { findMany: jest.Mock };
  inventoryException: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};

const ORDERED_AT = new Date('2026-08-01T00:00:00.000Z');
const CREATED_AT = new Date('2026-08-01T09:00:00.000Z');

function header(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord_1',
    supplierRef: 'PO-9',
    supplier: 'Acme',
    status: InboundShipmentStatus.RECEIVING,
    notes: null,
    createdBy: 7,
    closedBy: null,
    orderedAt: ORDERED_AT,
    feesCents: 1500,
    feesNote: 'freight',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    closedAt: null,
    creator: { id: 7, username: 'kris' },
    ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    id: 11,
    description: 'Peptide X 10mg',
    status: StagingItemStatus.VERIFIED,
    shipmentId: 'ord_1',
    orderedProductId: 42,
    resolvedProductId: 42,
    orderedQuantity: 10,
    verifiedQuantity: 10,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 10000,
    labelingRequired: true,
    locationId: null,
    verifiedAt: new Date('2026-08-05T10:00:00.000Z'),
    verifiedBy: 7,
    expectedQuantity: null,
    countedQuantity: null,
    ...overrides,
  };
}

/** A legacy (W1) staging row, as the legacy detail mapper expects it. */
function legacyLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    description: 'Box of vials',
    status: StagingItemStatus.GRADUATED,
    shipmentId: 'shp_legacy',
    expectedQuantity: 4,
    countedQuantity: 4,
    unitCostCents: 250,
    resolvedProductId: 42,
    locationId: 1,
    vendor: 'Acme',
    reference: 'INV-1',
    notes: null,
    receivedAt: new Date('2026-01-05T00:00:00.000Z'),
    receivedBy: 7,
    countedAt: new Date('2026-01-06T00:00:00.000Z'),
    countedBy: 7,
    orderedQuantity: null,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: null,
    labelingRequired: true,
    verifiedAt: null,
    verifiedBy: null,
    location: { id: 1, name: 'Main' },
    resolvedProduct: { id: 42, name: 'Peptide X 10mg' },
    receivedByUser: { id: 7, username: 'kris' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('modelOf — the discriminator lives HERE, once', () => {
  it('reads `orderedAt IS NULL` as legacy and anything else as a supply order', () => {
    expect(modelOf({ orderedAt: null })).toBe('legacy');
    expect(modelOf({ orderedAt: ORDERED_AT })).toBe('supply-order');
  });
});

describe('listSupplyOrders', () => {
  it('reads ONE page of headers then ONE `shipmentId IN` line query', async () => {
    mockPrisma.inboundShipment.findMany.mockResolvedValue([header()]);
    mockPrisma.stagingItem.findMany.mockResolvedValue([line()]);

    await listSupplyOrders({});

    expect(mockPrisma.inboundShipment.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.stagingItem.findMany).toHaveBeenCalledTimes(1);
    const headerArgs = mockPrisma.inboundShipment.findMany.mock.calls[0][0];
    expect(headerArgs.orderBy).toEqual([{ orderedAt: 'desc' }, { createdAt: 'desc' }]);
    expect(headerArgs.take).toBe(100);
    expect(headerArgs.where.status).toEqual({
      in: [InboundShipmentStatus.ORDERED, InboundShipmentStatus.RECEIVING],
    });
    expect(mockPrisma.stagingItem.findMany.mock.calls[0][0].where).toEqual({
      shipmentId: { in: ['ord_1'] },
    });
  });

  it('filters by model when asked, using the discriminator column', async () => {
    mockPrisma.inboundShipment.findMany.mockResolvedValue([]);

    await listSupplyOrders({ model: 'legacy', statuses: [InboundShipmentStatus.CLOSED] });
    expect(mockPrisma.inboundShipment.findMany.mock.calls[0][0].where).toEqual({
      status: { in: [InboundShipmentStatus.CLOSED] },
      orderedAt: null,
    });

    await listSupplyOrders({ model: 'supply-order' });
    expect(mockPrisma.inboundShipment.findMany.mock.calls[1][0].where.orderedAt).toEqual({
      not: null,
    });
  });

  it('issues NO line query when the page is empty', async () => {
    mockPrisma.inboundShipment.findMany.mockResolvedValue([]);

    expect(await listSupplyOrders({})).toEqual([]);
    expect(mockPrisma.stagingItem.findMany).not.toHaveBeenCalled();
  });

  it('folds a supply-order header into lineCounts / units / discrepancy', async () => {
    mockPrisma.inboundShipment.findMany.mockResolvedValue([header()]);
    mockPrisma.stagingItem.findMany.mockResolvedValue([
      line({ id: 11, status: StagingItemStatus.LABELING, verifiedQuantity: 7, stockedQuantity: 3 }),
      line({ id: 12, status: StagingItemStatus.ORDERED, verifiedQuantity: null }),
      line({ id: 13, status: StagingItemStatus.COMPLETE, verifiedQuantity: 10, stockedQuantity: 9, disposedQuantity: 1 }),
      line({ id: 14, status: StagingItemStatus.DISCARDED, verifiedQuantity: null }),
      line({ id: 15, status: StagingItemStatus.VERIFIED, orderedQuantity: null, verifiedQuantity: 2 }),
    ]);

    const [summary] = (await listSupplyOrders({})) as SupplyOrderSummaryNewFlow[];

    expect(summary.model).toBe('supply-order');
    expect(summary.lineCounts).toEqual({
      ordered: 1,
      verified: 1,
      labeling: 1,
      complete: 1,
      discarded: 1,
    });
    expect(summary.units).toEqual({ verified: 19, stocked: 12, disposed: 1 });
    expect(summary.discrepancy.shortUnits).toBe(3);
    expect(summary.discrepancy.unorderedLines).toBe(1);
  });

  it('A SHORTAGE NEVER RENDERS AS "no discrepancies"', async () => {
    mockPrisma.inboundShipment.findMany.mockResolvedValue([header()]);
    mockPrisma.stagingItem.findMany.mockResolvedValue([line({ verifiedQuantity: 7 })]);

    const [summary] = (await listSupplyOrders({})) as SupplyOrderSummaryNewFlow[];

    expect(summary.discrepancy).toEqual({
      linesWithDiscrepancy: 1,
      shortUnits: 3,
      overUnits: 0,
      lossCents: 3000,
      surplusValueCents: 0,
      unorderedLines: 0,
    });
  });

  it('renders a LEGACY header through `toShipmentSummary`, verbatim', async () => {
    const legacyHeader = header({ id: 'shp_legacy', orderedAt: null, status: 'CLOSED' });
    mockPrisma.inboundShipment.findMany.mockResolvedValue([legacyHeader]);
    const rows = [legacyLine()];
    mockPrisma.stagingItem.findMany.mockResolvedValue(rows);

    const [summary] = await listSupplyOrders({ statuses: [InboundShipmentStatus.CLOSED] });

    expect(summary).toEqual({
      model: 'legacy',
      legacy: toShipmentSummary(legacyHeader as never, rows as never),
    });
  });
});

describe('getSupplyOrderDetail', () => {
  it('answers null for an unknown id, without reading lines', async () => {
    mockPrisma.inboundShipment.findUnique.mockResolvedValue(null);

    expect(await getSupplyOrderDetail('nope')).toBeNull();
    expect(mockPrisma.stagingItem.findMany).not.toHaveBeenCalled();
  });

  it('renders a LEGACY order through the EXPORTED `toShipmentDetail` (S16)', async () => {
    const legacyHeader = header({ id: 'shp_legacy', orderedAt: null, status: 'CLOSED' });
    mockPrisma.inboundShipment.findUnique.mockResolvedValue(legacyHeader);
    const rows = [legacyLine()];
    mockPrisma.stagingItem.findMany.mockResolvedValue(rows);

    const detail = await getSupplyOrderDetail('shp_legacy');

    expect(detail).toEqual({
      model: 'legacy',
      legacy: toShipmentDetail(legacyHeader as never, rows as never),
    });
    // No exception read on the legacy branch — W1 history has no follow-up here.
    expect(mockPrisma.inventoryException.findMany).not.toHaveBeenCalled();
  });

  it('maps supply-order lines and reads the exceptions by DETERMINISTIC key', async () => {
    mockPrisma.inboundShipment.findUnique.mockResolvedValue(header());
    mockPrisma.stagingItem.findMany.mockResolvedValue([
      line({ id: 11, verifiedQuantity: 7, stockedQuantity: 2 }),
      line({ id: 12 }),
    ]);
    mockPrisma.inventoryException.findMany.mockResolvedValue([
      {
        key: 'recv-discrepancy:11',
        kind: 'recv-discrepancy',
        subject: { stagingItemId: 11 },
        firstSeenAt: CREATED_AT,
        lastSeenAt: CREATED_AT,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null,
        note: null,
      },
    ]);

    const detail = await getSupplyOrderDetail('ord_1');
    if (!detail || detail.model !== 'supply-order') throw new Error('expected a supply order');

    expect(mockPrisma.stagingItem.findMany.mock.calls[0][0]).toMatchObject({
      where: { shipmentId: 'ord_1' },
      orderBy: { id: 'asc' },
    });
    expect(mockPrisma.inventoryException.findMany.mock.calls[0][0].where).toEqual({
      key: {
        in: [
          'recv-discrepancy:11',
          'labeling-loss:11',
          'recv-discrepancy:12',
          'labeling-loss:12',
        ],
      },
    });

    expect(detail.lines[0]).toMatchObject({
      id: 11,
      productId: 42,
      orderedProductId: 42,
      productName: 'Peptide X 10mg',
      remaining: 5,
      unitCostCents: 1000,
      derivation: '$100.00 / 10 ordered = $10.00/unit',
      discrepancy: {
        shortUnits: 3,
        overUnits: 0,
        lossCents: 3000,
        surplusValueCents: 0,
        unordered: false,
      },
      exceptionKeys: ['recv-discrepancy:11'],
    });
    // A matched line reports no discrepancy and joins no exception row.
    expect(detail.lines[1].discrepancy).toBeNull();
    expect(detail.lines[1].exceptionKeys).toEqual([]);

    expect(detail.exceptions).toEqual([
      expect.objectContaining({ key: 'recv-discrepancy:11', kind: 'recv-discrepancy', lineId: 11 }),
    ]);
  });

  it('names the ORDERED product from its OWN relation, and says so when there is none', async () => {
    mockPrisma.inboundShipment.findUnique.mockResolvedValue(header());
    mockPrisma.stagingItem.findMany.mockResolvedValue([
      line({ id: 11, orderedProduct: { name: 'Peptide X 10mg' } }),
      line({ id: 12, orderedProductId: null, orderedProduct: null }),
    ]);
    mockPrisma.inventoryException.findMany.mockResolvedValue([]);

    const detail = await getSupplyOrderDetail('ord_1');
    if (!detail || detail.model !== 'supply-order') throw new Error('expected a supply order');

    // SELECTED, not hydrated: the name is the only column "ordered as" needs,
    // and the only one this read is allowed to carry.
    expect(mockPrisma.stagingItem.findMany.mock.calls[0][0].include).toEqual({
      orderedProduct: { select: { name: true } },
    });
    // The ORDERED product's CURRENT name — not `description`, which is the
    // snapshot of what actually arrived.
    expect(detail.lines[0].orderedProductName).toBe('Peptide X 10mg');
    // An unordered arrival was never ordered as anything: null, never the
    // delivered product's name standing in for one.
    expect(detail.lines[1].orderedProductName).toBeNull();
  });

  it('carries the header rollup onto the detail (the summary shape is shared)', async () => {
    mockPrisma.inboundShipment.findUnique.mockResolvedValue(header());
    mockPrisma.stagingItem.findMany.mockResolvedValue([line({ verifiedQuantity: 12 })]);
    mockPrisma.inventoryException.findMany.mockResolvedValue([]);

    const detail = await getSupplyOrderDetail('ord_1');
    if (!detail || detail.model !== 'supply-order') throw new Error('expected a supply order');

    expect(detail.discrepancy.overUnits).toBe(2);
    expect(detail.supplier).toBe('Acme');
    expect(detail.feesCents).toBe(1500);
    expect(detail.orderedAt).toEqual(ORDERED_AT);
  });
});

describe('listLabelingQueue (PK2-5)', () => {
  function queueTx(options: { count?: number; rows?: Record<string, unknown>[] } = {}) {
    const { count = 1, rows = [] } = options;
    const issued: { sql: string; values: unknown[] }[] = [];
    mockPrisma.$queryRaw.mockImplementation((query: { sql: string; values: unknown[] }) => {
      issued.push({ sql: String(query.sql), values: query.values });
      return { __statement: issued.length - 1 };
    });
    mockPrisma.$transaction.mockImplementation(async (batch: unknown[]) => {
      expect(Array.isArray(batch)).toBe(true);
      return [[{ count: BigInt(count) }], rows];
    });
    return issued;
  }

  function queueRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 11,
      description: 'Peptide X 10mg',
      status: StagingItemStatus.VERIFIED,
      orderedProductId: 42,
      resolvedProductId: 42,
      orderedQuantity: 10,
      verifiedQuantity: 10,
      stockedQuantity: 2,
      disposedQuantity: 0,
      lineTotalCents: 10000,
      labelingRequired: true,
      locationId: 1,
      verifiedAt: new Date('2026-08-05T10:00:00.000Z'),
      verifiedBy: 7,
      orderId: 'ord_1',
      orderStatus: InboundShipmentStatus.RECEIVING,
      supplier: 'Acme',
      supplierRef: 'PO-9',
      orderedAt: ORDERED_AT,
      ...overrides,
    };
  }

  it('runs a COUNT and a BOUNDED SELECT as ONE batch read transaction', async () => {
    const issued = queueTx({ count: 1, rows: [queueRow()] });

    await listLabelingQueue({});

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);
    expect(issued).toHaveLength(2);
    expect(issued[0].sql).toMatch(/SELECT COUNT\(\*\)/);
    expect(issued[1].sql).toMatch(/ORDER BY s\.verifiedAt ASC, s\.id ASC/);
    // The bound is applied IN SQL, after the filter — never in JS.
    expect(issued[1].sql).toMatch(/LIMIT \?/);
    expect(issued[1].values).toContain(LABELING_QUEUE_LIMIT);
  });

  it('carries the THREE filters on both statements', async () => {
    const issued = queueTx();

    await listLabelingQueue({});

    for (const statement of issued) {
      expect(statement.sql).toContain('h.orderedAt IS NOT NULL');
      expect(statement.sql).toMatch(/s\.status IN \('VERIFIED', ?'LABELING'\)/);
      expect(statement.sql).toContain(
        's.stockedQuantity + s.disposedQuantity < s.verifiedQuantity',
      );
      expect(statement.sql).toContain('JOIN inbound_shipments h ON h.id = s.shipmentId');
    }
  });

  it('adds the order filter as a BOUND parameter when a deep link asks for one', async () => {
    const issued = queueTx();

    await listLabelingQueue({ orderId: 'ord_1' });

    for (const statement of issued) {
      expect(statement.sql).toContain('AND h.id = ?');
      expect(statement.values).toContain('ord_1');
    }
  });

  it('groups the rows by order and reports a TRUTHFUL "N more"', async () => {
    queueTx({
      count: 7,
      rows: [
        queueRow({ id: 11 }),
        queueRow({ id: 12, verifiedQuantity: 4, stockedQuantity: 0 }),
        queueRow({ id: 13, orderId: 'ord_2', supplier: 'Beta', supplierRef: 'PO-10' }),
      ],
    });

    const queue = await listLabelingQueue({ limit: 3 });

    expect(queue.count).toBe(7);
    expect(queue.moreCount).toBe(4);
    expect(queue.groups).toHaveLength(2);
    expect(queue.groups[0].order).toEqual({
      id: 'ord_1',
      status: InboundShipmentStatus.RECEIVING,
      supplier: 'Acme',
      supplierRef: 'PO-9',
      orderedAt: ORDERED_AT,
    });
    expect(queue.groups[0].lines.map((l) => l.id)).toEqual([11, 12]);
    expect(queue.groups[0].lines[0].remaining).toBe(8);
    expect(queue.groups[1].order.id).toBe('ord_2');
  });

  it('LEFT JOINs the ordered product so a queue line can name what was ordered', async () => {
    const issued = queueTx({
      count: 2,
      rows: [
        queueRow({ id: 11, orderedProductName: 'Peptide X 10mg' }),
        queueRow({ id: 12, orderedProductId: null, orderedProductName: null }),
      ],
    });

    const queue = await listLabelingQueue({});

    expect(issued[1].sql).toContain('LEFT JOIN products op ON op.id = s.orderedProductId');
    expect(issued[1].sql).toContain('op.name AS orderedProductName');
    expect(queue.groups[0].lines[0].orderedProductName).toBe('Peptide X 10mg');
    // LEFT, not INNER: a line whose ordered product is gone stays in the queue
    // — work does not disappear because a catalogue row did.
    expect(queue.groups[0].lines[1].orderedProductName).toBeNull();
  });

  it('converts the COUNT BigInt safely and never reports a negative remainder', async () => {
    queueTx({ count: 2, rows: [queueRow()] });

    const queue = await listLabelingQueue({ limit: 100 });

    expect(queue.count).toBe(2);
    expect(typeof queue.count).toBe('number');
    expect(queue.moreCount).toBe(0);
  });
});

describe('listLegacyLines', () => {
  it('discriminates on `receivedAt IS NOT NULL` (orphan legacy rows survive)', async () => {
    mockPrisma.stagingItem.findMany.mockResolvedValue([legacyLine({ shipmentId: null })]);

    const rows = await listLegacyLines({});

    const args = mockPrisma.stagingItem.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      status: { in: [StagingItemStatus.GRADUATED, StagingItemStatus.DISCARDED] },
      receivedAt: { not: null },
    });
    expect(args.orderBy).toEqual({ receivedAt: 'desc' });
    expect(args.take).toBe(200);
    expect(rows[0]).toMatchObject({
      id: 3,
      description: 'Box of vials',
      status: StagingItemStatus.GRADUATED,
      shipmentId: null,
      locationId: 1,
      receivedBy: 7,
      productName: 'Peptide X 10mg',
    });
  });

  it('names the RECEIVER, projected to { id, username } and nothing more', async () => {
    mockPrisma.stagingItem.findMany.mockResolvedValue([legacyLine()]);

    const rows = await listLegacyLines({});

    // PII DISCIPLINE (S26): a user reaches a wire shape as an id and a
    // username, never as a row with a hash on it.
    expect(mockPrisma.stagingItem.findMany.mock.calls[0][0].include.receivedByUser).toEqual({
      select: { id: true, username: true },
    });
    expect(rows[0].receivedByName).toBe('kris');
  });

  it('says the receiver has no name rather than inventing one', async () => {
    mockPrisma.stagingItem.findMany.mockResolvedValue([legacyLine({ receivedByUser: null })]);

    const rows = await listLegacyLines({});

    // The id stays (it is a real fact); the NAME is null, and the archive says
    // so — a blank byline reads as "nobody received this".
    expect(rows[0].receivedBy).toBe(7);
    expect(rows[0].receivedByName).toBeNull();
  });

  it('honours an explicit bound', async () => {
    mockPrisma.stagingItem.findMany.mockResolvedValue([]);

    await listLegacyLines({ limit: 25 });

    expect(mockPrisma.stagingItem.findMany.mock.calls[0][0].take).toBe(25);
  });

  it('refuses a NEW-FLOW row that somehow reaches the legacy mapper (INVARIANT)', async () => {
    mockPrisma.stagingItem.findMany.mockResolvedValue([legacyLine({ receivedBy: null })]);

    await expect(listLegacyLines({})).rejects.toMatchObject({ statusCode: 500 });
  });
});
