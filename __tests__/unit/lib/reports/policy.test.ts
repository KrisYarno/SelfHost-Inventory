/**
 * @jest-environment node
 *
 * lib/reports/policy.ts — inventory-policy reader (assistant toolsuite breadth,
 * spec §5 T-POL / plan Task W1-POL).
 *
 * THE test (raw-based source, never equality-inference): an override that happens to
 * equal the system default must still read "product_override"; a raw-null field must
 * read "system_default" even though its effective value matches the default. Every
 * PolicyField in this suite is checked against that rule, not just lowStockThreshold.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient, GlobalReorderSettings } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import prisma from "@/lib/prisma";
import { getPolicy } from "@/lib/reports/policy";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const GLOBALS: GlobalReorderSettings = {
  id: 1,
  defaultLeadTimeDays: 14,
  defaultSafetyStockDays: 7,
  defaultTargetCoverageMultiple: 2,
  minEvidenceEvents: 3,
  holdingCostRate: "0.2500" as unknown as GlobalReorderSettings["holdingCostRate"],
  updatedBy: null,
  updatedAt: new Date("2026-07-14T00:00:00Z"),
};

const LOW_STOCK_DEFAULT = 10;

function mockLowStockDefault(value: number) {
  db.systemSetting.findUnique.mockResolvedValue({
    id: 1,
    key: "lowStockDefaultThreshold",
    value: String(value),
  } as never);
}

function mockGlobals(g: GlobalReorderSettings = GLOBALS) {
  db.globalReorderSettings.findUnique.mockResolvedValue(g);
}

beforeEach(() => {
  mockReset(db);
  mockLowStockDefault(LOW_STOCK_DEFAULT);
  mockGlobals();
});

describe("getPolicy — global-only call (no productId)", () => {
  it("returns global defaults with product undefined, issuing no product queries", async () => {
    const result = await getPolicy({});

    expect(result.product).toBeUndefined();
    expect(result.global.lowStockDefault).toBe(LOW_STOCK_DEFAULT);
    expect(result.global.reorder).toBe(GLOBALS);
    expect(result.global.minEvidenceEvents).toBe(3);
    expect(db.product.findFirst).not.toHaveBeenCalled();
    expect(db.product.findUnique).not.toHaveBeenCalled();
  });

  it("reflects a corrupt-but-clamped minEvidenceEvents via resolveReorderConfig (no re-derivation)", async () => {
    mockGlobals({ ...GLOBALS, minEvidenceEvents: -1 });
    const result = await getPolicy({});
    // resolveReorderConfig's own fallback (>=0 else 3) — reused, not duplicated.
    expect(result.global.minEvidenceEvents).toBe(3);
    // The raw row is still carried through verbatim (uncorrected) in `.reorder`.
    expect(result.global.reorder.minEvidenceEvents).toBe(-1);
  });
});

describe("getPolicy — unknown / pending / deleted product", () => {
  it("resolves to global-only when resolveAssistantProduct finds nothing", async () => {
    db.product.findFirst.mockResolvedValue(null);

    const result = await getPolicy({ productId: 999 });

    expect(result.product).toBeUndefined();
    expect(result.global.lowStockDefault).toBe(LOW_STOCK_DEFAULT);
    const arg = db.product.findFirst.mock.calls[0][0];
    expect(arg?.where).toEqual({ id: 999, deletedAt: null, approvalStatus: "APPROVED" });
    expect(db.product.findUnique).not.toHaveBeenCalled();
  });
});

describe("getPolicy — lowStockThreshold source (raw-based, THE test)", () => {
  it("an override EQUAL to the system default still reads product_override", async () => {
    db.product.findFirst.mockResolvedValue({ id: 1, name: "Widget" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 1,
      name: "Widget",
      lowStockThreshold: LOW_STOCK_DEFAULT, // == the global default (10)
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 1 });

    expect(result.product?.lowStockThreshold).toEqual({
      effective: LOW_STOCK_DEFAULT,
      raw: LOW_STOCK_DEFAULT,
      source: "product_override",
    });
  });

  it("raw-null reads system_default with effective = default", async () => {
    db.product.findFirst.mockResolvedValue({ id: 2, name: "Gadget" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 2,
      name: "Gadget",
      lowStockThreshold: null,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 2 });

    expect(result.product?.lowStockThreshold).toEqual({
      effective: LOW_STOCK_DEFAULT,
      raw: null,
      source: "system_default",
    });
  });

  it("an explicit 0 (disabled) is still product_override, not system_default", async () => {
    db.product.findFirst.mockResolvedValue({ id: 3, name: "Zero" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 3,
      name: "Zero",
      lowStockThreshold: 0,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 3 });

    expect(result.product?.lowStockThreshold).toEqual({
      effective: 0,
      raw: 0,
      source: "product_override",
    });
  });
});

describe("getPolicy — reorder fields (leadTimeDays / safetyStockDays): raw-based, not clamp-based", () => {
  it("an invalid raw override (still non-null) reads product_override even though the effective value falls back to default", async () => {
    db.product.findFirst.mockResolvedValue({ id: 4, name: "Bad Lead" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 4,
      name: "Bad Lead",
      lowStockThreshold: null,
      reorderConfig: {
        leadTimeDays: -5, // invalid -> resolveReorderConfig coerces effective to default
        customSafetyStockDays: -3, // invalid -> coerces to default
        minOrderQuantity: 1,
        reorderPointOverride: null,
      },
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 4 });

    expect(result.product?.leadTimeDays).toEqual({
      effective: 14, // coerced to global default
      raw: -5,
      source: "product_override", // raw is non-null -> still product_override
    });
    expect(result.product?.safetyStockDays).toEqual({
      effective: 7, // coerced to global default
      raw: -3,
      source: "product_override",
    });
  });

  it("null raw reorder fields read system_default with the resolved default effective values", async () => {
    db.product.findFirst.mockResolvedValue({ id: 5, name: "Inherits" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 5,
      name: "Inherits",
      lowStockThreshold: null,
      reorderConfig: {
        leadTimeDays: null,
        customSafetyStockDays: null,
        minOrderQuantity: 1,
        reorderPointOverride: null,
      },
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 5 });

    expect(result.product?.leadTimeDays).toEqual({ effective: 14, raw: null, source: "system_default" });
    expect(result.product?.safetyStockDays).toEqual({ effective: 7, raw: null, source: "system_default" });
  });
});

describe("getPolicy — minOrderQuantity (schema finding: column is non-nullable)", () => {
  it("no product_reorder_configs row at all: raw null, system_default, effective floors to 1", async () => {
    db.product.findFirst.mockResolvedValue({ id: 6, name: "No Config Row" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 6,
      name: "No Config Row",
      lowStockThreshold: null,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 6 });

    expect(result.product?.minOrderQuantity).toEqual({
      effective: 1,
      raw: null,
      source: "system_default",
    });
  });

  it("a config row exists holding the untouched DB default (1): still reads product_override (row-presence, not value-based)", async () => {
    db.product.findFirst.mockResolvedValue({ id: 7, name: "Row Exists" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 7,
      name: "Row Exists",
      lowStockThreshold: null,
      reorderConfig: {
        leadTimeDays: 21, // some OTHER field is why the row exists
        customSafetyStockDays: null,
        minOrderQuantity: 1, // the untouched DB default value
        reorderPointOverride: null,
      },
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 7 });

    expect(result.product?.minOrderQuantity).toEqual({
      effective: 1,
      raw: 1,
      source: "product_override", // the column can't be NULL once the row exists
    });
  });

  it("a config row with an explicit non-default minOrderQuantity: product_override, effective passthrough", async () => {
    db.product.findFirst.mockResolvedValue({ id: 8, name: "Real Override" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 8,
      name: "Real Override",
      lowStockThreshold: null,
      reorderConfig: {
        leadTimeDays: null,
        customSafetyStockDays: null,
        minOrderQuantity: 25,
        reorderPointOverride: null,
      },
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 8 });

    expect(result.product?.minOrderQuantity).toEqual({
      effective: 25,
      raw: 25,
      source: "product_override",
    });
  });
});

describe("getPolicy — reorderPointOverride (plain nullable field, not a PolicyField)", () => {
  it("passes resolveReorderConfig's validated value through (null when unset)", async () => {
    db.product.findFirst.mockResolvedValue({ id: 9, name: "No Pin" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 9,
      name: "No Pin",
      lowStockThreshold: null,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 9 });
    expect(result.product?.reorderPointOverride).toBeNull();
  });

  it("surfaces a valid pinned reorder point", async () => {
    db.product.findFirst.mockResolvedValue({ id: 10, name: "Pinned" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 10,
      name: "Pinned",
      lowStockThreshold: null,
      reorderConfig: {
        leadTimeDays: null,
        customSafetyStockDays: null,
        minOrderQuantity: 1,
        reorderPointOverride: 42,
      },
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 10 });
    expect(result.product?.reorderPointOverride).toBe(42);
  });

  it("drops an invalid (negative) stored override to null, reusing resolveReorderConfig's validation", async () => {
    db.product.findFirst.mockResolvedValue({ id: 11, name: "Bad Pin" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 11,
      name: "Bad Pin",
      lowStockThreshold: null,
      reorderConfig: {
        leadTimeDays: null,
        customSafetyStockDays: null,
        minOrderQuantity: 1,
        reorderPointOverride: -4,
      },
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 11 });
    expect(result.product?.reorderPointOverride).toBeNull();
  });
});

describe("getPolicy — locationMinimums (product_locations.minQuantity)", () => {
  it("returns only minQuantity > 0 rows, sorted by locationId asc, via a gt:0 where clause", async () => {
    db.product.findFirst.mockResolvedValue({ id: 12, name: "Multi-location" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 12,
      name: "Multi-location",
      lowStockThreshold: null,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([
      { locationId: 1, minQuantity: 5 },
      { locationId: 3, minQuantity: 2 },
    ] as never);

    const result = await getPolicy({ productId: 12 });

    expect(result.product?.locationMinimums).toEqual([
      { locationId: 1, minQuantity: 5 },
      { locationId: 3, minQuantity: 2 },
    ]);
    const arg = db.product_locations.findMany.mock.calls[0][0];
    expect(arg?.where).toEqual({ productId: 12, minQuantity: { gt: 0 } });
    expect(arg?.orderBy).toEqual({ locationId: "asc" });
  });

  it("no locations with a set minimum: empty array, not omitted", async () => {
    db.product.findFirst.mockResolvedValue({ id: 13, name: "No Minimums" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 13,
      name: "No Minimums",
      lowStockThreshold: null,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 13 });
    expect(result.product?.locationMinimums).toEqual([]);
  });
});

describe("getPolicy — product identity + race guard", () => {
  it("carries productId and name through from the findUnique read", async () => {
    db.product.findFirst.mockResolvedValue({ id: 14, name: "Named Thing" } as never);
    db.product.findUnique.mockResolvedValue({
      id: 14,
      name: "Named Thing",
      lowStockThreshold: null,
      reorderConfig: null,
    } as never);
    db.product_locations.findMany.mockResolvedValue([]);

    const result = await getPolicy({ productId: 14 });
    expect(result.product?.productId).toBe(14);
    expect(result.product?.name).toBe("Named Thing");
  });

  it("falls back to global-only if the product vanishes between the two reads", async () => {
    db.product.findFirst.mockResolvedValue({ id: 15, name: "Ghost" } as never);
    db.product.findUnique.mockResolvedValue(null);

    const result = await getPolicy({ productId: 15 });
    expect(result.product).toBeUndefined();
    expect(result.global.lowStockDefault).toBe(LOW_STOCK_DEFAULT);
  });
});
