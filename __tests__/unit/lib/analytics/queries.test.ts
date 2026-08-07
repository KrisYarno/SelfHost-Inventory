jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {
  productSalesFact: { groupBy: jest.fn() }, productStockSnapshot: { findMany: jest.fn() },
} }));
import prisma from "@/lib/prisma";
import { getSales, getStockSeries } from "@/lib/analytics/queries";
const m = prisma as unknown as { productSalesFact: { groupBy: jest.Mock }; productStockSnapshot: { findMany: jest.Mock } };
beforeEach(() => jest.clearAllMocks());

describe("getSales (multi-company isolation)", () => {
  test("always constrains companyId IN the caller's companies", async () => {
    m.productSalesFact.groupBy.mockResolvedValue([]);
    await getSales({ companyIds: ["c1", "c2"], productId: 42, from: "2026-06-01", to: "2026-06-30" });
    const arg = m.productSalesFact.groupBy.mock.calls[0][0];
    expect(arg.where.companyId).toEqual({ in: ["c1", "c2"] });
    // quality+reach Task 3.1: productId and the optional G5 approved-id set narrow the
    // SAME column, so the read builds ONE IntFilter instead of a bare scalar (a bare
    // second `productId` key would silently overwrite the first).
    expect(arg.where.productId).toEqual({ equals: 42 });
    expect(arg.where.dayKey).toEqual({ gte: "2026-06-01", lte: "2026-06-30" });
    expect(arg.by).toEqual(["productId"]); // default groupBy
  });
  test("groupBy=company groups by [companyId, dayKey]", async () => {
    m.productSalesFact.groupBy.mockResolvedValue([]);
    await getSales({ companyIds: ["c1"], groupBy: "company" });
    expect(m.productSalesFact.groupBy.mock.calls[0][0].by).toEqual(["companyId", "dayKey"]);
  });
  test("empty companyIds returns [] WITHOUT querying (hard isolation)", async () => {
    const out = await getSales({ companyIds: [] });
    expect(out).toEqual([]);
    expect(m.productSalesFact.groupBy).not.toHaveBeenCalled();
  });
  test("groupBy=product SUMS orderCount (orders containing that product); fulfilledQty is gone (B5)", async () => {
    m.productSalesFact.groupBy.mockResolvedValue([]);
    await getSales({ companyIds: ["c1"], groupBy: "product" });
    const _sum = m.productSalesFact.groupBy.mock.calls[0][0]._sum;
    expect(_sum).toEqual({ orderedQty: true, revenue: true, orderCount: true });
    expect(_sum.orderCount).toBe(true);
    expect(_sum).not.toHaveProperty("fulfilledQty"); // Lane 6: never surfaced
  });
  test("groupBy=day OMITS orderCount from _sum (summing it cross-product double-counts)", async () => {
    m.productSalesFact.groupBy.mockResolvedValue([]);
    await getSales({ companyIds: ["c1"], groupBy: "day" });
    const _sum = m.productSalesFact.groupBy.mock.calls[0][0]._sum;
    expect(_sum).toEqual({ orderedQty: true, revenue: true });
    expect(_sum).not.toHaveProperty("orderCount");
    expect(_sum).not.toHaveProperty("fulfilledQty");
  });
  test("groupBy=integration and =company also OMIT orderCount (cross-product grains)", async () => {
    m.productSalesFact.groupBy.mockResolvedValue([]);
    await getSales({ companyIds: ["c1"], groupBy: "integration" });
    expect(m.productSalesFact.groupBy.mock.calls[0][0]._sum).not.toHaveProperty("orderCount");
    m.productSalesFact.groupBy.mockClear();
    await getSales({ companyIds: ["c1"], groupBy: "company" });
    expect(m.productSalesFact.groupBy.mock.calls[0][0]._sum).not.toHaveProperty("orderCount");
  });
});

describe("getStockSeries (GLOBAL)", () => {
  test("filters by productId + dayKey range, NO company scoping", async () => {
    m.productStockSnapshot.findMany.mockResolvedValue([]);
    await getStockSeries({ productId: 7, from: "2026-06-01", to: "2026-06-30" });
    const arg = m.productStockSnapshot.findMany.mock.calls[0][0];
    expect(arg.where.productId).toBe(7);
    expect(arg.where.dayKey).toEqual({ gte: "2026-06-01", lte: "2026-06-30" });
    expect(arg.where).not.toHaveProperty("companyId");
  });
});
