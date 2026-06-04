// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/analytics/queries", () => ({
  getStockSeries: jest.fn(),
  getSales: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { userCompany: { findMany: jest.fn() } },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/product/[id]/route";
import { requireApproved } from "@/lib/api-utils";
import { getStockSeries, getSales } from "@/lib/analytics/queries";
import prisma from "@/lib/prisma";

const m = prisma as unknown as { userCompany: { findMany: jest.Mock } };
const getStockSeriesMock = getStockSeries as jest.Mock;
const getSalesMock = getSales as jest.Mock;

const req = () => new NextRequest("http://x/api/analytics/product/42");
const ctx = (id: string) => ({ params: { id } });

beforeEach(() => jest.clearAllMocks());

test("returns a unified { stock, sales } payload", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getStockSeriesMock.mockResolvedValue([
    { dayKey: "2026-06-03", locationId: 1, quantity: 5 },
  ]);
  getSalesMock.mockResolvedValue([]);

  const res = await GET(req(), ctx("42"));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.stock.series).toHaveLength(1);
  expect(Array.isArray(body.sales.series)).toBe(true);
});

test("stock is GLOBAL: getStockSeries called with productId and NO companyId", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getStockSeriesMock.mockResolvedValue([
    { dayKey: "2026-06-03", locationId: 1, quantity: 5 },
  ]);
  getSalesMock.mockResolvedValue([]);

  await GET(req(), ctx("42"));

  expect(getStockSeriesMock).toHaveBeenCalledTimes(1);
  const arg = getStockSeriesMock.mock.calls[0][0];
  expect(arg).toEqual({ productId: 42 });
  // hard guarantee: inventory is GLOBAL, never company-scoped
  expect(arg).not.toHaveProperty("companyId");
  expect(arg).not.toHaveProperty("companyIds");
});

test("sales is scoped to the caller's OWN companies (ownership view)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getStockSeriesMock.mockResolvedValue([]);
  getSalesMock.mockResolvedValue([]);

  await GET(req(), ctx("42"));

  expect(m.userCompany.findMany).toHaveBeenCalledWith({
    where: { userId: 1 },
    select: { companyId: true },
  });
  expect(getSalesMock).toHaveBeenCalledWith(
    expect.objectContaining({ companyIds: ["c1"], productId: 42 })
  );
});

test("caller with no companies => GLOBAL stock present, sales empty, no error", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  m.userCompany.findMany.mockResolvedValue([]);
  // stock is GLOBAL, so it still returns data even with zero memberships
  getStockSeriesMock.mockResolvedValue([
    { dayKey: "2026-06-03", locationId: 1, quantity: 5 },
  ]);
  // getSales contract: empty companyIds -> [] (hard isolation). Mirror it.
  getSalesMock.mockResolvedValue([]);

  const res = await GET(req(), ctx("42"));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.stock.series).toHaveLength(1);
  expect(body.sales.series).toEqual([]);
  // never leak: companyIds passed must be the empty set (or getSales not called at all)
  if (getSalesMock.mock.calls.length > 0) {
    expect(getSalesMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyIds: [] })
    );
  }
});
