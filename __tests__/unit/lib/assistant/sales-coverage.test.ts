/**
 * @jest-environment node
 *
 * lib/assistant/sales-coverage.ts — the CALLER-SCOPED sales coverage block (spec C7,
 * review F4). Every existing consumer MOCKS this function, so this is its first direct
 * suite.
 *
 * The failure this closes: `unattributedOrders: 319` shipped with no denominator, so a
 * reader could not tell whether that was 319 of 400 orders or 319 of 40,000. C7 adds
 * `totalOrders` (the same company-scoped population, no `isMapped` predicate) plus an
 * `attributionNote` that says out loud what the two counts are — ALL-TIME and
 * company-scoped — because they sit beside WINDOWED sales figures and must never be
 * read as windowed.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import prisma from "@/lib/prisma";
import {
  callerScopedSalesCoverage,
  BUNDLE_REVENUE_DISCLOSURE,
  SALES_ATTRIBUTION_NOTE,
} from "@/lib/assistant/sales-coverage";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

beforeEach(() => mockReset(db));

function seed(opts: { unattributed: number; total: number; lastRunAt?: Date | null }) {
  // The two counts share ONE delegate — the first call is the unattributed count, the
  // second the denominator (both issued inside the existing Promise.all).
  db.externalOrder.count
    .mockResolvedValueOnce(opts.unattributed as never)
    .mockResolvedValueOnce(opts.total as never);
  db.analyticsRebuildState.findUnique.mockResolvedValue(
    (opts.lastRunAt === undefined ? null : { lastRunAt: opts.lastRunAt }) as never,
  );
}

describe("totalOrders — the missing denominator (spec C7)", () => {
  it("returns the company-scoped total beside the unattributed count", async () => {
    seed({ unattributed: 319, total: 2331 });
    const coverage = await callerScopedSalesCoverage(["c1", "c2"]);
    expect(coverage.unattributedOrders).toBe(319);
    expect(coverage.totalOrders).toBe(2331);
  });

  it("counts the SAME company-scoped population, ALL-TIME (no window, no isMapped filter)", async () => {
    seed({ unattributed: 1, total: 9 });
    await callerScopedSalesCoverage(["c1"]);

    expect(db.externalOrder.count).toHaveBeenCalledTimes(2);
    const [unattributedArgs, totalArgs] = db.externalOrder.count.mock.calls.map((c) => c[0]);

    // Numerator: same companies, PLUS the unmapped-line-item predicate.
    expect(unattributedArgs).toEqual({
      where: { companyId: { in: ["c1"] }, items: { some: { isMapped: false } } },
    });
    // Denominator: same companies, NOTHING else — no items predicate, and (critically)
    // no createdAt/dayKey window. A windowed denominator beside an all-time numerator
    // would produce a ratio that means nothing.
    expect(totalArgs).toEqual({ where: { companyId: { in: ["c1"] } } });
  });

  it("issues both counts in the SAME round (siblings, not a second sequential await)", async () => {
    seed({ unattributed: 1, total: 9 });
    await callerScopedSalesCoverage(["c1"]);
    // 2 order counts + 1 rebuild-state read; nothing else was added to the read graph.
    expect(db.externalOrder.count).toHaveBeenCalledTimes(2);
    expect(db.analyticsRebuildState.findUnique).toHaveBeenCalledTimes(1);
  });

  it("empty membership short-circuits to 0/0 WITHOUT querying", async () => {
    const coverage = await callerScopedSalesCoverage([]);
    expect(coverage.unattributedOrders).toBe(0);
    expect(coverage.totalOrders).toBe(0);
    expect(coverage.lastRebuildAt).toBeNull();
    expect(db.externalOrder.count).not.toHaveBeenCalled();
  });

  it("a null count degrades to 0, never to undefined", async () => {
    db.externalOrder.count
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never);
    db.analyticsRebuildState.findUnique.mockResolvedValue(null as never);
    const coverage = await callerScopedSalesCoverage(["c1"]);
    expect(coverage.unattributedOrders).toBe(0);
    expect(coverage.totalOrders).toBe(0);
  });
});

describe("attributionNote — the counts must not read as windowed (spec C7)", () => {
  it("names both fields, the all-time span, and the company scope", async () => {
    seed({ unattributed: 319, total: 2331 });
    const coverage = await callerScopedSalesCoverage(["c1"]);

    expect(coverage.attributionNote).toBe(SALES_ATTRIBUTION_NOTE);
    expect(coverage.attributionNote).toContain(
      "unattributedOrders of totalOrders company-scoped orders (all time) contain at least one unmapped line item",
    );
    expect(coverage.attributionNote).toMatch(/ALL-TIME/i);
  });

  it("rides along on the empty-membership short circuit too", async () => {
    const coverage = await callerScopedSalesCoverage([]);
    expect(typeof coverage.attributionNote).toBe("string");
    expect(coverage.attributionNote).toBe(SALES_ATTRIBUTION_NOTE);
  });
});

describe("the coverage block stays ADDITIVE (contract pack T5/S18)", () => {
  it("keeps every pre-existing field beside the new ones", async () => {
    seed({ unattributed: 2, total: 20, lastRunAt: new Date("2026-07-01T12:00:00.000Z") });
    const coverage = await callerScopedSalesCoverage(["c1"]);
    expect(coverage).toEqual({
      unattributedOrders: 2,
      totalOrders: 20,
      attributionNote: SALES_ATTRIBUTION_NOTE,
      bundleRevenue: BUNDLE_REVENUE_DISCLOSURE,
      lastRebuildAt: "2026-07-01T12:00:00.000Z",
    });
  });
});
