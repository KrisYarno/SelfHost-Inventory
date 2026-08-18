/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/verify.ts` — THE VERIFY CORE (spec §4.0 /
 * §4.2, contract pack C2c.1; seams S2/S10/S11/S15).
 *
 * Verify is the act that turns an ORDER into a RECEIPT: somebody stood at the
 * dock, counted what arrived, and said so. Everything else in the lane hangs off
 * that number — the labeling ceiling, the money, the supplier discrepancy — so
 * the core's whole job is to move it ONLY when moving it is still honest.
 *
 * THE TRANSITION MATRIX (PK2-1) is the contract:
 *
 *   ORDERED                     -> `first`  -> VERIFIED (even at 0)
 *   VERIFIED|LABELING|COMPLETE  -> `raise`  when requested > locked verified
 *                               -> `lower`  otherwise (an EQUAL request is a
 *                                           lower of delta 0: re-stamp only)
 *   `raise` from COMPLETE       -> LABELING (box 2 arrived after the line closed)
 *   `lower` on LABELING to exactly stocked+disposed -> COMPLETE
 *   otherwise the locked status is preserved
 *
 * and the refusals are the same rule from the other side: a count may never
 * claim FEWER units arrived than the ledger already booked, and an UNORDERED
 * line's count may not move at all once anything is stocked or disposed
 * (its verified count IS the money basis — D4).
 *
 * The tx is MOCKED and records every statement in order, because the order is
 * part of the contract: line FOR UPDATE -> header claim (the legacy
 * discriminator lives inside it) -> promotion -> product resolve -> the ONE
 * guarded line write -> onRecord.
 */

import { Prisma, StagingItemStatus, InboundShipmentStatus } from '@prisma/client';

const mockResolveProduct = jest.fn();
jest.mock('@/lib/supply-orders/product-resolve', () => ({
  __esModule: true,
  resolveSupplyOrderProduct: (...args: unknown[]) => mockResolveProduct(...args),
}));

import { verifyLine, type VerifyRecordContext } from '@/lib/supply-orders/verify';
import { lineMoney } from '@/lib/supply-orders/money';
import { VerifiedLockedRefusal } from '@/lib/supply-orders/refusals';
import { AppError } from '@/lib/error-handling';

const LINE_ID = 5;
const SHIPMENT = 'ord_1';
const PRODUCT = 42;
const BATCH = 'BATCH-1';
const ACTOR = { id: 7, isAdmin: false };

/** A locked line: ordered 10 of product 42, nothing verified, $100.00 the lot. */
function lockedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    status: StagingItemStatus.ORDERED,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    resolvedProductId: PRODUCT,
    orderedProductId: PRODUCT,
    orderedQuantity: 10,
    lineTotalCents: 10000,
    shipmentId: SHIPMENT,
    locationId: null,
    labelingRequired: true,
    ...overrides,
  };
}

type Statement = { kind: string; sql?: string; values?: unknown[]; [k: string]: unknown };

function mkTx(options: {
  line?: Record<string, unknown> | null;
  orderedAt?: Date | null;
  headerWinner?: InboundShipmentStatus | null;
  promoted?: boolean;
  lineUpdateCount?: number;
} = {}) {
  const {
    line = lockedLine(),
    orderedAt = new Date('2026-08-01T00:00:00.000Z'),
    headerWinner = InboundShipmentStatus.ORDERED,
    promoted = true,
    lineUpdateCount = 1,
  } = options;

  const statements: Statement[] = [];

  const tx: Record<string, unknown> & { statements: Statement[] } = {
    statements,
    $queryRaw: jest.fn(async (query: { sql: string; values: unknown[] }) => {
      const sql = String(query.sql);
      if (sql.includes('FROM staging_items')) {
        statements.push({ kind: 'line-lock', sql, values: query.values });
        return line ? [line] : [];
      }
      if (sql.includes('FROM inbound_shipments')) {
        statements.push({ kind: 'header-orderedAt', sql, values: query.values });
        return [{ orderedAt }];
      }
      throw new Error(`unexpected raw query: ${sql}`);
    }),
    stagingItem: {
      updateMany: jest.fn(async ({ where, data }: { where: unknown; data: unknown }) => {
        statements.push({ kind: 'line-update', where, data });
        return { count: lineUpdateCount };
      }),
    },
    inboundShipment: {
      updateMany: jest.fn(
        async ({ where, data }: { where: { status?: unknown }; data: { status?: unknown } }) => {
          if (where.status === data.status) {
            statements.push({ kind: 'header-claim', status: where.status });
            return { count: headerWinner !== null && where.status === headerWinner ? 1 : 0 };
          }
          statements.push({ kind: 'header-promote', from: where.status, to: data.status });
          return { count: promoted ? 1 : 0 };
        },
      ),
      findUnique: jest.fn(async () => ({
        id: SHIPMENT,
        status: InboundShipmentStatus.CANCELLED,
      })),
    },
  };

  return tx as never as Parameters<typeof verifyLine>[0] & { statements: Statement[] };
}

const kinds = (tx: { statements: Statement[] }) => tx.statements.map((s) => s.kind);
const stmt = (tx: { statements: Statement[] }, kind: string) =>
  tx.statements.find((s) => s.kind === kind);

function recorder() {
  const seen: VerifyRecordContext[] = [];
  const onRecord = jest.fn(async (_tx: unknown, ctx: VerifyRecordContext) => {
    seen.push(ctx);
  });
  return { onRecord, ctx: () => seen[0], calls: () => seen.length };
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    lineId: LINE_ID,
    shipmentId: SHIPMENT,
    verifiedQuantity: 10,
    note: null,
    actor: ACTOR,
    ...overrides,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveProduct.mockResolvedValue({
    productId: 77,
    productName: 'Substitute Y 5mg',
    approvalStatus: 'APPROVED',
    created: false,
    locationId: 1,
  });
});

describe('the prologue: locks, ids and the legacy discriminator', () => {
  it('takes the line FOR UPDATE as the FIRST statement, ids nested', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(tx.statements[0].kind).toBe('line-lock');
    const lock = stmt(tx, 'line-lock')!;
    expect(lock.sql).toMatch(/FROM staging_items WHERE id = \? AND shipmentId = \? FOR UPDATE$/);
    expect(lock.values).toEqual([LINE_ID, SHIPMENT]);
  });

  it('answers 404 when the line is not on THIS order', async () => {
    const tx = mkTx({ line: null });
    const rec = recorder();

    await expect(
      verifyLine(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(kinds(tx)).toEqual(['line-lock']);
  });

  it('refuses a LEGACY header with 409 LEGACY_READ_ONLY (orderedAt IS NULL)', async () => {
    const tx = mkTx({ orderedAt: null });
    const rec = recorder();

    await expect(
      verifyLine(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LEGACY_READ_ONLY' });
    expect(kinds(tx)).not.toContain('line-update');
  });

  it('claims the header BEFORE it touches a product, and promotes ORDERED -> RECEIVING', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ deliveredProduct: { mode: 'existing', productId: 77 } }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    const order = kinds(tx);
    expect(order.indexOf('header-claim')).toBeLessThan(order.indexOf('line-update'));
    expect(stmt(tx, 'header-promote')).toMatchObject({
      from: InboundShipmentStatus.ORDERED,
      to: InboundShipmentStatus.RECEIVING,
    });
    expect(rec.ctx().headerPromoted).toBe(true);
    // The house lock order: line -> header -> products.
    expect(mockResolveProduct.mock.invocationCallOrder[0]).toBeGreaterThan(
      (tx.inboundShipment as unknown as { updateMany: jest.Mock }).updateMany.mock
        .invocationCallOrder[0],
    );
  });

  it('`headerPromoted` is FALSE for the loser of two concurrent first verifies', async () => {
    const tx = mkTx({ headerWinner: InboundShipmentStatus.RECEIVING, promoted: false });
    const rec = recorder();

    await verifyLine(tx, args(), { onRecord: rec.onRecord, batchId: BATCH });

    expect(rec.ctx().headerPromoted).toBe(false);
  });
});

describe('the FIRST-VERIFY claim (PK2-1)', () => {
  it('is a guarded updateMany whose WHERE is the whole precondition', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 7, note: 'two short' }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    const write = stmt(tx, 'line-update')!;
    expect(write.where).toEqual({
      id: LINE_ID,
      shipmentId: SHIPMENT,
      status: StagingItemStatus.ORDERED,
      verifiedQuantity: null,
      stockedQuantity: 0,
      disposedQuantity: 0,
    });
    expect(write.data).toMatchObject({
      status: StagingItemStatus.VERIFIED,
      verifiedQuantity: 7,
      verifiedBy: ACTOR.id,
    });
    expect((write.data as { verifiedAt: Date }).verifiedAt).toBeInstanceOf(Date);
    // NEVER writes orderedQuantity: an unordered line stays unordered, and an
    // ordered one keeps the number that was ordered (D4/PK-5).
    expect(write.data).not.toHaveProperty('orderedQuantity');
  });

  it('answers 409 CONFLICT when the claim matches no row', async () => {
    const tx = mkTx({ lineUpdateCount: 0 });
    const rec = recorder();

    await expect(
      verifyLine(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    expect(rec.calls()).toBe(0);
  });

  it('a first verify of 0 stays VERIFIED (remaining 0, not queued, order can close)', async () => {
    const tx = mkTx();
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 0 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.status).toBe(StagingItemStatus.VERIFIED);
    expect(result.verifiedQuantity).toBe(0);
    expect(result.remaining).toBe(0);
    expect(rec.ctx().kind).toBe('first');
  });

  it('writes labelingRequired only when the caller sent one', async () => {
    const silent = mkTx();
    await verifyLine(silent, args(), { onRecord: recorder().onRecord, batchId: BATCH });
    expect(stmt(silent, 'line-update')!.data).not.toHaveProperty('labelingRequired');

    const explicit = mkTx();
    await verifyLine(explicit, args({ labelingRequired: false }), {
      onRecord: recorder().onRecord,
      batchId: BATCH,
    });
    expect(stmt(explicit, 'line-update')!.data).toMatchObject({ labelingRequired: false });
  });
});

describe('the transition matrix (spec §4.0)', () => {
  it('classifies a HIGHER request on a VERIFIED line as a raise, keyed on the locked values', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.VERIFIED, verifiedQuantity: 8 }),
    });
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 10 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().kind).toBe('raise');
    expect(rec.ctx().delta).toBe(2);
    expect(rec.ctx().previousVerified).toBe(8);
    expect(result.status).toBe(StagingItemStatus.VERIFIED);
    expect(stmt(tx, 'line-update')!.where).toEqual({
      id: LINE_ID,
      shipmentId: SHIPMENT,
      status: StagingItemStatus.VERIFIED,
      verifiedQuantity: 8,
    });
    // The receipt act stays the FIRST verify: a later change is audited, not re-stamped.
    expect(stmt(tx, 'line-update')!.data).not.toHaveProperty('verifiedAt');
    expect(stmt(tx, 'line-update')!.data).not.toHaveProperty('verifiedBy');
  });

  it('a RAISE on a COMPLETE line returns it to LABELING (box 2 after the close)', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.COMPLETE,
        verifiedQuantity: 10,
        stockedQuantity: 10,
      }),
    });
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 12 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.status).toBe(StagingItemStatus.LABELING);
    expect(result.remaining).toBe(2);
    expect(rec.ctx().kind).toBe('raise');
  });

  it('a LOWER on a LABELING line down to exactly stocked+disposed -> COMPLETE', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        verifiedQuantity: 10,
        stockedQuantity: 6,
        disposedQuantity: 1,
      }),
    });
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 7 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.status).toBe(StagingItemStatus.COMPLETE);
    expect(result.remaining).toBe(0);
    expect(rec.ctx().kind).toBe('lower');
    expect(rec.ctx().delta).toBe(-3);
  });

  it('a LOWER that leaves work outstanding keeps LABELING', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        verifiedQuantity: 10,
        stockedQuantity: 4,
      }),
    });
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 8 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.status).toBe(StagingItemStatus.LABELING);
    expect(result.remaining).toBe(4);
  });

  it('an EQUAL request is a `lower` of delta 0 — it re-stamps note/flags only', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.VERIFIED, verifiedQuantity: 10 }),
    });
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 10, labelingRequired: false }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().kind).toBe('lower');
    expect(rec.ctx().delta).toBe(0);
    expect(result.status).toBe(StagingItemStatus.VERIFIED);
    expect(stmt(tx, 'line-update')!.data).toMatchObject({
      verifiedQuantity: 10,
      labelingRequired: false,
    });
  });

  it('refuses a verify on a DISCARDED line (no verifiable state left)', async () => {
    const tx = mkTx({ line: lockedLine({ status: StagingItemStatus.DISCARDED }) });
    const rec = recorder();

    await expect(
      verifyLine(tx, args(), { onRecord: rec.onRecord, batchId: BATCH }),
    ).rejects.toBeInstanceOf(AppError);
    expect(kinds(tx)).not.toContain('line-update');
  });

  it('a raise/lower whose guarded claim matches nothing is a 409 CONFLICT', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.VERIFIED, verifiedQuantity: 8 }),
      lineUpdateCount: 0,
    });

    await expect(
      verifyLine(tx, args({ verifiedQuantity: 9 }), {
        onRecord: recorder().onRecord,
        batchId: BATCH,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });
});

describe('VERIFIED_LOCKED — the count may not lie about what the ledger booked', () => {
  it('refuses a LOWER below stocked + disposed, naming both counters', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        verifiedQuantity: 10,
        stockedQuantity: 6,
        disposedQuantity: 1,
      }),
    });

    const refusal = await verifyLine(tx, args({ verifiedQuantity: 6 }), {
      onRecord: recorder().onRecord,
      batchId: BATCH,
    }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(VerifiedLockedRefusal);
    expect(refusal).toMatchObject({ code: 'VERIFIED_LOCKED', stocked: 6, disposed: 1 });
    expect(kinds(tx)).not.toContain('line-update');
  });

  it('refuses a LOWER on a COMPLETE line (only VERIFIED|LABELING may come down)', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.COMPLETE,
        verifiedQuantity: 10,
        stockedQuantity: 10,
      }),
    });

    await expect(
      verifyLine(tx, args({ verifiedQuantity: 9 }), {
        onRecord: recorder().onRecord,
        batchId: BATCH,
      }),
    ).rejects.toBeInstanceOf(VerifiedLockedRefusal);
  });

  it('refuses ANY change on an UNORDERED line once units are stocked (the basis is frozen)', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        orderedQuantity: null,
        verifiedQuantity: 10,
        stockedQuantity: 3,
      }),
    });

    await expect(
      verifyLine(tx, args({ verifiedQuantity: 12 }), {
        onRecord: recorder().onRecord,
        batchId: BATCH,
      }),
    ).rejects.toBeInstanceOf(VerifiedLockedRefusal);
  });

  it('allows an UNORDERED raise while both counters are still zero', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.VERIFIED,
        orderedQuantity: null,
        verifiedQuantity: 10,
      }),
    });
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 12 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(result.verifiedQuantity).toBe(12);
    expect(rec.ctx().kind).toBe('raise');
  });

  it('allows a labelingRequired-only change on a frozen UNORDERED line (delta 0)', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.LABELING,
        orderedQuantity: null,
        verifiedQuantity: 10,
        stockedQuantity: 3,
      }),
    });
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 10, labelingRequired: false }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(stmt(tx, 'line-update')!.data).toMatchObject({ labelingRequired: false });
  });
});

describe('deliveredProduct — the re-map (S10)', () => {
  it('re-maps resolvedProductId AND re-snapshots description in the SAME write', async () => {
    const tx = mkTx();
    const rec = recorder();

    const result = await verifyLine(
      tx,
      args({ deliveredProduct: { mode: 'existing', productId: 77 } }),
      { onRecord: rec.onRecord, batchId: BATCH },
    );

    expect(stmt(tx, 'line-update')!.data).toMatchObject({
      resolvedProductId: 77,
      description: 'Substitute Y 5mg',
    });
    // `orderedProductId` is UNTOUCHED — what was ordered stays legible.
    expect(stmt(tx, 'line-update')!.data).not.toHaveProperty('orderedProductId');
    expect(result.resolvedProductId).toBe(77);
    expect(rec.ctx().productRemapped).toEqual({
      from: PRODUCT,
      to: 77,
      productName: 'Substitute Y 5mg',
    });
    expect(rec.ctx().productCreated).toBe(false);
  });

  it('reports productCreated when the resolver had to create the product', async () => {
    mockResolveProduct.mockResolvedValue({
      productId: 78,
      productName: 'Brand New 1mg',
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      locationId: 1,
    });
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ deliveredProduct: { mode: 'new', productFields: {} } }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().productCreated).toBe(true);
  });

  it('publishes the POST-REMAP productId, so the route never derives one', async () => {
    // The route audits `PRODUCT_CREATE` against a product id. Deriving it from
    // the remap or the discrepancy subject reads the id off facts that are
    // allowed to be absent; the core knows it outright, so it says it.
    const plain = mkTx();
    const before = recorder();
    await verifyLine(plain, args(), { onRecord: before.onRecord, batchId: BATCH });
    expect(before.ctx().productId).toBe(PRODUCT);

    const tx = mkTx();
    const rec = recorder();
    await verifyLine(tx, args({ deliveredProduct: { mode: 'existing', productId: 77 } }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().productId).toBe(77);
  });

  it('refuses to publish a count it cannot attribute to a product (INVARIANT)', async () => {
    // Unreachable on a supply-order line — order entry writes BOTH product ids
    // — which is exactly why it is an invariant and not a refusal the operator
    // can act on. The alternative is a `productId` the type calls a number and
    // the row calls null.
    const tx = mkTx({ line: lockedLine({ resolvedProductId: null }) });

    await expect(
      verifyLine(tx, args(), { onRecord: recorder().onRecord, batchId: BATCH }),
    ).rejects.toMatchObject({ statusCode: 500, code: 'INVARIANT' });
    // Nothing was written: the invariant is checked before the guarded write.
    expect(kinds(tx)).not.toContain('line-update');
  });

  it('refuses a re-map once anything is stocked or disposed', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.VERIFIED,
        verifiedQuantity: 10,
        stockedQuantity: 1,
      }),
    });

    await expect(
      verifyLine(
        tx,
        args({ verifiedQuantity: 10, deliveredProduct: { mode: 'existing', productId: 77 } }),
        { onRecord: recorder().onRecord, batchId: BATCH },
      ),
    ).rejects.toBeInstanceOf(VerifiedLockedRefusal);
    expect(mockResolveProduct).not.toHaveBeenCalled();
  });

  it('refuses a re-map on a LABELING or COMPLETE line', async () => {
    for (const status of [StagingItemStatus.LABELING, StagingItemStatus.COMPLETE]) {
      const tx = mkTx({ line: lockedLine({ status, verifiedQuantity: 10 }) });
      await expect(
        verifyLine(
          tx,
          args({ verifiedQuantity: 10, deliveredProduct: { mode: 'existing', productId: 77 } }),
          { onRecord: recorder().onRecord, batchId: BATCH },
        ),
      ).rejects.toBeInstanceOf(VerifiedLockedRefusal);
    }
  });
});

describe('the discrepancy INTENT (PK2-2) — verify never writes the row itself', () => {
  it('upserts the COMPLETE subject when the count misses the order', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 7, note: 'two boxes short' }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().recvDiscrepancy).toEqual({
      action: 'upsert',
      subject: {
        stagingItemId: LINE_ID,
        shipmentId: SHIPMENT,
        productId: PRODUCT,
        orderedProductId: PRODUCT,
        expectedQty: 10,
        countedQty: 7,
        orderedQuantity: 10,
        verifiedQuantity: 7,
        shortUnits: 3,
        overUnits: 0,
        unitCostCents: 1000,
        lossCents: 3000,
        surplusValueCents: 0,
        note: 'two boxes short',
      },
    });
  });

  it('an UNORDERED arrival carries expectedQty NULL and no short/over', async () => {
    const tx = mkTx({
      line: lockedLine({
        status: StagingItemStatus.VERIFIED,
        orderedQuantity: null,
        verifiedQuantity: 4,
        lineTotalCents: null,
      }),
    });
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 6 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().recvDiscrepancy).toMatchObject({
      action: 'upsert',
      subject: {
        expectedQty: null,
        countedQty: 6,
        orderedQuantity: null,
        shortUnits: 0,
        overUnits: 0,
        unitCostCents: null,
        lossCents: 0,
        surplusValueCents: 0,
      },
    });
  });

  it('writes NOTHING when a FIRST verify matches the order exactly', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 10 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().recvDiscrepancy).toBeNull();
  });

  it('a RAISE that closes a shortage resolves `additional-delivery` with a refreshed subject', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.LABELING, verifiedQuantity: 7 }),
    });
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 10, note: 'box 2 arrived' }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().recvDiscrepancy).toEqual({
      action: 'resolve',
      resolution: 'additional-delivery',
      subjectPatch: {
        stagingItemId: LINE_ID,
        shipmentId: SHIPMENT,
        productId: PRODUCT,
        orderedProductId: PRODUCT,
        expectedQty: 10,
        countedQty: 10,
        orderedQuantity: 10,
        verifiedQuantity: 10,
        shortUnits: 0,
        overUnits: 0,
        unitCostCents: 1000,
        lossCents: 0,
        surplusValueCents: 0,
        note: 'box 2 arrived',
      },
    });
  });

  it('a LOWER back onto the ordered count resolves `recount-corrected`', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.VERIFIED, verifiedQuantity: 12 }),
    });
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 10 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().recvDiscrepancy).toMatchObject({
      action: 'resolve',
      resolution: 'recount-corrected',
    });
  });

  it('leaves a matching count alone when it already matched (nothing to resolve)', async () => {
    const tx = mkTx({
      line: lockedLine({ status: StagingItemStatus.VERIFIED, verifiedQuantity: 10 }),
    });
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 10 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.ctx().recvDiscrepancy).toBeNull();
  });
});

describe('money (seam S2) and the onRecord context', () => {
  it('CONTRACT: verify\'s lossCents is `lineMoney`\'s for the same inputs', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 7 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    const money = lineMoney({ lineTotalCents: 10000, orderedQuantity: 10, verifiedQuantity: 7 });
    expect(rec.ctx().lossCents).toBe(money.lossCents);
    expect(rec.ctx().surplusValueCents).toBe(money.surplusValueCents);
    expect(rec.ctx().unitCostCents).toBe(money.unitCostCents);
  });

  it('CONTRACT: an OVER delivery reports `lineMoney`\'s surplus', async () => {
    const tx = mkTx();
    const rec = recorder();

    await verifyLine(tx, args({ verifiedQuantity: 13 }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    const money = lineMoney({ lineTotalCents: 10000, orderedQuantity: 10, verifiedQuantity: 13 });
    expect(rec.ctx().surplusValueCents).toBe(money.surplusValueCents);
    expect(rec.ctx().lossCents).toBe(0);
  });

  it('hands the route the whole context, LAST, inside the same transaction', async () => {
    const tx = mkTx();
    const rec = recorder();

    const result = await verifyLine(tx, args({ verifiedQuantity: 7, note: 'short' }), {
      onRecord: rec.onRecord,
      batchId: BATCH,
    });

    expect(rec.calls()).toBe(1);
    expect(rec.ctx()).toEqual({
      lineId: LINE_ID,
      shipmentId: SHIPMENT,
      kind: 'first',
      previousVerified: null,
      ordered: 10,
      verified: 7,
      delta: 7,
      lossCents: 3000,
      surplusValueCents: 0,
      unitCostCents: 1000,
      note: 'short',
      headerPromoted: true,
      productId: PRODUCT,
      productRemapped: null,
      productCreated: false,
      recvDiscrepancy: expect.objectContaining({ action: 'upsert' }),
      batchId: BATCH,
    });
    // onRecord runs AFTER the line write — the route's exception + audit rows
    // land with the count, and a throw there aborts the whole verify.
    expect(kinds(tx)[kinds(tx).length - 1]).toBe('line-update');
    expect(result.money.lossCents).toBe(3000);
  });

  it('a throw from onRecord propagates (the caller\'s transaction aborts)', async () => {
    const tx = mkTx();
    const onRecord = jest.fn(async () => {
      throw new Error('audit exploded');
    });

    await expect(
      verifyLine(tx, args(), { onRecord, batchId: BATCH }),
    ).rejects.toThrow('audit exploded');
  });
});

describe('the raw SQL is parameterized', () => {
  it('binds the ids rather than interpolating them', async () => {
    const tx = mkTx();

    await verifyLine(tx, args(), { onRecord: recorder().onRecord, batchId: BATCH });

    const lock = stmt(tx, 'line-lock')!;
    expect(lock.sql).not.toContain(String(LINE_ID));
    expect(lock.sql).not.toContain(SHIPMENT);
    expect(Prisma.sql`SELECT 1`.values).toEqual([]);
  });
});
