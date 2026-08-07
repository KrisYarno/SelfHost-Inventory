/**
 * @jest-environment node
 *
 * Lane 4 trunk contract: the shared read-tool layer (lib/assistant/tools.ts).
 * Covers spec §5's tool-layer assertions: schema rejection (bad dates/ids/window),
 * caps + DB-level `take`, company isolation (empty -> empty + note), find_product
 * APPROVED-only, Decimal serialization, and the 32KB discriminated truncation result.
 *
 * The lib data layer is mocked so the tests pin the TOOL's contract (filters, bounds,
 * scope, serialization) rather than re-testing the underlying services. prisma is
 * deep-mocked for get_stock's direct product_locations read + getLowStockDefault.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

jest.mock("@/lib/products", () => ({
  __esModule: true,
  getProductsWithQuantities: jest.fn(),
}));

jest.mock("@/lib/analytics/queries", () => ({
  __esModule: true,
  getSales: jest.fn(),
  getStockSeries: jest.fn(),
  getOperationsRows: jest.fn(),
  getShrinkageSummary: jest.fn(),
  getValuationSummary: jest.fn(),
}));

jest.mock("@/lib/reports/low-stock", () => ({
  __esModule: true,
  getLowStockReport: jest.fn(),
}));

// get_inventory_summary delegates valuation to getValuation (which itself reads prisma).
// Mock it so the summary byte-budget test drives the REAL inventory-summary module over
// deep-mocked prisma without recomputing valuation.
jest.mock("@/lib/analytics/valuation", () => ({
  __esModule: true,
  getValuation: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { assistantTools, TURN_RESULT_BUDGET_BYTES, testCtx } from "@/lib/assistant/tools";
import { getProductsWithQuantities } from "@/lib/products";
import {
  getSales,
  getStockSeries,
  getOperationsRows,
} from "@/lib/analytics/queries";
import { getLowStockReport } from "@/lib/reports/low-stock";
import { getValuation } from "@/lib/analytics/valuation";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockGetProducts = getProductsWithQuantities as jest.Mock;
const mockGetSales = getSales as jest.Mock;
const mockGetStockSeries = getStockSeries as jest.Mock;
const mockGetOperations = getOperationsRows as jest.Mock;
const mockGetLowStock = getLowStockReport as jest.Mock;
const mockGetValuation = getValuation as jest.Mock;

const CTX = testCtx({ companyIds: ["c1"] });
const CTX_NO_COMPANY = testCtx({ companyIds: [] });

function product(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "TIRZ 10mg",
    baseName: "TIRZ",
    variant: "10mg",
    currentQuantity: 42,
    lowStockThreshold: 5,
    approvalStatus: "APPROVED",
    ...over,
  };
}

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
  // getLowStockDefault -> systemSetting.findUnique (real stock-threshold runs).
  db.systemSetting.findUnique.mockResolvedValue(null as never);
  db.product_locations.findMany.mockResolvedValue([] as never);
  mockGetStockSeries.mockResolvedValue([]);
  // W0-PROD: get_stock now resolves productId via resolveAssistantProduct
  // (prisma.product.findFirst). Default to an approved product so the happy paths
  // reach the series read; the schema-rejection tests throw before this is hit.
  db.product.findFirst.mockResolvedValue({ id: 1, name: "TIRZ 10mg" } as never);
  // W0-STOCK: the series is paged on DISTINCT DAYS (productStockSnapshot.groupBy) and
  // location names come from the locations table. Benign empties by default.
  db.productStockSnapshot.groupBy.mockResolvedValue([] as never);
  db.location.findMany.mockResolvedValue([] as never);
  // G2-6: find_product OMITS a matched product whose lifecycle it cannot read (it never
  // synthesizes "active"), so the shared identity lookup — prisma.product.findMany over
  // the ids just fetched — has to answer here. Id-less reads (the approved-id set) keep
  // returning [] exactly as before.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.product.findMany.mockImplementation((args: any) =>
    Promise.resolve(
      ((args?.where?.id?.in ?? []) as number[]).map((id) => ({
        id,
        name: `product ${id}`,
        deletedAt: null,
      })),
    ) as never,
  );
});

describe("find_product: APPROVED-only + caps", () => {
  it("passes approvalStatus:'APPROVED' and the ≤20 pageSize to the products service", async () => {
    mockGetProducts.mockResolvedValue({ products: [product()], total: 1 });

    const result = await assistantTools.find_product.run({ query: "TIRZ" }, CTX);

    expect(result.status).toBe("ok");
    const filters = mockGetProducts.mock.calls[0][0];
    expect(filters).toMatchObject({ search: "TIRZ", approvalStatus: "APPROVED", pageSize: 20, page: 1 });
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { products: unknown[] }).products).toHaveLength(1);
    }
  });

  it("honors an explicit limit within the ≤20 cap (paginated at the tool boundary)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => product({ id: i }));
    mockGetProducts.mockResolvedValue({ products: many, total: 12 });
    const result = await assistantTools.find_product.run({ query: "abc", limit: 5 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as { products: unknown[]; returned: number; nextOffset: number | null };
      expect(data.products).toHaveLength(5);
      expect(data.returned).toBe(5);
      expect(data.nextOffset).toBe(5);
    }
  });

  it("rejects a limit above the cap (schema)", async () => {
    await expect(assistantTools.find_product.run({ query: "abc", limit: 999 }, CTX)).rejects.toThrow();
  });

  // G2-6: the old `?? "active"` default was a SYNTHESIZED lifecycle — sound only under an
  // assumption the code cannot check. A product whose identity did not come back is now
  // omitted and COUNTED, so a reader is told the list is short rather than handed a row
  // claiming a state nobody read.
  it("OMITS a matched product whose lifecycle could not be read, and counts it (never 'active')", async () => {
    mockGetProducts.mockResolvedValue({
      products: [product({ id: 1 }), product({ id: 2 })],
      total: 2,
    });
    // The identity read answers for #1 only — #2's lifecycle is unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.product.findMany.mockImplementation((_args: any) =>
      Promise.resolve([{ id: 1, name: "Known", deletedAt: null }]) as never,
    );

    const result = await assistantTools.find_product.run({ query: "abc" }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as {
      products: Array<{ id: number; lifecycle: string }>;
      coverage: { matched: number; identityMisses: number; identityNote?: string };
    };
    expect(data.products.map((p) => p.id)).toEqual([1]);
    expect(data.products[0].lifecycle).toBe("active");
    // The gap is DISCLOSED: matched still says 2, and the miss is counted + explained.
    expect(data.coverage.matched).toBe(2);
    expect(data.coverage.identityMisses).toBe(1);
    expect(data.coverage.identityNote).toContain("never guesses");
  });

  it("reports identityMisses: 0 on the normal path (a defined field, not a conditional one)", async () => {
    mockGetProducts.mockResolvedValue({ products: [product()], total: 1 });
    const result = await assistantTools.find_product.run({ query: "abc" }, CTX);
    if (result.status !== "ok") throw new Error("not ok");
    const coverage = (result.data as { coverage: Record<string, unknown> }).coverage;
    expect(coverage.identityMisses).toBe(0);
    expect(coverage.identityNote).toBeUndefined();
  });

  it("rejects a too-short query (schema)", async () => {
    await expect(assistantTools.find_product.run({ query: "a" }, CTX)).rejects.toThrow();
  });

  it("paginates a large match set: a page of rows + nextOffset, never an empty truncation (D-T7)", async () => {
    const many = Array.from({ length: 4000 }, (_, i) =>
      product({ id: i, name: `Product-${i}-` + "x".repeat(40) }),
    );
    mockGetProducts.mockResolvedValue({ products: many, total: many.length });

    const result = await assistantTools.find_product.run({ query: "prod" }, CTX);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as {
        products: unknown[];
        returned: number;
        totalRows: number;
        nextOffset: number | null;
      };
      expect(data.products.length).toBeGreaterThan(0);
      expect(data.products.length).toBeLessThanOrEqual(20); // FIND_PRODUCT_MAX
      expect(data.returned).toBe(data.products.length);
      expect(data.nextOffset).not.toBeNull();
      expect(result.meta.bytes).toBeLessThanOrEqual(TURN_RESULT_BUDGET_BYTES);
      expect(result.meta.scope).toBe("global");
    }
  });
});

describe("get_stock: DB-level take + window validation", () => {
  it("passes a bounded `take` to getStockSeries and labels scope global", async () => {
    db.product_locations.findMany.mockResolvedValue([
      { locationId: 1, quantity: 30 },
      { locationId: 2, quantity: 12 },
    ] as never);
    // >= 1 distinct day so the day-grouped page actually fetches series rows.
    db.productStockSnapshot.groupBy.mockResolvedValue([{ dayKey: "2026-01-01" }] as never);
    db.location.findMany.mockResolvedValue([
      { id: 1, name: "Main" },
      { id: 2, name: "Back" },
    ] as never);

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);

    expect(result.status).toBe("ok");
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    // FIX 1(d): the points fetch probes ONE past the cap (STOCK_SERIES_MAX_ROWS + 1 =
    // 1001) so an overflow is detectable and trimmed on whole-day boundaries.
    expect(seriesArg.take).toBe(1001);
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { currentStock: number }).currentStock).toBe(42);
    }
  });

  it("returns notFound (never currentStock:0) for a non-approved / absent productId (W0-PROD)", async () => {
    db.product.findFirst.mockResolvedValue(null as never);
    const result = await assistantTools.get_stock.run({ productId: 424242 }, CTX);
    expect(result).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining("424242") },
    });
    // The series/stock reads never ran — the id was rejected up front.
    expect(mockGetStockSeries).not.toHaveBeenCalled();
  });

  it("names the scalar 'locationStock' (not currentStock) on a location-scoped read", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 2, quantity: 9 }] as never);
    const result = await assistantTools.get_stock.run({ productId: 1, locationId: 2 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as Record<string, unknown>;
      expect(data.locationStock).toBe(9);
      expect(data).not.toHaveProperty("currentStock");
      expect(data.locationId).toBe(2);
    }
  });

  it("seriesCoverage.complete is false + omitted>0 when older days overflow the day cap", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    // 400 distinct days: the DISTINCT-day count drives totalDays; the paged fetch honors
    // skip/take (max 366 days), so 34 older days are omitted with complete:false.
    const manyDays = Array.from({ length: 400 }, (_, i) => ({ dayKey: `2020-01-${i}` }));
    db.productStockSnapshot.groupBy.mockImplementation((arg: unknown) => {
      const a = arg as { skip?: number; take?: number };
      return Promise.resolve(
        a && a.take != null ? manyDays.slice(a.skip ?? 0, (a.skip ?? 0) + a.take) : manyDays,
      ) as never;
    });
    mockGetStockSeries.mockResolvedValue([]);

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
      expect(cov.totalDays).toBe(400);
      expect(cov.returnedDays).toBe(366);
      expect(cov.complete).toBe(false);
      expect(cov.omitted).toBe(34);
    }
  });

  // FIX 1 REV-2: a mock day-group source that honors orderBy desc + skip/take, so the
  // NEWEST-first paging (and offset into it) is actually exercised, not assumed.
  function mockDayGroups(allDaysAsc: string[]) {
    db.productStockSnapshot.groupBy.mockImplementation((arg: unknown) => {
      const a = arg as { orderBy?: { dayKey?: string }; skip?: number; take?: number };
      const all = allDaysAsc.map((dk) => ({ dayKey: dk }));
      if (a && a.orderBy && a.orderBy.dayKey === "desc") {
        const desc = [...all].reverse();
        const skip = a.skip ?? 0;
        return Promise.resolve(desc.slice(skip, skip + (a.take ?? desc.length))) as never;
      }
      return Promise.resolve(all) as never; // count() call: no orderBy/skip/take
    });
  }
  const isoSeq = (n: number, startUtc = Date.UTC(2024, 0, 1)) =>
    Array.from({ length: n }, (_, i) => new Date(startUtc + i * 86_400_000).toISOString().slice(0, 10));

  it("pages the NEWEST days first (re-sorted ASC) when history exceeds the day cap (FIX 1 REV-2)", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    const allDaysAsc = isoSeq(400);
    mockDayGroups(allDaysAsc);
    // Echo one point on the fetched range's from + to so the presented series shows dayKeys.
    mockGetStockSeries.mockImplementation((opts: { from: string; to: string }) =>
      Promise.resolve([
        { dayKey: opts.from, locationId: 1, quantity: 1 },
        { dayKey: opts.to, locationId: 1, quantity: 2 },
      ]),
    );

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const newest366 = allDaysAsc.slice(400 - 366); // the newest 366 days, ascending
    // The range fetch used min/max of the PAGE = the newest 366 days (never the oldest).
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    expect(seriesArg.from).toBe(newest366[0]); // oldest day OF the newest page
    expect(seriesArg.to).toBe(newest366[newest366.length - 1]); // the very newest day
    // The presented series is ASC.
    const series = (result.data as { series: Array<{ dayKey: string }> }).series;
    expect(series[0].dayKey).toBe(newest366[0]);
    expect(series[series.length - 1].dayKey).toBe(newest366[newest366.length - 1]);

    const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
    expect(cov.returnedDays).toBe(366);
    expect(cov.totalDays).toBe(400);
    expect(cov.complete).toBe(false);
    expect(cov.omitted).toBe(34);
    // FIX 1(c): the omission note is truthful about WHICH end + how to reach the rest.
    expect(String(cov.note)).toContain("most recent");
    expect(String(cov.note)).toContain("older days are available via offset");
  });

  it("offset reaches OLDER day pages (day-group offset into the newest-first order) (FIX 1b)", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    const allDaysAsc = isoSeq(400);
    mockDayGroups(allDaysAsc);
    mockGetStockSeries.mockResolvedValue([]);

    // offset 366 skips the newest 366 day-groups => the OLDEST 34 days remain.
    const result = await assistantTools.get_stock.run({ productId: 1, offset: 366 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const oldest34 = allDaysAsc.slice(0, 34);
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    expect(seriesArg.from).toBe(oldest34[0]); // 2024-01-01
    expect(seriesArg.to).toBe(oldest34[oldest34.length - 1]); // the oldest page's newest day
    const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
    expect(cov.returnedDays).toBe(34);
    expect(cov.totalDays).toBe(400);
    expect(cov.complete).toBe(true); // 366 + 34 = 400 => nothing beyond this page
  });

  it("trims WHOLE days off the OLDEST end + complete:false when points overflow the cap (FIX 1d)", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    const [dayA, dayB, dayC] = ["2026-03-01", "2026-03-02", "2026-03-03"]; // ASC
    mockDayGroups([dayA, dayB, dayC]);
    // 1001 compact points (> the 1000 cap): 500 on the OLDEST day, then 300 + 201.
    // Dropping the oldest whole day (dayA, 500 pts) brings the page under the cap.
    const pts: Array<{ dayKey: string; locationId: number; quantity: number }> = [];
    for (let i = 0; i < 500; i++) pts.push({ dayKey: dayA, locationId: 1, quantity: 1 });
    for (let i = 0; i < 300; i++) pts.push({ dayKey: dayB, locationId: 1, quantity: 1 });
    for (let i = 0; i < 201; i++) pts.push({ dayKey: dayC, locationId: 1, quantity: 1 });
    mockGetStockSeries.mockResolvedValue(pts); // length 1001 = STOCK_SERIES_MAX_ROWS + 1

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
    expect(cov.complete).toBe(false);
    expect(String(cov.pointsNote)).toContain(dayA); // the dropped oldest day is named
    const series = (result.data as { series: Array<{ dayKey: string }> }).series;
    expect(series.some((p) => p.dayKey === dayA)).toBe(false); // fully trimmed
    expect(series.some((p) => p.dayKey === dayB)).toBe(true);
    expect(series.some((p) => p.dayKey === dayC)).toBe(true);
  });

  it("rejects a non-ISO date (schema)", async () => {
    await expect(assistantTools.get_stock.run({ productId: 1, from: "2026-13-40" }, CTX)).rejects.toThrow();
  });

  it("rejects an impossible calendar day 2026-02-30 (isoDay round-trip, W0-ISO)", async () => {
    await expect(assistantTools.get_stock.run({ productId: 1, from: "2026-02-30" }, CTX)).rejects.toThrow();
  });

  it("rejects a non-positive / non-integer id (schema)", async () => {
    await expect(assistantTools.get_stock.run({ productId: -5 }, CTX)).rejects.toThrow();
    await expect(assistantTools.get_stock.run({ productId: 1.5 }, CTX)).rejects.toThrow();
  });

  it("rejects a date window wider than 366 days", async () => {
    await expect(
      assistantTools.get_stock.run({ productId: 1, from: "2024-01-01", to: "2026-01-01" }, CTX),
    ).rejects.toThrow();
  });

  it("accepts a window within 366 days", async () => {
    const result = await assistantTools.get_stock.run(
      { productId: 1, from: "2026-01-01", to: "2026-06-01" },
      CTX,
    );
    expect(result.status).toBe("ok");
  });

  // FIX 5: the explicit-range cap is EXACTLY 366 inclusive day-keys (a 365-day span).
  it("accepts a window of exactly 366 inclusive day-keys (2026-01-01..2027-01-01, 365-day span)", async () => {
    const result = await assistantTools.get_stock.run(
      { productId: 1, from: "2026-01-01", to: "2027-01-01" },
      CTX,
    );
    expect(result.status).toBe("ok");
  });

  it("rejects a window of 367 inclusive day-keys (2026-01-01..2027-01-02, 366-day span)", async () => {
    await expect(
      assistantTools.get_stock.run({ productId: 1, from: "2026-01-01", to: "2027-01-02" }, CTX),
    ).rejects.toThrow();
  });
});

describe("get_sales: company isolation + Decimal serialization", () => {
  it("empty companyIds -> empty result + explanatory note, WITHOUT calling getSales", async () => {
    const result = await assistantTools.get_sales.run({}, CTX_NO_COMPANY);

    expect(mockGetSales).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as { rows: unknown[]; note: string };
      expect(data.rows).toEqual([]);
      expect(typeof data.note).toBe("string");
      expect(result.meta.scope).toBe("company");
    }
  });

  it("scopes to ctx.companyIds and serializes Decimal revenue to a string", async () => {
    mockGetSales.mockResolvedValue([
      {
        productId: 1,
        _sum: { revenue: new Prisma.Decimal("123.45"), orderedQty: 5, fulfilledQty: 5, orderCount: 2 },
      },
    ]);

    const result = await assistantTools.get_sales.run({ groupBy: "product" }, CTX);

    expect(mockGetSales).toHaveBeenCalledWith(expect.objectContaining({ companyIds: ["c1"], groupBy: "product" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rows = (result.data as { rows: Array<{ _sum: { revenue: unknown } }> }).rows;
      expect(rows[0]._sum.revenue).toBe("123.45");
      expect(typeof rows[0]._sum.revenue).toBe("string");
      // No raw Decimal object crosses the tool boundary.
      expect(rows[0]._sum.revenue).not.toBeInstanceOf(Prisma.Decimal);
    }
  });
});

describe("get_operations: top-limit by attention", () => {
  it("returns at most `limit` rows, most-critical (attention) first", async () => {
    const rows = [
      { productId: 1, attention: "ok" },
      { productId: 2, attention: "out" },
      { productId: 3, attention: "low" },
      { productId: 4, attention: "stale" },
    ];
    mockGetOperations.mockResolvedValue({ rows, dataStarts: { sale: null, adjustment: null, receipt: null, snapshot: null } });

    const result = await assistantTools.get_operations.run({ limit: 2 }, CTX);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const out = (result.data as { rows: Array<{ productId: number; attention: string }> }).rows;
      expect(out).toHaveLength(2);
      expect(out[0].attention).toBe("out");
      expect(out[1].attention).toBe("low");
    }
  });

  it("rejects a limit above the ≤50 cap", async () => {
    await expect(assistantTools.get_operations.run({ limit: 51 }, CTX)).rejects.toThrow();
  });
});

describe("get_inventory_summary: reserves envelope bytes so a tight budget still returns a page (item 1)", () => {
  it("a tight remainingBytes returns a small OK page whose TOTAL bytes fit the budget — never discarded at the margin", async () => {
    // 50 products with long names: if the ranked page were given the FULL remaining
    // budget, it would fill it and the added valuation/totals/coverage envelope would push
    // the COMPLETED result OVER the budget the adapter threaded in — the residual-discard
    // bug. Reserving envelope bytes keeps the whole result under the budget.
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `Product-${i}-` + "x".repeat(300),
      lowStockThreshold: null,
      costPrice: null,
      retailPrice: null,
      product_locations: [{ locationId: 1, quantity: 100 - i, locations: { name: "Main" } }],
    }));
    db.product.findMany.mockResolvedValue(many as never);
    mockGetValuation.mockResolvedValue({
      groupBy: "total",
      rows: [
        { units: 999, atCurrentCostCents: null, atReceiptCostCents: null, atRetailCents: null, marginCents: null },
      ],
      coverage: {
        costedProducts: 0, ofProducts: 50, costedUnits: 0, ofUnits: 999,
        retailPricedProducts: 0, retailPricedUnits: 0,
        receiptCostedProducts: 0, receiptCostedUnits: 0, marginProducts: 0, marginUnits: 0,
      },
    });

    const TIGHT = 12_000;
    const result = await assistantTools.get_inventory_summary.run(
      { rankBy: "onHand", limit: 50 },
      testCtx({ companyIds: ["c1"], remainingBytes: TIGHT }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The COMPLETED result (ranked page + valuation + totals + coverage) fits under the
    // budget the adapter threaded in, so the adapter keeps it instead of discarding it.
    expect(result.meta.bytes).toBeLessThanOrEqual(TIGHT);
    // Still a real page (degrade to a SMALLER page, never nothing).
    const data = result.data as { ranked: { rows: unknown[]; returned: number } };
    expect(data.ranked.returned).toBeGreaterThan(0);
  });
});

describe("get_stock_asof: reserves envelope bytes so a tight budget still returns a page (item 6)", () => {
  it("a tight remainingBytes returns a small OK page whose TOTAL bytes fit the budget — never a truncation notice", async () => {
    // 100 compact rows so the byte-fit lands TIGHT against the budget (per-row slack is
    // small). If the page were given the FULL remaining budget it would fill it, and the
    // added dayKey + coverage envelope (larger than one row) would push the COMPLETED
    // result OVER the budget the adapter threaded in — the residual-discard bug. Reserving
    // envelope bytes keeps the whole result under the budget (a smaller page, never a notice).
    const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `P${i}` }));
    db.product.count.mockResolvedValue(many.length as never);
    db.product.findMany.mockImplementation((async (args: { skip?: number; take?: number }) => {
      const skip = args?.skip ?? 0;
      const take = args?.take ?? many.length;
      return many.slice(skip, skip + take);
    }) as never);
    db.productStockSnapshot.aggregate.mockResolvedValue({ _min: { dayKey: "2026-01-01" }, _max: { dayKey: "2026-06-30" } } as never);
    db.productStockSnapshot.groupBy.mockImplementation((async (args: { _sum?: unknown }) =>
      args._sum
        ? many.map((p) => ({ productId: p.id, _sum: { quantity: 5 }, _count: 1 }))
        : many.map((p) => ({ productId: p.id, locationId: 1, _max: { dayKey: "2026-06-30" }, _min: { dayKey: "2026-01-01" } }))) as never);
    db.analyticsRebuildState.findUnique.mockResolvedValue({ lastWindowTo: "2026-06-30", flaggedPairs: 0 } as never);

    // Small enough that the 100 rows overflow it (so the page is genuinely bounded by
    // bytes, not row count) — the residual-discard fires exactly at this margin.
    const TIGHT = 6_000;
    const result = await assistantTools.get_stock_asof.run(
      { dayKey: "2026-06-15", limit: 100 },
      testCtx({ companyIds: ["c1"], remainingBytes: TIGHT }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The COMPLETED result (page + dayKey + coverage) fits under the threaded budget, so
    // the adapter keeps it instead of downgrading to a truncation notice.
    expect(result.meta.bytes).toBeLessThanOrEqual(TIGHT);
    // Still a real page (degrade to a SMALLER page, never nothing) and byte-bounded (the
    // full 100-row catalog did not fit, so nextOffset advances).
    const data = result.data as { returned: number; totalRows: number; nextOffset: number | null };
    expect(data.returned).toBeGreaterThan(0);
    expect(data.totalRows).toBe(100);
    expect(data.nextOffset).not.toBeNull();
  });
});

describe("low_stock_report: fetches the full report and paginates at the tool", () => {
  it("fetches all alerts (no limit passed down) and surfaces systemDefaultThreshold", async () => {
    mockGetLowStock.mockResolvedValue({ alerts: [], threshold: 10 });
    const result = await assistantTools.low_stock_report.run({ limit: 25 }, CTX);
    // Paging happens at the tool boundary now, so the full report is fetched.
    expect(mockGetLowStock).toHaveBeenCalledWith({});
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { systemDefaultThreshold: number }).systemDefaultThreshold).toBe(10);
    }
  });
});
