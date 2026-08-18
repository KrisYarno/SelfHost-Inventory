/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/booking.ts` — THE BOOKING PRIMITIVE
 * (spec §5.2, contract pack C2b.2; seams S3/S4/S11/S12/S13/S20).
 *
 * The primitive is TX-SCOPED: it never opens a transaction, never retries, and
 * never imports the exceptions writer. It takes a `tx`, takes locks in the house
 * order, writes the ledger row and the line counter under those locks, ASSEMBLES
 * the exception subjects, and hands everything to the route through `onRecord`.
 *
 * So these tests drive a MOCKED tx that RECORDS EVERY STATEMENT IN ORDER,
 * because the order is the contract as much as the statements are (spec §5.2
 * FROZEN STEP ORDER): line FOR UPDATE -> idempotency read -> header claim ->
 * money -> product_locations range lock -> applyStockDelta -> products FOR
 * UPDATE -> D-COST + subjects -> guarded line update -> onRecord.
 *
 * PROPERTY -> TEST MATRIX (pack C2b.4). Three of the five rows land here, and
 * each test below names its OLD HOME:
 *
 *   ATOMICITY   old home `__tests__/unit/lib/staging/graduate.test.ts`
 *               ("the NULL-count throw escapes $transaction (Prisma rolls back
 *               on a thrown callback)") + `inbound-shipment-costs.test.ts`
 *               ("THE FD3-1 SCENARIO: line A lands, line B drifts, and A rolls
 *               back with it"). New home: "PRODUCT_DECLINED is detected after
 *               applyStockDelta and PROPAGATES so the caller's transaction
 *               aborts". REAL rollback is provable only against a real DB — the
 *               concurrency gate (M7a/M7b) owns that half.
 *   DRIFT       old home `__tests__/integration/api/inbound-shipment-costs.test.ts`
 *               (the BASIS_DRIFT family: "PIN 1: a RECOUNT under a write line
 *               refuses — old per-unit costs never land on new units"). New
 *               home: "guarded increment 0 rows -> CONFLICT" and "ceiling from
 *               the locked row".
 *   RETRY       old home `__tests__/integration/api/staging-deadlock-retry.test.ts`
 *               ("is RE-RUN after a P2034 rollback and succeeds on the second
 *               attempt" / "does NOT retry an ordinary refusal"). New home:
 *               "withBookingRetry retries P2034/P2002 only".
 */

import { Prisma, StagingItemStatus, InboundShipmentStatus } from '@prisma/client';

const mockApplyStockDelta = jest.fn();
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  applyStockDelta: (...args: any[]) => mockApplyStockDelta(...args),
  // The house 0 -> null cost conversion runs for real: the D-COST comparison is
  // against the LOCKED costPrice, and that conversion IS the comparison.
  centsFromCostPrice: jest.requireActual('@/lib/inventory').centsFromCostPrice,
}));

// What `applyReceiptCost` itself writes is pinned in
// __tests__/unit/lib/products/cost.test.ts; here it is a seam.
const mockApplyReceiptCost = jest.fn();
jest.mock('@/lib/products/cost', () => ({
  __esModule: true,
  applyReceiptCost: (...args: any[]) => mockApplyReceiptCost(...args),
}));

import {
  bookSupplyOrderBatch,
  discardRemaining,
  withBookingRetry,
  type BookingRecordContext,
  type DiscardRecordContext,
} from '@/lib/supply-orders/booking';
import { CeilingRefusal } from '@/lib/supply-orders/refusals';
import { AppError } from '@/lib/error-handling';

const LINE_ID = 5;
const SHIPMENT = 'ord_1';
const PRODUCT = 42;
const BOOKING_KEY = '11111111-2222-3333-4444-555555555555';
const BATCH = 'BATCH-1';
const ACTOR = { id: 7, isAdmin: false };

/** A locked line: ordered 10, verified 10, nothing stocked, $100.00 the lot. */
function lockedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    status: StagingItemStatus.VERIFIED,
    verifiedQuantity: 10,
    stockedQuantity: 0,
    disposedQuantity: 0,
    resolvedProductId: PRODUCT,
    orderedQuantity: 10,
    lineTotalCents: 10000,
    shipmentId: SHIPMENT,
    locationId: null,
    labelingRequired: true,
    ...overrides,
  };
}

/** The locked product row (step 6b), APPROVED with a $10.00 standing cost. */
function lockedProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT,
    approvalStatus: 'APPROVED',
    deletedAt: null,
    costPrice: new Prisma.Decimal(10),
    ...overrides,
  };
}

type Statement = { kind: string; sql?: string; values?: unknown[]; [k: string]: unknown };

function mkTx(options: {
  line?: Record<string, unknown> | null;
  prior?: Record<string, unknown> | null;
  product?: Record<string, unknown> | null;
  locations?: { id: number; locationId: number; quantity: number }[];
  orderedAt?: Date | null;
  headerWinner?: InboundShipmentStatus | null;
  /** rows the guarded line increment reports */
  lineUpdateCount?: number;
  /** rows the guarded raw discard update reports */
  discardCount?: number;
  /** let the applyStockDelta stub touch products (the location-1 mirror) */
  stockDeltaTouchesProduct?: boolean;
} = {}) {
  const {
    line = lockedLine(),
    prior = null,
    product = lockedProduct(),
    locations = [],
    orderedAt = new Date('2026-08-01T00:00:00.000Z'),
    headerWinner = InboundShipmentStatus.RECEIVING,
    lineUpdateCount = 1,
    discardCount = 1,
    stockDeltaTouchesProduct = false,
  } = options;

  const statements: Statement[] = [];

  const tx: any = {
    statements,
    $queryRaw: jest.fn(async (query: any) => {
      const sql = String(query.sql);
      const values = query.values;
      if (sql.includes('FROM staging_items')) {
        statements.push({ kind: 'line-lock', sql, values });
        return line ? [line] : [];
      }
      if (sql.includes('FROM inventory_logs')) {
        statements.push({ kind: 'idempotency', sql, values });
        return prior ? [prior] : [];
      }
      if (sql.includes('FROM inbound_shipments')) {
        statements.push({ kind: 'header-orderedAt', sql, values });
        return [{ orderedAt }];
      }
      if (sql.includes('FROM product_locations')) {
        statements.push({ kind: 'locations-lock', sql, values });
        return locations;
      }
      if (sql.includes('FROM products')) {
        statements.push({ kind: 'product-lock', sql, values });
        return product ? [product] : [];
      }
      throw new Error(`unexpected raw query: ${sql}`);
    }),
    $executeRaw: jest.fn(async (query: any) => {
      statements.push({ kind: 'raw-write', sql: String(query.sql), values: query.values });
      return discardCount;
    }),
    stagingItem: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        statements.push({ kind: 'line-update', where, data });
        return { count: lineUpdateCount };
      }),
    },
    inboundShipment: {
      updateMany: jest.fn(async ({ where }: any) => {
        statements.push({ kind: 'header-claim', status: where.status });
        return { count: headerWinner !== null && where.status === headerWinner ? 1 : 0 };
      }),
      findUnique: jest.fn(async () => ({ id: SHIPMENT, status: InboundShipmentStatus.CANCELLED })),
    },
    product: {
      findUnique: jest.fn(async () => ({ approvalStatus: product?.approvalStatus ?? 'APPROVED' })),
      update: jest.fn(async () => {
        statements.push({ kind: 'product-update' });
        return {};
      }),
    },
  };

  mockApplyStockDelta.mockImplementation(async () => {
    statements.push({ kind: 'stock-delta' });
    // Step 6 note (PK-10): for location 1 `applyStockDelta` ALSO updates
    // products.quantity, which MAY be the transaction's first product-ROW lock.
    // Legal, because the step-5 range lock already precedes it.
    if (stockDeltaTouchesProduct) await tx.product.update({ where: { id: PRODUCT } });
    return { log: { id: 1 }, newVersion: 1 };
  });

  return tx;
}

const kinds = (tx: any) => tx.statements.map((s: Statement) => s.kind);
const stmt = (tx: any, kind: string) => tx.statements.find((s: Statement) => s.kind === kind);

/** The onRecord hook, capturing the context the route would receive. */
function recorder() {
  const seen: BookingRecordContext[] = [];
  const onRecord = jest.fn(async (_tx: unknown, ctx: BookingRecordContext) => {
    seen.push(ctx);
  });
  return { onRecord, ctx: () => seen[0], calls: () => seen.length };
}

function discardRecorder() {
  const seen: DiscardRecordContext[] = [];
  const onRecord = jest.fn(async (_tx: unknown, ctx: DiscardRecordContext) => {
    seen.push(ctx);
  });
  return { onRecord, ctx: () => seen[0], calls: () => seen.length };
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    lineId: LINE_ID,
    shipmentId: SHIPMENT,
    bookingKey: BOOKING_KEY,
    quantity: 4,
    locationId: 2,
    note: 'first pallet',
    actor: ACTOR,
    ...overrides,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyReceiptCost.mockResolvedValue({
    outcome: 'equal',
    currentCents: 1000,
    receiptCents: 1000,
  });
});

describe('the FROZEN step order (spec §5.2)', () => {
  it('takes the line FOR UPDATE as the transaction\'s FIRST statement, ids nested', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(tx.statements[0].kind).toBe('line-lock');
    const lock = stmt(tx, 'line-lock')!;
    expect(lock.sql).toMatch(/FROM staging_items WHERE id = \? AND shipmentId = \? FOR UPDATE$/);
    expect(lock.values).toEqual([LINE_ID, SHIPMENT]);
  });

  it('reads the idempotency row AFTER the lock, keyed on (line, bookingKey)', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(kinds(tx).indexOf('idempotency')).toBe(1);
    const read = stmt(tx, 'idempotency')!;
    expect(read.sql).toMatch(
      /SELECT id, delta, locationId, unitCostCents, receiptCostCents FROM inventory_logs WHERE stagingItemId = \? AND bookingKey = \?$/,
    );
    expect(read.values).toEqual([LINE_ID, BOOKING_KEY]);
  });

  it('runs the WHOLE order: line -> idempotency -> header -> locations -> stock -> product -> line update -> onRecord', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    // Two header claims: the helper tries the allowed statuses ONE AT A TIME,
    // so ORDERED misses and RECEIVING wins.
    expect(kinds(tx)).toEqual([
      'line-lock',
      'idempotency',
      'header-claim',
      'header-claim',
      'header-orderedAt',
      'locations-lock',
      'stock-delta',
      'product-lock',
      'line-update',
    ]);
    expect(rec.calls()).toBe(1);
  });

  it('takes NO product statement before the step-5 product_locations range lock', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    const order = kinds(tx);
    const rangeLock = order.indexOf('locations-lock');
    expect(rangeLock).toBeGreaterThan(-1);
    for (const productish of ['product-lock', 'product-update']) {
      const at = order.indexOf(productish);
      if (at !== -1) expect(at).toBeGreaterThan(rangeLock);
    }
    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it('PERMITS applyStockDelta\'s location-1 products.quantity update before the 6b read (PK-10)', async () => {
    const tx = mkTx({ stockDeltaTouchesProduct: true });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ locationId: 1 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    const order = kinds(tx);
    expect(order.indexOf('product-update')).toBeGreaterThan(order.indexOf('locations-lock'));
    expect(order.indexOf('product-update')).toBeLessThan(order.indexOf('product-lock'));
  });

  it('locks the product_locations RANGE for the product, ordered by location', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    const lock = stmt(tx, 'locations-lock')!;
    expect(lock.sql).toMatch(
      /SELECT id, locationId, quantity FROM product_locations WHERE productId = \? ORDER BY locationId FOR UPDATE$/,
    );
    expect(lock.values).toEqual([PRODUCT]);
  });

  it('re-reads the product FOR UPDATE at 6b — the AUTHORITATIVE approval/cost/deleted read', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    const lock = stmt(tx, 'product-lock')!;
    expect(lock.sql).toMatch(
      /SELECT id, approvalStatus, deletedAt, costPrice FROM products WHERE id = \? FOR UPDATE$/,
    );
    expect(lock.values).toEqual([PRODUCT]);
  });

  it('claims the header through the REAL claim helper (a cancelled order refuses)', async () => {
    const tx = mkTx({ headerWinner: null });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('refuses a LEGACY header (orderedAt NULL) with 409 NOT_BOOKABLE, before any write', async () => {
    const tx = mkTx({ orderedAt: null });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });
});

describe('the asserts on the LOCKED row', () => {
  it('404s a line that is not on this order (the nested ids are the membership test)', async () => {
    const tx = mkTx({ line: null });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('409 NOT_BOOKABLE names the status of a line that is not VERIFIED|LABELING', async () => {
    for (const status of [
      StagingItemStatus.ORDERED,
      StagingItemStatus.COMPLETE,
      StagingItemStatus.DISCARDED,
      StagingItemStatus.RECEIVED,
    ]) {
      const tx = mkTx({ line: lockedLine({ status }) });
      const rec = recorder();

      const promise = bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });
      await expect(promise).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });
      await expect(promise).rejects.toThrow(new RegExp(status, 'i'));
    }
  });

  it('422s a line whose verifiedQuantity is NULL', async () => {
    const tx = mkTx({ line: lockedLine({ status: StagingItemStatus.LABELING, verifiedQuantity: null }) });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });

  it('422s a line with no resolved product', async () => {
    const tx = mkTx({ line: lockedLine({ resolvedProductId: null }) });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  });

  it('DRIFT (old home inbound-shipment-costs.test.ts BASIS_DRIFT): the ceiling is read from the LOCKED row', async () => {
    // 10 verified, 6 stocked, 1 disposed -> 3 remain; asking for 4 refuses with
    // the LOCKED counters, not with whatever the client was looking at.
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 6, disposedQuantity: 1 }),
    });
    const rec = recorder();

    const promise = bookSupplyOrderBatch(tx, args({ quantity: 4 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    await expect(promise).rejects.toBeInstanceOf(CeilingRefusal);
    await expect(promise).rejects.toMatchObject({
      code: 'CEILING',
      stocked: 6,
      disposed: 1,
      verified: 10,
      requested: 4,
    });
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('counts DISPOSED units against the ceiling (they were verified and are gone)', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 0, disposedQuantity: 8 }),
    });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args({ quantity: 3 }), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toBeInstanceOf(CeilingRefusal);
  });

  it('allows a batch that lands EXACTLY on the ceiling', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 6, disposedQuantity: 1 }),
    });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 3 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.status).toBe(StagingItemStatus.COMPLETE);
    expect(result.remaining).toBe(0);
  });
});

describe('idempotency — replay and mismatch (G2s-6 / G2s2-4)', () => {
  const prior = { id: 91, delta: 4, locationId: 2, unitCostCents: 1000, receiptCostCents: 4000 };

  it('a REPLAY returns the ORIGINAL batch fields and the CURRENT line fields, writing nothing', async () => {
    const tx = mkTx({
      prior,
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4 }),
    });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 4, locationId: 2 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result).toEqual({
      lineId: LINE_ID,
      status: StagingItemStatus.LABELING,
      stockedQuantity: 4,
      disposedQuantity: 0,
      remaining: 6,
      batch: {
        quantity: 4,
        locationId: 2,
        unitCostCents: 1000,
        receiptCostCents: 4000,
        replayed: true,
      },
      productId: PRODUCT,
      approvalStatus: 'APPROVED',
      costPrompt: null,
    });
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockApplyReceiptCost).not.toHaveBeenCalled();
    expect(tx.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(rec.calls()).toBe(0);
    expect(kinds(tx)).toEqual(['line-lock', 'idempotency']);
  });

  it('a replay reports the product\'s CURRENT approval status', async () => {
    const tx = mkTx({ prior, line: lockedLine({ stockedQuantity: 4 }) });
    tx.product.findUnique.mockResolvedValue({ approvalStatus: 'PENDING_REVIEW' });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 4 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.approvalStatus).toBe('PENDING_REVIEW');
  });

  it('a DIFFERENT quantity under the same key is 409 IDEMPOTENCY_MISMATCH', async () => {
    const tx = mkTx({ prior });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args({ quantity: 5, locationId: 2 }), {
        onRecord: rec.onRecord,
        batchId: BATCH,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_MISMATCH' });
    expect(mockApplyStockDelta).not.toHaveBeenCalled();
  });

  it('says it in the OPERATOR\'s frame — no booking keys (REV-10 clause 10)', async () => {
    const tx = mkTx({ prior });
    const rec = recorder();

    const error = await bookSupplyOrderBatch(tx, args({ quantity: 5, locationId: 2 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    }).catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    // The person reading this is standing at a bench with a printed label; a
    // sentence about idempotency keys tells them nothing they can act on.
    expect((error as Error).message).not.toMatch(/booking key/i);
    expect((error as Error).message).toBe(
      'Already recorded 4 unit(s) for this attempt into location 2; 5 unit(s) into location 2 is a different batch — reload to see the current count, then record it again.',
    );
  });

  it('a DIFFERENT location under the same key is 409 IDEMPOTENCY_MISMATCH', async () => {
    const tx = mkTx({ prior });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args({ quantity: 4, locationId: 3 }), {
        onRecord: rec.onRecord,
        batchId: BATCH,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('the replay path never claims the header (it writes nothing at all)', async () => {
    const tx = mkTx({ prior, line: lockedLine({ stockedQuantity: 4 }) });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(tx.inboundShipment.updateMany).not.toHaveBeenCalled();
  });
});

describe('the money (D4) and the ledger row', () => {
  it('stamps the LINE unit cost and the EXACT batch share on the ledger row, with every passthrough', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4, locationId: 2 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(mockApplyStockDelta).toHaveBeenCalledWith(tx, {
      userId: ACTOR.id,
      productId: PRODUCT,
      locationId: 2,
      delta: 4,
      logType: 'STOCK_IN',
      unitCostCents: 1000,
      inboundShipmentId: SHIPMENT,
      stagingItemId: LINE_ID,
      receiptCostCents: 4000,
      bookingKey: BOOKING_KEY,
      batchId: BATCH,
    });
  });

  it('EXACTNESS: the batch share is cumulative(after) - cumulative(before), never unit x qty', async () => {
    // $100.01 over 3 ordered units: 3333 / 3334 / 3334 — the 10001/3 family.
    const tx = mkTx({
      line: lockedLine({
        orderedQuantity: 3,
        verifiedQuantity: 3,
        lineTotalCents: 10001,
        status: StagingItemStatus.LABELING,
        stockedQuantity: 1,
      }),
    });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 1 }), { onRecord: rec.onRecord, batchId: BATCH });

    const call = mockApplyStockDelta.mock.calls[0][1];
    expect(call.receiptCostCents).toBe(3334);
    expect(call.unitCostCents).toBe(3334);
  });

  it('an UNORDERED line is priced from the LOCKED verified count and orderedQuantity is NEVER written', async () => {
    const tx = mkTx({
      line: lockedLine({ orderedQuantity: null, verifiedQuantity: 5, lineTotalCents: 500 }),
    });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 2 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBe(100);
    expect(mockApplyStockDelta.mock.calls[0][1].receiptCostCents).toBe(200);
    expect(stmt(tx, 'line-update')!.data).not.toHaveProperty('orderedQuantity');
  });

  it('BASIS FREEZE: basisFrozen is true only on an unordered line\'s FIRST batch', async () => {
    const first = mkTx({ line: lockedLine({ orderedQuantity: null, verifiedQuantity: 5, lineTotalCents: 500 }) });
    const firstRec = recorder();
    await bookSupplyOrderBatch(first, args({ quantity: 2 }), {
      onRecord: firstRec.onRecord,
      batchId: BATCH,
    });
    expect(firstRec.ctx().basisFrozen).toBe(true);
    expect(firstRec.ctx().firstBatch).toBe(true);

    const second = mkTx({
      line: lockedLine({
        orderedQuantity: null,
        verifiedQuantity: 5,
        lineTotalCents: 500,
        stockedQuantity: 2,
        status: StagingItemStatus.LABELING,
      }),
    });
    const secondRec = recorder();
    await bookSupplyOrderBatch(second, args({ quantity: 1 }), {
      onRecord: secondRec.onRecord,
      batchId: BATCH,
    });
    expect(secondRec.ctx().basisFrozen).toBe(false);

    const ordered = mkTx();
    const orderedRec = recorder();
    await bookSupplyOrderBatch(ordered, args({ quantity: 1 }), {
      onRecord: orderedRec.onRecord,
      batchId: BATCH,
    });
    expect(orderedRec.ctx().basisFrozen).toBe(false);
  });

  it('an UNPRICED line books NULL money rather than a $0.00 (truthful data)', async () => {
    const tx = mkTx({ line: lockedLine({ lineTotalCents: null }) });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 4 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(mockApplyStockDelta.mock.calls[0][1].unitCostCents).toBeNull();
    expect(mockApplyStockDelta.mock.calls[0][1].receiptCostCents).toBeNull();
    expect(result.batch.receiptCostCents).toBeNull();
  });
});

describe('step 6b — the product gate', () => {
  it('ATOMICITY (old home graduate.test.ts "the NULL-count throw escapes $transaction"): PRODUCT_DECLINED is detected AFTER applyStockDelta and PROPAGATES so the caller\'s transaction aborts', async () => {
    const tx = mkTx({ product: lockedProduct({ deletedAt: new Date('2026-08-16T00:00:00.000Z') }) });
    const rec = recorder();

    const promise = bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    await expect(promise).rejects.toMatchObject({ statusCode: 409, code: 'PRODUCT_DECLINED' });
    // The ledger write HAPPENED and is rolled back BY the throw — that is the
    // whole rollback contract at this level (the real rollback is proven against
    // a real DB in the concurrency gate, M7a/M7b).
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    expect(kinds(tx)).toEqual([
      'line-lock',
      'idempotency',
      'header-claim',
      'header-claim',
      'header-orderedAt',
      'locations-lock',
      'stock-delta',
      'product-lock',
    ]);
    // Nothing after the gate ran: no counter increment, no subjects, no record.
    expect(tx.stagingItem.updateMany).not.toHaveBeenCalled();
    expect(rec.calls()).toBe(0);
  });

  it('404s when the product row vanished under the lock', async () => {
    const tx = mkTx({ product: null });
    const rec = recorder();

    await expect(
      bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });
});

describe('D-COST (step 7) and the subjects the ROUTE writes', () => {
  it('runs applyReceiptCost on the FIRST batch only, with the LINE unit cost', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(mockApplyReceiptCost).toHaveBeenCalledWith(tx, {
      productId: PRODUCT,
      receiptCents: 1000,
      actor: ACTOR,
      batchId: BATCH,
    });
  });

  it('does NOT re-run D-COST on a later batch (the prompt fires once per line)', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4 }),
    });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 2 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(mockApplyReceiptCost).not.toHaveBeenCalled();
    expect(rec.ctx().costDiffers).toBeNull();
    expect(rec.ctx().costPrompt).toBeNull();
  });

  it('decides the DIFFER from the LOCKED costPrice, not from a read taken behind the lock', async () => {
    // The stub reports "equal" from a stale snapshot; the LOCKED row says $9.00
    // against a $10.00 line cost, and the locked row is the truth.
    mockApplyReceiptCost.mockResolvedValue({ outcome: 'equal', currentCents: 1000, receiptCents: 1000 });
    const tx = mkTx({ product: lockedProduct({ costPrice: new Prisma.Decimal(9) }) });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().costDiffers).toEqual({
      productId: PRODUCT,
      stagingItemId: LINE_ID,
      currentCents: 900,
      receiptCents: 1000,
    });
  });

  it('a FILLED cost is never a differ (this receipt is where the number came from)', async () => {
    mockApplyReceiptCost.mockResolvedValue({ outcome: 'filled', currentCents: null, receiptCents: 1000 });
    const tx = mkTx({ product: lockedProduct({ costPrice: null }) });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().costDiffers).toBeNull();
    expect(rec.ctx().costPrompt).toBeNull();
  });

  it('the ADMIN also gets the prompt; everybody gets the durable subject', async () => {
    mockApplyReceiptCost.mockResolvedValue({ outcome: 'differs', currentCents: 900, receiptCents: 1000 });
    const tx = mkTx({ product: lockedProduct({ costPrice: new Prisma.Decimal(9) }) });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(
      tx,
      args({ quantity: 4, actor: { id: 3, isAdmin: true } }),
      { onRecord: rec.onRecord, batchId: BATCH },
    );

    expect(result.costPrompt).toEqual({ productId: PRODUCT, currentCents: 900, receiptCents: 1000 });
    expect(rec.ctx().costDiffers).not.toBeNull();
  });

  it('a NON-admin gets the subject and NO prompt', async () => {
    const tx = mkTx({ product: lockedProduct({ costPrice: new Prisma.Decimal(9) }) });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 4 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.costPrompt).toBeNull();
    expect(rec.ctx().costDiffers).not.toBeNull();
  });

  it('PENDING units are the LOCKED on-hand sum plus this batch (D10), not the batch alone', async () => {
    const tx = mkTx({
      product: lockedProduct({ approvalStatus: 'PENDING_REVIEW' }),
      locations: [
        { id: 1, locationId: 1, quantity: 6 },
        { id: 2, locationId: 2, quantity: 3 },
      ],
    });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().pendingWithStock).toEqual({
      productId: PRODUCT,
      stagingItemId: LINE_ID,
      units: 13,
    });
    expect(rec.ctx().approvalStatus).toBe('PENDING_REVIEW');
  });

  it('raises NO pending subject for an APPROVED product', async () => {
    const tx = mkTx({ locations: [{ id: 1, locationId: 1, quantity: 6 }] });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().pendingWithStock).toBeNull();
  });

  it('S20: a line with a prior DISPOSAL carries the labeling-loss REFRESH subject, cumulative', async () => {
    // 10 verified, $100.00; 2 already stocked, 3 disposed. This batch stocks 2
    // more, so the loss slice is cumulative(4 + 3) - cumulative(4) = 3000.
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        stockedQuantity: 2,
        disposedQuantity: 3,
      }),
    });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 2 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().labelingLossRefresh).toEqual({
      stagingItemId: LINE_ID,
      shipmentId: SHIPMENT,
      productId: PRODUCT,
      units: 3,
      unitCostCents: 1000,
      lossCents: 3000,
      reason: expect.any(String),
    });
  });

  it('the refresh KEEPS null on an unpriced line (REV-10 clause 8)', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        stockedQuantity: 2,
        disposedQuantity: 3,
        lineTotalCents: null,
      }),
    });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 2 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().labelingLossRefresh).toMatchObject({
      units: 3,
      unitCostCents: null,
      lossCents: null,
    });
  });

  it('carries NO labeling-loss subject when the line has never disposed anything', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().labelingLossRefresh).toBeNull();
  });
});

describe('step 8 — the guarded increment', () => {
  it('DRIFT: the WHERE carries the LOCKED stockedQuantity, and 0 rows is a CONFLICT', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4 }),
      lineUpdateCount: 0,
    });
    const rec = recorder();

    const promise = bookSupplyOrderBatch(tx, args({ quantity: 2 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    await expect(promise).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(stmt(tx, 'line-update')!.where).toEqual({ id: LINE_ID, stockedQuantity: 4 });
    expect(rec.calls()).toBe(0);
  });

  it('increments the counter, stamps the status and writes the submitted location as the next-batch default', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4, locationId: 2 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(stmt(tx, 'line-update')!.data).toEqual({
      stockedQuantity: { increment: 4 },
      status: StagingItemStatus.LABELING,
      locationId: 2,
    });
  });

  it('is COMPLETE exactly when verified - stocked - disposed reaches 0', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 5, disposedQuantity: 2 }),
    });
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 3 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(stmt(tx, 'line-update')!.data.status).toBe(StagingItemStatus.COMPLETE);
    expect(result.status).toBe(StagingItemStatus.COMPLETE);
    expect(result.remaining).toBe(0);
    expect(result.stockedQuantity).toBe(8);
  });
});

describe('the onRecord context + the response (seams S4/S12)', () => {
  it('hands the route every field the audit and the exception writes need', async () => {
    const tx = mkTx({ locations: [{ id: 1, locationId: 2, quantity: 1 }] });
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 4, locationId: 2, note: 'first pallet' }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx()).toEqual({
      lineId: LINE_ID,
      shipmentId: SHIPMENT,
      productId: PRODUCT,
      approvalStatus: 'APPROVED',
      quantity: 4,
      locationId: 2,
      unitCostCents: 1000,
      receiptCostCents: 4000,
      stockedAfter: 4,
      disposed: 0,
      verified: 10,
      remaining: 6,
      firstBatch: true,
      fastPath: false,
      basisFrozen: false,
      bookingKey: BOOKING_KEY,
      note: 'first pallet',
      batchId: BATCH,
      replayed: false,
      costDiffers: null,
      pendingWithStock: null,
      labelingLossRefresh: null,
      costPrompt: null,
    });
  });

  it('names the FAST PATH: one batch off a VERIFIED line that finishes it', async () => {
    const tx = mkTx();
    const rec = recorder();

    await bookSupplyOrderBatch(tx, args({ quantity: 10 }), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().fastPath).toBe(true);
    expect(rec.ctx().firstBatch).toBe(true);
  });

  it('an onRecord throw PROPAGATES (the route\'s failed audit aborts the booking)', async () => {
    const tx = mkTx();
    const boom = new Error('audit unavailable');

    await expect(
      bookSupplyOrderBatch(tx, args(), {
        onRecord: async () => {
          throw boom;
        },
        batchId: BATCH,
      }),
    ).rejects.toBe(boom);
  });

  it('answers the route with the batch and the line as they now stand', async () => {
    const tx = mkTx();
    const rec = recorder();

    const result = await bookSupplyOrderBatch(tx, args({ quantity: 4, locationId: 2 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result).toEqual({
      lineId: LINE_ID,
      status: StagingItemStatus.LABELING,
      stockedQuantity: 4,
      disposedQuantity: 0,
      remaining: 6,
      batch: {
        quantity: 4,
        locationId: 2,
        unitCostCents: 1000,
        receiptCostCents: 4000,
        replayed: false,
      },
      productId: PRODUCT,
      approvalStatus: 'APPROVED',
      costPrompt: null,
    });
  });
});

describe('withBookingRetry (seam S13) — RETRY, old home staging-deadlock-retry.test.ts', () => {
  it('is RE-RUN after a P2034 rollback and succeeds on the second attempt', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('write conflict'), { code: 'P2034' }))
      .mockResolvedValue('ok');

    await expect(withBookingRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('is re-run for the raw MySQL 1213 shape too (no Prisma code at all)', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Deadlock found when trying to get lock; try restarting transaction'))
      .mockResolvedValue('ok');

    await expect(withBookingRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('is re-run on P2002 — the UNIQUE (stagingItemId, bookingKey) race resolves as a REPLAY', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }))
      .mockResolvedValue('replayed');

    await expect(withBookingRetry(fn)).resolves.toBe('replayed');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry an ordinary refusal — a raced claim is an ANSWER (409, once)', async () => {
    const refusal = new AppError('Only 3 remain', 'CEILING', 409);
    const fn = jest.fn().mockRejectedValue(refusal);

    await expect(withBookingRetry(fn)).rejects.toBe(refusal);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a structured refusal either', async () => {
    const refusal = new CeilingRefusal(6, 1, 10, 4);
    const fn = jest.fn().mockRejectedValue(refusal);

    await expect(withBookingRetry(fn)).rejects.toBe(refusal);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded attempts and rethrows the last error', async () => {
    const err = Object.assign(new Error('write conflict'), { code: 'P2034' });
    const fn = jest.fn().mockRejectedValue(err);

    await expect(withBookingRetry(fn, 3)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('REGENERATES NOTHING: the caller\'s fn is re-run verbatim', async () => {
    const seen: unknown[] = [];
    const fn = jest.fn(async () => {
      seen.push(BATCH);
      if (seen.length === 1) throw Object.assign(new Error('deadlock'), { code: 'P2034' });
      return 'ok';
    });

    await withBookingRetry(fn);

    expect(fn).toHaveBeenCalledWith();
    expect(seen).toEqual([BATCH, BATCH]);
  });
});

describe('discardRemaining — the same prologue, the labeling-loss half (§4.3.5)', () => {
  const discardArgs = (overrides: Record<string, unknown> = {}) =>
    ({
      lineId: LINE_ID,
      shipmentId: SHIPMENT,
      reason: 'crushed in the labeler',
      actor: ACTOR,
      ...overrides,
    }) as any;

  it('takes the line FOR UPDATE first, then claims the header — the booking prologue', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4 }),
    });
    const rec = discardRecorder();

    await discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(kinds(tx).slice(0, 4)).toEqual([
      'line-lock',
      // ORDERED misses, RECEIVING wins — the claim is tried one status at a time.
      'header-claim',
      'header-claim',
      'header-orderedAt',
    ]);
    expect(stmt(tx, 'line-lock')!.values).toEqual([LINE_ID, SHIPMENT]);
  });

  it('REV-11 clause 1: a STALE expectRemaining is a 409 CONFLICT naming the locked counters', async () => {
    // 10 verified, 4 stocked, 1 disposed -> 5 left. The card said 6, so the card
    // is older than the line: writing off "the remainder" here would dispose a
    // number the operator never saw.
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4, disposedQuantity: 1 }),
    });
    const rec = discardRecorder();

    await expect(
      discardRemaining(tx, discardArgs({ expectRemaining: 6 }), {
        onRecord: rec.onRecord,
        batchId: BATCH,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message:
        'The remainder changed since you loaded this line — it is now 5 (verified 10, stocked 4, disposed 1). Reload and try again.',
    });
    // BEFORE the claim and before every write: the lock is the ONLY statement.
    expect(kinds(tx)).toEqual(['line-lock']);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(rec.calls()).toBe(0);
  });

  it('fix-delta 5 FD5-2: on a COMPLETE line a stale expectRemaining is answered with the COUNTERS (CONFLICT), not with NOT_BOOKABLE', async () => {
    // The likeliest stale card: a colleague finished the line. The operator needs
    // the counters, not a sentence about stocking.
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.COMPLETE, stockedQuantity: 10, disposedQuantity: 0 }),
    });
    const rec = discardRecorder();
    await expect(
      discardRemaining(tx, discardArgs({ expectRemaining: 4 }), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(kinds(tx)).toEqual(['line-lock']);
    // With NO belief stated the status assert still answers (the gate drives it that way).
    const tx2 = mkTx({
      line: lockedLine({ status: StagingItemStatus.COMPLETE, stockedQuantity: 10, disposedQuantity: 0 }),
    });
    await expect(
      discardRemaining(tx2, discardArgs({}), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });
  });

  it('fix-delta 6 FD6-2: a NEVER-VERIFIED line with a stated belief still answers NOT_BOOKABLE (null is not 0)', async () => {
    const tx = mkTx({ line: lockedLine({ status: StagingItemStatus.ORDERED, verifiedQuantity: null }) });
    await expect(
      discardRemaining(tx, discardArgs({ expectRemaining: 3 }), { onRecord: jest.fn(), batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });
  });

  it('REV-11 clause 1: an expectRemaining that MATCHES the locked remainder proceeds', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4, disposedQuantity: 1 }),
    });
    const rec = discardRecorder();

    const result = await discardRemaining(tx, discardArgs({ expectRemaining: 5 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result).toMatchObject({ disposedQuantity: 6, remaining: 0 });
    expect(rec.calls()).toBe(1);
  });

  it('REV-11 clause 1: an ABSENT expectRemaining asserts NOTHING (the gate drives it that way)', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4, disposedQuantity: 1 }),
    });
    const rec = discardRecorder();

    // No belief was stated, so there is nothing to contradict — the primitive
    // stays callable by a caller that never rendered a card.
    await expect(
      discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).resolves.toMatchObject({ disposedQuantity: 6 });
  });

  it('refuses a line with NOTHING remaining — 409 NOT_BOOKABLE, idempotent by construction', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 6, disposedQuantity: 4 }),
    });
    const rec = discardRecorder();

    await expect(
      discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('writes the GUARDED raw update: disposed += remaining, status COMPLETE, WHERE the locked disposal', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4, disposedQuantity: 1 }),
    });
    const rec = discardRecorder();

    await discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH });

    const write = stmt(tx, 'raw-write')!;
    expect(write.sql).toMatch(
      /UPDATE staging_items SET disposedQuantity = disposedQuantity \+ \?, status = \?, updatedAt = NOW\(\) WHERE id = \? AND disposedQuantity = \?$/,
    );
    expect(write.values).toEqual([5, StagingItemStatus.COMPLETE, LINE_ID, 1]);
  });

  it('DRIFT: 0 rows from the guarded update is a CONFLICT (somebody else disposed first)', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4 }),
      discardCount: 0,
    });
    const rec = discardRecorder();

    await expect(
      discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(rec.calls()).toBe(0);
  });

  it('hands the route the CUMULATIVE labeling-loss subject and the remainder', async () => {
    // 10 verified at $100.00; 4 stocked, 1 already disposed. The remaining 5 are
    // lost: disposed becomes 6, and the loss is cumulative(4 + 6) - cumulative(4)
    // = 10000 - 4000 = 6000.
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, stockedQuantity: 4, disposedQuantity: 1 }),
    });
    const rec = discardRecorder();

    const result = await discardRemaining(tx, discardArgs(), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx()).toEqual({
      lineId: LINE_ID,
      shipmentId: SHIPMENT,
      productId: PRODUCT,
      reason: 'crushed in the labeler',
      discarded: 5,
      disposedAfter: 6,
      stockedQuantity: 4,
      verified: 10,
      remaining: 0,
      unitCostCents: 1000,
      lossCents: 6000,
      labelingLoss: {
        stagingItemId: LINE_ID,
        shipmentId: SHIPMENT,
        productId: PRODUCT,
        units: 6,
        unitCostCents: 1000,
        lossCents: 6000,
        reason: 'crushed in the labeler',
      },
      batchId: BATCH,
    });
    expect(result).toEqual({
      lineId: LINE_ID,
      status: StagingItemStatus.COMPLETE,
      disposedQuantity: 6,
      stockedQuantity: 4,
      remaining: 0,
    });
  });

  it('NEVER moves stock — a discard is not a movement (the units were never stock)', async () => {
    const tx = mkTx({ line: lockedLine({ status: StagingItemStatus.LABELING }) });
    const rec = discardRecorder();

    await discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(mockApplyStockDelta).not.toHaveBeenCalled();
    expect(mockApplyReceiptCost).not.toHaveBeenCalled();
  });

  it("an UNPRICED line's loss is UNKNOWN — null, never a fabricated 0 (REV-10 clause 8)", async () => {
    // CONTRACT CHANGE (codex CR-5): this pin previously demanded 0. An unbilled
    // unordered arrival has no lineTotalCents at all, so what its lost units
    // cost is not zero — it is not recorded. $0.00 on the register would read as
    // a settled, costless write-off.
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, lineTotalCents: null }),
    });
    const rec = discardRecorder();

    await discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().lossCents).toBeNull();
    expect(rec.ctx().labelingLoss.lossCents).toBeNull();
    expect(rec.ctx().labelingLoss.unitCostCents).toBeNull();
  });

  it('a REAL lineTotalCents of 0 is a KNOWN zero and stays 0', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, lineTotalCents: 0 }),
    });
    const rec = discardRecorder();

    await discardRemaining(tx, discardArgs(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().lossCents).toBe(0);
    expect(rec.ctx().labelingLoss.lossCents).toBe(0);
  });

  it('refuses a line that was never verified (422) and a legacy header (409)', async () => {
    const unverified = mkTx({ line: lockedLine({ status: StagingItemStatus.ORDERED, verifiedQuantity: null }) });
    await expect(
      discardRemaining(unverified, discardArgs(), { onRecord: jest.fn(), batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });

    const legacy = mkTx({ line: lockedLine({ status: StagingItemStatus.LABELING }), orderedAt: null });
    await expect(
      discardRemaining(legacy, discardArgs(), { onRecord: jest.fn(), batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'NOT_BOOKABLE' });
  });
});
