// @jest-environment node
/**
 * Change-tracking CHARACTERIZATION — staging/scratchpad group (Phase A Task 10).
 *
 * Proves the shared-recipe invariants for every migrated call site in this group:
 *   1. SAME-TX: each recordChange runs on the IDENTICAL tx object as its mutation
 *      (asserted by reference, not shape).
 *   2. BATCH GROUPING: the flagship GRADUATION fan-out emits STAGING_GRADUATE +
 *      PRODUCT_CREATE under ONE batchId, on one tx — and PRODUCT_CREATE fires only
 *      when a new product is minted (existing-restock path emits STAGING_GRADUATE
 *      alone).
 *   3. 409 RECORDS NOTHING: the discard atomic-guard 409 (count 0) and the
 *      scratchpad version-CAS 409s (OptimisticLockError from PATCH/DELETE) leave
 *      NO recordChange behind.
 *
 * recordChange itself is mocked here (its payload assembly/redaction is unit-tested
 * in __tests__/unit/lib/change-tracking.test.ts). This file asserts the ROUTE +
 * graduate-helper WIRING: which events fire, on which tx, under which batchId.
 * The REAL apiHandler is preserved so AppError/OptimisticLockError -> status map
 * centrally, exactly as production does.
 */

import { NextRequest } from 'next/server';
import { mockDeep, type DeepMockProxy } from 'jest-mock-extended';
import type { Prisma } from '@prisma/client';

// --- Real apiHandler (central status mapping); stub the auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return { __esModule: true, ...actual, requireApproved: jest.fn(), requireAdmin: jest.fn() };
});

jest.mock('@/lib/csrf', () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));

// --- prisma: a reconfigurable $transaction. Routes that wrap their own mutation
// (staging create/discard, scratchpad create/patch/delete) get TX; the real
// graduate helper (Part B) reconfigures $transaction to a mockDeep tx per test.
jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}));

// --- recordChange spy: assert the wiring, not the payload internals.
jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'BATCH-UUID'),
}));

// --- scratchpad mutations mocked for route-wiring tests.
jest.mock('@/lib/scratchpad/mutations', () => ({
  createScratchpadRow: jest.fn(),
  updateScratchpadRow: jest.fn(),
  deleteScratchpadRow: jest.fn(),
}));
jest.mock('@/lib/scratchpad/queries', () => ({
  getScratchpadBoard: jest.fn(),
  getLabelSuggestions: jest.fn(),
}));

// --- graduate helper mocked for the ROUTE-wiring tests; the REAL helper is pulled
// via requireActual in Part B to prove the same-tx fan-out inside its transaction.
jest.mock('@/lib/staging/graduate', () => ({ graduateStagingItem: jest.fn() }));

// --- inventory mocked so the REAL graduate helper's stock-in is a spy (Part B);
// OptimisticLockError + centsFromCostPrice stay the REAL implementations
// (graduate.ts imports centsFromCostPrice to freeze STOCK_IN unit cost — Task 4).
// withDeadlockRetry is a reconfigurable spy: its default runs the fn once, but the
// batchId-across-retries test overrides it to re-run the fn (Phase C P-C1: re-runs
// reuse the caller's opts.batchId, never regenerate).
const mockApplyStockDelta = jest.fn();
const mockWithDeadlockRetry = jest.fn((fn: () => Promise<any>) => fn());
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  applyStockDelta: (...a: any[]) => mockApplyStockDelta(...a),
  withDeadlockRetry: (fn: () => Promise<any>) => mockWithDeadlockRetry(fn),
  centsFromCostPrice: jest.requireActual('@/lib/inventory').centsFromCostPrice,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
}));

import prisma from '@/lib/prisma';
import { requireApproved } from '@/lib/api-utils';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { graduateStagingItem } from '@/lib/staging/graduate';
import {
  createScratchpadRow,
  updateScratchpadRow,
  deleteScratchpadRow,
} from '@/lib/scratchpad/mutations';
import { OptimisticLockError } from '@/lib/inventory';

import { POST as stagingCreatePOST } from '@/app/api/staging-items/route';
import { POST as discardPOST } from '@/app/api/staging-items/[id]/discard/route';
import { POST as graduatePOST } from '@/app/api/staging-items/[id]/graduate/route';
import { POST as scratchpadCreatePOST } from '@/app/api/scratchpad/route';
import { PATCH as scratchpadPATCH, DELETE as scratchpadDELETE } from '@/app/api/scratchpad/[id]/route';

const mockPrisma = prisma as any;
const mockRecordChange = recordChange as jest.Mock;
const mockGraduate = graduateStagingItem as jest.Mock;

// A stable tx sentinel the self-wrapping routes mutate on AND recordChange must
// receive — "same tx" is asserted by identity against this object.
const TX: any = { stagingItem: { create: jest.fn(), updateMany: jest.fn() } };

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };

function mkReq(url: string, method: string, body?: any) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED_USER });
  (newBatchId as jest.Mock).mockReturnValue('BATCH-UUID');
  // Default: $transaction hands the SAME TX sentinel to the callback.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(TX));
});

// ---------------------------------------------------------------------------
// Part A — ROUTE wiring (mocked mutations + mocked recordChange)
// ---------------------------------------------------------------------------

describe('staging POST /api/staging-items (create)', () => {
  it('records STAGING_CREATE on the SAME tx as the stagingItem.create', async () => {
    TX.stagingItem.create.mockResolvedValue({ id: 42, description: 'Box', locationId: 1 });

    const res = await stagingCreatePOST(
      mkReq('http://t/api/staging-items', 'POST', { description: 'Box', locationId: 1 }),
    );

    expect(res.status).toBe(201);
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX); // same tx as the mutation
    expect(TX.stagingItem.create).toHaveBeenCalled();
    expect(event).toMatchObject({
      actionType: 'STAGING_CREATE',
      entityType: 'STAGING',
      entityId: 42,
      actor: { userId: APPROVED_USER.id },
    });
  });
});

describe('staging POST /api/staging-items/[id]/discard', () => {
  it('records STAGING_DISCARD on the same tx when the atomic guard claims a row', async () => {
    TX.stagingItem.updateMany.mockResolvedValue({ count: 1 });

    const res = await discardPOST(mkReq('http://t/api/staging-items/5/discard', 'POST'), {
      params: { id: '5' },
    });

    expect(res.status).toBe(200);
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'STAGING_DISCARD', entityType: 'STAGING', entityId: 5 });
  });

  it('records NOTHING on a 409 (count 0: already graduated/discarded/missing)', async () => {
    TX.stagingItem.updateMany.mockResolvedValue({ count: 0 });

    const res = await discardPOST(mkReq('http://t/api/staging-items/5/discard', 'POST'), {
      params: { id: '5' },
    });

    expect(res.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('graduate POST /api/staging-items/[id]/graduate — flagship fan-out', () => {
  it('new-product path: STAGING_GRADUATE + PRODUCT_CREATE share ONE batchId on ONE tx', async () => {
    // W1-3b: a non-admin's new product also raises `pending-with-stock` on this
    // very tx, so the sentinel needs the delegate the register writes through.
    // What that row CONTAINS is owned by staging-graduate-exceptions.test.ts.
    const GRAD_TX: any = {
      __gradTx: true,
      inventoryException: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
        update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      },
      // PK-11: the writer's read is a LOCKING one now; an absent key here.
      $queryRaw: jest.fn(async () => []),
    };
    mockGraduate.mockImplementation(async (_id: number, _body: any, _actor: any, opts: any) => {
      if (opts?.onRecord) {
        await opts.onRecord(GRAD_TX, {
          productId: 100,
          approvalStatus: 'PENDING_REVIEW',
          locationId: 1,
          countedQuantity: 5,
          bookedQuantity: 5,
          override: null,
          created: true,
        });
      }
      return {
        productId: 100,
        approvalStatus: 'PENDING_REVIEW',
        locationId: 1,
        countedQuantity: 5,
        bookedQuantity: 5,
      };
    });

    const res = await graduatePOST(
      mkReq('http://t/api/staging-items/5/graduate', 'POST', {
        mode: 'new',
        productFields: { baseName: 'X', variant: '1', locationId: 1 },
        locationId: 1,
      }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    expect(mockRecordChange).toHaveBeenCalledTimes(2);

    // Both events landed on the helper's transaction (GRAD_TX) under one batchId.
    for (const [txArg, event] of mockRecordChange.mock.calls) {
      expect(txArg).toBe(GRAD_TX);
      expect(event.batchId).toBe('BATCH-UUID');
    }

    const byType = Object.fromEntries(
      mockRecordChange.mock.calls.map(([, e]) => [e.actionType, e]),
    );
    expect(byType.PRODUCT_CREATE).toMatchObject({ entityType: 'PRODUCT', entityId: 100 });
    expect(byType.STAGING_GRADUATE).toMatchObject({ entityType: 'STAGING', entityId: 5 });
    // A single batchId across the two distinct events (not two independent ids).
    expect(byType.PRODUCT_CREATE.batchId).toBe(byType.STAGING_GRADUATE.batchId);

    // The route threads its event batchId into graduateStagingItem via opts, so the
    // helper stamps the SAME id onto the STOCK_IN ledger row (P-C1 join). onRecord
    // moved into opts too (ER-C1: options object, not a positional).
    const opts = mockGraduate.mock.calls[0][3];
    expect(opts.batchId).toBe('BATCH-UUID');
    expect(typeof opts.onRecord).toBe('function');
  });

  it('existing-restock path: only STAGING_GRADUATE fires (no PRODUCT_CREATE)', async () => {
    const GRAD_TX: any = { __gradTx: true };
    mockGraduate.mockImplementation(async (_id: number, _body: any, _actor: any, opts: any) => {
      if (opts?.onRecord) {
        await opts.onRecord(GRAD_TX, {
          productId: 77,
          approvalStatus: 'APPROVED',
          locationId: 1,
          countedQuantity: 5,
          bookedQuantity: 5,
          override: null,
          created: false,
        });
      }
      return {
        productId: 77,
        approvalStatus: 'APPROVED',
        locationId: 1,
        countedQuantity: 5,
        bookedQuantity: 5,
      };
    });

    const res = await graduatePOST(
      mkReq('http://t/api/staging-items/5/graduate', 'POST', {
        mode: 'existing',
        productId: 77,
        locationId: 1,
      }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    expect(mockRecordChange).toHaveBeenCalledTimes(1);
    const [, event] = mockRecordChange.mock.calls[0];
    expect(event).toMatchObject({ actionType: 'STAGING_GRADUATE', entityType: 'STAGING', entityId: 5 });
    const types = mockRecordChange.mock.calls.map(([, e]) => e.actionType);
    expect(types).not.toContain('PRODUCT_CREATE');
  });
});

describe('scratchpad POST /api/scratchpad (create)', () => {
  it('records SCRATCHPAD_CREATE on the same tx the mutation received', async () => {
    (createScratchpadRow as jest.Mock).mockResolvedValue({ id: 42, label: 'Awake', productId: 1 });

    const res = await scratchpadCreatePOST(
      mkReq('http://t/api/scratchpad', 'POST', { productId: 1, label: 'Awake' }),
    );

    expect(res.status).toBe(201);
    // mutation received TX as its tx arg…
    const mutationTx = (createScratchpadRow as jest.Mock).mock.calls[0][2];
    expect(mutationTx).toBe(TX);
    // …and recordChange landed on the very same TX.
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'SCRATCHPAD_CREATE', entityType: 'SCRATCHPAD', entityId: 42 });
  });
});

describe('scratchpad PATCH /api/scratchpad/[id] — version CAS', () => {
  it('records SCRATCHPAD_UPDATE on the same tx on success', async () => {
    (updateScratchpadRow as jest.Mock).mockResolvedValue({ id: 5, version: 3 });

    const res = await scratchpadPATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const mutationTx = (updateScratchpadRow as jest.Mock).mock.calls[0][4];
    expect(mutationTx).toBe(TX);
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'SCRATCHPAD_UPDATE', entityType: 'SCRATCHPAD', entityId: 5 });
  });

  it('records NOTHING on a stale-version 409 (OptimisticLockError)', async () => {
    (updateScratchpadRow as jest.Mock).mockRejectedValue(
      new OptimisticLockError('Row was modified by someone else', 7, 2),
    );

    const res = await scratchpadPATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('records NOTHING on a racey delete (mutation returns null) and maps to 200 { deleted: true }', async () => {
    (updateScratchpadRow as jest.Mock).mockResolvedValue(null);

    const res = await scratchpadPATCH(
      mkReq('http://t/api/scratchpad/5', 'PATCH', { expectedVersion: 2, value: '42' }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

describe('scratchpad DELETE /api/scratchpad/[id] — version CAS', () => {
  it('records SCRATCHPAD_DELETE on the same tx on success', async () => {
    (deleteScratchpadRow as jest.Mock).mockResolvedValue({ deleted: true });

    const res = await scratchpadDELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(200);
    const mutationTx = (deleteScratchpadRow as jest.Mock).mock.calls[0][2];
    expect(mutationTx).toBe(TX);
    const [txArg, event] = mockRecordChange.mock.calls[0];
    expect(txArg).toBe(TX);
    expect(event).toMatchObject({ actionType: 'SCRATCHPAD_DELETE', entityType: 'SCRATCHPAD', entityId: 5 });
  });

  it('records NOTHING on a stale-version 409 (OptimisticLockError)', async () => {
    (deleteScratchpadRow as jest.Mock).mockRejectedValue(
      new OptimisticLockError('Row was modified by someone else', 4, 1),
    );

    const res = await scratchpadDELETE(
      mkReq('http://t/api/scratchpad/5', 'DELETE', { expectedVersion: 1 }),
      { params: { id: '5' } },
    );

    expect(res.status).toBe(409);
    expect(mockRecordChange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part B — the REAL graduate helper hands onRecord the SAME tx it mutates on,
// proving the recordChange calls above truly co-transact with the graduation.
// ---------------------------------------------------------------------------

describe('graduateStagingItem (real helper) — onRecord co-transacts with the mutation', () => {
  const realGraduate = jest.requireActual('@/lib/staging/graduate')
    .graduateStagingItem as typeof graduateStagingItem;

  const newFields = {
    baseName: 'Test Peptide',
    variant: '10mg',
    unit: 'mg',
    numericValue: 10,
    lowStockThreshold: 5,
    costPrice: 1.5,
    retailPrice: 3,
    locationId: 1,
  };

  function driveWithTx(counted = 8): DeepMockProxy<Prisma.TransactionClient> {
    const tx = mockDeep<Prisma.TransactionClient>();
    tx.stagingItem.updateMany.mockResolvedValue({ count: 1 } as any);
    tx.stagingItem.update.mockResolvedValue({} as any);
    // W1-3b (pack REV-3 T3): the real helper now runs D-COST inside this same
    // transaction. Default = the fill claim matches nothing (the product already
    // has a cost), so these tests keep testing the fan-out, not the cost rule.
    tx.product.updateMany.mockResolvedValue({ count: 0 } as any);
    tx.product.findUnique.mockResolvedValue(null as any);
    // W1-3a (pack REV-3 T2): the booked quantity is READ from the claimed row,
    // never taken from the request — so every drive has to supply one.
    tx.stagingItem.findUnique.mockResolvedValue({
      countedQuantity: counted,
      shipmentId: null,
      unitCostCents: null,
    } as any);
    mockApplyStockDelta.mockResolvedValue({ log: { id: 1 }, newVersion: 1 });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));
    return tx;
  }

  it('new-product path: onRecord receives the SAME tx that product.create ran on, created=true', async () => {
    const tx = driveWithTx();
    tx.product.create.mockResolvedValue({ id: 101, approvalStatus: 'PENDING_REVIEW' } as any);
    const onRecord = jest.fn();

    await realGraduate(
      55,
      { mode: 'new', productFields: newFields as any, locationId: 1 },
      { id: 42, isAdmin: false },
      { onRecord, batchId: 'GRAD-BATCH' },
    );

    expect(onRecord).toHaveBeenCalledTimes(1);
    const [txArg, ctx] = onRecord.mock.calls[0];
    expect(txArg).toBe(tx); // same tx as the mutation
    expect(tx.product.create).toHaveBeenCalled(); // mutation ran on this tx
    expect(ctx).toMatchObject({ productId: 101, approvalStatus: 'PENDING_REVIEW', created: true });

    // Task 4: the graduation stock-in is a STOCK_IN row joined to the batch, on the
    // SAME tx as the mutation.
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(1);
    const [stockTx, stockArgs] = mockApplyStockDelta.mock.calls[0];
    expect(stockTx).toBe(tx);
    expect(stockArgs).toMatchObject({
      productId: 101,
      locationId: 1,
      delta: 8,
      logType: 'STOCK_IN',
      batchId: 'GRAD-BATCH',
    });
  });

  it('new-product path: freezes unitCostCents from the created product row (12.34 -> 1234)', async () => {
    const tx = driveWithTx();
    tx.product.create.mockResolvedValue({
      id: 101,
      approvalStatus: 'PENDING_REVIEW',
      costPrice: 12.34,
    } as any);

    await realGraduate(
      55,
      { mode: 'new', productFields: newFields as any, locationId: 1 },
      { id: 42, isAdmin: false },
      { onRecord: jest.fn(), batchId: 'GRAD-BATCH' },
    );

    const stockArgs = mockApplyStockDelta.mock.calls[0][1];
    expect(stockArgs.logType).toBe('STOCK_IN');
    expect(stockArgs.unitCostCents).toBe(1234);
  });

  it('new-product path: costPrice 0 freezes unitCostCents to null (unset = no cost)', async () => {
    const tx = driveWithTx();
    tx.product.create.mockResolvedValue({
      id: 101,
      approvalStatus: 'PENDING_REVIEW',
      costPrice: 0,
    } as any);

    await realGraduate(
      55,
      { mode: 'new', productFields: newFields as any, locationId: 1 },
      { id: 42, isAdmin: false },
      { onRecord: jest.fn(), batchId: 'GRAD-BATCH' },
    );

    const stockArgs = mockApplyStockDelta.mock.calls[0][1];
    expect(stockArgs.unitCostCents).toBeNull();
  });

  it('existing-restock path: freezes unitCostCents from the LOADED product row', async () => {
    const tx = driveWithTx(3);
    tx.product.findFirst.mockResolvedValue({
      id: 7,
      approvalStatus: 'APPROVED',
      deletedAt: null,
      costPrice: 5,
    } as any);

    await realGraduate(
      55,
      { mode: 'existing', productId: 7, locationId: 2 },
      { id: 42, isAdmin: false },
      { onRecord: jest.fn(), batchId: 'GRAD-BATCH' },
    );

    const stockArgs = mockApplyStockDelta.mock.calls[0][1];
    expect(stockArgs).toMatchObject({
      productId: 7,
      logType: 'STOCK_IN',
      unitCostCents: 500,
      batchId: 'GRAD-BATCH',
    });
  });

  it('deadlock re-runs reuse the caller opts.batchId — never regenerate inside', async () => {
    const tx = driveWithTx();
    tx.product.create.mockResolvedValue({ id: 101, approvalStatus: 'PENDING_REVIEW' } as any);
    // Simulate a deadlock retry: withDeadlockRetry re-invokes the tx fn once more.
    mockWithDeadlockRetry.mockImplementationOnce(async (fn: () => Promise<any>) => {
      await fn();
      return fn();
    });

    await realGraduate(
      55,
      { mode: 'new', productFields: newFields as any, locationId: 1 },
      { id: 42, isAdmin: false },
      { onRecord: jest.fn(), batchId: 'GRAD-BATCH' },
    );

    // Both attempts stamped the SAME opts.batchId (not a fresh id per re-run).
    expect(mockApplyStockDelta).toHaveBeenCalledTimes(2);
    expect(mockApplyStockDelta.mock.calls[0][1].batchId).toBe('GRAD-BATCH');
    expect(mockApplyStockDelta.mock.calls[1][1].batchId).toBe('GRAD-BATCH');
  });

  it('existing-restock path: created=false (no product minted)', async () => {
    const tx = driveWithTx(12);
    tx.product.findFirst.mockResolvedValue({ id: 7, approvalStatus: 'APPROVED', deletedAt: null } as any);
    const onRecord = jest.fn();

    await realGraduate(
      55,
      { mode: 'existing', productId: 7, locationId: 3 },
      { id: 42, isAdmin: false },
      { onRecord, batchId: 'GRAD-BATCH' },
    );

    expect(onRecord).toHaveBeenCalledTimes(1);
    const [txArg, ctx] = onRecord.mock.calls[0];
    expect(txArg).toBe(tx);
    expect(tx.product.create).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({ productId: 7, created: false });
  });

  it('a 409 claim (count 0) never reaches onRecord — records nothing', async () => {
    const tx = driveWithTx();
    tx.stagingItem.updateMany.mockResolvedValue({ count: 0 } as any);
    const onRecord = jest.fn();

    await expect(
      realGraduate(
        55,
        { mode: 'existing', productId: 7, locationId: 1 },
        { id: 42, isAdmin: false },
        { onRecord, batchId: 'GRAD-BATCH' },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(onRecord).not.toHaveBeenCalled();
  });
});
