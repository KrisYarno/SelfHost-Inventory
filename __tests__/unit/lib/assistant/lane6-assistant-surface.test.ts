/**
 * @jest-environment node
 *
 * Lane 6 (L-ASSIST) — the assistant-surface fixes (plan Task 9; spec D-T6/D-T7/D-T8;
 * review B4/M3/M1/M4). Pins:
 *   - the DATE anchor in the system prompt (server-controlled context, still pure);
 *   - `relativeDays` + the returned effective window (omitting dates is NEVER all-time);
 *   - graceful truncation (an oversized read returns rows + nextOffset, never empty);
 *   - threshold NAMING (systemDefaultThreshold / effectiveThreshold / thresholdSource);
 *   - get_sales grains: company (names, not IDs) vs company_day, week/month rollups,
 *     and orderCount as an explicit null-with-reason at non-product grains.
 *
 * The data layer (queries.ts, low-stock.ts, products.ts — L-TRUTH's fences) is mocked
 * so these tests pin the TOOL contract, not the underlying services.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/analytics/queries", () => ({
  __esModule: true,
  getSales: jest.fn(),
  getStockSeries: jest.fn(),
  getOperationsRows: jest.fn(),
  getShrinkageSummary: jest.fn(),
  getValuationSummary: jest.fn(),
}));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import prisma from "@/lib/prisma";
import { assistantTools, PER_TOOL_RESULT_CAP_BYTES, testCtx } from "@/lib/assistant/tools";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { getSales, getOperationsRows } from "@/lib/analytics/queries";
import { getLowStockReport } from "@/lib/reports/low-stock";
import { toDayKey, dayKeyStart } from "@/lib/analytics/dates";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockGetSales = getSales as jest.Mock;
const mockGetOperations = getOperationsRows as jest.Mock;
const mockGetLowStock = getLowStockReport as jest.Mock;

const DAY_MS = 24 * 60 * 60 * 1000;
const CTX = testCtx({ companyIds: ["c1", "c2"] });
const CTX_NO_COMPANY = testCtx({ companyIds: [] });
const D = (v: string) => new Prisma.Decimal(v);
const spanDays = (from: string, to: string) =>
  Math.round((dayKeyStart(to).getTime() - dayKeyStart(from).getTime()) / DAY_MS);

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
  db.systemSetting.findUnique.mockResolvedValue(null as never);
});

// ---------------------------------------------------------------------------
// D-T6 — the date anchor
// ---------------------------------------------------------------------------

describe("buildSystemPrompt: today's UTC date (review B4)", () => {
  it("weaves today's UTC calendar day into the prompt", () => {
    const p = buildSystemPrompt(new Date("2026-07-14T09:30:00.000Z"));
    expect(p).toContain("Today is 2026-07-14 (UTC).");
  });

  it("is pure for a fixed now, and only the UTC DAY matters (server-controlled context)", () => {
    const now = new Date("2026-07-14T09:30:00.000Z");
    expect(buildSystemPrompt(now)).toBe(buildSystemPrompt(now));
    // A different instant on the same UTC day yields the identical date line.
    expect(buildSystemPrompt(new Date("2026-07-14T23:59:59.000Z"))).toContain("Today is 2026-07-14 (UTC).");
    // A different UTC day changes it.
    expect(buildSystemPrompt(new Date("2026-07-15T00:00:00.000Z"))).toContain("Today is 2026-07-15 (UTC).");
  });
});

// ---------------------------------------------------------------------------
// D-T6 — relativeDays + returned window (omitting dates is never all-time)
// ---------------------------------------------------------------------------

describe("get_sales: relativeDays default + returned window (review B4; W0-WIN resolver)", () => {
  // W0-WIN: relativeDays N = EXACTLY N day-keys (from = to − (N−1)); the resolved
  // window echoes days + source. spanDays is the day DIFFERENCE, so N keys span N−1.
  it("no dates -> last 30 day-keys ending today, and the payload states the window", async () => {
    mockGetSales.mockResolvedValue([]);
    const today = toDayKey(new Date());

    const result = await assistantTools.get_sales.run({}, CTX);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as { window: { from: string; to: string; days: number; source: string } };
      expect(data.window.to).toBe(today);
      expect(data.window.days).toBe(30);
      expect(data.window.source).toBe("default");
      expect(spanDays(data.window.from, data.window.to)).toBe(29); // 30 inclusive day-keys
    }
    // getSales received EXPLICIT dates — never undefined (which would mean all-time).
    const call = mockGetSales.mock.calls[0][0];
    expect(typeof call.from).toBe("string");
    expect(typeof call.to).toBe("string");
    expect(call.to).toBe(today);
  });

  it("honors a custom relativeDays (N day-keys, source relative)", async () => {
    mockGetSales.mockResolvedValue([]);
    const result = await assistantTools.get_sales.run({ relativeDays: 7 }, CTX);
    if (result.status === "ok") {
      const data = result.data as { window: { from: string; to: string; days: number; source: string } };
      expect(data.window.days).toBe(7);
      expect(data.window.source).toBe("relative");
      expect(spanDays(data.window.from, data.window.to)).toBe(6); // 7 inclusive day-keys
    }
  });

  it("uses explicit from/to verbatim (source explicit + inclusive day count)", async () => {
    mockGetSales.mockResolvedValue([]);
    const result = await assistantTools.get_sales.run({ from: "2026-01-01", to: "2026-01-31" }, CTX);
    if (result.status === "ok") {
      const data = result.data as { window: { from: string; to: string; days: number; source: string } };
      expect(data.window.from).toBe("2026-01-01");
      expect(data.window.to).toBe("2026-01-31");
      expect(data.window.days).toBe(31);
      expect(data.window.source).toBe("explicit");
    }
  });

  it("empty company access still reports the resolved window, never all-time", async () => {
    const result = await assistantTools.get_sales.run({}, CTX_NO_COMPANY);
    expect(mockGetSales).not.toHaveBeenCalled();
    if (result.status === "ok") {
      const data = result.data as { window: { days: number; source: string }; note: string };
      expect(data.window.days).toBe(30);
      expect(data.window.source).toBe("default");
      expect(typeof data.note).toBe("string");
    }
  });

  it("rejects from + relativeDays together (resolveWindow throws AppError)", async () => {
    await expect(
      assistantTools.get_sales.run({ from: "2026-01-01", relativeDays: 5 }, CTX),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// D-T7 — graceful truncation
// ---------------------------------------------------------------------------

describe("truncation degrades to a page + cursor, never an empty notice (review M3)", () => {
  it("an oversized get_operations read returns rows + nextOffset, status ok", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      productId: i,
      name: "Product-" + "x".repeat(3000), // ~3 KB each => 50 rows blow the row budget
      currentStock: 1,
      attention: "ok" as const,
      unitsOut30: null,
      unitsOut90: null,
      avgDailyOutbound30: null,
      daysOfSupply: null,
      turns: null,
      turnsWindowDays: 90,
      turnsCoverage: null,
      lastInboundAt: null,
      lastOutboundAt: null,
      shrinkage90: null,
      correctionsIn90: 0,
      lastReceiptCostCents: null,
    }));
    mockGetOperations.mockResolvedValue({
      rows,
      dataStarts: { sale: null, adjustment: null, receipt: null, snapshot: null },
    });

    const result = await assistantTools.get_operations.run({ limit: 50 }, CTX);

    expect(result.status).toBe("ok"); // NOT "truncated"
    if (result.status === "ok") {
      const data = result.data as {
        rows: unknown[];
        returned: number;
        totalRows: number;
        nextOffset: number | null;
      };
      expect(data.rows.length).toBeGreaterThan(0);
      expect(data.rows.length).toBeLessThan(50); // the byte cap cut the page short
      expect(data.returned).toBe(data.rows.length);
      expect(data.totalRows).toBe(50);
      expect(data.nextOffset).toBe(data.rows.length); // resume cursor, offset 0
      expect(result.meta.bytes).toBeLessThanOrEqual(PER_TOOL_RESULT_CAP_BYTES);
    }
  });

  it("offset resumes where the previous page left off", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ productId: i, attention: "ok" as const }));
    mockGetOperations.mockResolvedValue({
      rows,
      dataStarts: { sale: null, adjustment: null, receipt: null, snapshot: null },
    });
    const result = await assistantTools.get_operations.run({ limit: 3, offset: 6 }, CTX);
    if (result.status === "ok") {
      const data = result.data as { returned: number; nextOffset: number | null; totalRows: number };
      expect(data.returned).toBe(3);
      expect(data.totalRows).toBe(10);
      expect(data.nextOffset).toBe(9);
    }
  });
});

// ---------------------------------------------------------------------------
// D-T8 — naming that can't be misread
// ---------------------------------------------------------------------------

describe("low_stock_report naming (review M1)", () => {
  it("exposes systemDefaultThreshold + per-row effectiveThreshold/thresholdSource, no bare `threshold`", async () => {
    mockGetLowStock.mockResolvedValue({
      threshold: 10,
      alerts: [
        { productId: 1, productName: "A", currentStock: 0, threshold: 10, percentageRemaining: 0, averageDailyUsage: 0, daysUntilEmpty: null },
        { productId: 2, productName: "B", currentStock: 1, threshold: 50, percentageRemaining: 2, averageDailyUsage: 0.1, daysUntilEmpty: 10 },
      ],
    });

    const result = await assistantTools.low_stock_report.run({}, CTX);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as {
        systemDefaultThreshold: number;
        alerts: Array<Record<string, unknown>>;
      };
      expect(data.systemDefaultThreshold).toBe(10);
      expect(data.alerts[0]).not.toHaveProperty("threshold");
      expect(data.alerts[0].effectiveThreshold).toBe(10);
      expect(data.alerts[0].thresholdSource).toBe("system_default");
      expect(data.alerts[1].effectiveThreshold).toBe(50);
      expect(data.alerts[1].thresholdSource).toBe("product_override");
    }
  });
});

describe("get_sales grains carry names, not bare IDs, and mark orderCount (review M4)", () => {
  it("groupBy='company' is company-only (no dayKey), named, with orderCount null + reason", async () => {
    mockGetSales.mockResolvedValue([
      { companyId: "c1", dayKey: "2026-07-01", _sum: { orderedQty: 5, fulfilledQty: 5, revenue: D("10.00") } },
      { companyId: "c1", dayKey: "2026-07-02", _sum: { orderedQty: 3, fulfilledQty: 3, revenue: D("6.00") } },
      { companyId: "c2", dayKey: "2026-07-01", _sum: { orderedQty: 2, fulfilledQty: 2, revenue: D("4.00") } },
    ]);
    db.company.findMany.mockResolvedValue([
      { id: "c1", name: "Acme" },
      { id: "c2", name: "Beta" },
    ] as never);

    const result = await assistantTools.get_sales.run({ groupBy: "company" }, CTX);

    // Base grain fetched from getSales is the existing company×day grain.
    expect(mockGetSales.mock.calls[0][0]).toMatchObject({ groupBy: "company" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as {
        groupBy: string;
        orderCountNote?: string;
        rows: Array<{ companyId: string; name: string | null; dayKey?: string; _sum: Record<string, unknown> }>;
      };
      expect(data.groupBy).toBe("company");
      expect(typeof data.orderCountNote).toBe("string");
      const c1 = data.rows.find((r) => r.companyId === "c1")!;
      expect(c1.name).toBe("Acme"); // name, not a bare id
      expect(c1.dayKey).toBeUndefined(); // company ONLY — the day grain collapsed
      expect(c1._sum.orderedQty).toBe(8); // 5 + 3 summed across days
      expect(c1._sum.revenue).toBe("16"); // Decimal 10 + 6, serialized to a string
      expect(c1._sum.orderCount).toBeNull(); // explicit null (would double-count)
    }
  });

  it("groupBy='company_day' keeps the old company×day grain (named)", async () => {
    mockGetSales.mockResolvedValue([
      { companyId: "c1", dayKey: "2026-07-02", _sum: { orderedQty: 3, revenue: D("6.00") } },
      { companyId: "c1", dayKey: "2026-07-01", _sum: { orderedQty: 5, revenue: D("10.00") } },
    ]);
    db.company.findMany.mockResolvedValue([{ id: "c1", name: "Acme" }] as never);

    const result = await assistantTools.get_sales.run({ groupBy: "company_day" }, CTX);
    if (result.status === "ok") {
      const data = result.data as {
        rows: Array<{ companyId: string; name: string | null; dayKey: string; _sum: Record<string, unknown> }>;
      };
      expect(data.rows).toHaveLength(2);
      expect(data.rows[0].dayKey).toBe("2026-07-01"); // deterministic order
      expect(data.rows[0].name).toBe("Acme");
      expect(data.rows[0]._sum.orderCount).toBeNull();
    }
  });

  it("groupBy='week' rolls day rows into weekly buckets (orderCount null)", async () => {
    mockGetSales.mockResolvedValue([
      { dayKey: "2026-07-06", _sum: { orderedQty: 2, revenue: D("2.00") } },
      { dayKey: "2026-07-07", _sum: { orderedQty: 3, revenue: D("3.00") } },
      { dayKey: "2026-07-13", _sum: { orderedQty: 4, revenue: D("4.00") } },
    ]);

    const result = await assistantTools.get_sales.run({ groupBy: "week" }, CTX);

    // week rolls up the base "day" grain.
    expect(mockGetSales.mock.calls[0][0]).toMatchObject({ groupBy: "day" });
    if (result.status === "ok") {
      const data = result.data as {
        rows: Array<{ week: string; _sum: { orderedQty: number; orderCount: number | null } }>;
      };
      expect(data.rows).toHaveLength(2); // 07-06/07 collapse into one week; 07-13 another
      expect(data.rows.every((r) => typeof r.week === "string")).toBe(true);
      expect(data.rows.every((r) => r._sum.orderCount === null)).toBe(true);
      expect(data.rows.some((r) => r._sum.orderedQty === 5)).toBe(true); // 2 + 3
      expect(data.rows.some((r) => r._sum.orderedQty === 4)).toBe(true);
    }
  });

  it("groupBy='month' rolls day rows into YYYY-MM buckets", async () => {
    mockGetSales.mockResolvedValue([
      { dayKey: "2026-06-30", _sum: { orderedQty: 1, revenue: D("1.00") } },
      { dayKey: "2026-07-01", _sum: { orderedQty: 2, revenue: D("2.00") } },
      { dayKey: "2026-07-15", _sum: { orderedQty: 3, revenue: D("3.00") } },
    ]);

    const result = await assistantTools.get_sales.run({ groupBy: "month" }, CTX);
    if (result.status === "ok") {
      const data = result.data as {
        rows: Array<{ month: string; _sum: { orderedQty: number } }>;
      };
      expect(data.rows.map((r) => r.month)).toEqual(["2026-06", "2026-07"]);
      expect(data.rows.find((r) => r.month === "2026-07")!._sum.orderedQty).toBe(5); // 2 + 3
    }
  });

  it("groupBy='product' keeps orderCount (no note) and resolves the product name", async () => {
    mockGetSales.mockResolvedValue([
      { productId: 1, _sum: { orderedQty: 5, fulfilledQty: 5, revenue: D("10.00"), orderCount: 2 } },
    ]);
    db.product.findMany.mockResolvedValue([{ id: 1, name: "TIRZ 10mg" }] as never);

    const result = await assistantTools.get_sales.run({ groupBy: "product" }, CTX);
    if (result.status === "ok") {
      const data = result.data as {
        orderCountNote?: string;
        rows: Array<{ productId: number; name: string | null; _sum: { orderCount: number | null } }>;
      };
      expect(data.orderCountNote).toBeUndefined(); // product grain keeps it
      expect(data.rows[0].name).toBe("TIRZ 10mg");
      expect(data.rows[0]._sum.orderCount).toBe(2);
    }
  });

  it("groupBy='integration' is named, with orderCount null + reason", async () => {
    mockGetSales.mockResolvedValue([
      { integrationId: "i1", _sum: { orderedQty: 5, fulfilledQty: 5, revenue: D("10.00") } },
    ]);
    db.integration.findMany.mockResolvedValue([{ id: "i1", name: "Woo Store" }] as never);

    const result = await assistantTools.get_sales.run({ groupBy: "integration" }, CTX);
    if (result.status === "ok") {
      const data = result.data as {
        orderCountNote?: string;
        rows: Array<{ integrationId: string; name: string | null; _sum: { orderCount: number | null } }>;
      };
      expect(data.rows[0].name).toBe("Woo Store");
      expect(data.rows[0]._sum.orderCount).toBeNull();
      expect(typeof data.orderCountNote).toBe("string");
    }
  });
});
