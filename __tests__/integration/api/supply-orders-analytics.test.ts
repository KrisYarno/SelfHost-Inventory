// @jest-environment node
/**
 * M3b — `GET /api/analytics/supply-orders?from=&to=` (plan P-10).
 *
 * The thin Next half of the analytics seam: the producer
 * (`lib/analytics/supply-orders.ts`, pinned in its own unit suite) owns the
 * numbers and the strings that ride them; this route owns the guard, the query
 * parse and the envelope — and owns NOT growing anything else, because the house
 * analytics reads carry no CSRF, no rate limiter and no audit.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/api-utils', () => {
  const actual = jest.requireActual('@/lib/api-utils');
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(async () => ({
      user: { id: 7, isAdmin: false, isApproved: true },
    })),
  };
});

jest.mock('@/lib/analytics/supply-orders', () => ({
  __esModule: true,
  getSupplyOrdersAnalytics: jest.fn(),
}));

import { GET as analyticsGET } from '@/app/api/analytics/supply-orders/route';
import { requireApproved } from '@/lib/api-utils';
import { getSupplyOrdersAnalytics } from '@/lib/analytics/supply-orders';

const mockProducer = getSupplyOrdersAnalytics as jest.Mock;

const PAYLOAD = {
  window: { from: '2026-08-01', to: '2026-08-31' },
  orders: { count: 0, byStatus: {} },
  metrics: {
    fees: {
      valueCents: null,
      definition: 'd',
      coverage: 'c',
      contributingRows: 0,
      reason: 'none',
    },
  },
};

function mkReq(query: string) {
  return new NextRequest(`http://t/api/analytics/supply-orders${query}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, isAdmin: false, isApproved: true },
  });
  mockProducer.mockResolvedValue(PAYLOAD);
});

describe('GET /api/analytics/supply-orders', () => {
  it('requires an approved user', async () => {
    (requireApproved as jest.Mock).mockRejectedValue(
      new (jest.requireActual('@/lib/error-handling').AppError)('Unauthorized', 'UNAUTHORIZED', 401),
    );

    const res = await analyticsGET(mkReq('?from=2026-08-01&to=2026-08-31'), {} as never);
    expect(res.status).toBe(401);
    expect(mockProducer).not.toHaveBeenCalled();
  });

  it('passes the window straight through and returns the producer payload', async () => {
    const res = await analyticsGET(mkReq('?from=2026-08-01&to=2026-08-31'), {} as never);

    expect(res.status).toBe(200);
    expect(mockProducer).toHaveBeenCalledWith({ from: '2026-08-01', to: '2026-08-31' });
    expect(await res.json()).toEqual(PAYLOAD);
  });

  it('400s a missing end of the window', async () => {
    const res = await analyticsGET(mkReq('?from=2026-08-01'), {} as never);
    expect(res.status).toBe(400);
    expect(mockProducer).not.toHaveBeenCalled();
  });

  it('400s a day that does not exist', async () => {
    const res = await analyticsGET(mkReq('?from=2026-02-30&to=2026-03-01'), {} as never);
    expect(res.status).toBe(400);
    expect(mockProducer).not.toHaveBeenCalled();
  });

  it('400s a window that runs backwards', async () => {
    const res = await analyticsGET(mkReq('?from=2026-08-31&to=2026-08-01'), {} as never);
    expect(res.status).toBe(400);
    expect(mockProducer).not.toHaveBeenCalled();
  });
});
