// @jest-environment node
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { count: jest.fn(), findMany: jest.fn() },
    product_locations: { findMany: jest.fn() },
    inventory_logs: { groupBy: jest.fn(), count: jest.fn() },
    productStockSnapshot: { groupBy: jest.fn(), aggregate: jest.fn() },
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/reports/metrics/route";
import { requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  product: { count: jest.Mock; findMany: jest.Mock };
  product_locations: { findMany: jest.Mock };
  inventory_logs: { groupBy: jest.Mock; count: jest.Mock };
  productStockSnapshot: { groupBy: jest.Mock; aggregate: jest.Mock };
};

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: true } });
  m.product.count.mockResolvedValue(2);
  // Two products, both threshold 10.
  m.product.findMany.mockResolvedValue([
    { id: 1, costPrice: 0, retailPrice: 0, lowStockThreshold: 10 },
    { id: 2, costPrice: 0, retailPrice: 0, lowStockThreshold: 10 },
  ]);
  m.product_locations.findMany.mockResolvedValue([]);
  m.inventory_logs.groupBy.mockResolvedValue([]);
  m.inventory_logs.count.mockResolvedValue(0);
  // Latest snapshot day drives the trend-window floor; default to a fixed day so the
  // bounded groupBy runs. The "no snapshots" case overrides this to a null max.
  m.productStockSnapshot.aggregate.mockResolvedValue({ _max: { dayKey: "2026-06-08" } });
  m.productStockSnapshot.groupBy.mockResolvedValue([]);
});

test("no snapshots => lowStockTrend defaults to {value:0, direction:'stable'} (card never breaks)", async () => {
  // No snapshot rows at all => aggregate max dayKey is null => the heavy groupBy is skipped.
  m.productStockSnapshot.aggregate.mockResolvedValue({ _max: { dayKey: null } });
  const res = await GET(new NextRequest("http://x/api/reports/metrics"));
  const body = await res.json();
  expect(body.metrics.lowStockTrend).toEqual({ value: 0, direction: "stable" });
  expect(m.productStockSnapshot.groupBy).not.toHaveBeenCalled();
});

test("<2 distinct snapshot days => stable", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([
    { productId: 1, dayKey: "2026-06-08", _sum: { quantity: 3 } },
  ]);
  const res = await GET(new NextRequest("http://x/api/reports/metrics"));
  const body = await res.json();
  expect(body.metrics.lowStockTrend).toEqual({ value: 0, direction: "stable" });
});

test("low-stock count rose 1->2 across 7 days => up 100%", async () => {
  // day-7: product1 qty 3 (<10 low) => count 1. day0: product1 qty 3 + product2 qty 5 => count 2.
  m.productStockSnapshot.groupBy.mockResolvedValue([
    { productId: 1, dayKey: "2026-06-01", _sum: { quantity: 3 } },
    { productId: 1, dayKey: "2026-06-08", _sum: { quantity: 3 } },
    { productId: 2, dayKey: "2026-06-08", _sum: { quantity: 5 } },
  ]);
  const res = await GET(new NextRequest("http://x/api/reports/metrics"));
  const body = await res.json();
  expect(body.metrics.lowStockTrend).toEqual({ value: 100, direction: "up" });
});

test("a product at/above its threshold on a day is NOT counted low", async () => {
  // product1 qty 50 (>=10, not low) both days => count 0 both => stable.
  m.productStockSnapshot.groupBy.mockResolvedValue([
    { productId: 1, dayKey: "2026-06-01", _sum: { quantity: 50 } },
    { productId: 1, dayKey: "2026-06-08", _sum: { quantity: 50 } },
  ]);
  const res = await GET(new NextRequest("http://x/api/reports/metrics"));
  const body = await res.json();
  expect(body.metrics.lowStockTrend).toEqual({ value: 0, direction: "stable" });
});

test("selectedLocationId is pushed into the snapshot groupBy where-clause", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([]);
  await GET(new NextRequest("http://x/api/reports/metrics?locationId=2"));
  const arg = m.productStockSnapshot.groupBy.mock.calls[0][0];
  expect(arg.where).toMatchObject({ locationId: 2 });
});

test("no locationId => snapshot groupBy is GLOBAL (no locationId in where)", async () => {
  m.productStockSnapshot.groupBy.mockResolvedValue([]);
  await GET(new NextRequest("http://x/api/reports/metrics"));
  const arg = m.productStockSnapshot.groupBy.mock.calls[0][0];
  expect(arg.where).not.toHaveProperty("locationId");
});

test("snapshot groupBy is bounded to a trailing window floored on the latest snapshot day", async () => {
  // Latest snapshot day 2026-06-08 => floor = 2026-06-08 minus the 30-day window = 2026-05-09.
  m.productStockSnapshot.aggregate.mockResolvedValue({ _max: { dayKey: "2026-06-08" } });
  m.productStockSnapshot.groupBy.mockResolvedValue([]);
  await GET(new NextRequest("http://x/api/reports/metrics"));
  const arg = m.productStockSnapshot.groupBy.mock.calls[0][0];
  expect(arg.where.dayKey).toEqual({ gte: "2026-05-09" });
});
