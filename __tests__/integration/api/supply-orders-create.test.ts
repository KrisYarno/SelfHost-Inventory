// @jest-environment node
/**
 * M3a — POST /api/inbound-shipments, the SUPPLY-ORDER create (pack C3a.0).
 *
 * The W1 header-only create is gone: an order without lines is not an order, so
 * `lines` is required (1..50) and the whole thing — the products a line minted,
 * the header, the lines and every audit row — commits in ONE transaction under
 * ONE batchId minted OUTSIDE the retry.
 *
 * Prisma is mocked (no DB) and the REAL `apiHandler` is kept, so ZodError -> 400
 * and AppError -> its status map exactly as the route relies on. The product
 * RESOLVER is mocked at its seam (S10): its own approval-gate rules are pinned
 * in `__tests__/unit/lib/supply-orders/product-resolve.test.ts`, and what this
 * suite owns is that the route ASKS it once per line and audits what it created.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
  };
});

jest.mock('@/lib/prisma', () => {
  const client: Record<string, unknown> = {
    inboundShipment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    stagingItem: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    inventoryException: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => []),
  };
  client.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({ 'X-RateLimit-Remaining': '99' })),
  applyRateLimitHeaders: jest.fn((resp: unknown) => resp),
}));

jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'batch-create-0001'),
}));

jest.mock('@/lib/supply-orders/product-resolve', () => ({
  __esModule: true,
  resolveSupplyOrderProduct: jest.fn(),
}));

import { POST } from '@/app/api/inbound-shipments/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { recordChange, newBatchId } from '@/lib/change-tracking';
import { resolveSupplyOrderProduct } from '@/lib/supply-orders/product-resolve';
import prisma from '@/lib/prisma';

const db = prisma as unknown as Record<string, any>;
const mockRecordChange = recordChange as jest.Mock;
const mockNewBatchId = newBatchId as jest.Mock;
const mockResolve = resolveSupplyOrderProduct as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
const ORDER_ID = 'cksupplyorder00000000001';

function setApprovedUser(user: Record<string, unknown> = APPROVED_USER) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}

function mkReq(body?: unknown) {
  return new NextRequest('http://t/api/inbound-shipments', {
    method: 'POST',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

function headerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    supplierRef: 'PO-42',
    supplier: 'Acme',
    status: 'ORDERED',
    notes: null,
    createdBy: APPROVED_USER.id,
    closedBy: null,
    orderedAt: new Date('2026-08-14T00:00:00.000Z'),
    feesCents: 0,
    feesNote: null,
    createdAt: new Date('2026-08-14T09:00:00.000Z'),
    updatedAt: new Date('2026-08-14T09:00:00.000Z'),
    closedAt: null,
    creator: { id: APPROVED_USER.id, username: 'kris' },
    ...overrides,
  };
}

function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    description: 'Vial Blue',
    status: 'ORDERED',
    shipmentId: ORDER_ID,
    orderedProductId: 31,
    resolvedProductId: 31,
    orderedQuantity: 100,
    verifiedQuantity: null,
    stockedQuantity: 0,
    disposedQuantity: 0,
    lineTotalCents: 125_000,
    labelingRequired: true,
    locationId: null,
    verifiedAt: null,
    verifiedBy: null,
    expectedQuantity: null,
    countedQuantity: null,
    ...overrides,
  };
}

/** The detail re-read every successful create performs before responding. */
function primeDetailRead(lines: Record<string, unknown>[] = [lineRow()]) {
  db.inboundShipment.findUnique.mockResolvedValue(headerRow());
  db.stagingItem.findMany.mockResolvedValue(lines);
  db.inventoryException.findMany.mockResolvedValue([]);
}

const body = (overrides: Record<string, unknown> = {}) => ({
  supplier: 'Acme',
  supplierRef: 'PO-42',
  orderedAt: '2026-08-14',
  feesCents: 0,
  lines: [
    {
      product: { mode: 'existing', productId: 31 },
      orderedQuantity: 100,
      lineTotalCents: 125_000,
      labelingRequired: true,
    },
  ],
  ...overrides,
});

/** Every recordChange call of one actionType. */
const recorded = (actionType: string) =>
  mockRecordChange.mock.calls.filter((c) => c[1].actionType === actionType).map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  mockNewBatchId.mockReturnValue('batch-create-0001');
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.inboundShipment.create.mockResolvedValue(headerRow());
  db.stagingItem.create.mockResolvedValue(lineRow());
  mockResolve.mockResolvedValue({
    productId: 31,
    productName: 'Vial Blue',
    approvalStatus: 'APPROVED',
    created: false,
    locationId: 1,
  });
  primeDetailRead();
});

describe('POST /api/inbound-shipments — the order', () => {
  it('creates the header ORDERED at UTC midnight of the ordered date', async () => {
    setApprovedUser();

    const res = await POST(mkReq(body()), {} as never);

    expect(res.status).toBe(201);
    expect(db.inboundShipment.create).toHaveBeenCalledTimes(1);
    expect(db.inboundShipment.create.mock.calls[0][0].data).toEqual({
      status: 'ORDERED',
      orderedAt: new Date('2026-08-14T00:00:00.000Z'),
      supplier: 'Acme',
      supplierRef: 'PO-42',
      notes: null,
      feesCents: 0,
      feesNote: null,
      createdBy: APPROVED_USER.id,
    });
  });

  it('creates each line ORDERED with the resolver name snapshotted into description', async () => {
    setApprovedUser();

    await POST(mkReq(body()), {} as never);

    expect(db.stagingItem.create).toHaveBeenCalledTimes(1);
    expect(db.stagingItem.create.mock.calls[0][0].data).toEqual({
      status: 'ORDERED',
      description: 'Vial Blue',
      orderedProductId: 31,
      resolvedProductId: 31,
      orderedQuantity: 100,
      lineTotalCents: 125_000,
      labelingRequired: true,
      notes: null,
      shipmentId: ORDER_ID,
      receivedBy: null,
      receivedAt: null,
      locationId: null,
    });
  });

  it('asks the resolver once per line, with that line\'s selector and the actor', async () => {
    setApprovedUser();
    mockResolve
      .mockResolvedValueOnce({
        productId: 31,
        productName: 'Vial Blue',
        approvalStatus: 'APPROVED',
        created: false,
        locationId: 1,
      })
      .mockResolvedValueOnce({
        productId: 88,
        productName: 'Cap Red',
        approvalStatus: 'PENDING_REVIEW',
        created: true,
        locationId: 1,
      });
    db.stagingItem.create
      .mockResolvedValueOnce(lineRow())
      .mockResolvedValueOnce(lineRow({ id: 502, resolvedProductId: 88 }));

    await POST(
      mkReq(
        body({
          lines: [
            {
              product: { mode: 'existing', productId: 31 },
              orderedQuantity: 100,
              lineTotalCents: 125_000,
            },
            {
              product: {
                mode: 'new',
                productFields: { baseName: 'Cap', variant: 'Red', locationId: 1 },
              },
              orderedQuantity: 5,
              lineTotalCents: 0,
              labelingRequired: false,
              notes: 'rush',
            },
          ],
        }),
      ),
      {} as never,
    );

    expect(mockResolve).toHaveBeenCalledTimes(2);
    expect(mockResolve.mock.calls[0][1]).toEqual({ mode: 'existing', productId: 31 });
    expect(mockResolve.mock.calls[1][1]).toEqual({
      mode: 'new',
      productFields: { baseName: 'Cap', variant: 'Red', locationId: 1 },
    });
    expect(mockResolve.mock.calls[0][2]).toEqual({ id: 7, isAdmin: false });
    expect(db.stagingItem.create.mock.calls[1][0].data).toMatchObject({
      description: 'Cap Red',
      orderedProductId: 88,
      resolvedProductId: 88,
      orderedQuantity: 5,
      lineTotalCents: 0,
      labelingRequired: false,
      notes: 'rush',
    });
  });

  it('records PRODUCT_CREATE per created product and SHIPMENT_CREATE, all under ONE batchId', async () => {
    setApprovedUser();
    mockResolve.mockResolvedValue({
      productId: 88,
      productName: 'Cap Red',
      approvalStatus: 'PENDING_REVIEW',
      created: true,
      locationId: 1,
    });

    await POST(mkReq(body()), {} as never);

    const products = recorded('PRODUCT_CREATE');
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      entityType: 'PRODUCT',
      entityId: 88,
      batchId: 'batch-create-0001',
    });

    const creates = recorded('SHIPMENT_CREATE');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      entityType: 'SHIPMENT',
      entityId: ORDER_ID,
      batchId: 'batch-create-0001',
    });
    expect(creates[0].details).toMatchObject({ lineCount: 1, orderedUnits: 100 });
  });

  it('records NO PRODUCT_CREATE for a product the resolver merely selected', async () => {
    setApprovedUser();

    await POST(mkReq(body()), {} as never);

    expect(recorded('PRODUCT_CREATE')).toHaveLength(0);
  });

  it('does all of it inside ONE transaction', async () => {
    setApprovedUser();

    await POST(mkReq(body()), {} as never);

    expect(db.$transaction).toHaveBeenCalledTimes(1);
  });

  it('mints the batchId OUTSIDE the retry (a retried transaction keeps one batch)', async () => {
    setApprovedUser();
    let attempts = 0;
    db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
      attempts += 1;
      if (attempts === 1) {
        const deadlock: Error & { code?: string } = new Error('Deadlock found');
        deadlock.code = 'P2034';
        throw deadlock;
      }
      return fn(db);
    });

    const res = await POST(mkReq(body()), {} as never);

    expect(res.status).toBe(201);
    expect(attempts).toBe(2);
    expect(mockNewBatchId).toHaveBeenCalledTimes(1);
  });

  it('answers the SupplyOrderDetail shape (201)', async () => {
    setApprovedUser();

    const res = await POST(mkReq(body()), {} as never);
    const json = await res.json();

    expect(json.model).toBe('supply-order');
    expect(json.id).toBe(ORDER_ID);
    expect(json.status).toBe('ORDERED');
    expect(json.lineCounts).toEqual({
      ordered: 1,
      verified: 0,
      labeling: 0,
      complete: 0,
      discarded: 0,
    });
    expect(json.lines).toHaveLength(1);
    expect(json.lines[0]).toMatchObject({ id: 501, productId: 31, productName: 'Vial Blue' });
  });
});

describe('POST /api/inbound-shipments — refusals', () => {
  it('400s a body with no lines at all (the header-only create is gone)', async () => {
    setApprovedUser();

    const res = await POST(mkReq({ orderedAt: '2026-08-14' }), {} as never);

    expect(res.status).toBe(400);
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
  });

  it('400s an empty lines array and a 51-line order', async () => {
    setApprovedUser();

    const empty = await POST(mkReq(body({ lines: [] })), {} as never);
    expect(empty.status).toBe(400);

    const tooMany = await POST(
      mkReq(
        body({
          lines: Array.from({ length: 51 }, () => ({
            product: { mode: 'existing', productId: 31 },
            orderedQuantity: 1,
            lineTotalCents: 0,
          })),
        }),
      ),
      {} as never,
    );
    expect(tooMany.status).toBe(400);
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
  });

  it('400s a calendar day that does not exist', async () => {
    setApprovedUser();

    const res = await POST(mkReq(body({ orderedAt: '2026-02-30' })), {} as never);

    expect(res.status).toBe(400);
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
  });

  it('400s a new-product payload that carries costPrice at all (premise 1)', async () => {
    setApprovedUser();

    const res = await POST(
      mkReq(
        body({
          lines: [
            {
              product: {
                mode: 'new',
                productFields: { baseName: 'Cap', variant: 'Red', costPrice: 12.5 },
              },
              orderedQuantity: 5,
              lineTotalCents: 100,
            },
          ],
        }),
      ),
      {} as never,
    );

    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('403s an invalid CSRF token before any write', async () => {
    setApprovedUser();
    (validateCSRFToken as jest.Mock).mockResolvedValue(false);

    const res = await POST(mkReq(body()), {} as never);

    expect(res.status).toBe(403);
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
    expect(mockRecordChange).not.toHaveBeenCalled();
  });

  it('lets a resolver refusal (the approval gate) travel as its own 400', async () => {
    setApprovedUser();
    const { AppError } = jest.requireActual('@/lib/error-handling');
    mockResolve.mockRejectedValue(
      new AppError('Product 31 is pending approval', 'BAD_REQUEST', 400),
    );

    const res = await POST(mkReq(body()), {} as never);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('pending approval');
    expect(db.inboundShipment.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/inbound-shipments — the legacy discriminator (REV-10 clause 4)', () => {
  it('writes receivedAt NULL explicitly on every line it creates', async () => {
    await POST(mkReq(body()), {} as never);

    // `receivedAt` KEEPS its DB default (CURRENT_TIMESTAMP) so a code rollback
    // stays schema-compatible — which means an OMITTED field would be stamped
    // with a timestamp, and `receivedAt IS NOT NULL` is the LEGACY
    // DISCRIMINATOR. A supply-order line stamped that way would read back as a
    // pre-staging box.
    const creates = db.stagingItem.create.mock.calls;
    expect(creates.length).toBeGreaterThan(0);
    for (const [args] of creates) {
      expect(args.data).toHaveProperty('receivedAt', null);
      expect(args.data).toHaveProperty('receivedBy', null);
    }
  });
});

describe('POST /api/inbound-shipments — the transaction budget (REV-10 clause 9)', () => {
  it('runs the create with an explicit timeout and maxWait', async () => {
    await POST(mkReq(body()), {} as never);

    const options = db.$transaction.mock.calls[0][1];
    // Fifty lines of product resolution can outrun Prisma's 5s default, and a
    // timeout mid-create is an order the operator typed and lost.
    expect(options).toEqual({ timeout: 20_000, maxWait: 5_000 });
  });
});
