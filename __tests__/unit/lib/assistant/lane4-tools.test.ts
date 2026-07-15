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

import prisma from "@/lib/prisma";
import { assistantTools, TURN_RESULT_BUDGET_BYTES, testCtx } from "@/lib/assistant/tools";
import { getProductsWithQuantities } from "@/lib/products";
import {
  getSales,
  getStockSeries,
  getOperationsRows,
} from "@/lib/analytics/queries";
import { getLowStockReport } from "@/lib/reports/low-stock";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockGetProducts = getProductsWithQuantities as jest.Mock;
const mockGetSales = getSales as jest.Mock;
const mockGetStockSeries = getStockSeries as jest.Mock;
const mockGetOperations = getOperationsRows as jest.Mock;
const mockGetLowStock = getLowStockReport as jest.Mock;

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

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);

    expect(result.status).toBe("ok");
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    expect(typeof seriesArg.take).toBe("number");
    expect(seriesArg.take).toBeLessThanOrEqual(1000);
    expect(seriesArg.take).toBeGreaterThan(0);
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { currentStock: number }).currentStock).toBe(42);
    }
  });

  it("rejects a non-ISO date (schema)", async () => {
    await expect(assistantTools.get_stock.run({ productId: 1, from: "2026-13-40" }, CTX)).rejects.toThrow();
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
