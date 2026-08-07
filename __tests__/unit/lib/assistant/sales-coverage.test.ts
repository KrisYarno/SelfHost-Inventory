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
  callerWindowCoverage,
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
      // Task 2.2 (C6) additive step in the S18 chain. Null here because this fixture
      // seeds no approved catalog — the field is present regardless, never omitted.
      salesDataStart: null,
    });
  });
});

describe("salesDataStart — the recording boundary, scoped from birth (spec C6 / G5)", () => {
  it("returns the caller-scoped _min(dayKey) over ProductSalesFact", async () => {
    seed({ unattributed: 0, total: 0 });
    db.product.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2024-03-01" } } as never);

    const coverage = await callerScopedSalesCoverage(["c1"]);
    expect(coverage.salesDataStart).toBe("2024-03-01");
  });

  it("carries the G5 APPROVED-id-set filter FROM BIRTH — an unapproved product's facts can never move it", async () => {
    seed({ unattributed: 0, total: 0 });
    // The approved universe is {1, 2}; product 3 is unapproved and must never be read.
    db.product.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2024-03-01" } } as never);

    await callerScopedSalesCoverage(["c1"]);

    // The id set comes from an approval-filtered read...
    const idSetArgs = db.product.findMany.mock.calls[0][0] as { where: Record<string, unknown>; select: unknown };
    expect(idSetArgs.where).toMatchObject({ approvalStatus: "APPROVED" });
    expect(idSetArgs.select).toEqual({ id: true });
    // ...ARCHIVED products are included (this is a HISTORICAL fact read — their past
    // sales really happened), so the filter must NOT carry deletedAt: null.
    expect(idSetArgs.where).not.toHaveProperty("deletedAt");
    // ...and the aggregate is narrowed by that set AND the caller's companies.
    const aggArgs = db.productSalesFact.aggregate.mock.calls[0][0] as {
      where: { companyId: unknown; productId: unknown };
      _min: unknown;
    };
    expect(aggArgs.where.productId).toEqual({ in: [1, 2] });
    expect(aggArgs.where.companyId).toEqual({ in: ["c1"] });
    expect(aggArgs._min).toEqual({ dayKey: true });
  });

  it("an EMPTY approved universe still filters (in: []) — never an unfiltered read", async () => {
    seed({ unattributed: 0, total: 0 });
    db.product.findMany.mockResolvedValue([] as never);
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: null } } as never);

    const coverage = await callerScopedSalesCoverage(["c1"]);
    expect(coverage.salesDataStart).toBeNull();
    const aggArgs = db.productSalesFact.aggregate.mock.calls[0][0] as { where: { productId: unknown } };
    expect(aggArgs.where.productId).toEqual({ in: [] });
  });

  it("is null on the empty-membership short circuit (no query at all)", async () => {
    const coverage = await callerScopedSalesCoverage([]);
    expect(coverage.salesDataStart).toBeNull();
    expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FD-2 — the per-company detection MATERIALIZES every requested company.
//
// The per-company read only returns companies that HAVE facts. A company with none was
// therefore absent from `companyCoverage` entirely, could not make the set "staggered",
// and so INHERITED the recording company's start: its window read as fully covered and
// every silence in it became a MEASURED zero — for a company that never recorded a thing.
// That is the strongest form of the manufactured zero the per-company rule exists to
// prevent, and it was the one case the rule did not see.
// ---------------------------------------------------------------------------

describe("FD-2 companyCoverage — a company with NO facts is a null start, not an absence", () => {
  /** Seed the per-company groupBy: only the companies listed have facts. */
  function seedStarts(
    groups: Array<{ companyId: string; _min: { dayKey: string | null } }>,
    callerWide: string | null,
  ) {
    seed({ unattributed: 0, total: 0 });
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: callerWide } } as never);
    db.productSalesFact.groupBy.mockResolvedValue(groups as never);
  }

  it("lists the silent company with salesDataStart null and DEGRADES the window", async () => {
    // c1 has recorded since 2020; c2 has no facts at all.
    seedStarts([{ companyId: "c1", _min: { dayKey: "2020-01-01" } }], "2020-01-01");

    const coverage = await callerScopedSalesCoverage(["c1", "c2"]);

    expect(coverage.salesDataStart).toBe("2020-01-01");
    expect(coverage.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01" },
      { companyId: "c2", salesDataStart: null },
    ]);
    // The caller-wide start alone says "full"; the silent company makes it partial —
    // NOT "none" (c1's data really does cover the window, and saying otherwise would be
    // its own lie).
    expect(callerWindowCoverage(coverage, "2026-07-01")).toBe("partial");
  });

  it("materializes every requested company even when NONE of them recorded", async () => {
    seedStarts([], null);
    const coverage = await callerScopedSalesCoverage(["c2", "c1"]);
    // Sorted by companyId, both present, both null — and the caller-wide verdict is the
    // honest "none", not a stagger.
    expect(coverage.companyCoverage).toBeUndefined(); // they SHARE a start (nothing)
    expect(coverage.salesDataStart).toBeNull();
    expect(callerWindowCoverage(coverage, "2026-07-01")).toBe("none");
  });

  it("a single company is never 'staggered' with itself", async () => {
    seedStarts([{ companyId: "c1", _min: { dayKey: "2020-01-01" } }], "2020-01-01");
    const coverage = await callerScopedSalesCoverage(["c1"]);
    expect(coverage.companyCoverage).toBeUndefined();
    expect(callerWindowCoverage(coverage, "2026-07-01")).toBe("full");
  });

  it("the per-company read carries the SAME company + approved-id narrowing as the total", async () => {
    seedStarts([{ companyId: "c1", _min: { dayKey: "2020-01-01" } }], "2020-01-01");
    await callerScopedSalesCoverage(["c1", "c2"]);
    const args = db.productSalesFact.groupBy.mock.calls[0][0] as {
      by: string[];
      where: { companyId: unknown; productId: unknown };
      _min: unknown;
    };
    expect(args.by).toEqual(["companyId"]);
    expect(args.where.companyId).toEqual({ in: ["c1", "c2"] });
    expect(args.where.productId).toEqual({ in: [1] });
    expect(args._min).toEqual({ dayKey: true });
  });
});

describe("FD-2 callerWindowCoverage — the governing start, including the null one", () => {
  const perCompany = (starts: Array<[string, string | null]>) =>
    starts.map(([companyId, salesDataStart]) => ({ companyId, salesDataStart }));

  it("a null start governs over any recorded one (mixed => partial)", () => {
    expect(
      callerWindowCoverage(
        {
          salesDataStart: "2020-01-01",
          companyCoverage: perCompany([
            ["c1", "2020-01-01"],
            ["c2", null],
          ]),
        },
        "2026-07-01",
      ),
    ).toBe("partial");
  });

  it("the LATEST recorded start still governs when every company has one", () => {
    expect(
      callerWindowCoverage(
        {
          salesDataStart: "2020-01-01",
          companyCoverage: perCompany([
            ["c1", "2020-01-01"],
            ["c2", "2099-01-01"],
          ]),
        },
        "2026-07-01",
      ),
    ).toBe("partial");
    expect(
      callerWindowCoverage(
        {
          salesDataStart: "2020-01-01",
          companyCoverage: perCompany([
            ["c1", "2020-01-01"],
            ["c2", "2021-06-01"],
          ]),
        },
        "2026-07-01",
      ),
    ).toBe("full");
  });
});
