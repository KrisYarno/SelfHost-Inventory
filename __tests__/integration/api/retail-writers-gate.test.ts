// @jest-environment node
//
// W0-RETAIL RETAIL WRITERS GATE (spec §4 W0-RETAIL / REV-2).
//
// Invariant: NO product write path may coerce an UNKNOWN retail price to 0. A
// payload that OMITS retailPrice must persist NULL ("unknown"), never a phantom
// $0.00 — and an explicit human-entered 0 (genuinely free) must be preserved
// distinctly from NULL. This mirrors the cost NULL-preservation gate (R-D3) one
// column over, because a single re-coercing writer silently re-materializes the
// exact "$0.00 on unknown price" lie the migration removes.
//
// The persistence writers gated here are the two product routes; the graduation
// writer (lib/staging/graduate.ts) is gated in __tests__/unit/lib/staging/graduate.test.ts.

// Keep the REAL apiHandler so ZodError -> 400 and AppError -> its status get
// mapped centrally; stub the auth guards.
jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
    requireAdmin: jest.fn(),
  };
});

jest.mock('@/lib/prisma', () => {
  const tx = {
    product: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    location: {
      findUnique: jest.fn(),
    },
    productReorderConfig: {
      create: jest.fn(),
      upsert: jest.fn(),
    },
  };
  return {
    __esModule: true,
    default: {
      ...tx,
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    },
  };
});

jest.mock('@/lib/csrf', () => ({
  validateCSRFToken: jest.fn(async () => true),
}));

jest.mock('@/lib/rateLimit', () => ({
  __esModule: true,
  RateLimitError: jest.requireActual('@/lib/rateLimit').RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((resp: any) => resp),
}));

jest.mock('@/lib/change-tracking', () => ({
  __esModule: true,
  recordChange: jest.fn(async () => undefined),
  newBatchId: jest.fn(() => 'test-batch-id'),
}));

jest.mock('@/lib/products', () => ({
  getProductsWithQuantities: jest.fn(),
  isProductUnique: jest.fn(async () => true),
  formatProductName: jest.fn(({ baseName, variant }: any) =>
    `${baseName}${variant ? ' ' + variant : ''}`.trim()
  ),
}));

jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
  getCurrentQuantity: jest.fn(async () => 0),
}));

import { NextRequest } from 'next/server';
import { POST as createPOST } from '@/app/api/products/route';
import { PUT as updatePUT } from '@/app/api/products/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const ADMIN_USER = { id: 1, isAdmin: true, isApproved: true };

function setUser(user: any) {
  (requireApproved as jest.Mock).mockResolvedValue({ user });
}

function mkReq(url: string, method: string, body?: any) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': 'x' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateCSRF.mockResolvedValue(true);
  db.location.findUnique.mockResolvedValue({ id: 1, name: 'Main' });
});

describe('retail NULL preservation — POST /api/products', () => {
  it('POST with NO retailPrice stores NULL, never 0', async () => {
    setUser(ADMIN_USER);
    db.product.create.mockImplementation(async ({ data }: any) => ({ id: 70, ...data }));

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', { baseName: 'NR', variant: '5mg', locationId: 1 }),
    );

    expect(resp.status).toBe(201);
    expect(db.product.create.mock.calls[0][0].data.retailPrice).toBeNull();
  });

  it('POST with an explicit 0 keeps 0 (genuinely free, distinct from NULL)', async () => {
    setUser(ADMIN_USER);
    db.product.create.mockImplementation(async ({ data }: any) => ({ id: 71, ...data }));

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', {
        baseName: 'FREE',
        variant: '5mg',
        locationId: 1,
        retailPrice: 0,
      }),
    );

    expect(resp.status).toBe(201);
    expect(db.product.create.mock.calls[0][0].data.retailPrice).toBe(0);
  });

  it('POST with a positive retail stores that retail', async () => {
    setUser(ADMIN_USER);
    db.product.create.mockImplementation(async ({ data }: any) => ({ id: 72, ...data }));

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', {
        baseName: 'PR',
        variant: '5mg',
        locationId: 1,
        retailPrice: 24.99,
      }),
    );

    expect(resp.status).toBe(201);
    expect(db.product.create.mock.calls[0][0].data.retailPrice).toBe(24.99);
  });
});

describe('retail NULL preservation — PUT /api/products/[id]', () => {
  function seedExisting(overrides: any = {}) {
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: 999, approvalStatus: 'APPROVED', deletedAt: null })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 7,
        reorderConfig: null,
        ...overrides,
      });
    db.product.update.mockImplementation(async ({ data }: any) => ({ id: 5, name: 'BPC 5mg', ...data }));
  }

  it('PUT with retailPrice=null clears the retail back to unknown (NULL)', async () => {
    setUser(ADMIN_USER);
    seedExisting();

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { retailPrice: null }),
      { params: { id: '5' } },
    );

    expect(resp.status).toBe(200);
    expect(db.product.update.mock.calls[0][0].data.retailPrice).toBeNull();
  });

  it('PUT with retailPrice=0 stores an explicit free price (kept distinct from NULL)', async () => {
    setUser(ADMIN_USER);
    seedExisting({ retailPrice: null });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { retailPrice: 0 }),
      { params: { id: '5' } },
    );

    expect(resp.status).toBe(200);
    expect(db.product.update.mock.calls[0][0].data.retailPrice).toBe(0);
  });

  it('PUT omitting retailPrice leaves it untouched (never coerced to 0)', async () => {
    setUser(ADMIN_USER);
    seedExisting();

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { variant: '10mg' }),
      { params: { id: '5' } },
    );

    expect(resp.status).toBe(200);
    const data = db.product.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('retailPrice');
  });
});
