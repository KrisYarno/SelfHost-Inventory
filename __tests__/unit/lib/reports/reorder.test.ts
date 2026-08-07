/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 3: the reorder computation (lib/reports/reorder.ts).
 *
 * The truthful-data CORE. Pins:
 *  - avgDaily null  => {status:"unavailable", reason:"no_demand_signal"} with NO numbers.
 *  - events < minEvidence => {status:"unavailable", reason:"insufficient_history"}.
 *  - RAW decimals carried; Math.ceil the LEVELS once:
 *      reorderPoint = ceil(avgDaily*lead + avgDaily*buffer)
 *      targetLevel  = max(reorderPoint, ceil(avgDaily*lead*multiple))  <- the max() guard
 *      grossReplenishmentNeed = roundUpToMOQ(max(0, targetLevel - stock), moq)
 *  - the lead=1/buffer=7/stock=8 hole: needsReorder AND grossReplenishmentNeed > 0.
 *  - reorderPointOverride pins the reorder point.
 *  - cost: null => costPrice null + orderValue null (NOT $0); explicit 0 => 0 + 0.
 *  - urgency buckets OUT / CRITICAL / REORDER_NOW / APPROACHING.
 *  - inventoryPositionKnown:false on every result.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

// Inject demand directly so the math is tested in isolation from the days-covered query.
jest.mock("@/lib/reports/demand", () => ({
  __esModule: true,
  reorderDemand: jest.fn(),
}));

// Real resolver (pure, tested in Task 1); only the globals read is stubbed.
jest.mock("@/lib/reorder-config", () => {
  const actual = jest.requireActual("@/lib/reorder-config");
  return { __esModule: true, ...actual, getGlobalReorderSettings: jest.fn() };
});

import prisma from "@/lib/prisma";
import { reorderDemand } from "@/lib/reports/demand";
import { getGlobalReorderSettings } from "@/lib/reorder-config";
import { getReorderReport, type ReorderRow } from "@/lib/reports/reorder";
import type { ProductDemand } from "@/lib/reports/demand";
import type { OutboundMix } from "@/lib/reports/outbound-mix";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockReorderDemand = reorderDemand as jest.Mock;
const mockGetGlobals = getGlobalReorderSettings as jest.Mock;

const GLOBALS = {
  id: 1,
  defaultLeadTimeDays: 14,
  defaultSafetyStockDays: 7,
  defaultTargetCoverageMultiple: 2,
  minEvidenceEvents: 3,
  holdingCostRate: "0.2500",
  updatedBy: null,
  updatedAt: new Date("2026-07-14T00:00:00Z"),
};

interface SeedProduct {
  id: number;
  name: string;
  costPrice: number | null;
  stock: number;
  reorderConfig?: {
    leadTimeDays: number | null;
    customSafetyStockDays: number | null;
    minOrderQuantity: number;
    reorderPointOverride: number | null;
  } | null;
  // The C12 additions ride on ProductDemand; older fixtures omit them and get the
  // no-signal defaults (demandUnits 0 / mix null).
  demand?: {
    avgDailyDemand: number | null;
    outboundEvents: number;
    daysCovered: number;
    demandUnits?: number;
    mix?: OutboundMix | null;
  };
}

function seed(products: SeedProduct[]) {
  mockGetGlobals.mockResolvedValue(GLOBALS);
  db.product.findMany.mockResolvedValue(
    products.map((p) => ({
      id: p.id,
      name: p.name,
      costPrice: p.costPrice,
      product_locations: [{ quantity: p.stock }],
      reorderConfig: p.reorderConfig ?? null,
    })) as never,
  );
  const map = new Map<number, ProductDemand>();
  for (const p of products) {
    const d = p.demand ?? { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0 };
    map.set(p.id, { demandUnits: 0, mix: null, ...d });
  }
  mockReorderDemand.mockResolvedValue(map);
}

const asSuggested = (r: ReorderRow) => {
  if (r.status !== "suggested") throw new Error(`expected suggested, got ${r.status}`);
  return r;
};
const asUnavailable = (r: ReorderRow) => {
  if (r.status !== "unavailable") throw new Error(`expected unavailable, got ${r.status}`);
  return r;
};

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
});

describe("truthful-data gates", () => {
  it("no demand signal => unavailable/no_demand_signal with NO numbers", async () => {
    seed([{ id: 1, name: "Idle", costPrice: 5, stock: 0, demand: { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0 } }]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asUnavailable(report.rows.find((r) => r.productId === 1)!);
    expect(row.reason).toBe("no_demand_signal");
    expect(row).not.toHaveProperty("reorderPoint");
    expect(row).not.toHaveProperty("grossReplenishmentNeed");
    expect(row).not.toHaveProperty("avgDailyDemand");
  });

  it("below the min-evidence gate => unavailable/insufficient_history (a day-one event drives nothing)", async () => {
    seed([{ id: 1, name: "New", costPrice: 5, stock: 0, demand: { avgDailyDemand: 50, outboundEvents: 2, daysCovered: 1 } }]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asUnavailable(report.rows.find((r) => r.productId === 1)!);
    expect(row.reason).toBe("insufficient_history");
    expect(row).not.toHaveProperty("reorderPoint");
  });
});

describe("reorder math — raw decimals, ceil the levels once", () => {
  it("reorderPoint = ceil(avgDaily*lead + avgDaily*buffer)", async () => {
    // avgDaily 1.5, lead 14, buffer 7 => 1.5*14 + 1.5*7 = 21 + 10.5 = 31.5 => ceil 32.
    seed([{ id: 1, name: "P", costPrice: null, stock: 0, demand: { avgDailyDemand: 1.5, outboundEvents: 10, daysCovered: 30 } }]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.reorderPoint).toBe(32);
    expect(row.leadTimeDays).toBe(14);
    expect(row.bufferDays).toBe(7);
  });

  it("the max() guard closes the lead=1/buffer=7/stock=8 hole (needsReorder AND need > 0)", async () => {
    // avgDaily 2, lead 1, buffer 7 => reorderPoint = ceil(2*1 + 2*7) = 16. stock 8 <= 16.
    // Without max(): targetLevel = ceil(2*1*2) = 4 => need = max(0, 4-8) = 0 (the hole).
    // With max(): targetLevel = max(16, 4) = 16 => need = 16 - 8 = 8 > 0.
    seed([
      {
        id: 1,
        name: "Hole",
        costPrice: null,
        stock: 8,
        reorderConfig: { leadTimeDays: 1, customSafetyStockDays: 7, minOrderQuantity: 1, reorderPointOverride: null },
        demand: { avgDailyDemand: 2, outboundEvents: 10, daysCovered: 30 },
      },
    ]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.reorderPoint).toBe(16);
    expect(row.targetLevel).toBe(16);
    expect(row.grossReplenishmentNeed).toBe(8);
  });

  it("reorderPointOverride pins the reorder point", async () => {
    seed([
      {
        id: 1,
        name: "Pinned",
        costPrice: null,
        stock: 5,
        reorderConfig: { leadTimeDays: 14, customSafetyStockDays: 7, minOrderQuantity: 1, reorderPointOverride: 100 },
        demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 },
      },
    ]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.reorderPoint).toBe(100);
    // targetLevel = max(100, ceil(1*14*2)=28) = 100 => need = 100 - 5 = 95.
    expect(row.targetLevel).toBe(100);
    expect(row.grossReplenishmentNeed).toBe(95);
  });

  it("rounds the gross need UP to the minimum order quantity", async () => {
    // avgDaily 1, lead 14, buffer 7 => reorderPoint 21; targetLevel max(21, 28) = 28.
    // stock 0 => raw need 28; MOQ 10 => roundUp(28,10) = 30.
    seed([
      {
        id: 1,
        name: "MOQ",
        costPrice: null,
        stock: 0,
        reorderConfig: { leadTimeDays: 14, customSafetyStockDays: 7, minOrderQuantity: 10, reorderPointOverride: null },
        demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 },
      },
    ]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.targetLevel).toBe(28);
    expect(row.minOrderQuantity).toBe(10);
    expect(row.grossReplenishmentNeed).toBe(30);
  });
});

describe("cost is number|null — never collapse 0 and unknown", () => {
  it("null cost => costPrice null AND orderValue null (not $0)", async () => {
    seed([{ id: 1, name: "Unknown", costPrice: null, stock: 0, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } }]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.costPrice).toBeNull();
    expect(row.orderValue).toBeNull();
  });

  it("explicit 0 cost => costPrice 0 AND orderValue 0 (known free)", async () => {
    seed([{ id: 1, name: "Free", costPrice: 0, stock: 0, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } }]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.costPrice).toBe(0);
    expect(row.orderValue).toBe(0);
  });

  it("known cost => orderValue = cost * grossReplenishmentNeed", async () => {
    // avgDaily 1, lead 14, buffer 7 => reorderPoint 21, targetLevel 28, stock 0, MOQ 1 => need 28.
    seed([{ id: 1, name: "Costed", costPrice: 2.5, stock: 0, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } }]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows.find((r) => r.productId === 1)!);
    expect(row.grossReplenishmentNeed).toBe(28);
    expect(row.costPrice).toBe(2.5);
    expect(row.orderValue).toBe(70);
  });
});

describe("urgency buckets (reorder-specific, not warehouse getOrderStatus)", () => {
  // avgDaily 1, lead 14, buffer 7 => leadTimeDemand 14, reorderPoint 21, 1.2x = 25.2.
  const cfg = (stock: number): SeedProduct => ({
    id: 1,
    name: "U",
    costPrice: null,
    stock,
    reorderConfig: { leadTimeDays: 14, customSafetyStockDays: 7, minOrderQuantity: 1, reorderPointOverride: null },
    demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 },
  });

  it("OUT when stock is 0", async () => {
    seed([cfg(0)]);
    const report = await getReorderReport({ includeOkay: true });
    expect(asSuggested(report.rows[0]).urgency).toBe("OUT");
  });
  it("CRITICAL when stock < leadTimeDemand", async () => {
    seed([cfg(10)]); // 10 < 14
    const report = await getReorderReport({ includeOkay: true });
    expect(asSuggested(report.rows[0]).urgency).toBe("CRITICAL");
  });
  it("REORDER_NOW when leadTimeDemand <= stock <= reorderPoint", async () => {
    seed([cfg(20)]); // 14 <= 20 <= 21
    const report = await getReorderReport({ includeOkay: true });
    expect(asSuggested(report.rows[0]).urgency).toBe("REORDER_NOW");
  });
  it("APPROACHING when reorderPoint < stock <= reorderPoint*1.2", async () => {
    seed([cfg(24)]); // 21 < 24 <= 25.2
    const report = await getReorderReport({ includeOkay: true });
    expect(asSuggested(report.rows[0]).urgency).toBe("APPROACHING");
  });
  it("a healthy product (stock > reorderPoint*1.2) is not a row by default", async () => {
    seed([cfg(40)]); // 40 > 25.2 -> healthy
    const report = await getReorderReport(); // includeOkay defaults false
    expect(report.rows.find((r) => r.productId === 1)).toBeUndefined();
    expect(report.coverage.total).toBe(1);
  });
});

describe("report envelope", () => {
  it("states inventoryPositionKnown:false, discloses assumptions, and counts coverage", async () => {
    seed([
      { id: 1, name: "Sug", costPrice: 3, stock: 0, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } },
      { id: 2, name: "NoCost", costPrice: null, stock: 0, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } },
      { id: 3, name: "Idle", costPrice: 1, stock: 0, demand: { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0 } },
    ]);
    const report = await getReorderReport({ includeOkay: true });
    expect(report.inventoryPositionKnown).toBe(false);
    expect(report.assumptions.targetCoverageMultiple).toBe(2);
    expect(report.assumptions.bufferDaysDefault).toBe(7);
    expect(typeof report.assumptions.demandDefinition).toBe("string");
    expect(report.coverage.total).toBe(3);
    expect(report.coverage.suggested).toBe(2);
    expect(report.coverage.unavailable).toBe(1);
    expect(report.coverage.costed).toBe(1); // only product 1 has a cost among the suggested
  });
});

describe("demand mix on suggested rows (spec C12)", () => {
  it("surfaces demandUnits + demandMix from ProductDemand; the buckets sum to demandUnits", async () => {
    seed([
      {
        id: 1,
        name: "Mixed",
        costPrice: null,
        stock: 0,
        demand: {
          avgDailyDemand: 1,
          outboundEvents: 10,
          daysCovered: 30,
          demandUnits: 30,
          // The whole point of C12: this product's "demand" is 24 units of legacy
          // unclassified adjustment and only 6 units of actual SALE.
          mix: {
            sale: 6,
            classifiedLoss: 0,
            adjustmentUnclassified: 24,
            correctionUnclassified: 0,
            countOut: 0,
            stockInReversal: 0,
          },
        },
      },
    ]);
    const report = await getReorderReport({ includeOkay: true });
    const row = asSuggested(report.rows[0]);
    expect(row.demandUnits).toBe(30);
    expect(row.demandMix).toEqual({
      sale: 6,
      classifiedLoss: 0,
      adjustmentUnclassified: 24,
      correctionUnclassified: 0,
      countOut: 0,
      stockInReversal: 0,
    });
    expect(Object.values(row.demandMix!).reduce((a, b) => a + b, 0)).toBe(row.demandUnits);
  });
});
