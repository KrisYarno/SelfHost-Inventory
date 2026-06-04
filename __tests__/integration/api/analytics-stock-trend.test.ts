// @jest-environment node
jest.mock("@/lib/api-utils", () => ({ apiHandler: (fn: any) => fn, requireApproved: jest.fn() }));
jest.mock("@/lib/rateLimit", () => ({ enforceRateLimit: jest.fn(() => ({})), applyRateLimitHeaders: jest.fn((r: any) => r) }));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { productStockSnapshot: { findMany: jest.fn() } } }));
import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/stock-trend/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
const m = prisma as unknown as { productStockSnapshot: { findMany: jest.Mock } };

beforeEach(() => jest.clearAllMocks());

test("returns the snapshot series for a product, GLOBAL (no company scoping)", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isApproved: true } });
  m.productStockSnapshot.findMany.mockResolvedValue([{ dayKey: "2026-06-03", locationId: 1, quantity: 5 }]);
  const res = await GET(new NextRequest("http://x/api/analytics/stock-trend?productId=42&from=2026-06-01&to=2026-06-04"));
  expect(res.status).toBe(200);
  const where = m.productStockSnapshot.findMany.mock.calls[0][0].where;
  expect(where.productId).toBe(42);
  expect(where).not.toHaveProperty("companyId");
  expect(where.dayKey).toEqual({ gte: "2026-06-01", lte: "2026-06-04" });
  const body = await res.json();
  expect(body.series).toHaveLength(1);
});

test("omits dayKey filter when no from/to given", async () => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isApproved: true } });
  m.productStockSnapshot.findMany.mockResolvedValue([]);
  const res = await GET(new NextRequest("http://x/api/analytics/stock-trend?productId=42"));
  expect(res.status).toBe(200);
  const where = m.productStockSnapshot.findMany.mock.calls[0][0].where;
  expect(where).not.toHaveProperty("dayKey");
});
