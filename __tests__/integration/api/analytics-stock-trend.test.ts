// @jest-environment node
// N0 (C8): the REAL apiHandler, so the thrown AppError maps to its HTTP status as it
// does in production; only the guard is stubbed.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireApproved: jest.fn() };
});
jest.mock("@/lib/rateLimit", () => ({
  // The real apiHandler does `instanceof RateLimitError` — keep the real class.
  RateLimitError: jest.requireActual("@/lib/rateLimit").RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
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

// N0 (C7) SUPERSEDES the no-productId case: it used to return the WHOLE snapshot
// table. productId is REQUIRED and must be a positive Int.
test.each([
  ["no productId", "http://x/api/analytics/stock-trend"],
  ["empty productId", "http://x/api/analytics/stock-trend?productId="],
  ["productId=0", "http://x/api/analytics/stock-trend?productId=0"],
  ["productId=-3", "http://x/api/analytics/stock-trend?productId=-3"],
  ["productId=abc", "http://x/api/analytics/stock-trend?productId=abc"],
  ["productId=42abc", "http://x/api/analytics/stock-trend?productId=42abc"],
  ["productId=042", "http://x/api/analytics/stock-trend?productId=042"],
  ["productId past Int", "http://x/api/analytics/stock-trend?productId=2147483648"],
])("%s => 400 productId is required, no snapshot read", async (_label, url) => {
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isApproved: true } });
  const res = await GET(new NextRequest(url));
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "productId is required", code: "VALIDATION_ERROR" });
  expect(m.productStockSnapshot.findMany).not.toHaveBeenCalled();
});
