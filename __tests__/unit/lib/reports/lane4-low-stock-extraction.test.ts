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
// The stock-state identity below drives get_inventory_summary for real; its valuation
// delegation is the only part stubbed (it has its own suite, and the identity is about
// the stock-state census, not money).
jest.mock("@/lib/analytics/valuation", () => ({
  __esModule: true,
  getValuation: jest.fn(async () => ({
    groupBy: "total",
    rows: [],
    coverage: { costedProducts: 0, ofProducts: 0, costedUnits: 0, ofUnits: 0 },
  })),
}));

import prisma from "@/lib/prisma";
import {
  needsReorderAttention,
  getLowStockReport,
  LOW_STOCK_USAGE_WINDOW_DAYS,
} from "@/lib/reports/low-stock";
import { OUTBOUND_USAGE_DEFINITION } from "@/lib/reports/metrics-contract";
import { requireApproved } from "@/lib/api-utils";
import { GET as lowStockGET } from "@/app/api/reports/low-stock/route";
import { assistantTools, testCtx } from "@/lib/assistant/tools";

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

  // spec C8: `rawThreshold` is the per-product column VERBATIM (null = inherit), the
  // only truthful basis for thresholdSource. The old tool-layer equality inference
  // ("effective != default => override") lied whenever an override equalled the default.
  it("carries the RAW per-product threshold beside the effective one (spec C8)", async () => {
    seedProducts();
    const report = await getLowStockReport({});
    // Product 1 has an explicit 5; product 2 inherits (column is NULL).
    expect(report.alerts.find((a) => a.productId === 1)?.rawThreshold).toBe(5);
    expect(report.alerts.find((a) => a.productId === 2)?.rawThreshold).toBeNull();
  });

  it("an override EQUAL to the system default is still a raw override (not null)", async () => {
    db.product.findMany.mockResolvedValue([
      // Explicit 10, and the system default is also 10 — indistinguishable by equality.
      { id: 1, name: "Equal", lowStockThreshold: 10, product_locations: [{ quantity: 4 }] },
    ] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never); // default 10
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    const report = await getLowStockReport({});
    expect(report.threshold).toBe(10);
    expect(report.alerts[0].threshold).toBe(10);
    expect(report.alerts[0].rawThreshold).toBe(10);
  });

  // Two-part 0-override pin, part 1 (the property is UNOBSERVABLE through the report,
  // so it must be pinned here AND on the derivation function — see the tool suite).
  it("a 0 override is NEVER an alert row (disabled), so rawThreshold:0 cannot be observed here", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "Disabled", lowStockThreshold: 0, product_locations: [{ quantity: 0 }] },
      { id: 2, name: "Live", lowStockThreshold: 5, product_locations: [{ quantity: 0 }] },
    ] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never);
    db.inventory_logs.findMany.mockResolvedValue([] as never);

    const report = await getLowStockReport({});
    expect(report.alerts.map((a) => a.productId)).toEqual([2]);
    expect(report.alerts.some((a) => a.rawThreshold === 0)).toBe(false);
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
    // of outflow whose first event is 20 days ago => 2/20 = 0.1/day. A2 C5 re-derived:
    // the shared rate() keeps 3 significant figures below 1, and 0.1 to 3 s.f. is 0.1, so
    // the displayed 0.1 and daysUntilEmpty = floor(10 / 0.1) = 100 hold unchanged —
    // reproducible from the displayed rate.
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

// ---------------------------------------------------------------------------
// A2 pack C5 (review #4's 0.0/day misread): the usage rate uses the shared rate() — 2
// decimals at 1 or more, 3 significant figures below — so a slow mover's real rate shows
// instead of 0.0, and daysUntilEmpty still derives from the DISPLAYED figure.
// ---------------------------------------------------------------------------

describe("A2 C5: low-stock usage rounding never shows a non-zero rate as 0", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const DAY = 86_400_000;
  const run = async (stock: number, logs: Array<{ delta: number; daysAgo: number }>) => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    try {
      db.product.findMany.mockResolvedValue([
        { id: 1, name: "Slow", lowStockThreshold: 20, product_locations: [{ quantity: stock }] },
      ] as never);
      db.systemSetting.findUnique.mockResolvedValue(null as never);
      db.inventory_logs.findMany.mockResolvedValue(
        logs.map((l) => ({
          productId: 1,
          delta: l.delta,
          changeTime: new Date(now.getTime() - l.daysAgo * DAY),
          reasonCode: null,
        })) as never,
      );
      return (await getLowStockReport({})).alerts[0];
    } finally {
      jest.useRealTimers();
    }
  };

  it("the usage window is a named 30-day constant, and it is what the usage read looks back", async () => {
    expect(LOW_STOCK_USAGE_WINDOW_DAYS).toBe(30);
    await run(5, []);
    const where = db.inventory_logs.findMany.mock.calls[0][0]!.where as { changeTime: { gte: Date } };
    expect(now.getTime() - where.changeTime.gte.getTime()).toBe(LOW_STOCK_USAGE_WINDOW_DAYS * DAY);
  });

  it("1 unit over 30 days reads 0.0333/day (it read 0.0), and daysUntilEmpty derives from 0.0333", async () => {
    // First (only) outbound 30 days ago => days covered 30 => 1/30 = 0.0333...
    const row = await run(5, [{ delta: -1, daysAgo: 30 }]);
    expect(row.averageDailyUsage).toBe(0.0333);
    expect(row.usageKnown).toBe(true);
    // From the DISPLAYED rate: floor(5 / 0.0333) = 150 (the unrounded 1/30 also gives 150).
    expect(row.daysUntilEmpty).toBe(Math.floor(5 / 0.0333));
    expect(row.daysUntilEmpty).toBe(150);
  });

  it("the original TESA incoherence (2 units over 30 days): 0.0667/day and 149 days, both from the displayed figure", async () => {
    // Before Lane 6 this displayed 0.1 beside 150 days; Lane 6 made both 0.1 / 100 (one
    // rounding, coherent but coarse); A2 shows the real 0.0667 with floor(10 / 0.0667) = 149.
    const row = await run(10, [{ delta: -2, daysAgo: 30 }]);
    expect(row.averageDailyUsage).toBe(0.0667);
    expect(row.daysUntilEmpty).toBe(Math.floor(10 / 0.0667));
    expect(row.daysUntilEmpty).toBe(149);
  });

  it("rates of 1 or more keep 2 decimals", async () => {
    // 37 units, first event 3 days ago => 37/3 = 12.333... => 12.33.
    const row = await run(15, [{ delta: -37, daysAgo: 3 }]);
    expect(row.averageDailyUsage).toBe(12.33);
    expect(row.daysUntilEmpty).toBe(Math.floor(15 / 12.33));
  });

  it("no movement stays unknown (null), never a 0/day", async () => {
    const row = await run(5, []);
    expect(row.averageDailyUsage).toBeNull();
    expect(row.usageKnown).toBe(false);
    expect(row.daysUntilEmpty).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A2 pack C2: the catalog-level counts the module owns — products whose alerts are OFF
// (effective threshold <= 0, never listed), those of them with no stock, and EVERY product
// with no stock. They do not depend on `limit` (they describe the catalog, not the page).
// ---------------------------------------------------------------------------

describe("A2 C2: alertsOff / alertsOffAtZeroStock / outOfStockAllProducts", () => {
  function seedCensus() {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "OutAlert", lowStockThreshold: 5, product_locations: [{ quantity: 0 }] },
      { id: 2, name: "LowInherit", lowStockThreshold: null, product_locations: [{ quantity: 8 }] },
      { id: 3, name: "Fine", lowStockThreshold: 5, product_locations: [{ quantity: 100 }] },
      { id: 4, name: "OffAtZero", lowStockThreshold: 0, product_locations: [{ quantity: 0 }] },
      { id: 5, name: "OffStocked", lowStockThreshold: 0, product_locations: [{ quantity: 3 }] },
      { id: 6, name: "OffNegative", lowStockThreshold: 0, product_locations: [{ quantity: 2 }, { quantity: -4 }] },
      { id: 7, name: "NoLocations", lowStockThreshold: null, product_locations: [] },
    ] as never);
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never); // default 10
  }

  it("counts the alerts-off products (threshold 0), those at no stock, and every product at no stock", async () => {
    seedCensus();
    const report = await getLowStockReport({});
    // Alerts: 1 (out), 2 (low, inherits 10), 7 (no locations = stock 0, inherits 10).
    expect(report.alerts.map((a) => a.productId).sort()).toEqual([1, 2, 7]);
    expect(report.alertsOff).toBe(3); // 4, 5, 6
    expect(report.alertsOffAtZeroStock).toBe(2); // 4 (0) and 6 (2 - 4 = -2)
    expect(report.outOfStockAllProducts).toBe(4); // 1, 4, 6, 7 — alerts on or off
  });

  it("they are catalog counts: a `limit` caps the alert list, never the counts", async () => {
    seedCensus();
    const report = await getLowStockReport({ limit: 1 });
    expect(report.alerts).toHaveLength(1);
    expect(report.alertsOff).toBe(3);
    expect(report.alertsOffAtZeroStock).toBe(2);
    expect(report.outOfStockAllProducts).toBe(4);
  });

  it("a threshold override moves the inherited products only (an explicit 0 stays off)", async () => {
    seedCensus();
    // An explicit ?threshold=0 turns the INHERITED products' alerts off too.
    const report = await getLowStockReport({ thresholdOverride: 0 });
    expect(report.alertsOff).toBe(5); // 4, 5, 6 + the inherited 2 and 7
    expect(report.alertsOffAtZeroStock).toBe(3); // 4, 6, 7
    expect(report.outOfStockAllProducts).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// A2 pack C2 (A2-OCR2-16): THE STOCK-STATE IDENTITY, on ONE fixture through BOTH real
// tools. The inventory summary's census and low_stock_report's counts are two views of
// the same catalog, so: low === lowAlerts, and out === outOfStockAllProducts ===
// outOfStockAlerts + alertsOffAtZeroStock. A model handed both must never see them
// disagree — and the alert-scoped out-of-stock count must never pass for the catalog's.
// ---------------------------------------------------------------------------

describe("A2 C2: the stock-state identity (get_inventory_summary vs low_stock_report)", () => {
  function seedCatalog() {
    // One row shape serves both reads (the summary also selects locationId).
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "OutAlert", lowStockThreshold: 5, product_locations: [{ locationId: 1, quantity: 0 }] },
      { id: 2, name: "LowInherit", lowStockThreshold: null, product_locations: [{ locationId: 1, quantity: 8 }] },
      { id: 3, name: "Fine", lowStockThreshold: 5, product_locations: [{ locationId: 1, quantity: 100 }] },
      { id: 4, name: "OffAtZero", lowStockThreshold: 0, product_locations: [{ locationId: 1, quantity: 0 }] },
      { id: 5, name: "OffStocked", lowStockThreshold: 0, product_locations: [{ locationId: 1, quantity: 3 }] },
      { id: 6, name: "OutInherit", lowStockThreshold: null, product_locations: [{ locationId: 2, quantity: 0 }] },
      {
        id: 7,
        name: "OffNegative",
        lowStockThreshold: 0,
        product_locations: [
          { locationId: 1, quantity: 1 },
          { locationId: 2, quantity: -3 },
        ],
      },
      { id: 8, name: "LowBoundary", lowStockThreshold: 4, product_locations: [{ locationId: 1, quantity: 4 }] },
    ] as never);
    db.inventory_logs.findMany.mockResolvedValue([] as never);
    db.systemSetting.findUnique.mockResolvedValue(null as never); // default 10
  }

  it("low === lowAlerts and out === outOfStockAllProducts === outOfStockAlerts + alertsOffAtZeroStock", async () => {
    seedCatalog();
    const ctx = testCtx();
    const summary = await assistantTools.get_inventory_summary.run({}, ctx);
    // A 2-row page of a 4-alert result: the counts must not follow the page.
    const lowStock = await assistantTools.low_stock_report.run({ limit: 2 }, ctx);
    if (summary.status !== "ok" || lowStock.status !== "ok") throw new Error("expected ok");
    const census = (summary.data as { stockStateCounts: Record<string, number> }).stockStateCounts;
    const data = lowStock.data as { counts: Record<string, number>; alerts: unknown[]; totalRows: number };

    expect(data.alerts).toHaveLength(2);
    expect(data.totalRows).toBe(4);
    // The fixture spans every cell of the identity (non-vacuity).
    expect(census).toEqual({ in_stock: 2, low: 2, out: 4 });
    expect(data.counts).toEqual({
      alerts: 4, // 1, 2, 6, 8
      outOfStockAlerts: 2, // 1, 6
      lowAlerts: 2, // 2, 8
      productOverride: 2, // 1, 8
      systemDefault: 2, // 2, 6
      alertsOff: 3, // 4, 5, 7
      alertsOffAtZeroStock: 2, // 4, 7 (1 - 3 = -2)
      outOfStockAllProducts: 4,
    });

    expect(census.low).toBe(data.counts.lowAlerts);
    expect(census.out).toBe(data.counts.outOfStockAllProducts);
    expect(data.counts.outOfStockAllProducts).toBe(
      data.counts.outOfStockAlerts + data.counts.alertsOffAtZeroStock,
    );
    // ...and the alert-scoped out-of-stock count is NOT the catalog's.
    expect(data.counts.outOfStockAlerts).not.toBe(census.out);
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
          // spec C8: the web API intentionally gains rawThreshold (additive; the
          // "byte-identical" route contract is consciously amended).
          rawThreshold: 5,
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
          rawThreshold: null,
          percentageRemaining: 80,
          averageDailyUsage: null,
          usageKnown: false,
          daysUntilEmpty: null,
        },
      ],
      threshold: 10,
      velocityDefinition: OUTBOUND_USAGE_DEFINITION,
      // A2 C2 (declared web change): the module's three catalog counts ride the body.
      // Product 3 (threshold 5, stock 100) is the only non-alert and its alerts are on.
      alertsOff: 0,
      alertsOffAtZeroStock: 0,
      outOfStockAllProducts: 1,
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
