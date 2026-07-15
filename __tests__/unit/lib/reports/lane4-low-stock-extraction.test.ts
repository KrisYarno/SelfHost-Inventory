/**
 * @jest-environment node
 *
 * Lane 4 trunk: the low-stock report extraction (lib/reports/low-stock.ts) and the
 * thin route caller (app/api/reports/low-stock/route.ts). Pins:
 *  - needsReorderAttention semantics, INCLUDING qty-0 preservation (codex #8: a
 *    reorder report must not drop stockouts — the most urgent rows).
 *  - route shape parity, including the `?threshold=` override reflected in `threshold`.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireApproved: jest.fn() };
});

import prisma from "@/lib/prisma";
import { needsReorderAttention, getLowStockReport } from "@/lib/reports/low-stock";
import { OUTBOUND_USAGE_DEFINITION } from "@/lib/reports/metrics-contract";
import { requireApproved } from "@/lib/api-utils";
import { GET as lowStockGET } from "@/app/api/reports/low-stock/route";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockRequireApproved = requireApproved as jest.Mock;

function seedProducts() {
  db.product.findMany.mockResolvedValue([
    { id: 1, name: "A", lowStockThreshold: 5, product_locations: [{ quantity: 0 }] },
    { id: 2, name: "B", lowStockThreshold: null, product_locations: [{ quantity: 8 }] },
    { id: 3, name: "C", lowStockThreshold: 5, product_locations: [{ quantity: 100 }] },
  ] as never);
  db.inventory_logs.findMany.mockResolvedValue([] as never);
  db.systemSetting.findUnique.mockResolvedValue(null as never); // getLowStockDefault -> fallback 10
}

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
  mockRequireApproved.mockResolvedValue({ user: { id: 1, isApproved: true, isAdmin: false } });
});

describe("needsReorderAttention predicate", () => {
  it("INCLUDES out-of-stock (qty 0) when the threshold is > 0", () => {
    expect(needsReorderAttention(0, 5)).toBe(true);
  });
  it("is inclusive at the boundary and below", () => {
    expect(needsReorderAttention(5, 5)).toBe(true);
    expect(needsReorderAttention(3, 5)).toBe(true);
  });
  it("is false above threshold and when the threshold is disabled (0)", () => {
    expect(needsReorderAttention(6, 5)).toBe(false);
    expect(needsReorderAttention(0, 0)).toBe(false);
  });
});

describe("getLowStockReport: qty-0 preserved + threshold override", () => {
  it("keeps the qty-0 row and sorts most-critical first", async () => {
    seedProducts();
    const report = await getLowStockReport({});

    expect(report.threshold).toBe(10);
    expect(report.alerts.map((a) => a.productId)).toEqual([1, 2]); // 0% before 80%
    const stockout = report.alerts[0];
    expect(stockout.productId).toBe(1);
    expect(stockout.currentStock).toBe(0);
    expect(stockout.threshold).toBe(5);
    expect(stockout.percentageRemaining).toBe(0);
  });

  it("applies a thresholdOverride as the inherited default and reports it as `threshold`", async () => {
    seedProducts();
    const report = await getLowStockReport({ thresholdOverride: 20 });

    expect(report.threshold).toBe(20);
    // product 2 (NULL threshold) now inherits 20 and stays low at qty 8; product 1's
    // explicit 5 still wins (override is only the inherited default).
    expect(report.alerts.find((a) => a.productId === 2)?.threshold).toBe(20);
    expect(report.alerts.find((a) => a.productId === 1)?.threshold).toBe(5);
  });

  it("caps the alert list at `limit`", async () => {
    seedProducts();
    const report = await getLowStockReport({ limit: 1 });
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0].productId).toBe(1);
  });
});

describe("Lane 6 (review M2 / D-T5): transfers are not usage + display-consistent daysUntilEmpty", () => {
  it("daysUntilEmpty is computed from the SAME rounded figure it displays (days-covered)", async () => {
    // reorder-points Task 2: usage now divides by DAYS COVERED (span from the first
    // outbound in the window to now), not a fixed 30. TESA: 10 units on hand, 2 units
    // of outflow whose first event is 20 days ago => 2/20 = 0.1/day. Displayed 0.1;
    // daysUntilEmpty = floor(10 / 0.1) = 100 — reproducible from the displayed rate.
    const now = new Date("2026-07-14T00:00:00.000Z");
    jest.useFakeTimers();
    jest.setSystemTime(now);
    try {
      db.product.findMany.mockResolvedValue([
        { id: 1, name: "TESA", lowStockThreshold: 20, product_locations: [{ quantity: 10 }] },
      ] as never);
      db.systemSetting.findUnique.mockResolvedValue(null as never);
      db.inventory_logs.findMany.mockResolvedValue([
        { productId: 1, delta: -2, changeTime: new Date(now.getTime() - 20 * 86_400_000), reasonCode: null },
      ] as never);

      const report = await getLowStockReport({});
      const row = report.alerts.find((a) => a.productId === 1)!;
      expect(row.averageDailyUsage).toBe(0.1);
      expect(row.usageKnown).toBe(true); // measured movement, not an unknown rate
      expect(row.daysUntilEmpty).toBe(100);
    } finally {
      jest.useRealTimers();
    }
  });

  it("excludes internal TRANSFER movement from the usage query (only counts real consumption)", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "A", lowStockThreshold: 5, product_locations: [{ quantity: 3 }] },
    ] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    await getLowStockReport({});
    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as Record<string, unknown>;
    expect(where.logType).toEqual({ not: "TRANSFER" });
    expect(where.delta).toEqual({ lt: 0 });
  });
});

describe("route parity: GET /api/reports/low-stock is a thin caller", () => {
  it("returns the extraction's shape (no limit) with the system default threshold", async () => {
    seedProducts();
    const resp = await lowStockGET(new NextRequest("http://t/api/reports/low-stock"));
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // Null propagation (spec §2 D4): no outbound movement => averageDailyUsage null +
    // usageKnown false (NOT a fabricated 0). Report carries the usage-rate definition.
    expect(body).toEqual({
      alerts: [
        {
          productId: 1,
          productName: "A",
          currentStock: 0,
          threshold: 5,
          percentageRemaining: 0,
          averageDailyUsage: null,
          usageKnown: false,
          daysUntilEmpty: null,
        },
        {
          productId: 2,
          productName: "B",
          currentStock: 8,
          threshold: 10,
          percentageRemaining: 80,
          averageDailyUsage: null,
          usageKnown: false,
          daysUntilEmpty: null,
        },
      ],
      threshold: 10,
      velocityDefinition: OUTBOUND_USAGE_DEFINITION,
    });
  });

  it("honors ?threshold= in the response threshold", async () => {
    seedProducts();
    const resp = await lowStockGET(new NextRequest("http://t/api/reports/low-stock?threshold=20"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.threshold).toBe(20);
  });
});
