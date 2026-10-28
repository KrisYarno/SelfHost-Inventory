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
  companyCoverageDetail,
  salesDataStartsByCompany,
  salesCoverageReason,
  salesFreshnessNote,
  salesRebuildState,
  type SalesRebuildState,
  BUNDLE_REVENUE_DISCLOSURE,
  SALES_ATTRIBUTION_NOTE,
  SALES_COMPANY_COVERAGE_NOTE,
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
    // A2 C8: the names come from ONE read over the requested ids.
    db.company.findMany.mockResolvedValue([
      { id: "c1", name: "Acme Peptides" },
      { id: "c2", name: "Beta Labs" },
    ] as never);
  }

  it("lists the silent company with salesDataStart null and DEGRADES the window", async () => {
    // c1 has recorded since 2020; c2 has no facts at all.
    seedStarts([{ companyId: "c1", _min: { dayKey: "2020-01-01" } }], "2020-01-01");

    const coverage = await callerScopedSalesCoverage(["c1", "c2"]);

    expect(coverage.salesDataStart).toBe("2020-01-01");
    expect(coverage.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01", name: "Acme Peptides" },
      { companyId: "c2", salesDataStart: null, name: "Beta Labs" },
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

// ---------------------------------------------------------------------------
// A2 pack C4 (A2-OCR2-17 / A2-G2S-9): the zero-row reason, EXTRACTED from get_sales so the
// reorder order signal states an unknown in exactly the words get_sales uses. The strings
// are get_sales' inline ones, byte for byte (its own suites pin them through the tool).
// ---------------------------------------------------------------------------

describe("A2 C4 salesCoverageReason — get_sales' three reason strings, extracted", () => {
  // A2 C8: the entries carry their company's name, as salesDataStartsByCompany returns them.
  const NAMES: Record<string, string> = { c1: "Acme Peptides", c2: "Beta Labs" };
  const perCompany = (starts: Array<[string, string | null]>) =>
    starts.map(([companyId, salesDataStart]) => ({ companyId, salesDataStart, name: NAMES[companyId] ?? null }));

  it("no recorded start at all -> the no-data sentence (no date to quote)", () => {
    expect(salesCoverageReason(null, "2026-07-01")).toBe("no attributed sales data recorded");
    // ...whatever the per-company list says: there is no start to describe.
    expect(salesCoverageReason(null, "2026-07-01", perCompany([["c1", null]]))).toBe(
      "no attributed sales data recorded",
    );
  });

  it("the window predates or straddles the caller-wide start -> the starts-<date> sentence", () => {
    expect(salesCoverageReason("2026-07-10", "2026-07-01")).toBe(
      "window predates/straddles sales data (starts 2026-07-10)",
    );
    // The per-company list does not change the window-level sentence.
    expect(
      salesCoverageReason("2026-07-10", "2026-07-01", perCompany([["c1", "2026-07-10"], ["c2", null]])),
    ).toBe("window predates/straddles sales data (starts 2026-07-10)");
  });

  it("covered caller-wide but a member company not recording -> the per-company sentence, named", () => {
    expect(
      salesCoverageReason("2020-01-01", "2026-07-01", perCompany([["c1", "2020-01-01"], ["c2", null]])),
    ).toBe(
      "sales data is not recorded in every company for this window " +
        `(no sales data recorded for Beta Labs; latest company start 2020-01-01; ${SALES_COMPANY_COVERAGE_NOTE})`,
    );
    // A company whose name is gone (deleted) falls back to its id, said as "company <id>".
    expect(
      salesCoverageReason("2020-01-01", "2026-07-01", perCompany([["c1", "2020-01-01"], ["c9", null]])),
    ).toBe(
      "sales data is not recorded in every company for this window " +
        `(no sales data recorded for company c9; latest company start 2020-01-01; ${SALES_COMPANY_COVERAGE_NOTE})`,
    );
    expect(
      salesCoverageReason("2020-01-01", "2026-07-01", perCompany([["c1", "2020-01-01"], ["c2", "2026-07-09"]])),
    ).toBe(
      "sales data is not recorded in every company for this window " +
        `(latest company start 2026-07-09; ${SALES_COMPANY_COVERAGE_NOTE})`,
    );
  });

  it("the per-company sentence never ships an empty detail (the guard)", () => {
    const expected =
      `sales data is not recorded in every company for this window (${SALES_COMPANY_COVERAGE_NOTE})`;
    expect(salesCoverageReason("2020-01-01", "2026-07-01")).toBe(expected);
    expect(salesCoverageReason("2020-01-01", "2026-07-01", [])).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// A2 pack C8 (R4-12/13): names for ids. Every companyCoverage array is built from
// salesDataStartsByCompany, so its entries carry the company's NAME (one read, scoped to
// the caller's own companies), and the prose names the company alone — the id only when
// the name is gone.
// ---------------------------------------------------------------------------

describe("A2 C8 salesDataStartsByCompany — entries carry the company name", () => {
  function seedFacts(names: Array<{ id: string; name: string }> | undefined) {
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2020-01-01" } } as never);
    db.productSalesFact.groupBy.mockResolvedValue([
      { companyId: "c1", _min: { dayKey: "2020-01-01" } },
      { companyId: "c2", _min: { dayKey: "2026-07-09" } },
    ] as never);
    db.company.findMany.mockResolvedValue(names as never);
  }

  it("one company read over the requested ids, selecting id + name only; each entry gains its name", async () => {
    seedFacts([
      { id: "c2", name: "Beta Labs" },
      { id: "c1", name: "Acme Peptides" },
    ]);
    const starts = await salesDataStartsByCompany(["c2", "c1"]);
    expect(db.company.findMany).toHaveBeenCalledTimes(1);
    expect(db.company.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["c2", "c1"] } },
      select: { id: true, name: true },
    });
    expect(starts.perCompany).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01", name: "Acme Peptides" },
      { companyId: "c2", salesDataStart: "2026-07-09", name: "Beta Labs" },
    ]);
  });

  it("a deleted company (no name row) reads name: null; an undefined read is guarded", async () => {
    seedFacts([{ id: "c1", name: "Acme Peptides" }]);
    const starts = await salesDataStartsByCompany(["c1", "c2"]);
    expect(starts.perCompany[1]).toEqual({ companyId: "c2", salesDataStart: "2026-07-09", name: null });

    seedFacts(undefined);
    const guarded = await salesDataStartsByCompany(["c1", "c2"]);
    expect(guarded.perCompany.map((c) => c.name)).toEqual([null, null]);
  });

  it("no companies: no read at all (names included)", async () => {
    await salesDataStartsByCompany([]);
    expect(db.company.findMany).not.toHaveBeenCalled();
  });

  it("callerScopedSalesCoverage relays the named entries in companyCoverage", async () => {
    seed({ unattributed: 0, total: 0 });
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);
    seedFacts([
      { id: "c1", name: "Acme Peptides" },
      { id: "c2", name: "Beta Labs" },
    ]);
    const coverage = await callerScopedSalesCoverage(["c1", "c2"]);
    expect(coverage.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01", name: "Acme Peptides" },
      { companyId: "c2", salesDataStart: "2026-07-09", name: "Beta Labs" },
    ]);
  });
});

describe("A2 C8 companyCoverageDetail — the name alone, the id only as a fallback", () => {
  it("names each silent company alone; a missing name falls back to 'company <id>'", () => {
    expect(
      companyCoverageDetail([
        { companyId: "c1", salesDataStart: "2020-01-01", name: "Acme Peptides" },
        { companyId: "c2", salesDataStart: null, name: "Beta Labs" },
      ]),
    ).toBe("no sales data recorded for Beta Labs; latest company start 2020-01-01");
    expect(
      companyCoverageDetail([
        { companyId: "c1", salesDataStart: null, name: "Acme Peptides" },
        { companyId: "c2", salesDataStart: null, name: null },
      ]),
    ).toBe("no sales data recorded for Acme Peptides, company c2");
    // Entries without a name key (an unnamed producer) read exactly as a null name.
    expect(companyCoverageDetail([{ companyId: "c2", salesDataStart: null }])).toBe(
      "no sales data recorded for company c2",
    );
  });

  it("never prints a company id when the name is known", () => {
    const detail = companyCoverageDetail([
      { companyId: "cmp_123", salesDataStart: null, name: "Acme Peptides" },
      { companyId: "cmp_456", salesDataStart: "2026-07-09", name: "Beta Labs" },
    ]);
    expect(detail).not.toContain("cmp_");
    expect(detail).toBe("no sales data recorded for Acme Peptides; latest company start 2026-07-09");
  });
});

// ===========================================================================
// A2 pack C7 — the sales rebuild state and the freshness note (material staleness only)
// ===========================================================================

describe("A2 C7 salesRebuildState — the newest 50 sales runs, lock-held skips filtered in JS", () => {
  type Run = { status: string; startedAt: Date; finishedAt: Date | null; skippedReason: string | null };
  const at = (iso: string) => new Date(iso);
  /** Rows as the read returns them: newest startedAt first. */
  const seedRuns = (runs: Run[]) =>
    db.analyticsRebuildRun.findMany.mockResolvedValue(
      [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()) as never,
    );
  const success = (start: string, finish: string): Run => ({
    status: "SUCCEEDED",
    startedAt: at(start),
    finishedAt: at(finish),
    skippedReason: null,
  });

  it("reads the newest 50 rows of the sales job by startedAt, with NO skippedReason predicate in SQL", async () => {
    seedRuns([]);
    await salesRebuildState();
    expect(db.analyticsRebuildRun.findMany).toHaveBeenCalledTimes(1);
    const args = db.analyticsRebuildRun.findMany.mock.calls[0][0] as Record<string, any>;
    expect(args.where).toEqual({ job: "sales" });
    expect(args.orderBy).toEqual({ startedAt: "desc" });
    expect(args.take).toBe(50);
    // A Prisma `{ not: 'lock-held' }` compiles to SQL `<>`, which drops every FAILED run
    // (their skippedReason is NULL) — the filter must never be in the query.
    expect(JSON.stringify(args.where)).not.toContain("skippedReason");
  });

  it("a success behind 12 newer lock-held skips is still found (they never fill the read window)", async () => {
    const skips: Run[] = Array.from({ length: 12 }, (_, i) => ({
      status: "ABORTED",
      startedAt: at(`2026-10-27T03:${String(10 + i).padStart(2, "0")}:00.000Z`),
      finishedAt: null,
      skippedReason: "lock-held",
    }));
    seedRuns([success("2026-10-27T03:00:00.000Z", "2026-10-27T03:08:00.000Z"), ...skips]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-27T03:08:00.000Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-27T03:00:00.000Z",
    });
  });

  it("lastSucceededAt is the success run's finishedAt (the lastRunAt clock), never its startedAt", async () => {
    seedRuns([success("2026-10-27T02:00:00.000Z", "2026-10-27T02:07:31.250Z")]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-27T02:07:31.250Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-27T02:00:00.000Z",
    });
  });

  it("the NEWEST success wins; an older one never shows", async () => {
    seedRuns([
      success("2026-10-25T02:00:00.000Z", "2026-10-25T02:05:00.000Z"),
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
    ]);
    expect((await salesRebuildState()).lastSucceededAt).toBe("2026-10-26T02:06:00.000Z");
  });

  it("a FAILED run (NULL skippedReason) started after the success -> latestAttemptFailedAfterSuccess", async () => {
    seedRuns([
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
      { status: "FAILED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:00:09.000Z"), skippedReason: null },
    ]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-26T02:06:00.000Z",
      latestAttemptFailedAfterSuccess: true,
      lastSucceededStartedAt: "2026-10-26T02:00:00.000Z",
    });
  });

  it("an ABORTED run that was not a lock-held skip (lease lost) counts as an attempt that did not succeed", async () => {
    seedRuns([
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
      { status: "ABORTED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:20:00.000Z"), skippedReason: "lease-lost" },
    ]);
    expect((await salesRebuildState()).latestAttemptFailedAfterSuccess).toBe(true);
  });

  it("a lock-held ABORTED row is IGNORED — it was never an attempt", async () => {
    seedRuns([
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
      { status: "ABORTED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:00:00.000Z"), skippedReason: "lock-held" },
    ]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-26T02:06:00.000Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-26T02:00:00.000Z",
    });
  });

  it("a failure BEFORE the newest success, and a RUNNING attempt after it, do not count", async () => {
    seedRuns([
      { status: "FAILED", startedAt: at("2026-10-25T02:00:00.000Z"), finishedAt: at("2026-10-25T02:00:09.000Z"), skippedReason: null },
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
      { status: "RUNNING", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: null, skippedReason: null },
    ]);
    expect((await salesRebuildState()).latestAttemptFailedAfterSuccess).toBe(false);
  });

  it("no success on record (only failures and skips) -> lastSucceededAt null, and no success to have failed after", async () => {
    seedRuns([
      { status: "FAILED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:00:09.000Z"), skippedReason: null },
      { status: "ABORTED", startedAt: at("2026-10-27T03:00:00.000Z"), finishedAt: at("2026-10-27T03:00:00.000Z"), skippedReason: "lock-held" },
    ]);
    const none = { lastSucceededAt: null, latestAttemptFailedAfterSuccess: false, lastSucceededStartedAt: null };
    expect(await salesRebuildState()).toEqual(none);
    db.analyticsRebuildRun.findMany.mockResolvedValue(undefined as never); // a deep-mock read
    expect(await salesRebuildState()).toEqual(none);
  });

  // A2 C14 (A2-OCC-2): the success's START is what bounds the complete sales days (a run
  // that started on day D re-read every order updated before it) — internal, never shown.
  it("lastSucceededStartedAt is the SAME (newest, non-skipped) success run's startedAt", async () => {
    seedRuns([
      success("2026-10-25T02:00:00.000Z", "2026-10-25T02:05:00.000Z"),
      success("2026-10-26T02:59:59.000Z", "2026-10-26T03:06:00.000Z"),
      { status: "ABORTED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:00:00.000Z"), skippedReason: "lock-held" },
      { status: "FAILED", startedAt: at("2026-10-27T03:00:00.000Z"), finishedAt: at("2026-10-27T03:00:09.000Z"), skippedReason: null },
    ]);
    const state = await salesRebuildState();
    expect(state.lastSucceededStartedAt).toBe("2026-10-26T02:59:59.000Z");
    expect(state.lastSucceededAt).toBe("2026-10-26T03:06:00.000Z");
  });
});

describe("A2 C7 salesFreshnessNote — a note only on material staleness", () => {
  const NOW = new Date("2026-10-27T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const state = (lastSucceededAt: string | null, failed = false): SalesRebuildState => ({
    lastSucceededAt,
    latestAttemptFailedAfterSuccess: failed,
    lastSucceededStartedAt: null, // A2 C14: internal — the note never reads it
  });

  it("no successful rebuild on record -> the missing-figures sentence", () => {
    expect(salesFreshnessNote(state(null), NOW)).toBe(
      "No successful sales rebuild is on record — order figures may be missing.",
    );
  });

  it("a 20-hour-old success -> no note (the most recent day or two is the standing description sentence)", () => {
    expect(salesFreshnessNote(state(hoursAgo(20)), NOW)).toBeUndefined();
  });

  it("a 30-hour-old success -> the stale sentence, naming the finish", () => {
    const finished = hoursAgo(30);
    expect(salesFreshnessNote(state(finished), NOW)).toBe(
      `The last successful sales rebuild finished at ${finished}, more than a day ago; orders ` +
        `recorded after that are not counted yet.`,
    );
  });

  it("the boundary is MORE than 26 hours: exactly 26 is no note, one second past is", () => {
    expect(salesFreshnessNote(state(hoursAgo(26)), NOW)).toBeUndefined();
    const past = new Date(NOW.getTime() - 26 * 3_600_000 - 1_000).toISOString();
    expect(salesFreshnessNote(state(past), NOW)).toContain("more than a day ago");
  });

  it("a recent success with a newer attempt that did not succeed -> the as-of sentence", () => {
    const finished = hoursAgo(20);
    expect(salesFreshnessNote(state(finished, true), NOW)).toBe(
      `The latest sales rebuild attempt did not succeed; figures are as of the last successful ` +
        `rebuild, finished at ${finished}.`,
    );
  });

  it("a stale success with a newer attempt that did not succeed -> the stale sentence + 'did not succeed'", () => {
    const finished = hoursAgo(30);
    expect(salesFreshnessNote(state(finished, true), NOW)).toBe(
      `The last successful sales rebuild finished at ${finished}, more than a day ago; orders ` +
        `recorded after that are not counted yet. The latest rebuild attempt did not succeed.`,
    );
  });

  it("a defined no-success note gains the sentence too when the flag is set", () => {
    expect(salesFreshnessNote(state(null, true), NOW)).toBe(
      "No successful sales rebuild is on record — order figures may be missing. The latest " +
        "rebuild attempt did not succeed.",
    );
  });

  it("the end to end: a FAILED run after a 20-hour-old success reads 'did not succeed' through the real state read", async () => {
    db.analyticsRebuildRun.findMany.mockResolvedValue([
      { status: "FAILED", startedAt: new Date(hoursAgo(2)), finishedAt: new Date(hoursAgo(2)), skippedReason: null },
      { status: "SUCCEEDED", startedAt: new Date(hoursAgo(20.1)), finishedAt: new Date(hoursAgo(20)), skippedReason: null },
    ] as never);
    const note = salesFreshnessNote(await salesRebuildState(), NOW);
    expect(note).toBe(
      `The latest sales rebuild attempt did not succeed; figures are as of the last successful ` +
        `rebuild, finished at ${hoursAgo(20)}.`,
    );
  });
});
