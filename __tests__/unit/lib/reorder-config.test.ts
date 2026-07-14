/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 1: the config resolver (lib/reorder-config.ts).
 *
 * Pins the inheritance model ADOPTED from the orphaned product_reorder_configs /
 * global_reorder_settings tables:
 *  - product override wins; NULL inherits the global default.
 *  - lead time is ALWAYS positive: 0/negative/absurd coerce to the default WITH
 *    leadTimeSource:"default" (codex #11 — distinct from threshold's 0=disabled).
 *  - bufferDays 0 is VALID (no buffer) and does NOT coerce.
 *  - MOQ floors at 1; targetCoverageMultiple floors at 1.
 *  - getGlobalReorderSettings seeds the singleton (id=1) when the row is missing.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import type { GlobalReorderSettings } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  resolveReorderConfig,
  getGlobalReorderSettings,
} from "@/lib/reorder-config";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

// A fully-populated globals row (matches the seeded singleton defaults).
const GLOBALS = {
  id: 1,
  defaultLeadTimeDays: 14,
  defaultSafetyStockDays: 7,
  defaultTargetCoverageMultiple: 2,
  minEvidenceEvents: 3,
  holdingCostRate: "0.2500",
  updatedBy: null,
  updatedAt: new Date("2026-07-14T00:00:00Z"),
} as unknown as GlobalReorderSettings;

beforeEach(() => {
  mockReset(db);
});

describe("resolveReorderConfig — inheritance", () => {
  it("uses the product override when present", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 21, customSafetyStockDays: 3, minOrderQuantity: 12, reorderPointOverride: 99 },
      GLOBALS,
    );
    expect(eff.leadTimeDays).toBe(21);
    expect(eff.leadTimeSource).toBe("product");
    expect(eff.bufferDays).toBe(3);
    expect(eff.bufferSource).toBe("product");
    expect(eff.minOrderQuantity).toBe(12);
    expect(eff.reorderPointOverride).toBe(99);
    expect(eff.targetCoverageMultiple).toBe(2);
    expect(eff.minEvidenceEvents).toBe(3);
  });

  it("inherits the global defaults when the product config is null", () => {
    const eff = resolveReorderConfig(null, GLOBALS);
    expect(eff.leadTimeDays).toBe(14);
    expect(eff.leadTimeSource).toBe("default");
    expect(eff.bufferDays).toBe(7);
    expect(eff.bufferSource).toBe("default");
    expect(eff.minOrderQuantity).toBe(1);
    expect(eff.reorderPointOverride).toBeNull();
  });

  it("inherits per-field when a product field is NULL", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: null, customSafetyStockDays: null, minOrderQuantity: null, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.leadTimeDays).toBe(14);
    expect(eff.leadTimeSource).toBe("default");
    expect(eff.bufferDays).toBe(7);
    expect(eff.bufferSource).toBe("default");
  });
});

describe("resolveReorderConfig — lead time is ALWAYS positive (codex #11)", () => {
  it("coerces a 0 lead time to the default with leadTimeSource:default", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 0, customSafetyStockDays: null, minOrderQuantity: null, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.leadTimeDays).toBe(14);
    expect(eff.leadTimeSource).toBe("default");
  });

  it("coerces a negative lead time to the default", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: -5, customSafetyStockDays: null, minOrderQuantity: null, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.leadTimeDays).toBe(14);
    expect(eff.leadTimeSource).toBe("default");
  });

  it("coerces an absurd lead time to the default", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 100000, customSafetyStockDays: null, minOrderQuantity: null, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.leadTimeDays).toBe(14);
    expect(eff.leadTimeSource).toBe("default");
  });

  it("falls back to the hard default when even the global default is non-positive", () => {
    const eff = resolveReorderConfig(null, { ...GLOBALS, defaultLeadTimeDays: 0 });
    expect(eff.leadTimeDays).toBe(14); // DEFAULT_LEAD_TIME_DAYS
    expect(eff.leadTimeSource).toBe("default");
  });
});

describe("resolveReorderConfig — bufferDays 0 is valid; MOQ + multiple floor", () => {
  it("keeps an explicit bufferDays of 0 (no buffer) and does NOT coerce", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 10, customSafetyStockDays: 0, minOrderQuantity: 1, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.bufferDays).toBe(0);
    expect(eff.bufferSource).toBe("product");
  });

  it("coerces a negative bufferDays to the default", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 10, customSafetyStockDays: -3, minOrderQuantity: 1, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.bufferDays).toBe(7);
    expect(eff.bufferSource).toBe("default");
  });

  it("floors minOrderQuantity at 1", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 10, customSafetyStockDays: 2, minOrderQuantity: 0, reorderPointOverride: null },
      GLOBALS,
    );
    expect(eff.minOrderQuantity).toBe(1);
  });

  it("floors targetCoverageMultiple at 1 when the global is misconfigured", () => {
    const eff = resolveReorderConfig(null, { ...GLOBALS, defaultTargetCoverageMultiple: 0 });
    expect(eff.targetCoverageMultiple).toBe(1);
  });

  it("drops a negative reorderPointOverride to null", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 10, customSafetyStockDays: 2, minOrderQuantity: 1, reorderPointOverride: -4 },
      GLOBALS,
    );
    expect(eff.reorderPointOverride).toBeNull();
  });

  it("keeps an explicit reorderPointOverride of 0 (pin to zero)", () => {
    const eff = resolveReorderConfig(
      { leadTimeDays: 10, customSafetyStockDays: 2, minOrderQuantity: 1, reorderPointOverride: 0 },
      GLOBALS,
    );
    expect(eff.reorderPointOverride).toBe(0);
  });
});

describe("getGlobalReorderSettings — singleton seeding", () => {
  it("returns the existing singleton row", async () => {
    db.globalReorderSettings.upsert.mockResolvedValue(GLOBALS);
    const g = await getGlobalReorderSettings();
    expect(g.id).toBe(1);
    const arg = db.globalReorderSettings.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 1 });
    expect(arg.create).toEqual({ id: 1 });
  });
});
