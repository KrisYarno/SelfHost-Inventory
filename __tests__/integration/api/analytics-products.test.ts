// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/analytics/queries", () => ({ getSales: jest.fn() }));
jest.mock("@/lib/analytics/product-trends", () => ({ getProductStockTrends: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    userCompany: { findMany: jest.fn() },
    product: { findMany: jest.fn() },
    product_locations: { groupBy: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/products/route";
import { requireApproved, requireCompanyMembership } from "@/lib/api-utils";
import { enforceRateLimit } from "@/lib/rateLimit";
import { getSales } from "@/lib/analytics/queries";
import { getProductStockTrends } from "@/lib/analytics/product-trends";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  userCompany: { findMany: jest.Mock };
  product: { findMany: jest.Mock };
  product_locations: { groupBy: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
};
const getSalesMock = getSales as jest.Mock;
const getTrendsMock = getProductStockTrends as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  // No lowStockDefaultThreshold row => getLowStockDefault falls back to 10.
  m.systemSetting.findUnique.mockResolvedValue(null);
  // Default to zero memberships; tests that exercise the sales path override this.
  m.userCompany.findMany.mockResolvedValue([]);
  m.product.findMany.mockResolvedValue([
    { id: 1, name: "Alpha", lowStockThreshold: 5 },
    { id: 2, name: "Bravo", lowStockThreshold: 10 },
  ]);
  m.product_locations.groupBy.mockResolvedValue([
    { productId: 1, _sum: { quantity: 7 } },
    { productId: 2, _sum: { quantity: 0 } },
  ]);
  getSalesMock.mockResolvedValue([]);
  getTrendsMock.mockResolvedValue(new Map());
});

test("requireApproved gates the route, and the rate-limit guard runs", async () => {
  await GET(new NextRequest("http://x/api/analytics/products"));
  expect(requireApproved).toHaveBeenCalled();
  expect(enforceRateLimit).toHaveBeenCalledWith(expect.anything(), "analytics-products:GET", { identifier: 1 });
});

test("filters to APPROVED + non-deleted (current-state positive filter)", async () => {
  await GET(new NextRequest("http://x/api/analytics/products"));
  const where = m.product.findMany.mock.calls[0][0].where;
  expect(where).toMatchObject({ deletedAt: null, approvalStatus: "APPROVED" });
});

test("omit companyId => sums across the caller's OWN memberships (never all companies)", async () => {
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }, { companyId: "c2" }]);
  await GET(new NextRequest("http://x/api/analytics/products"));
  expect(getSalesMock).toHaveBeenCalledWith(expect.objectContaining({ companyIds: ["c1", "c2"], groupBy: "product" }));
  expect(requireCompanyMembership).not.toHaveBeenCalled();
});

test("explicit companyId => membership-checked, scopes to that one company", async () => {
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  await GET(new NextRequest("http://x/api/analytics/products?companyId=c1"));
  expect(requireCompanyMembership).toHaveBeenCalledWith(1, "c1", false);
  expect(getSalesMock).toHaveBeenCalledWith(expect.objectContaining({ companyIds: ["c1"] }));
  expect(m.userCompany.findMany).not.toHaveBeenCalled();
});

test("explicit non-member companyId => 404 propagates; sales/stock-trend NEVER reached", async () => {
  const notFound: any = new Error("Resource not found");
  notFound.statusCode = 404;
  (requireCompanyMembership as jest.Mock).mockRejectedValue(notFound);
  await expect(GET(new NextRequest("http://x/api/analytics/products?companyId=other")))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(getSalesMock).not.toHaveBeenCalled();
  expect(getTrendsMock).not.toHaveBeenCalled();
});

test("zero-membership approved user: stock renders, sales empty, no 403", async () => {
  m.userCompany.findMany.mockResolvedValue([]);
  getSalesMock.mockResolvedValue([]); // getSales returns [] for empty companyIds
  const res = await GET(new NextRequest("http://x/api/analytics/products"));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(getSalesMock).toHaveBeenCalledWith(expect.objectContaining({ companyIds: [] }));
  // stock still present; sales zeroed
  const alpha = body.products.find((p: any) => p.productId === 1);
  expect(alpha.currentStock).toBe(7);
  expect(alpha.units).toBe(0);
  expect(alpha.revenue).toBe("0.00");
});

test("rollup merge: sales row maps onto product; Decimal revenue serialized to string", async () => {
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getSalesMock.mockResolvedValue([
    { productId: 1, _sum: { orderedQty: 12, orderCount: 3, revenue: { toString: () => "45.50" } } },
  ]);
  const res = await GET(new NextRequest("http://x/api/analytics/products?sort=units&dir=desc"));
  const body = await res.json();
  const alpha = body.products.find((p: any) => p.productId === 1);
  expect(alpha).toMatchObject({ units: 12, orderCount: 3, revenue: "45.50", currentStock: 7 });
});

test("all-my-companies SUM: a product selling in two companies folds into ONE row", async () => {
  // getSales(groupBy=product) already returns ONE row per productId summed across companyIds.
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }, { companyId: "c2" }]);
  getSalesMock.mockResolvedValue([
    { productId: 1, _sum: { orderedQty: 30, orderCount: 4, revenue: { toString: () => "99.00" } } },
  ]);
  const res = await GET(new NextRequest("http://x/api/analytics/products"));
  const body = await res.json();
  const rows = body.products.filter((p: any) => p.productId === 1);
  expect(rows).toHaveLength(1);
  expect(rows[0].units).toBe(30);
});

test("filter=out applied AFTER merge: keeps only zero-stock products", async () => {
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  const res = await GET(new NextRequest("http://x/api/analytics/products?filter=out"));
  const body = await res.json();
  expect(body.products.map((p: any) => p.productId)).toEqual([2]); // Bravo has 0 stock
  expect(body.total).toBe(1);
});

test("pagination is applied AFTER sort over the full set", async () => {
  m.product.findMany.mockResolvedValue([
    { id: 1, name: "Alpha", lowStockThreshold: 5 },
    { id: 2, name: "Bravo", lowStockThreshold: 5 },
    { id: 3, name: "Charlie", lowStockThreshold: 5 },
  ]);
  m.product_locations.groupBy.mockResolvedValue([]);
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  getSalesMock.mockResolvedValue([
    { productId: 1, _sum: { orderedQty: 5, orderCount: 1, revenue: { toString: () => "0" } } },
    { productId: 2, _sum: { orderedQty: 50, orderCount: 1, revenue: { toString: () => "0" } } },
    { productId: 3, _sum: { orderedQty: 20, orderCount: 1, revenue: { toString: () => "0" } } },
  ]);
  const res = await GET(new NextRequest("http://x/api/analytics/products?sort=units&dir=desc&page=1&pageSize=2"));
  const body = await res.json();
  expect(body.products.map((p: any) => p.productId)).toEqual([2, 3]);
  expect(body.total).toBe(3);
});

test("no candidate products => empty page, no rollup queries fire", async () => {
  m.product.findMany.mockResolvedValue([]);
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  const res = await GET(new NextRequest("http://x/api/analytics/products"));
  const body = await res.json();
  expect(body).toMatchObject({ products: [], total: 0 });
  expect(getSalesMock).not.toHaveBeenCalled();
  expect(m.product_locations.groupBy).not.toHaveBeenCalled();
});
