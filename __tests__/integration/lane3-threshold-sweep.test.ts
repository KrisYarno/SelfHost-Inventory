// @jest-environment node
/**
 * Lane 3 Task 7 — threshold-sweep regression pins (spec R-L13 / R-L6 / D-L9).
 *
 * These lock the behaviors the cross-cutting sweep must preserve or establish:
 *   - stock-checker at-threshold STILL alerts (INCLUSIVE boundary preserved);
 *   - the hub `low` filter now INCLUDES qty == threshold;
 *   - metrics `lowStockProducts` counts the inclusive boundary;
 *   - the dashboard stock classifier binds COALESCE(lowStockThreshold, :default)
 *     as a PARAMETER (never a literal), sourced from the configurable setting;
 *   - the thresholds PATCH emits ONE PRODUCT_UPDATE per changed product sharing a
 *     single batchId (R-L6), not a bulk details.rows event;
 *   - create paths write NULL by default (inherit), not a materialized 10;
 *   - the tri-state model: inherit resolves to the system default, custom 0 is
 *     disabled and is DISTINCT from inherit (null).
 *
 * One shared prisma mock backs every route under test; `$transaction` hands the
 * handler the same object (tx === db) so tx-scoped writes are observable.
 */

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: false } })),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1, isAdmin: true } })),
  requireCSRF: jest.fn(() => Promise.resolve()),
}));
jest.mock("@/lib/rateLimit", () => ({
  __esModule: true,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordChange: jest.fn(() => Promise.resolve()),
  newBatchId: jest.fn(() => "batch-sweep-0001"),
}));
jest.mock("@/lib/email", () => ({
  __esModule: true,
  emailService: { sendLowStockDigest: jest.fn(), sendMinimumsDigest: jest.fn() },
}));
jest.mock("@/lib/products", () => ({
  __esModule: true,
  getProductsWithQuantities: jest.fn(),
  isProductUnique: jest.fn(() => Promise.resolve(true)),
  formatProductName: jest.fn(
    ({ baseName, variant }: any) => `${baseName ?? ""}${variant ? " " + variant : ""}`.trim()
  ),
}));

jest.mock("@/lib/prisma", () => {
  const db: any = {
    product: {
      count: jest.fn(() => Promise.resolve(0)),
      findMany: jest.fn(() => Promise.resolve([])),
      findUnique: jest.fn(),
      create: jest.fn(() => Promise.resolve({ id: 99, name: "New" })),
      update: jest.fn(() => Promise.resolve({})),
    },
    product_locations: {
      findMany: jest.fn(() => Promise.resolve([])),
      groupBy: jest.fn(() => Promise.resolve([])),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    inventory_logs: {
      groupBy: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    user: { groupBy: jest.fn(() => Promise.resolve([])), findMany: jest.fn(() => Promise.resolve([])) },
    location: { findUnique: jest.fn(() => Promise.resolve({ id: 1 })) },
    systemSetting: { findUnique: jest.fn(() => Promise.resolve(null)) },
    productStockSnapshot: {
      aggregate: jest.fn(() => Promise.resolve({ _max: { dayKey: null } })),
      groupBy: jest.fn(() => Promise.resolve([])),
    },
    $queryRaw: jest.fn(() => Promise.resolve([])),
  };
  db.$transaction = jest.fn(async (fn: any) => fn(db));
  return { __esModule: true, default: db };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { StockChecker } from "@/lib/stock-checker";
import { buildHubRows } from "@/lib/analytics/hub";
import {
  effectiveLowStockThreshold,
  isLowStock,
  LOW_STOCK_DEFAULT_FALLBACK,
} from "@/lib/stock-threshold";

const db = prisma as any;

beforeEach(() => {
  jest.clearAllMocks();
  db.systemSetting.findUnique.mockResolvedValue(null); // getLowStockDefault -> 10
});

// ---------------------------------------------------------------------------
// stock-checker — INCLUSIVE at-threshold still alerts (regression pin)
// ---------------------------------------------------------------------------
describe("stock-checker preserves the INCLUSIVE at-threshold alert", () => {
  it("a product AT its explicit threshold alerts; one above does not", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "At", lowStockThreshold: 5, product_locations: [{ quantity: 5 }] }, // 5 <= 5 low
      { id: 2, name: "Above", lowStockThreshold: 5, product_locations: [{ quantity: 6 }] }, // 6 > 5 not
    ]);
    const low = await new StockChecker().checkLowStock();
    expect(low.map((p) => p.id)).toEqual([1]);
    expect(low[0].threshold).toBe(5);
  });

  it("a NULL-threshold product inherits the system default (10) at the boundary", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 3, name: "Inherit", lowStockThreshold: null, product_locations: [{ quantity: 10 }] }, // 10 <= 10 low
      { id: 4, name: "Disabled", lowStockThreshold: 0, product_locations: [{ quantity: 1 }] }, // 0 disables
    ]);
    const low = await new StockChecker().checkLowStock();
    expect(low.map((p) => p.id)).toEqual([3]);
    expect(low[0].threshold).toBe(10);
  });

  it("batches the outflow read into ONE query (no per-product N+1)", async () => {
    // reorder-points Task 2: the outflow read moved from a bespoke groupBy to the ONE
    // shared units-out velocity (lib/reports/demand.ts), which reads via a single
    // findMany. The no-N+1 guarantee is preserved — it is still exactly one query.
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "A", lowStockThreshold: 5, product_locations: [{ quantity: 3 }] },
      { id: 2, name: "B", lowStockThreshold: 5, product_locations: [{ quantity: 4 }] },
    ]);
    await new StockChecker().checkLowStock();
    expect(db.inventory_logs.findMany).toHaveBeenCalledTimes(1);
    expect(db.inventory_logs.groupBy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hub — INCLUSIVE low filter (regression pin)
// ---------------------------------------------------------------------------
describe("hub low filter is INCLUSIVE at the boundary", () => {
  it("includes qty == threshold (and null inherits the default)", () => {
    const out = buildHubRows({
      candidates: [
        { id: 1, name: "A", lowStockThreshold: 5 },
        { id: 2, name: "B", lowStockThreshold: null },
      ],
      stockByProduct: new Map([[1, 5], [2, 10]]), // both exactly at threshold (5 / default 10)
      salesByProduct: new Map(),
      trendByProduct: new Map(),
      filter: "low",
      sort: "name",
      dir: "asc",
      page: 1,
      pageSize: 25,
      lowStockDefault: 10,
    });
    expect(out.products.map((p) => p.productId).sort()).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// metrics — lowStockProducts inclusive boundary
// ---------------------------------------------------------------------------
describe("metrics lowStockProducts counts the inclusive boundary", () => {
  it("qty == effective threshold counts as low", async () => {
    const { GET } = await import("@/app/api/reports/metrics/route");
    db.product.count.mockResolvedValue(2);
    db.product_locations.findMany.mockResolvedValue([
      { productId: 1, quantity: 10 }, // == default 10 -> low (inclusive)
      { productId: 2, quantity: 11 }, // > 10 -> not low
    ]);
    db.product.findMany.mockResolvedValue([
      { id: 1, costPrice: 0, retailPrice: 0, lowStockThreshold: null },
      { id: 2, costPrice: 0, retailPrice: 0, lowStockThreshold: null },
    ]);
    const res = await GET(new NextRequest("http://x/api/reports/metrics"));
    const body = await res.json();
    expect(body.metrics.lowStockProducts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dashboard — COALESCE(lowStockThreshold, :default) bound as a PARAMETER
// ---------------------------------------------------------------------------
describe("dashboard classifier parameterizes the default (never a literal)", () => {
  it("binds the configured default via COALESCE + a query parameter", async () => {
    const { GET } = await import("@/app/api/admin/dashboard/route");
    // Configured default = 15 (proves the bound value is the SETTING, not a literal).
    db.systemSetting.findUnique.mockResolvedValue({ value: "15" });
    db.user.groupBy.mockResolvedValue([]);
    db.$queryRaw.mockResolvedValue([]);

    // Dashboard GET takes no runtime args (apiHandler passthrough in the mock).
    await (GET as unknown as () => Promise<Response>)();

    // The classifier call passes a Prisma.Sql (function-call form) with `.values`.
    const sqlCall = db.$queryRaw.mock.calls.find((c: any[]) => Array.isArray(c[0]?.values));
    expect(sqlCall).toBeDefined();
    const sql = sqlCall[0];
    expect(sql.strings.join("")).toContain("COALESCE(p.lowStockThreshold,");
    expect(sql.values).toContain(15); // the default is a bound parameter
    // Never inline the literal into the SQL text.
    expect(sql.strings.join("")).not.toContain("COALESCE(p.lowStockThreshold, 15)");
  });
});

// ---------------------------------------------------------------------------
// thresholds PATCH — per-product PRODUCT_UPDATE events, one shared batchId (R-L6)
// ---------------------------------------------------------------------------
describe("thresholds PATCH emits per-product events with a shared batchId", () => {
  it("one PRODUCT_UPDATE per changed product, addressed to it, same batchId", async () => {
    const { PATCH } = await import("@/app/api/admin/products/thresholds/route");
    db.product.findMany.mockResolvedValue([
      { id: 10, name: "Alpha", lowStockThreshold: 5 },
      { id: 11, name: "Bravo", lowStockThreshold: 8 },
    ]);
    db.product_locations.findMany.mockResolvedValue([]);

    const req = new NextRequest("http://x/api/admin/products/thresholds", {
      method: "PATCH",
      body: JSON.stringify({
        updates: [
          { productId: 10, combinedMinimum: 15 },
          { productId: 11, combinedMinimum: 20 },
        ],
      }),
      headers: { "content-type": "application/json", "x-csrf-token": "x" },
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    const calls = (recordChange as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const events = calls.map((c) => c[1]);
    expect(events.every((e) => e.actionType === "PRODUCT_UPDATE")).toBe(true);
    expect(events.map((e) => e.entityId).sort()).toEqual([10, 11]);
    expect(new Set(events.map((e) => e.batchId))).toEqual(new Set(["batch-sweep-0001"]));
  });
});

// ---------------------------------------------------------------------------
// create paths — write NULL by default (inherit), never a materialized 10
// ---------------------------------------------------------------------------
describe("create paths write NULL lowStockThreshold by default", () => {
  it("products POST writes NULL when no threshold is supplied", async () => {
    const { POST } = await import("@/app/api/products/route");
    db.location.findUnique.mockResolvedValue({ id: 1 });
    db.product.create.mockResolvedValue({ id: 50, name: "BPC 5mg" });

    const req = new NextRequest("http://x/api/products", {
      method: "POST",
      body: JSON.stringify({ baseName: "BPC", variant: "5mg", locationId: 1 }),
      headers: { "content-type": "application/json", "x-csrf-token": "x" },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const createData = db.product.create.mock.calls[0][0].data;
    expect(createData.lowStockThreshold).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tri-state semantics — inherit vs custom-0 (disabled) are DISTINCT
// ---------------------------------------------------------------------------
describe("tri-state threshold semantics (R-L13 / D-L9)", () => {
  it("inherit (null) resolves to the system default; custom 0 disables and differs from inherit", () => {
    expect(LOW_STOCK_DEFAULT_FALLBACK).toBe(10);
    // inherit -> effective is the system default (what the form shows as "Effective: N")
    expect(effectiveLowStockThreshold(null, 15)).toBe(15);
    expect(effectiveLowStockThreshold(undefined, 15)).toBe(15);
    // custom 0 -> disabled: effective 0, never low at any qty
    expect(effectiveLowStockThreshold(0, 15)).toBe(0);
    expect(isLowStock(1, effectiveLowStockThreshold(0, 15))).toBe(false);
    // inherit and disabled produce DIFFERENT effective values (15 vs 0)
    expect(effectiveLowStockThreshold(null, 15)).not.toBe(effectiveLowStockThreshold(0, 15));
    // explicit override is honored verbatim
    expect(effectiveLowStockThreshold(3, 15)).toBe(3);
    expect(isLowStock(3, effectiveLowStockThreshold(3, 15))).toBe(true);
  });
});
