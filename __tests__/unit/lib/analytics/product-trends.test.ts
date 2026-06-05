jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { productStockSnapshot: { groupBy: jest.fn() } },
}));
import prisma from "@/lib/prisma";
import { getProductStockTrends } from "@/lib/analytics/product-trends";

const m = prisma as unknown as { productStockSnapshot: { groupBy: jest.Mock } };
beforeEach(() => jest.clearAllMocks());

test("empty productIds short-circuits (no query)", async () => {
  const out = await getProductStockTrends([]);
  expect(out.size).toBe(0);
  expect(m.productStockSnapshot.groupBy).not.toHaveBeenCalled();
});

test("groups by [productId, dayKey] SUMMING quantity; date range bounds dayKey", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([]);
  await getProductStockTrends([1, 2], "2026-05-01", "2026-06-01");
  const arg = m.productStockSnapshot.groupBy.mock.calls[0][0];
  expect(arg.by).toEqual(["productId", "dayKey"]);
  expect(arg._sum).toEqual({ quantity: true });
  expect(arg.where.productId).toEqual({ in: [1, 2] });
  expect(arg.where.dayKey).toEqual({ gte: "2026-05-01", lte: "2026-06-01" });
});

test("product with <2 distinct days => null", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([
    { productId: 1, dayKey: "2026-06-01", _sum: { quantity: 10 } },
  ]);
  const out = await getProductStockTrends([1]);
  expect(out.get(1)).toBeNull();
});

test("product with >=2 days => calculateTrend(latest, earliest); decreasing stock => down", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([
    { productId: 1, dayKey: "2026-06-01", _sum: { quantity: 100 } },
    { productId: 1, dayKey: "2026-06-08", _sum: { quantity: 50 } }, // -50% => down 50
  ]);
  const out = await getProductStockTrends([1]);
  expect(out.get(1)).toEqual({ value: 50, direction: "down" });
});

test("per-day level SUMS multiple location rows for the same day", async () => {
  // Two locations on day1 (40+60=100), two on day2 (60+60=120) => +20% up.
  m.productStockSnapshot.groupBy.mockResolvedValue([
    { productId: 7, dayKey: "2026-06-01", _sum: { quantity: 100 } },
    { productId: 7, dayKey: "2026-06-02", _sum: { quantity: 120 } },
  ]);
  const out = await getProductStockTrends([7]);
  expect(out.get(7)).toEqual({ value: 20, direction: "up" });
});

test("requested product with no snapshots at all => null entry present", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([]);
  const out = await getProductStockTrends([3]);
  expect(out.has(3)).toBe(true);
  expect(out.get(3)).toBeNull();
});
