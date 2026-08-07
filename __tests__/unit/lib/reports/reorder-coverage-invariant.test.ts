/**
 * @jest-environment node
 *
 * REORDER COVERAGE INVARIANT (spec C5, review F3) — the accounting gate for
 * `lib/reports/reorder.ts`.
 *
 * The failure this closes: the report counted only what it EMITTED, so a healthy
 * product (final urgency null) and an APPROACHING product dropped by includeOkay=false
 * both vanished from the accounting. A reader could not tell "we checked 40 products
 * and 35 are fine" from "we only looked at 5".
 *
 * NORMATIVE invariant over the approved-ACTIVE population:
 *     total = suggested + unavailable + healthy + approachingOmitted
 *
 * CATEGORY DEFINITIONS ARE BINDING (contract pack T5/CP-4 — a partition-sum assertion
 * alone stays green under misclassification, so EVERY bucket is asserted per fixture,
 * never only the total):
 *   - suggested          = emitted suggested rows
 *   - unavailable        = emitted no_demand_signal / insufficient_history rows
 *   - healthy            = FINAL urgency null (classifyUrgency returned null) AND not emitted
 *   - approachingOmitted = APPROACHING dropped by includeOkay=false
 *
 * Harness copied from `reorder.test.ts`: prisma deep-mocked, demand injected directly,
 * the real (pure) reorder-config resolver with only the globals read stubbed.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

// Inject demand directly so the accounting is tested in isolation from the ledger read.
jest.mock("@/lib/reports/demand", () => ({
  __esModule: true,
  reorderDemand: jest.fn(),
  outboundVelocity: jest.fn(),
}));

// Real resolver (pure); only the globals read is stubbed.
jest.mock("@/lib/reorder-config", () => {
  const actual = jest.requireActual("@/lib/reorder-config");
  return { __esModule: true, ...actual, getGlobalReorderSettings: jest.fn() };
});

// tools.ts pulls these in at import time; they must never reach a real prisma. The
// reorder module itself is NOT mocked — the tool assertion drives the REAL report.
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import prisma from "@/lib/prisma";
import { reorderDemand } from "@/lib/reports/demand";
import { getGlobalReorderSettings } from "@/lib/reorder-config";
import { getReorderReport } from "@/lib/reports/reorder";
import { assistantTools, testCtx } from "@/lib/assistant/tools";

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
  demand?: { avgDailyDemand: number | null; outboundEvents: number; daysCovered: number };
}

function seed(products: SeedProduct[]) {
  mockGetGlobals.mockResolvedValue(GLOBALS);
  db.product.findMany.mockResolvedValue(
    products.map((p) => ({
      id: p.id,
      name: p.name,
      costPrice: p.costPrice,
      product_locations: [{ quantity: p.stock }],
      reorderConfig: null,
    })) as never,
  );
  const map = new Map<number, { avgDailyDemand: number | null; outboundEvents: number; daysCovered: number }>();
  for (const p of products) {
    map.set(p.id, p.demand ?? { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0 });
  }
  mockReorderDemand.mockResolvedValue(map);
}

/**
 * The four-way population. With the GLOBALS above (lead 14, buffer 7, multiple 2,
 * minEvidence 3) and avgDaily 1: leadTimeDemand = 14, reorderPoint = ceil(14+7) = 21,
 * so APPROACHING is 21 < stock <= 25.2 and healthy (urgency null) is stock > 25.2.
 */
const POPULATION: SeedProduct[] = [
  // OUT — stock 0 always classifies OUT; costed (costPrice present).
  { id: 1, name: "A Out", costPrice: 5, stock: 0, demand: { avgDailyDemand: 2, outboundEvents: 10, daysCovered: 30 } },
  // APPROACHING — emitted only when includeOkay; UNCOSTED so `costed` moves with it.
  { id: 2, name: "B Approaching", costPrice: null, stock: 24, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } },
  // healthy — final urgency null, never a row in W1.
  { id: 3, name: "C Healthy", costPrice: 5, stock: 40, demand: { avgDailyDemand: 1, outboundEvents: 10, daysCovered: 30 } },
  // unavailable / no_demand_signal.
  { id: 4, name: "D NoDemand", costPrice: 5, stock: 12, demand: { avgDailyDemand: null, outboundEvents: 0, daysCovered: 0 } },
  // unavailable / insufficient_history (1 event < minEvidenceEvents 3).
  { id: 5, name: "E ThinHistory", costPrice: 5, stock: 12, demand: { avgDailyDemand: 1, outboundEvents: 1, daysCovered: 5 } },
];

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
});

describe("coverage accounting — EVERY bucket, both includeOkay branches (spec C5)", () => {
  it("includeOkay=true: APPROACHING is emitted, so approachingOmitted is 0", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true });

    // Every bucket asserted individually (CP-4) — not just the sum.
    expect(report.coverage).toEqual({
      total: 5,
      suggested: 2, // OUT + APPROACHING
      unavailable: 2, // no_demand_signal + insufficient_history
      healthy: 1, // final urgency null, not emitted
      approachingOmitted: 0,
      costed: 1, // only the OUT row carries a costPrice
    });
    expect(
      report.coverage.suggested +
        report.coverage.unavailable +
        report.coverage.healthy +
        report.coverage.approachingOmitted,
    ).toBe(report.coverage.total);
  });

  it("includeOkay=false: the dropped APPROACHING moves to approachingOmitted, never to healthy", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: false });

    expect(report.coverage).toEqual({
      total: 5,
      suggested: 1, // OUT only
      unavailable: 2,
      healthy: 1, // unchanged — includeOkay does not reclassify a healthy product
      approachingOmitted: 1,
      costed: 1,
    });
    expect(
      report.coverage.suggested +
        report.coverage.unavailable +
        report.coverage.healthy +
        report.coverage.approachingOmitted,
    ).toBe(report.coverage.total);
  });

  it("the buckets match the rows ACTUALLY emitted (counts are not a parallel fiction)", async () => {
    seed(POPULATION);
    for (const includeOkay of [true, false]) {
      const report = await getReorderReport({ includeOkay });
      const emittedSuggested = report.rows.filter((r) => r.status === "suggested").length;
      const emittedUnavailable = report.rows.filter((r) => r.status === "unavailable").length;
      expect(report.coverage.suggested).toBe(emittedSuggested);
      expect(report.coverage.unavailable).toBe(emittedUnavailable);
      // healthy + approachingOmitted are precisely the products NOT emitted.
      expect(report.coverage.healthy + report.coverage.approachingOmitted).toBe(
        report.coverage.total - report.rows.length,
      );
    }
  });

  it("holds for an all-healthy population (nothing emitted, nothing lost)", async () => {
    seed([POPULATION[2]]);
    const report = await getReorderReport({ includeOkay: true });
    expect(report.rows).toHaveLength(0);
    expect(report.coverage).toEqual({
      total: 1,
      suggested: 0,
      unavailable: 0,
      healthy: 1,
      approachingOmitted: 0,
      costed: 0,
    });
  });

  it("holds for an EMPTY approved population", async () => {
    seed([]);
    const report = await getReorderReport({ includeOkay: true });
    expect(report.coverage).toEqual({
      total: 0,
      suggested: 0,
      unavailable: 0,
      healthy: 0,
      approachingOmitted: 0,
      costed: 0,
    });
  });
});

describe("coverageNote — healthy is DEFINED by final urgency null (spec C5)", () => {
  it("states the definition and the conditional row rule", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true });
    const note = report.coverageNote;

    expect(note).toContain("healthy = final urgency null");
    expect(note).toContain("classifyUrgency returned null");
    // NORMATIVE: never phrased as a stock-vs-reorderPoint band (that overlaps
    // APPROACHING's reorderPoint < stock <= 1.2x band).
    expect(note).toContain("1.2");
    // Conditional, not unconditional: C11 makes a healthy row requestable.
    expect(note).toMatch(/a row ONLY when explicitly requested \(productIds\) or includeHealthy is set/);
  });
});

describe("the TOOL envelope surfaces the coverage additions (G2-7)", () => {
  // reorder_report projects the report by hand — new report fields are invisible to the
  // assistant/MCP surface until that projection carries them.
  const CTX = testCtx();

  it("reorder_report relays coverage (all six buckets) + coverageNote", async () => {
    seed(POPULATION);
    const result = await assistantTools.reorder_report.run({}, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as { coverage: Record<string, number>; coverageNote: string };

    // The tool defaults includeOkay to TRUE (the report module defaults to false).
    expect(data.coverage).toEqual({
      total: 5,
      suggested: 2,
      unavailable: 2,
      healthy: 1,
      approachingOmitted: 0,
      costed: 1,
    });
    expect(data.coverageNote).toContain("healthy = final urgency null");
  });

  it("reorder_report with includeOkay:false relays the approachingOmitted count", async () => {
    seed(POPULATION);
    const result = await assistantTools.reorder_report.run({ includeOkay: false }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as { coverage: Record<string, number> };
    expect(data.coverage.approachingOmitted).toBe(1);
    expect(data.coverage.healthy).toBe(1);
    expect(data.coverage.suggested).toBe(1);
  });
});
