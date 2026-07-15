/**
 * @jest-environment node
 *
 * lib/reports/inventory-summary.ts (assistant toolsuite breadth, spec §5 T-SUM).
 *
 * Pins:
 *  - unitsOnHand/productCount/stockStateCounts over the approved+non-deleted scope;
 *    a 0-stock product counts "out" AND NOT "low" (find_product's stockState rule,
 *    reused via the real @/lib/stock-threshold helpers, never re-implemented).
 *  - locationId scopes unitsOnHand/stockStateCounts (and the onHand/outbound30/
 *    daysOfSupply ranked metrics); productCount stays GLOBAL; valuation stays
 *    GLOBAL and carries a `reasons.valuation` disclosure note.
 *  - valuation is delegated VERBATIM to the (mocked) getValuation — never recomputed.
 *  - ranked: onHand / value (null for uncosted, sorted last) / outbound30 (measured
 *    zero, never null, when no qualifying rows) / daysOfSupply (null — never 0/Infinity
 *    — when there is no outbound signal). Deterministic tie-break: metric desc, nulls
 *    last, then productId asc.
 *  - pagination shape (rows/returned/totalRows/nextOffset) via the shared `paginate`.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

jest.mock("@/lib/analytics/valuation", () => ({
  __esModule: true,
  getValuation: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { getValuation } from "@/lib/analytics/valuation";
import { getInventorySummary } from "@/lib/reports/inventory-summary";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockGetValuation = getValuation as jest.Mock;

const DAY_MS = 86_400_000;
const NOW = new Date("2026-07-14T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY_MS);

const BYTE_BUDGET = 65536;

// A minimal, valid ValuationResult stub for groupBy "total" — the exact numbers
// don't matter to this module (it never recomputes valuation), only that the
// object is relayed verbatim (plus the location-note augmentation).
function totalValuation(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    groupBy: "total" as const,
    rows: [
      {
        units: 999,
        atCurrentCostCents: 12345,
        atReceiptCostCents: null,
        atRetailCents: null,
        marginCents: null,
      },
    ],
    coverage: {
      costedProducts: 1,
      ofProducts: 1,
      costedUnits: 999,
      ofUnits: 999,
      retailPricedProducts: 0,
      retailPricedUnits: 0,
      receiptCostedProducts: 0,
      receiptCostedUnits: 0,
      marginProducts: 0,
      marginUnits: 0,
    },
    ...overrides,
  };
}

function product(over: {
  id: number;
  name?: string | null;
  lowStockThreshold?: number | null;
  locations: Array<{ locationId: number; quantity: number }>;
}) {
  return {
    id: over.id,
    name: over.name ?? `P${over.id}`,
    lowStockThreshold: over.lowStockThreshold ?? null,
    product_locations: over.locations.map((l) => ({ locationId: l.locationId, quantity: l.quantity })),
  };
}

beforeEach(() => {
  mockReset(db);
  mockGetValuation.mockReset();
  mockGetValuation.mockResolvedValue(totalValuation());
});

describe("catalog totals + stock state", () => {
  it("unitsOnHand/productCount/stockStateCounts over approved+non-deleted scope; 0-stock counts out AND not low", async () => {
    db.product.findMany.mockResolvedValue([
      // low: 5 units, inherits system default threshold (10) => 0 < 5 <= 10.
      product({ id: 1, locations: [{ locationId: 1, quantity: 5 }] }),
      // out: 0 units, EXPLICIT threshold 5 — must still be "out", not "low".
      product({ id: 2, lowStockThreshold: 5, locations: [{ locationId: 1, quantity: 0 }] }),
      // in_stock: 50 units, well above the default threshold.
      product({ id: 3, locations: [{ locationId: 1, quantity: 50 }] }),
    ] as never);

    const summary = await getInventorySummary({ byteBudget: BYTE_BUDGET }, NOW);

    expect(summary.unitsOnHand).toBe(55);
    expect(summary.productCount).toBe(3);
    expect(summary.stockStateCounts).toEqual({ in_stock: 1, low: 1, out: 1 });
    expect(summary.ranked).toBeUndefined();
    expect(mockGetValuation).toHaveBeenCalledWith({ groupBy: "total" });
  });

  it("query scope: approved, non-deleted (verifies the where clause passed to prisma)", async () => {
    db.product.findMany.mockResolvedValue([]);
    await getInventorySummary({ byteBudget: BYTE_BUDGET }, NOW);
    expect(db.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, approvalStatus: "APPROVED" },
      }),
    );
  });
});

describe("locationId scoping", () => {
  it("scopes unitsOnHand/stockStateCounts to the location; productCount stays global; valuation stays global + carries the note", async () => {
    db.product.findMany.mockResolvedValue([
      // Present at both locations: 5 @ loc1 (would be "low" there), 20 @ loc2 ("in_stock").
      product({
        id: 1,
        locations: [
          { locationId: 1, quantity: 5 },
          { locationId: 2, quantity: 20 },
        ],
      }),
      // Only present at loc1 — at loc2 it has zero presence ("out" there).
      product({ id: 2, locations: [{ locationId: 1, quantity: 3 }] }),
    ] as never);

    const atLoc2 = await getInventorySummary({ byteBudget: BYTE_BUDGET, locationId: 2 }, NOW);

    // unitsOnHand only counts loc2 quantities: 20 (product 1) + 0 (product 2).
    expect(atLoc2.unitsOnHand).toBe(20);
    // productCount is the GLOBAL approved+non-deleted count, unaffected by locationId.
    expect(atLoc2.productCount).toBe(2);
    // product 1 in_stock at loc2 (20 > default 10); product 2 out at loc2 (0 units).
    expect(atLoc2.stockStateCounts).toEqual({ in_stock: 1, low: 0, out: 1 });

    // valuation is relayed GLOBAL (the mock's numbers, untouched) + gets the note.
    expect(atLoc2.valuation.rows[0].units).toBe(999);
    expect(atLoc2.valuation.rows[0].atCurrentCostCents).toBe(12345);
    expect(atLoc2.valuation.rows[0].reasons?.valuation).toBe(
      "valuation is catalog-wide; location-scoped valuation is not provided here",
    );
  });

  it("no note is added when locationId is omitted", async () => {
    db.product.findMany.mockResolvedValue([product({ id: 1, locations: [{ locationId: 1, quantity: 5 }] })] as never);
    const summary = await getInventorySummary({ byteBudget: BYTE_BUDGET }, NOW);
    expect(summary.valuation.rows[0].reasons).toBeUndefined();
  });
});

describe("ranked — onHand", () => {
  it("sorts desc by summed on-hand units, tie-break productId asc; paginates", async () => {
    db.product.findMany.mockResolvedValue([
      product({ id: 1, locations: [{ locationId: 1, quantity: 10 }] }),
      product({ id: 2, locations: [{ locationId: 1, quantity: 30 }] }), // tied with 3
      product({ id: 3, locations: [{ locationId: 1, quantity: 30 }] }), // tied with 2
    ] as never);

    const summary = await getInventorySummary(
      { rankBy: "onHand", limit: 2, offset: 0, byteBudget: BYTE_BUDGET },
      NOW,
    );

    expect(summary.ranked).toBeDefined();
    expect(summary.ranked!.rows).toEqual([
      { productId: 2, name: "P2", metric: 30 },
      { productId: 3, name: "P3", metric: 30 },
    ]);
    expect(summary.ranked!.returned).toBe(2);
    expect(summary.ranked!.totalRows).toBe(3);
    expect(summary.ranked!.nextOffset).toBe(2);
  });

  it("second page returns the remainder with nextOffset null", async () => {
    db.product.findMany.mockResolvedValue([
      product({ id: 1, locations: [{ locationId: 1, quantity: 10 }] }),
      product({ id: 2, locations: [{ locationId: 1, quantity: 30 }] }),
      product({ id: 3, locations: [{ locationId: 1, quantity: 30 }] }),
    ] as never);

    const summary = await getInventorySummary(
      { rankBy: "onHand", limit: 2, offset: 2, byteBudget: BYTE_BUDGET },
      NOW,
    );

    expect(summary.ranked!.rows).toEqual([{ productId: 1, name: "P1", metric: 10 }]);
    expect(summary.ranked!.returned).toBe(1);
    expect(summary.ranked!.totalRows).toBe(3);
    expect(summary.ranked!.nextOffset).toBeNull();
  });

  it("respects locationId scoping for the onHand metric", async () => {
    db.product.findMany.mockResolvedValue([
      product({
        id: 1,
        locations: [
          { locationId: 1, quantity: 5 },
          { locationId: 2, quantity: 40 },
        ],
      }),
      product({ id: 2, locations: [{ locationId: 1, quantity: 100 }] }), // absent at loc2
    ] as never);

    const summary = await getInventorySummary(
      { rankBy: "onHand", locationId: 2, byteBudget: BYTE_BUDGET },
      NOW,
    );

    expect(summary.ranked!.rows).toEqual([
      { productId: 1, name: "P1", metric: 40 },
      { productId: 2, name: "P2", metric: 0 },
    ]);
  });
});

describe("ranked — value (null-metric ordering: uncosted sorts last)", () => {
  it("uses getValuation groupBy:'product' rows; null metric for uncosted products sorts last", async () => {
    db.product.findMany.mockResolvedValue([
      product({ id: 1, locations: [{ locationId: 1, quantity: 5 }] }),
      product({ id: 2, locations: [{ locationId: 1, quantity: 5 }] }), // uncosted
    ] as never);

    mockGetValuation.mockImplementation(async (opts: { groupBy?: string }) => {
      if (opts.groupBy === "product") {
        return {
          groupBy: "product",
          rows: [
            { productId: 1, name: "P1", units: 5, atCurrentCostCents: 500, atReceiptCostCents: null, atRetailCents: null, marginCents: null },
            { productId: 2, name: "P2", units: 5, atCurrentCostCents: null, atReceiptCostCents: null, atRetailCents: null, marginCents: null },
          ],
          coverage: {
            costedProducts: 1, ofProducts: 2, costedUnits: 5, ofUnits: 10,
            retailPricedProducts: 0, retailPricedUnits: 0,
            receiptCostedProducts: 0, receiptCostedUnits: 0,
            marginProducts: 0, marginUnits: 0,
          },
        };
      }
      return totalValuation();
    });

    const summary = await getInventorySummary({ rankBy: "value", byteBudget: BYTE_BUDGET }, NOW);

    expect(summary.ranked!.rows).toEqual([
      { productId: 1, name: "P1", metric: 500 },
      { productId: 2, name: "P2", metric: null },
    ]);
    expect(mockGetValuation).toHaveBeenCalledWith({ groupBy: "total" });
    expect(mockGetValuation).toHaveBeenCalledWith({ groupBy: "product" });
  });
});

describe("ranked — outbound30 (measured zero, never null, when no qualifying rows)", () => {
  it("sums physical-outbound units per product over the trailing 30 days; no rows => 0", async () => {
    db.product.findMany.mockResolvedValue([
      product({ id: 1, locations: [{ locationId: 1, quantity: 10 }] }),
      product({ id: 2, locations: [{ locationId: 1, quantity: 10 }] }), // no outbound rows
    ] as never);

    db.inventory_logs.groupBy.mockResolvedValue([
      { productId: 1, _sum: { delta: -6 }, _min: { changeTime: daysAgo(5) } },
    ] as never);

    const summary = await getInventorySummary({ rankBy: "outbound30", byteBudget: BYTE_BUDGET }, NOW);

    expect(summary.ranked!.rows).toEqual([
      { productId: 1, name: "P1", metric: 6 },
      { productId: 2, name: "P2", metric: 0 },
    ]);

    // Uses the shared physicalOutbound predicate + the 30-day window + in-scope ids.
    expect(db.inventory_logs.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["productId"],
        where: expect.objectContaining({
          delta: { lt: 0 },
          logType: { not: "TRANSFER" },
          productId: { in: [1, 2] },
          changeTime: { gte: new Date(NOW.getTime() - 30 * DAY_MS) },
        }),
      }),
    );
  });

  it("scopes the outbound query by locationId when given", async () => {
    db.product.findMany.mockResolvedValue([product({ id: 1, locations: [{ locationId: 1, quantity: 10 }] })] as never);
    db.inventory_logs.groupBy.mockResolvedValue([]);

    await getInventorySummary({ rankBy: "outbound30", locationId: 7, byteBudget: BYTE_BUDGET }, NOW);

    expect(db.inventory_logs.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ locationId: 7 }) }),
    );
  });
});

describe("ranked — daysOfSupply (null, never 0 or Infinity, for no-outbound)", () => {
  it("computes onHand / (outbound30/daysCovered); null when there is no outbound signal", async () => {
    db.product.findMany.mockResolvedValue([
      product({ id: 1, locations: [{ locationId: 1, quantity: 100 }] }), // has outbound
      product({ id: 2, locations: [{ locationId: 1, quantity: 20 }] }), // no outbound
    ] as never);

    // product 1: 10 units out over the last 5 days => daysCovered=5, rate=2/day.
    db.inventory_logs.groupBy.mockResolvedValue([
      { productId: 1, _sum: { delta: -10 }, _min: { changeTime: daysAgo(5) } },
    ] as never);

    const summary = await getInventorySummary({ rankBy: "daysOfSupply", byteBudget: BYTE_BUDGET }, NOW);

    expect(summary.ranked!.rows).toEqual([
      { productId: 1, name: "P1", metric: 50 }, // 100 / (10/5) = 50
      { productId: 2, name: "P2", metric: null }, // null, never 0 or Infinity
    ]);
  });
});

describe("pagination shape", () => {
  it("returns a DbPage-shaped object (rows/returned/totalRows/nextOffset)", async () => {
    db.product.findMany.mockResolvedValue([
      product({ id: 1, locations: [{ locationId: 1, quantity: 1 }] }),
    ] as never);

    const summary = await getInventorySummary({ rankBy: "onHand", byteBudget: BYTE_BUDGET }, NOW);

    expect(summary.ranked).toEqual(
      expect.objectContaining({
        rows: expect.any(Array),
        returned: expect.any(Number),
        totalRows: expect.any(Number),
      }),
    );
    expect(summary.ranked!.nextOffset === null || typeof summary.ranked!.nextOffset === "number").toBe(true);
  });
});
