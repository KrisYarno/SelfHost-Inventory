// @jest-environment node
import { NextRequest } from 'next/server';

// Keep the REAL apiHandler (so ZodError -> 400 and AppError -> its status get
// mapped centrally), but stub the auth guards.
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
      findFirst: jest.fn(),
    },
    location: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
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

jest.mock('@/lib/audit', () => ({
  auditService: {
    log: jest.fn(async () => undefined),
    logProductCreate: jest.fn(async () => undefined),
    logProductUpdate: jest.fn(async () => undefined),
  },
}));

// Stub the pure lib/products helpers the route calls so the test focuses on the
// field pass-through behavior.
jest.mock('@/lib/products', () => ({
  getProductsWithQuantities: jest.fn(),
  isProductUnique: jest.fn(async () => true),
  formatProductName: jest.fn(({ baseName, variant }: any) =>
    `${baseName ?? ''}${variant ? ' ' + variant : ''}`.trim()
  ),
}));

// The sibling GET imports getCurrentQuantity from lib/inventory; stub it so
// importing the route doesn't pull the real inventory graph.
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
  getCurrentQuantity: jest.fn(async () => 0),
}));

import { PUT as updatePUT } from '@/app/api/products/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import { auditService } from '@/lib/audit';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;
const mockLogProductUpdate = auditService.logProductUpdate as jest.Mock;

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

describe('PUT /api/products/[id] (size-field pass-through: unit + numericValue)', () => {
  it('passes validated unit and numericValue through to prisma.product.update', async () => {
    setUser(ADMIN_USER);
    // First findUnique = guard check; second = existingProduct fetch.
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: 999, approvalStatus: 'APPROVED', deletedAt: null })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        unit: null,
        numericValue: null,
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 0,
      });
    db.product.update.mockResolvedValue({ id: 5, name: 'BPC 5mg' });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { unit: 'mg', numericValue: 10 }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(db.product.update).toHaveBeenCalled();
    const updateArgs = db.product.update.mock.calls[0][0];
    expect(updateArgs.data.unit).toBe('mg');
    expect(updateArgs.data.numericValue).toBe(10);
  });

  it('records unit and numericValue in the audit change diff', async () => {
    setUser(ADMIN_USER);
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: 999, approvalStatus: 'APPROVED', deletedAt: null })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        unit: null,
        numericValue: null,
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 0,
      });
    db.product.update.mockResolvedValue({ id: 5, name: 'BPC 5mg' });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { unit: 'mg', numericValue: 10 }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(mockLogProductUpdate).toHaveBeenCalled();
    const changes = mockLogProductUpdate.mock.calls[0][3];
    expect(changes.unit).toEqual({ from: null, to: 'mg' });
    expect(changes.numericValue).toEqual({ from: null, to: 10 });
  });

  it('does not corrupt the derived name when unit/numericValue change (name stays baseName+variant)', async () => {
    setUser(ADMIN_USER);
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: 999, approvalStatus: 'APPROVED', deletedAt: null })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        unit: null,
        numericValue: null,
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 0,
      });
    db.product.update.mockResolvedValue({ id: 5, name: 'BPC 5mg' });

    await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { unit: 'mg', numericValue: 10 }),
      { params: { id: '5' } }
    );

    const updateArgs = db.product.update.mock.calls[0][0];
    // name is derived only from baseName+variant; a size-only edit must not set it.
    expect(updateArgs.data.name).toBeUndefined();
  });
});
