// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCompanyMembership: jest.fn(),
}));
jest.mock("@/lib/analytics/queries", () => ({ getStockSeries: jest.fn(), getSales: jest.fn() }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    userCompany: { findMany: jest.fn() },
    // Lane 3 T3: the route now also loads product identity + a GLOBAL stock sum
    // for the D-L2 History-host header.
    product: { findUnique: jest.fn() },
    product_locations: { aggregate: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/analytics/product/[id]/route";
import { requireApproved, requireCompanyMembership } from "@/lib/api-utils";
import { getStockSeries, getSales } from "@/lib/analytics/queries";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  userCompany: { findMany: jest.Mock };
  product: { findUnique: jest.Mock };
  product_locations: { aggregate: jest.Mock };
};
const stockMock = getStockSeries as jest.Mock;
const salesMock = getSales as jest.Mock;
const ctx = (id: string) => ({ params: { id } });

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: false } });
  stockMock.mockResolvedValue([]);
  salesMock.mockResolvedValue([]);
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]);
  m.product.findUnique.mockResolvedValue({ name: "BPC 5mg", baseName: "BPC", variant: "5mg" });
  m.product_locations.aggregate.mockResolvedValue({ _sum: { quantity: 42 } });
});

test("requireApproved gates the route before any data access", async () => {
  await GET(new NextRequest("http://x/api/analytics/product/5"), ctx("5"));
  expect(requireApproved).toHaveBeenCalled();
});

test("from/to are passed to BOTH getStockSeries and getSales (date-bounding)", async () => {
  await GET(new NextRequest("http://x/api/analytics/product/5?from=2026-05-01&to=2026-06-01"), ctx("5"));
  expect(stockMock).toHaveBeenCalledWith(expect.objectContaining({ productId: 5, from: "2026-05-01", to: "2026-06-01" }));
  expect(salesMock).toHaveBeenCalledWith(expect.objectContaining({ productId: 5, from: "2026-05-01", to: "2026-06-01" }));
});

test("omit companyId => memberships sum (default behavior preserved)", async () => {
  m.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }, { companyId: "c2" }]);
  await GET(new NextRequest("http://x/api/analytics/product/5"), ctx("5"));
  expect(salesMock).toHaveBeenCalledWith(expect.objectContaining({ companyIds: ["c1", "c2"] }));
  expect(requireCompanyMembership).not.toHaveBeenCalled();
});

test("explicit companyId => membership-checked, scopes to that one company", async () => {
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  await GET(new NextRequest("http://x/api/analytics/product/5?companyId=c1"), ctx("5"));
  expect(requireCompanyMembership).toHaveBeenCalledWith(1, "c1", false);
  expect(salesMock).toHaveBeenCalledWith(expect.objectContaining({ companyIds: ["c1"] }));
  expect(m.userCompany.findMany).not.toHaveBeenCalled();
});

test("explicit non-member companyId => 404 propagates; sales NEVER reached (isolation)", async () => {
  const notFound: any = new Error("Resource not found");
  notFound.statusCode = 404;
  (requireCompanyMembership as jest.Mock).mockRejectedValue(notFound);
  await expect(GET(new NextRequest("http://x/api/analytics/product/5?companyId=other"), ctx("5")))
    .rejects.toMatchObject({ statusCode: 404 });
  expect(salesMock).not.toHaveBeenCalled();
});

test("stock is GLOBAL: still fetched even with zero memberships (no leak on sales)", async () => {
  m.userCompany.findMany.mockResolvedValue([]);
  salesMock.mockResolvedValue([]); // getSales returns [] for empty companyIds
  const res = await GET(new NextRequest("http://x/api/analytics/product/5"), ctx("5"));
  expect(res.status).toBe(200);
  expect(stockMock).toHaveBeenCalledWith(expect.objectContaining({ productId: 5 }));
  expect(salesMock).toHaveBeenCalledWith(expect.objectContaining({ companyIds: [] }));
});

test("invalid id => 400, no queries", async () => {
  const res = await GET(new NextRequest("http://x/api/analytics/product/abc"), ctx("abc"));
  expect(res.status).toBe(400);
  expect(stockMock).not.toHaveBeenCalled();
});

test("payload carries product identity + GLOBAL current stock for the D-L2 header", async () => {
  const res = await GET(new NextRequest("http://x/api/analytics/product/5"), ctx("5"));
  expect(res.status).toBe(200);
  const body = await (res as Response).json();
  expect(body.product).toEqual({
    name: "BPC 5mg",
    baseName: "BPC",
    variant: "5mg",
    currentStock: 42,
  });
  expect(m.product.findUnique).toHaveBeenCalledWith({
    where: { id: 5 },
    select: { name: true, baseName: true, variant: true },
  });
  expect(m.product_locations.aggregate).toHaveBeenCalledWith({
    _sum: { quantity: true },
    where: { productId: 5 },
  });
});

test("missing product row => identity nulls + zero stock (no crash)", async () => {
  m.product.findUnique.mockResolvedValue(null);
  m.product_locations.aggregate.mockResolvedValue({ _sum: { quantity: null } });
  const res = await GET(new NextRequest("http://x/api/analytics/product/5"), ctx("5"));
  expect(res.status).toBe(200);
  const body = await (res as Response).json();
  expect(body.product).toEqual({ name: null, baseName: null, variant: null, currentStock: 0 });
});
