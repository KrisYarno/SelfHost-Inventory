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
    },
    location: {
      findUnique: jest.fn(),
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

// lib/products helpers are exercised elsewhere; here we stub the pure helpers the
// routes call so the test focuses on the guard + approval-field behavior.
jest.mock('@/lib/products', () => ({
  getProductsWithQuantities: jest.fn(),
  isProductUnique: jest.fn(async () => true),
  formatProductName: jest.fn(({ baseName, variant }: any) =>
    `${baseName}${variant ? ' ' + variant : ''}`.trim()
  ),
}));

// PUT's sibling GET imports getCurrentQuantity from lib/inventory; stub it so
// importing the route doesn't pull the real inventory graph. Preserve the real
// OptimisticLockError class — the real apiHandler does `error instanceof
// OptimisticLockError`, which throws if the export is undefined.
jest.mock('@/lib/inventory', () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual('@/lib/inventory').OptimisticLockError,
  getCurrentQuantity: jest.fn(async () => 0),
}));

import { POST as createPOST } from '@/app/api/products/route';
import { PUT as updatePUT } from '@/app/api/products/[id]/route';
import { requireApproved } from '@/lib/api-utils';
import { validateCSRFToken } from '@/lib/csrf';
import prisma from '@/lib/prisma';

const db: any = prisma as any;
const mockValidateCSRF = validateCSRFToken as jest.Mock;

const APPROVED_USER = { id: 7, isAdmin: false, isApproved: true };
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

describe('POST /api/products (create — provisional approval)', () => {
  it('non-admin approved user creates a PENDING_REVIEW product with createdBy set (201)', async () => {
    setUser(APPROVED_USER);
    db.product.create.mockImplementation(async ({ data }: any) => ({ id: 50, ...data }));

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', {
        baseName: 'BPC',
        variant: '5mg',
        locationId: 1,
      })
    );

    expect(resp.status).toBe(201);
    const createArgs = db.product.create.mock.calls[0][0];
    expect(createArgs.data.approvalStatus).toBe('PENDING_REVIEW');
    expect(createArgs.data.createdBy).toBe(APPROVED_USER.id);
  });

  it('admin creates an APPROVED product (201)', async () => {
    setUser(ADMIN_USER);
    db.product.create.mockImplementation(async ({ data }: any) => ({ id: 51, ...data }));

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', {
        baseName: 'TB',
        variant: '500',
        locationId: 1,
      })
    );

    expect(resp.status).toBe(201);
    const createArgs = db.product.create.mock.calls[0][0];
    expect(createArgs.data.approvalStatus).toBe('APPROVED');
    expect(createArgs.data.createdBy).toBe(ADMIN_USER.id);
  });

  it('returns 403 when CSRF token is invalid (no create)', async () => {
    setUser(APPROVED_USER);
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await createPOST(
      mkReq('http://t/api/products', 'POST', {
        baseName: 'BPC',
        variant: '5mg',
        locationId: 1,
      })
    );

    expect(resp.status).toBe(403);
    expect(db.product.create).not.toHaveBeenCalled();
  });
});

describe('PUT /api/products/[id] (creator-edit-own-pending guard)', () => {
  it('allows the creator to edit their own PENDING_REVIEW product (200)', async () => {
    setUser(APPROVED_USER);
    // First findUnique = guard check (narrow select); second = existingProduct fetch.
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: APPROVED_USER.id, approvalStatus: 'PENDING_REVIEW' })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 0,
      });
    db.product.update.mockResolvedValue({ id: 5, baseName: 'BPC', variant: '10mg', name: 'BPC 10mg' });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { variant: '10mg' }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(db.product.update).toHaveBeenCalled();
  });

  it('returns 403 when a different non-admin edits a product they did not create', async () => {
    setUser(APPROVED_USER);
    db.product.findUnique.mockResolvedValueOnce({
      createdBy: 999, // a different user
      approvalStatus: 'PENDING_REVIEW',
    });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { variant: '10mg' }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/forbidden/i);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('returns 403 when the creator tries to edit their product after it is APPROVED', async () => {
    setUser(APPROVED_USER);
    db.product.findUnique.mockResolvedValueOnce({
      createdBy: APPROVED_USER.id,
      approvalStatus: 'APPROVED', // no longer pending -> non-admin loses edit rights
    });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { variant: '10mg' }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    expect(db.product.update).not.toHaveBeenCalled();
  });

  it('allows an admin to edit any product (200)', async () => {
    setUser(ADMIN_USER);
    db.product.findUnique
      .mockResolvedValueOnce({ createdBy: 999, approvalStatus: 'APPROVED' })
      .mockResolvedValueOnce({
        id: 5,
        baseName: 'BPC',
        variant: '5mg',
        lowStockThreshold: 10,
        costPrice: 0,
        retailPrice: 0,
      });
    db.product.update.mockResolvedValue({ id: 5, baseName: 'BPC', variant: '10mg', name: 'BPC 10mg' });

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { variant: '10mg' }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(200);
    expect(db.product.update).toHaveBeenCalled();
  });

  it('returns 403 when CSRF token is invalid (no guard lookup, no update)', async () => {
    setUser(APPROVED_USER);
    mockValidateCSRF.mockResolvedValue(false);

    const resp = await updatePUT(
      mkReq('http://t/api/products/5', 'PUT', { variant: '10mg' }),
      { params: { id: '5' } }
    );

    expect(resp.status).toBe(403);
    expect(db.product.findUnique).not.toHaveBeenCalled();
    expect(db.product.update).not.toHaveBeenCalled();
  });
});
