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
// The second binding is the SAME function under the name the skipped C5xC11 family
// re-types locally (Task 2.5 widens the real signature and deletes the alias).
import { getReorderReport, getReorderReport as getReorderReportW1 } from "@/lib/reports/reorder";
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

/** Extra visibility fixtures the C5xC11 family needs: approved-but-ARCHIVED products
 *  exist for the batch resolver's identity lookup but are never a sizeable population. */
interface SeedOpts {
  archived?: Array<{ id: number; name: string }>;
}

function seed(products: SeedProduct[], opts: SeedOpts = {}) {
  mockGetGlobals.mockResolvedValue(GLOBALS);
  const population = products.map((p) => ({
    id: p.id,
    name: p.name,
    costPrice: p.costPrice,
    product_locations: [{ quantity: p.stock }],
    reorderConfig: null,
  }));
  // ONE delegate serves two DIFFERENT reads: the reorder population (selects
  // product_locations) and the batch resolver's identity lookup (selects deletedAt).
  // Dispatch on the select shape so neither can be answered with the other's rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.product.findMany.mockImplementation((args: any) => {
    const scopedIds: number[] | undefined = args?.where?.id?.in;
    if (args?.select?.product_locations) {
      // The POPULATION read. Task 2.5 narrows it with `id: { in: activeRequestedIds }`,
      // so the mock must honor that filter or a productIds call would silently size the
      // whole catalog (and the test would pass for the wrong reason).
      return Promise.resolve(
        scopedIds ? population.filter((p) => scopedIds.includes(p.id)) : population,
      ) as never;
    }
    const ids: number[] = scopedIds ?? [];
    const identities = [
      ...products.map((p) => ({ id: p.id, name: p.name, deletedAt: null })),
      ...(opts.archived ?? []).map((a) => ({ ...a, deletedAt: new Date("2026-01-01T00:00:00.000Z") })),
    ].filter((r) => ids.length === 0 || ids.includes(r.id));
    return Promise.resolve(identities) as never;
  });
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

// ---------------------------------------------------------------------------
// C5 x C11 — the W2 accounting family (plan REV-5 W2 ENTRY GATE). Appended here by
// Task 2.1 as executable, skipped fixtures; Task 2.5's Step 1 is "unskip, run,
// VERIFY RED", then implement. It lives in THIS domain file (one file per domain;
// the C12/C6/C9 families live in the charter file outbound-mix.test.ts).
//
// NORMATIVE (spec C11 / OC-15): coverage.total/suggested/unavailable/healthy/
// approachingOmitted count the approved-ACTIVE population ONLY (with productIds: the
// resolved-active subset). `not_active` / `unknown_id` rows are counted ONLY in
// coverage.requested and NEVER in coverage.unavailable — the C5 invariant must hold in
// EVERY combination of includeOkay x includeHealthy x productIds.
// ---------------------------------------------------------------------------

describe("C5 x C11 accounting — includeOkay x includeHealthy x productIds (Task 2.5)", () => {
  const CTX = testCtx();

  // The Task 2.5 signature, declared LOCALLY so this family is executable and
  // type-clean BEFORE 2.5 widens the real one. 2.5 deletes this alias and calls
  // getReorderReport directly (tsc is the proof the shapes converged).
  type W2Opts = {
    includeOkay?: boolean;
    includeHealthy?: boolean;
    productIds?: number[];
    limit?: number;
    offset?: number;
  };
  type W2Report = {
    rows: Array<Record<string, unknown> & { status: string; productId: number }>;
    coverage: {
      total: number;
      suggested: number;
      unavailable: number;
      healthy: number;
      approachingOmitted: number;
      costed: number;
      requested?: { requested: number; notActive: number; unknownIds: number };
    };
  };
  const getReorderReport = getReorderReportW1 as unknown as (o: W2Opts) => Promise<W2Report>;

  const invariantHolds = (c: {
    total: number;
    suggested: number;
    unavailable: number;
    healthy: number;
    approachingOmitted: number;
  }) => expect(c.suggested + c.unavailable + c.healthy + c.approachingOmitted).toBe(c.total);

  it("includeHealthy emits the healthy product as an OK row — and it counts under `suggested`", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true, includeHealthy: true });
    const healthyRow = report.rows.find((r) => r.productId === 3);
    expect(healthyRow).toBeDefined();
    expect(healthyRow!.status).toBe("suggested");
    expect((healthyRow as { urgency?: string }).urgency).toBe("OK");
    // A real, possibly-0 need under CONFIGURED assumptions only.
    expect(typeof (healthyRow as { grossReplenishmentNeed?: number }).grossReplenishmentNeed).toBe("number");
    expect(report.coverage).toEqual({
      total: 5,
      suggested: 3, // OUT + APPROACHING + the emitted healthy OK row
      unavailable: 2,
      healthy: 0, // emitted, so no longer a NOT-emitted healthy count
      approachingOmitted: 0,
      costed: 2, // the OUT row and the healthy row both carry a costPrice
    });
    invariantHolds(report.coverage);
  });

  it("includeOkay=false x includeHealthy=true: APPROACHING still omitted, healthy still emitted", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: false, includeHealthy: true });
    expect(report.coverage.approachingOmitted).toBe(1);
    expect(report.coverage.healthy).toBe(0);
    expect(report.coverage.suggested).toBe(2); // OUT + healthy OK
    invariantHolds(report.coverage);
  });

  it("productIds narrows the POPULATION to the resolved-active subset (total shrinks with it)", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true, productIds: [1, 3] });
    expect(report.coverage.total).toBe(2);
    // force-emit: BOTH requested products are rows, healthy included as an OK row.
    expect(report.rows.map((r) => r.productId).sort()).toEqual([1, 3]);
    expect(report.coverage.requested).toEqual({ requested: 2, notActive: 0, unknownIds: 0 });
    invariantHolds(report.coverage);
  });

  it("an ARCHIVED-approved id is unavailable/not_active with its REAL name — never sized", async () => {
    seed(POPULATION, { archived: [{ id: 9, name: "Archived Product" }] });
    const report = await getReorderReport({ includeOkay: true, productIds: [1, 9] });
    const row = report.rows.find((r) => r.productId === 9)!;
    expect(row).toEqual({
      status: "unavailable",
      productId: 9,
      productName: "Archived Product",
      currentStock: null,
      reason: "not_active",
    });
    // OUTSIDE the invariant: counted in `requested`, never in `unavailable`.
    expect(report.coverage.unavailable).toBe(0);
    expect(report.coverage.requested).toEqual({ requested: 2, notActive: 1, unknownIds: 0 });
    expect(report.coverage.total).toBe(1); // only the resolved-ACTIVE product
    invariantHolds(report.coverage);
  });

  it("an UNKNOWN (absent or unapproved) id carries NO fabricated fields — name null", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true, productIds: [1, 424242] });
    const row = report.rows.find((r) => r.productId === 424242)!;
    expect(row).toEqual({
      status: "unavailable",
      productId: 424242,
      productName: null,
      currentStock: null,
      reason: "unknown_id",
    });
    expect(report.coverage.unavailable).toBe(0);
    expect(report.coverage.requested).toEqual({ requested: 2, notActive: 0, unknownIds: 1 });
    invariantHolds(report.coverage);
  });

  it("the OK urgency ranks BELOW APPROACHING so OK rows sort last deterministically", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true, includeHealthy: true });
    const suggested = report.rows.filter((r) => r.status === "suggested") as unknown as Array<{
      urgency: string;
    }>;
    expect(suggested[suggested.length - 1].urgency).toBe("OK");
  });

  it("the TOOL envelope relays coverage.requested beside the invariant buckets", async () => {
    seed(POPULATION);
    const result = await assistantTools.reorder_report.run({ productIds: [1, 424242] }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as { coverage: W2Report["coverage"] };
    expect(data.coverage.requested).toEqual({ requested: 2, notActive: 0, unknownIds: 1 });
    invariantHolds(data.coverage);
  });

  it("an EMPTY productIds array is rejected with a hint (G1 assert)", async () => {
    seed(POPULATION);
    await expect(assistantTools.reorder_report.run({ productIds: [] }, CTX)).rejects.toBeDefined();
  });

  it("duplicate requested ids are DEDUPED (a repeated id never double-counts)", async () => {
    seed(POPULATION);
    const report = await getReorderReport({ includeOkay: true, productIds: [1, 1, 3] });
    expect(report.coverage.total).toBe(2);
    expect(report.coverage.requested!.requested).toBe(2);
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
