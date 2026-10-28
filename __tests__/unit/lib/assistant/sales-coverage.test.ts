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

import fs from "fs";
import path from "path";
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
import { REBUILD_RUN_RETENTION } from "@/lib/analytics/rebuild-lock";

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
// A2 pack C7 / C15 — the sales rebuild state and the freshness note (material staleness only)
// ===========================================================================

/** A2 C16: `mode` is the run's own ('nightly' | 'full' | 'backfill', rebuild-lock.ts); a seeded
 *  run that does not name one is a nightly. */
type Run = { status: string; startedAt: Date; finishedAt: Date | null; skippedReason: string | null; mode?: string };
type RunQuery = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, string>;
  take?: number;
  select?: Record<string, boolean>;
};

/**
 * A2 C15: the sales run table, answered QUERY-FAITHFULLY — `where` (equality, `in`, `gt`, and
 * `not` with SQL's NULL rule: a NULL column never matches `<>`), `orderBy` startedAt, `take`
 * and `select` — so a read that asks the wrong question gets the wrong answer here too. An
 * operator it does not model throws rather than matching silently.
 */
function seedRuns(runs: Run[]) {
  const scalar = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const holds = (field: unknown, cond: unknown): boolean =>
    cond === null || typeof cond !== "object" || cond instanceof Date
      ? scalar(field) === scalar(cond)
      : Object.entries(cond).every(([op, arg]) => {
          if (op === "in") return (arg as unknown[]).some((v) => scalar(v) === scalar(field));
          if (op === "gt") return field != null && (scalar(field) as number) > (scalar(arg) as number);
          if (op === "not") return arg === null ? field != null : field != null && scalar(field) !== scalar(arg);
          throw new Error(`run fake: unmodelled operator ${op}`);
        });
  const query = ({ where = {}, orderBy, take, select }: RunQuery = {}) => {
    const rows: Array<Record<string, unknown>> = runs
      .map((run) => ({ job: "sales", mode: "nightly", ...run }))
      .filter((run: Record<string, unknown>) =>
        Object.entries(where).every(([key, cond]) => holds(run[key], cond)),
      );
    for (const [key, dir] of Object.entries(orderBy ?? {})) {
      if (key !== "startedAt") throw new Error(`run fake: unmodelled orderBy ${key}`);
      const sign = dir === "asc" ? 1 : -1;
      rows.sort((a, b) => sign * ((a.startedAt as Date).getTime() - (b.startedAt as Date).getTime()));
    }
    const page = take == null ? rows : rows.slice(0, take);
    if (!select) return page;
    const keys = Object.keys(select).filter((k) => select[k]);
    return page.map((row) => Object.fromEntries(keys.map((k) => [k, row[k]])));
  };
  db.analyticsRebuildRun.findFirst.mockImplementation(
    (async (args?: RunQuery) => query({ ...args, take: 1 })[0] ?? null) as never,
  );
  db.analyticsRebuildRun.findMany.mockImplementation((async (args?: RunQuery) => query(args)) as never);
}

describe("A2 C15 salesRebuildState — the newest success read directly, then the attempts after it", () => {
  const at = (iso: string) => new Date(iso);
  const success = (start: string, finish: string): Run => ({
    status: "SUCCEEDED",
    startedAt: at(start),
    finishedAt: at(finish),
    skippedReason: null,
  });
  /** `n` lock-held skips, one a minute from `from` (beginRebuildRun self-finalizes them). */
  const lockHeldSkips = (n: number, from: string): Run[] =>
    Array.from({ length: n }, (_, i) => {
      const startedAt = new Date(at(from).getTime() + i * 60_000);
      return { status: "ABORTED", startedAt, finishedAt: startedAt, skippedReason: "lock-held" };
    });

  it("reads the newest SUCCEEDED run directly, then only the FAILED / ABORTED runs started after it", async () => {
    seedRuns([success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z")]);
    await salesRebuildState();
    // A2 C16: two findFirst reads now — the newest success (first, unchanged) and the newest
    // FULL success (pinned below).
    expect(db.analyticsRebuildRun.findFirst).toHaveBeenCalledTimes(2);
    expect(db.analyticsRebuildRun.findFirst.mock.calls[0][0]).toEqual({
      where: { job: "sales", status: "SUCCEEDED", finishedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, finishedAt: true },
    });
    expect(db.analyticsRebuildRun.findMany).toHaveBeenCalledTimes(1);
    expect(db.analyticsRebuildRun.findMany.mock.calls[0][0]).toEqual({
      where: {
        job: "sales",
        status: { in: ["FAILED", "ABORTED"] },
        startedAt: { gt: at("2026-10-26T02:00:00.000Z") },
      },
      select: { skippedReason: true },
      take: REBUILD_RUN_RETENTION,
    });
    expect(REBUILD_RUN_RETENTION).toBe(100);
    // A Prisma `{ not: 'lock-held' }` compiles to SQL `<>`, which drops every FAILED run
    // (their skippedReason is NULL) — the filter must never be in either query.
    for (const read of [db.analyticsRebuildRun.findFirst, db.analyticsRebuildRun.findMany]) {
      for (const call of read.mock.calls) {
        expect(JSON.stringify((call[0] as RunQuery).where)).not.toContain("skippedReason");
      }
    }
  });

  it("60 lock-held skips newer than a retained success: the success is still found (A2-CR-5)", async () => {
    seedRuns([
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
      ...lockHeldSkips(60, "2026-10-26T03:00:00.000Z"),
    ]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-26T02:06:00.000Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-26T02:00:00.000Z",
      lastFullSucceededStartedAt: null,
    });
  });

  it("...and a FAILED run (NULL skippedReason) among those 60 skips still reads as a failed attempt", async () => {
    seedRuns([
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:06:00.000Z"),
      { status: "FAILED", startedAt: at("2026-10-26T02:30:00.000Z"), finishedAt: at("2026-10-26T02:30:09.000Z"), skippedReason: null },
      ...lockHeldSkips(60, "2026-10-26T03:00:00.000Z"),
    ]);
    expect((await salesRebuildState()).latestAttemptFailedAfterSuccess).toBe(true);
  });

  it("lastSucceededAt is the success run's finishedAt (the lastRunAt clock), never its startedAt", async () => {
    seedRuns([success("2026-10-27T02:00:00.000Z", "2026-10-27T02:07:31.250Z")]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-27T02:07:31.250Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-27T02:00:00.000Z",
      lastFullSucceededStartedAt: null,
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
      lastFullSucceededStartedAt: null,
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
      lastFullSucceededStartedAt: null,
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

  it("no success on record (only failures and skips) -> lastSucceededAt null, and the attempts are never read", async () => {
    seedRuns([
      { status: "FAILED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:00:09.000Z"), skippedReason: null },
      { status: "ABORTED", startedAt: at("2026-10-27T03:00:00.000Z"), finishedAt: at("2026-10-27T03:00:00.000Z"), skippedReason: "lock-held" },
    ]);
    const none = {
      lastSucceededAt: null,
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: null,
      lastFullSucceededStartedAt: null,
    };
    expect(await salesRebuildState()).toEqual(none);
    expect(db.analyticsRebuildRun.findMany).not.toHaveBeenCalled();
    // A2 C16: no success at all means no full success either — the third read is not issued.
    expect(db.analyticsRebuildRun.findFirst).toHaveBeenCalledTimes(1);
    db.analyticsRebuildRun.findFirst.mockResolvedValue(undefined as never); // a deep-mock read
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

  // A2 C16 (A2-FD1-1): the newest FULL success's start — only a full rebuild re-reads every
  // day, so a listing linked after it may have orders the facts do not carry yet. Internal.
  it("lastFullSucceededStartedAt: a third read, exactly — the newest SUCCEEDED run in mode 'full'", async () => {
    seedRuns([
      success("2026-10-25T02:00:00.000Z", "2026-10-25T02:05:00.000Z"),
      { ...success("2026-10-26T02:00:00.000Z", "2026-10-26T02:40:00.000Z"), mode: "full" },
    ]);
    const state = await salesRebuildState();
    expect(db.analyticsRebuildRun.findFirst.mock.calls[1][0]).toEqual({
      where: { job: "sales", status: "SUCCEEDED", mode: "full", finishedAt: { not: null } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    expect(state).toEqual({
      lastSucceededAt: "2026-10-26T02:40:00.000Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-26T02:00:00.000Z",
      lastFullSucceededStartedAt: "2026-10-26T02:00:00.000Z",
    });
  });

  it("a nightly success NEWER than the last full one never moves it; an older full is still found", async () => {
    seedRuns([
      { ...success("2026-10-18T02:00:00.000Z", "2026-10-18T02:41:00.000Z"), mode: "full" },
      { ...success("2026-10-25T02:00:00.000Z", "2026-10-25T02:42:00.000Z"), mode: "full" },
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:05:00.000Z"),
      success("2026-10-27T02:00:00.000Z", "2026-10-27T02:05:00.000Z"),
    ]);
    const state = await salesRebuildState();
    expect(state.lastSucceededStartedAt).toBe("2026-10-27T02:00:00.000Z");
    expect(state.lastFullSucceededStartedAt).toBe("2026-10-25T02:00:00.000Z");
  });

  it("a FAILED or ABORTED full run, or one still RUNNING, is not a full success", async () => {
    seedRuns([
      success("2026-10-26T02:00:00.000Z", "2026-10-26T02:05:00.000Z"),
      { status: "FAILED", startedAt: at("2026-10-25T02:00:00.000Z"), finishedAt: at("2026-10-25T02:09:00.000Z"), skippedReason: null, mode: "full" },
      { status: "ABORTED", startedAt: at("2026-10-24T02:00:00.000Z"), finishedAt: at("2026-10-24T02:00:00.000Z"), skippedReason: "lock-held", mode: "full" },
      { status: "RUNNING", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: null, skippedReason: null, mode: "full" },
    ]);
    expect((await salesRebuildState()).lastFullSucceededStartedAt).toBeNull();
  });

  it("no full success on record (nightlies only) -> lastFullSucceededStartedAt null, the rest unchanged", async () => {
    seedRuns([success("2026-10-26T02:00:00.000Z", "2026-10-26T02:05:00.000Z")]);
    expect(await salesRebuildState()).toEqual({
      lastSucceededAt: "2026-10-26T02:05:00.000Z",
      latestAttemptFailedAfterSuccess: false,
      lastSucceededStartedAt: "2026-10-26T02:00:00.000Z",
      lastFullSucceededStartedAt: null,
    });
  });

  it("the fake models mode: a run that names none is a nightly, so a 'full' predicate skips it", async () => {
    seedRuns([success("2026-10-26T02:00:00.000Z", "2026-10-26T02:05:00.000Z")]);
    const read = (where: Record<string, unknown>) =>
      db.analyticsRebuildRun.findMany({ where, select: { mode: true } } as never) as unknown as Promise<unknown[]>;
    expect(await read({ job: "sales", mode: "full" })).toEqual([]);
    expect(await read({ job: "sales", mode: "nightly" })).toEqual([{ mode: "nightly" }]);
  });

  it("source pin: neither read filters on skippedReason — the lock-held skips are dropped in JS", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../../lib/assistant/sales-coverage.ts"), "utf8");
    const start = src.indexOf("export async function salesRebuildState");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain(".findFirst(");
    expect(body).toContain(".findMany(");
    // A2 C16: the third read names the mode, as an equality.
    expect(body).toContain('mode: "full"');
    // skippedReason appears in the reads only as a SELECTED column, never as a predicate.
    expect(body).not.toMatch(/skippedReason\s*:(?!\s*true\b)/);
    expect(body).not.toMatch(/\bnot\s*:\s*["']lock-held/);
    expect(body).toContain("run.skippedReason !== LOCK_HELD_SKIP");
  });

  it("the fake is faithful where it matters: a `not` on skippedReason drops the FAILED NULL row, as SQL `<>` does", async () => {
    seedRuns([
      { status: "FAILED", startedAt: at("2026-10-27T02:00:00.000Z"), finishedAt: at("2026-10-27T02:00:09.000Z"), skippedReason: null },
      { status: "ABORTED", startedAt: at("2026-10-27T03:00:00.000Z"), finishedAt: at("2026-10-27T03:20:00.000Z"), skippedReason: "lease-lost" },
    ]);
    const read = (where: Record<string, unknown>) =>
      db.analyticsRebuildRun.findMany({ where, select: { status: true } } as never) as unknown as Promise<unknown[]>;
    expect(await read({ job: "sales", skippedReason: { not: "lock-held" } })).toEqual([{ status: "ABORTED" }]);
    expect(await read({ job: "sales" })).toEqual([{ status: "FAILED" }, { status: "ABORTED" }]);
  });
});

describe("A2 C7 / C15 salesFreshnessNote — a note only on material staleness, no 'as of' claim after a failure", () => {
  const NOW = new Date("2026-10-27T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const state = (lastSucceededAt: string | null, failed = false): SalesRebuildState => ({
    lastSucceededAt,
    latestAttemptFailedAfterSuccess: failed,
    lastSucceededStartedAt: null, // A2 C14: internal — the note never reads it
    lastFullSucceededStartedAt: null, // A2 C16: internal — the note never reads it
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

  // A2 C15 (A2-CR-4): the rebuild commits each day in its own transaction, so a failed or
  // aborted attempt can leave some days rebuilt and others not — the note never says the
  // figures are a snapshot "as of" the last success.
  it("a recent success with a newer attempt that did not succeed -> the may-be-missing sentence", () => {
    const finished = hoursAgo(20);
    expect(salesFreshnessNote(state(finished, true), NOW)).toBe(
      `The latest sales rebuild attempt did not succeed; the last successful rebuild finished at ` +
        `${finished}, and orders recorded since then may be missing or only partly counted.`,
    );
  });

  it("a stale success with a newer attempt that did not succeed -> one stale + failed sentence", () => {
    const finished = hoursAgo(30);
    expect(salesFreshnessNote(state(finished, true), NOW)).toBe(
      `The last successful sales rebuild finished at ${finished}, more than a day ago, and a later ` +
        `attempt did not succeed; orders recorded since then may be missing or only partly counted.`,
    );
  });

  it("no success on record is unchanged even with the flag set — the old appended sentence is gone", () => {
    expect(salesFreshnessNote(state(null, true), NOW)).toBe(
      "No successful sales rebuild is on record — order figures may be missing.",
    );
  });

  it("no branch claims the figures are 'as of' the last success, or appends the old sentence", () => {
    for (const s of [state(null), state(null, true), state(hoursAgo(30)), state(hoursAgo(30), true), state(hoursAgo(20), true)]) {
      const note = salesFreshnessNote(s, NOW) as string;
      expect(note).not.toContain("as of");
      expect(note).not.toContain("The latest rebuild attempt did not succeed.");
    }
  });

  it("the end to end: a FAILED run after a 20-hour-old success reads 'did not succeed' through the real state read", async () => {
    seedRuns([
      { status: "FAILED", startedAt: new Date(hoursAgo(2)), finishedAt: new Date(hoursAgo(2)), skippedReason: null },
      { status: "SUCCEEDED", startedAt: new Date(hoursAgo(20.1)), finishedAt: new Date(hoursAgo(20)), skippedReason: null },
    ]);
    const note = salesFreshnessNote(await salesRebuildState(), NOW);
    expect(note).toBe(
      `The latest sales rebuild attempt did not succeed; the last successful rebuild finished at ` +
        `${hoursAgo(20)}, and orders recorded since then may be missing or only partly counted.`,
    );
  });
});
