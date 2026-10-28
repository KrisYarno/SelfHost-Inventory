/**
 * @jest-environment node
 *
 * W3-TUNE (spec §5 T-TUNE REV-2, turn-budget residual R2-m1) — the page-SHRINK pin.
 *
 * The adapter threads the turn's remaining budget into each tool's run-ctx
 * (`remainingBytes = min(PER_TOOL_RESULT_CAP_BYTES, budget.remaining)`), and every
 * list tool byte-fits its page to `byteBudget(ctx) − ENVELOPE_RESERVE_BYTES`. So a
 * late-turn read with only a little budget left returns a SMALLER page (fewer rows +
 * a nextOffset) instead of being discarded whole as a truncation notice.
 *
 * This pins that behavior for get_stock_asof (the W2 seam-fix wired its envelope
 * reserve) AND one W1 list tool (get_inventory_summary). The module functions are
 * mocked to byte-fit their page to the budget they are handed — exactly as the real
 * DB-side paging does — so the assertions exercise the ADAPTER threading + the tool's
 * reserve, not a live database. Remove the ctx threading (page against the fixed
 * ROW budget) OR the envelope reserve, and a tight budget truncates instead → red.
 */

// `ai` (v7) is ESM-only; createAiTools only stores def+execute, never invokes ai's
// tool() body, so a passthrough is faithful (same stub the asof-error suite uses).
jest.mock("ai", () => ({ __esModule: true, tool: (def: unknown) => def }));

// The two module functions are mocked, so their prisma reads never run; a bare stub
// satisfies the tools.ts import graph.
// productSalesFact.groupBy is the ONLY direct prisma read the tools under test reach
// (get_sales fills zero rows' firstSaleDayKey post-pagination); everything else runs
// through the mocked module functions below.
// quality+reach Task 3.1: get_sales also runs the G5 contributor CENSUS (a
// `product.findMany` starting from Product), so the stub gains that delegate. An empty
// census is the right shape here — the pin is about byte-fitting, not disclosure values.
// A2 M3: get_stock_asof resolves a locationId (and the movement filters echo reads the
// location's name), so the stub gains location.findUnique — a 100-character name, the
// column's width (`locations.name` VARCHAR(100)), so the echo is at its heaviest.
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    productSalesFact: { groupBy: jest.fn(async () => []) },
    product: { findMany: jest.fn(async () => []) },
    location: { findUnique: jest.fn(async () => ({ id: 2, name: "L".repeat(100) })) },
  },
}));
// A2 M3 (pack C6 / C2): the two other paged tools M3 grows — valuation product rows gain
// unit prices, the movement breakdown gains counts — have their module reads injected so
// the adapter's byte fit is what is pinned.
jest.mock("@/lib/analytics/valuation", () => ({ __esModule: true, getValuation: jest.fn() }));
jest.mock("@/lib/reports/movement", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/reports/movement"),
  getMovementByProduct: jest.fn(),
}));
jest.mock("@/lib/analytics/stock-asof", () => ({ __esModule: true, getStockAsOf: jest.fn() }));
jest.mock("@/lib/reports/inventory-summary", () => ({ __esModule: true, getInventorySummary: jest.fn() }));
// W3 seam-fix item 1: get_sales byte-fits IN-MEMORY via paginate (no module byteBudget
// arg), so its page-shrink pin mocks the sales query + coverage + an identity serialize
// and drives the tool's own paginate. groupBy:"day" avoids any prisma name-resolution.
jest.mock("@/lib/analytics/queries", () => ({ __esModule: true, getSales: jest.fn() }));
jest.mock("@/lib/analytics/serialize", () => ({ __esModule: true, serializeSalesRows: (rows: unknown[]) => rows }));
// Only the QUERY is mocked; the pure classifiers (callerWindowCoverage) and the note
// constants stay REAL, so this pin exercises the same coverage logic the tool ships with.
jest.mock("@/lib/assistant/sales-coverage", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/assistant/sales-coverage"),
  callerScopedSalesCoverage: jest.fn(),
}));
// C6 zero rows read the approved catalog + the shared identity map; both are prisma
// reads, so the page-shrink pin stubs them and drives the tool's own paginate.
jest.mock("@/lib/reports/outbound-mix", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/reports/outbound-mix"),
  approvedProductIds: jest.fn(),
  productIdentities: jest.fn(),
}));
// G2-5: the compare by_product fitter is driven through the ADAPTER (the only place the
// over-budget downgrade actually happens), so the module's ranked rows are injected.
jest.mock("@/lib/reports/compare-periods", () => ({
  __esModule: true,
  comparePeriods: jest.fn(),
  comparePeriodsByProduct: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { createAiTools } from "@/lib/assistant/tool-adapters";
import { getStockAsOf } from "@/lib/analytics/stock-asof";
import { getInventorySummary } from "@/lib/reports/inventory-summary";
import { getSales } from "@/lib/analytics/queries";
import { callerScopedSalesCoverage } from "@/lib/assistant/sales-coverage";
import { approvedProductIds, productIdentities } from "@/lib/reports/outbound-mix";
import { comparePeriodsByProduct } from "@/lib/reports/compare-periods";
import { getValuation } from "@/lib/analytics/valuation";
import { getMovementByProduct, UNCLASSIFIED_LEGACY_NOTE } from "@/lib/reports/movement";
import type { ToolContext as ResolvedContext } from "@/lib/assistant/context";

const asOfMock = getStockAsOf as jest.Mock;
const summaryMock = getInventorySummary as jest.Mock;
const salesMock = getSales as jest.Mock;
const salesCoverageMock = callerScopedSalesCoverage as jest.Mock;
const approvedIdsMock = approvedProductIds as jest.Mock;
const identitiesMock = productIdentities as jest.Mock;
const compareByProductMock = comparePeriodsByProduct as jest.Mock;
/** The post-pagination evidence lookup (get_sales' + compare's first-fact reads). */
const prismaGroupBy = (prisma as unknown as { productSalesFact: { groupBy: jest.Mock } })
  .productSalesFact.groupBy;

const CTX: ResolvedContext = {
  userId: 1,
  tokenId: null,
  surface: "web",
  companyIds: ["c1"],
} as unknown as ResolvedContext;

// A tight late-turn budget vs. a comfortable one. TIGHT still clears one small page;
// the point is that the completed page shrinks to fit instead of being discarded.
const TIGHT = 16_384;
const LARGE = 65_536;
const TOTAL = 3_000; // far more rows than either budget can hold => nextOffset always set
const SALES_TOTAL = 3_000; // ditto for the get_sales in-memory paginate pin

/** Mirror the real byte-fit paginate: add rows until the next would exceed byteBudget. */
function fitPage<T>(byteBudget: number, total: number, makeRow: (i: number) => T) {
  const rows: T[] = [];
  let bytes = 2; // "[]"
  for (let i = 0; i < total; i++) {
    const row = makeRow(i);
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1; // + comma
    if (rows.length > 0 && bytes + rowBytes > byteBudget) break;
    rows.push(row);
    bytes += rowBytes;
  }
  return { rows, returned: rows.length, totalRows: total, nextOffset: rows.length < total ? rows.length : null };
}

beforeEach(() => {
  asOfMock.mockReset();
  summaryMock.mockReset();
  salesMock.mockReset();
  salesCoverageMock.mockReset();
  salesCoverageMock.mockResolvedValue({
    unattributedOrders: 0,
    bundleRevenue: "excluded",
    lastRebuildAt: null,
    // FULL coverage, so the zero rows below are MEASURED zeros (the heavier shape).
    salesDataStart: "2019-01-01",
  });
  approvedIdsMock.mockReset();
  approvedIdsMock.mockResolvedValue(Array.from({ length: SALES_TOTAL }, (_v, i) => i + 1));
  identitiesMock.mockReset();
  identitiesMock.mockImplementation(async (ids: number[]) =>
    new Map(ids.map((id) => [id, { name: `Product ${"x".repeat(60)} ${id}`, lifecycle: "active" }])),
  );
  // Day-grain raw rows, each padded so BOTH budgets are byte-bound (page < the 500-row
  // limit), proving the byte budget — not the row limit — shrinks the tight page.
  salesMock.mockImplementation(async () =>
    Array.from({ length: SALES_TOTAL }, (_v, i) => ({
      dayKey: "2020-01-01",
      _sum: { orderedQty: i, revenue: "1234.50", pad: "x".repeat(150) },
    })),
  );
  asOfMock.mockImplementation(async (opts: { dayKey: string; byteBudget: number }) => {
    const page = fitPage(opts.byteBudget, TOTAL, (i) => ({
      productId: i,
      name: `Product ${i}`,
      units: i,
      seriesEndsAt: "2020-01-02",
      possiblyStale: false,
      pairsPresentOnDay: 1,
      knownPairs: 1,
    }));
    return {
      ...page,
      coverage: {
        dayKey: opts.dayKey,
        snapshotWatermark: "2020-01-02",
        snapshotDataStart: "2019-01-01",
        flaggedPairs: 0,
      },
    };
  });
  summaryMock.mockImplementation(async (opts: { byteBudget: number }) => {
    const ranked = fitPage(opts.byteBudget, TOTAL, (i) => ({ productId: i, name: `Product ${i}`, metric: i }));
    return {
      unitsOnHand: 12_345,
      productCount: TOTAL,
      stockStateCounts: { in_stock: 1_000, low: 1_000, out: 1_000 },
      valuation: { coverage: { costedProducts: 10, ofProducts: TOTAL } },
      ranked,
    };
  });
});

type ExecResult = {
  status: string;
  notice?: string;
  meta?: { bytes: number };
  data?: { rows?: unknown[]; totalRows?: number; nextOffset?: number | null; ranked?: { rows: unknown[]; totalRows: number; nextOffset: number | null } };
};
type ExecTool = { execute: (args: unknown) => Promise<ExecResult> };

/** One isolated turn: a fresh tool set + fresh budget (so tight vs. large never share). */
function runOnce(name: string, args: unknown, remaining: number): Promise<ExecResult> {
  const set = createAiTools(CTX, { remaining }, jest.fn().mockResolvedValue(undefined) as never);
  return (set[name] as unknown as ExecTool).execute(args);
}

describe("createAiTools — a tight remainingBytes shrinks the page, never truncates (W3-TUNE)", () => {
  it("get_stock_asof: tight budget -> smaller page + nextOffset, status ok (no truncation notice)", async () => {
    const tight = await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, TIGHT);
    const large = await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, LARGE);

    // A completed, byte-fit page — NOT the turn-budget truncation notice.
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.rows!.length).toBeLessThan(tight.data!.totalRows!);
    expect(tight.data!.nextOffset).not.toBeNull();
    // Genuinely SMALLER than a comfortable-budget read of the same data.
    expect(tight.data!.rows!.length).toBeLessThan(large.data!.rows!.length);
  });

  it("get_inventory_summary (W1 list tool): tight budget -> smaller ranked page + nextOffset, status ok", async () => {
    const tight = await runOnce("get_inventory_summary", { rankBy: "onHand" }, TIGHT);
    const large = await runOnce("get_inventory_summary", { rankBy: "onHand" }, LARGE);

    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.ranked!.rows.length).toBeLessThan(tight.data!.ranked!.totalRows);
    expect(tight.data!.ranked!.nextOffset).not.toBeNull();
    expect(tight.data!.ranked!.rows.length).toBeLessThan(large.data!.ranked!.rows.length);
  });

  it("get_sales (W3 seam-fix item 1 — in-memory paginate): tight budget -> smaller page + nextOffset, status ok", async () => {
    const tight = await runOnce("get_sales", { groupBy: "day" }, TIGHT);
    const large = await runOnce("get_sales", { groupBy: "day" }, LARGE);

    // A completed, byte-fit page — NOT the turn-budget truncation notice.
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.rows!.length).toBeLessThan(tight.data!.totalRows!);
    expect(tight.data!.nextOffset).not.toBeNull();
    // Genuinely SMALLER than a comfortable-budget read of the same data — the byte budget
    // binds before the 500-row limit for BOTH, so this proves the ctx page-shrink wiring.
    expect(tight.data!.rows!.length).toBeLessThan(large.data!.rows!.length);
    // Pin the fixed ROW budget removal: with the OLD constant both reads would return the
    // SAME page (limit-bound), never a tighter one.
    expect(large.status).toBe("ok");
    expect(large.data!.nextOffset).not.toBeNull();
  });

  it("get_sales includeZeroRows (C6, a NEW list mode): tight budget -> smaller page + nextOffset, status ok", async () => {
    // G2 is NORMATIVE for every new list mode: the synthesised zero rows page through
    // the SAME byte fitter, so a late-turn catalog-wide zero-row read shrinks instead of
    // returning the last-resort truncation notice.
    salesMock.mockImplementation(async () => []); // no real facts => every product is a zero row
    const tight = await runOnce("get_sales", { groupBy: "product", includeZeroRows: true }, TIGHT);
    const large = await runOnce("get_sales", { groupBy: "product", includeZeroRows: true }, LARGE);

    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.totalRows).toBe(SALES_TOTAL);
    expect(tight.data!.rows!.length).toBeLessThan(tight.data!.totalRows!);
    expect(tight.data!.nextOffset).not.toBeNull();
    expect(tight.data!.rows!.length).toBeLessThan(large.data!.rows!.length);
  });

  it("the ctx budget is threaded through with the envelope reserve subtracted (both tools)", async () => {
    await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, TIGHT);
    await runOnce("get_stock_asof", { dayKey: "2020-01-01" }, LARGE);
    const tightAsOf = asOfMock.mock.calls[0][0].byteBudget as number;
    const largeAsOf = asOfMock.mock.calls[1][0].byteBudget as number;
    // A tighter remaining reaches the module as a smaller page budget (threading)...
    expect(tightAsOf).toBeLessThan(largeAsOf);
    // ...and the module budget is BELOW the raw remaining (the envelope reserve).
    expect(tightAsOf).toBeLessThan(TIGHT);

    await runOnce("get_inventory_summary", { rankBy: "onHand" }, TIGHT);
    await runOnce("get_inventory_summary", { rankBy: "onHand" }, LARGE);
    const tightSum = summaryMock.mock.calls[0][0].byteBudget as number;
    const largeSum = summaryMock.mock.calls[1][0].byteBudget as number;
    expect(tightSum).toBeLessThan(largeSum);
    expect(tightSum).toBeLessThan(TIGHT);
  });
});

// ---------------------------------------------------------------------------
// G2-5 — the compare by_product JOINT fitter, at the ADAPTER (where the over-budget
// downgrade really happens). The fitter used to page against a CONSTANT: the caller's
// budget minus a fixed 8 KiB reserve, floored at 4 KiB. Below ~12 KiB of remaining turn
// budget that floor is LARGER than the whole budget, so the fitter built a page the
// caller had no room for and the adapter threw the completed result away — a truncation
// notice in the one place the joint fitter exists to prevent one. Then the evidence fill
// GREW the rows after they were measured, so even a correctly-sized page could overshoot.
// ---------------------------------------------------------------------------

describe("G2-5 — compare_periods by_product fits the EXACT remaining budget", () => {
  /** A 5 KB late-turn budget: smaller than the old 8 KiB reserve AND the 4 KiB floor. */
  const CRAMPED = 5_000;
  const RANKED_ROWS = 400;

  /** The module's per-day row fields (A2 C3), at their widest realistic values: 3
   *  significant figures below 1, 2 decimals above. */
  function perDayOf(a: number | null, b: number | null, daysA: number, daysB: number) {
    const r = (x: number | null) =>
      x == null ? null : x === 0 ? 0 : Math.abs(x) >= 1 ? Math.round(x * 100) / 100 : Number(x.toPrecision(3));
    const aRaw = a == null ? null : a / daysA;
    const bRaw = b == null ? null : b / daysB;
    const change = aRaw == null || bRaw == null ? null : bRaw - aRaw;
    return {
      aPerDay: r(aRaw),
      bPerDay: r(bRaw),
      perDayDelta: r(change),
      perDayPctChange: change == null || aRaw === 0 ? null : change / (aRaw as number),
      perDayDirection: change == null ? null : change > 0 ? "increase" : change < 0 ? "decrease" : "unchanged",
    };
  }

  beforeEach(() => {
    // 255-char names: the widest a product name can be, so a handful of rows is already
    // more than the budget holds.
    identitiesMock.mockImplementation(async (ids: number[]) =>
      new Map(ids.map((id) => [id, { name: "N".repeat(255), lifecycle: "active" }])),
    );
    compareByProductMock.mockReset();
    compareByProductMock.mockResolvedValue({
      // A2 C3: the module's rows carry the per-day figures, and its result says how it
      // ranked and how many moved each way — the shape the fitter must measure.
      ranked: Array.from({ length: RANKED_ROWS }, (_v, i) => ({
        productId: i + 1,
        a: i,
        b: i * 2,
        delta: i,
        pctChange: 1,
        ...perDayOf(i, i * 2, 7, 7),
      })),
      unranked: [],
      reasons: { a: "measured", b: "measured" },
      periodCoverage: { a: "full", b: "full" },
      unequalLengths: false,
      rankedBy: "total",
      directionCounts: { increased: RANKED_ROWS - 1, decreased: 0, unchanged: 1 },
      excludedUnapprovedProducts: 0,
    });
    // The post-pagination evidence fill returns a REAL day-key for every page id, so the
    // rows grow after they were fit — which is what the re-fit exists to absorb.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prismaGroupBy as jest.Mock).mockImplementation(async (args: any) =>
      ((args?.where?.productId?.in ?? []) as number[]).map((id) => ({
        productId: id,
        _min: { dayKey: "2021-03-04" },
      })),
    );
  });

  const compareArgs = {
    metric: "sales_units",
    periodA: { relativeDays: 7 },
    periodB: { relativeDays: 7 },
    groupBy: "product",
  };

  it("a 5KB budget returns a SMALL ok page — never the truncated downgrade", async () => {
    const tight = (await runOnce("compare_periods", compareArgs, CRAMPED)) as ExecResult & {
      meta?: { bytes: number };
    };

    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    const rows = tight.data!.rows!;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(RANKED_ROWS);
    expect(tight.data!.nextOffset).not.toBeNull();
    // The completed result FITS the budget the adapter threaded in — that is the whole
    // claim: measured envelope + measured rows, not a constant that ignores both.
    expect(tight.meta!.bytes).toBeLessThanOrEqual(CRAMPED);
  });

  it("the page it returns is the EVIDENCE-POPULATED one (fit survives the fill)", async () => {
    const tight = (await runOnce("compare_periods", compareArgs, CRAMPED)) as ExecResult & {
      meta?: { bytes: number };
    };
    const rows = tight.data!.rows! as Array<{ firstSaleDayKey: string | null; name: string }>;
    // Every returned row carries its filled evidence and its full-width name...
    for (const row of rows) {
      expect(row.firstSaleDayKey).toBe("2021-03-04");
      expect(row.name).toHaveLength(255);
    }
    // ...and the bytes the caller receives are still within budget AFTER that growth.
    expect(tight.meta!.bytes).toBeLessThanOrEqual(CRAMPED);
  });

  it("a comfortable budget still returns a bigger page (the fit is budget-driven)", async () => {
    const tight = await runOnce("compare_periods", compareArgs, CRAMPED);
    const large = await runOnce("compare_periods", compareArgs, LARGE);
    expect(large.status).toBe("ok");
    expect(large.data!.rows!.length).toBeGreaterThan(tight.data!.rows!.length);
  });

  // FD3-5: the case the pack's scaffold line called structurally impossible. FD2-2 made
  // it reachable — under PER-COMPANY degradation a product with rows in both periods is
  // measured and ranked while a product absent from one of them is unranked — and the
  // two arrays then share ONE budget at the tightest point in the turn. Both the
  // ranked-only and unranked-only cases were pinned; the case where the joint fitter has
  // to divide a budget between two non-empty arrays was not tested anywhere.
  it("BOTH arrays non-empty at a 5KB budget: each keeps rows AND the payload fits", async () => {
    compareByProductMock.mockResolvedValue({
      ranked: Array.from({ length: 200 }, (_v, i) => ({
        productId: i + 1,
        a: i,
        b: i * 2,
        delta: i,
        pctChange: 1,
        ...perDayOf(i, i * 2, 7, 7),
      })),
      // Products with no row in period A: unknown-base under degradation, never ranked.
      unranked: Array.from({ length: 200 }, (_v, i) => ({
        productId: 1_000 + i,
        a: null,
        b: i,
        delta: null,
        pctChange: null,
        ...perDayOf(null, i, 7, 7),
        reasons: { a: "period A is not fully covered by sales_units data in every company" },
      })),
      reasons: { a: "period A is not fully covered by sales_units data in every company" },
      periodCoverage: { a: "partial", b: "partial" },
      unequalLengths: false,
      rankedBy: "total",
      directionCounts: { increased: 199, decreased: 0, unchanged: 1 },
      // A2 C8: the per-company entries carry names, and the note names the company. A
      // realistic length here: measured in M3, this 5 KB floor case holds through 120-char
      // company names and downgrades to truncated from ~150 (the column allows 191) —
      // recorded for the orchestrator, not hidden by this fixture.
      companyCoverage: [
        { companyId: "c1", salesDataStart: "2019-01-01", name: "Acme Peptides" },
        { companyId: "c2", salesDataStart: null, name: "Beta Labs" },
      ],
      companyCoverageNote: "no sales data recorded for Beta Labs; latest company start 2019-01-01",
      excludedUnapprovedProducts: 0,
    });

    const tight = (await runOnce("compare_periods", compareArgs, CRAMPED)) as ExecResult & {
      data?: { rows?: unknown[]; unranked?: unknown[]; unrankedTotal?: number };
      meta?: { bytes: number };
    };

    // NEVER the truncated downgrade — that is the failure this fitter exists to prevent.
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    // Neither array is starved by the other: each keeps at least one 255-char-name row.
    expect(tight.data!.rows!.length).toBeGreaterThan(0);
    expect(tight.data!.unranked!.length).toBeGreaterThan(0);
    // Both are PAGES of their arrays, not the whole thing.
    expect(tight.data!.rows!.length).toBeLessThan(200);
    expect(tight.data!.unranked!.length).toBeLessThan(200);
    expect(tight.data!.unrankedTotal).toBe(200);
    // ...and the completed payload fits the budget the adapter threaded in.
    expect(tight.meta!.bytes).toBeLessThanOrEqual(CRAMPED);
  });

  // A2 C3/C2: periods of different lengths rank by the per-day change, and the envelope
  // grows by rankedBy, counts + countsNote and coverage.rateDefinition. The measured
  // envelope must absorb all of it at the tightest budget: still an ok page, still fits.
  it("per-day ranking at a 5KB budget: rankedBy, counts and rateDefinition ride and the payload fits", async () => {
    compareByProductMock.mockResolvedValue({
      ranked: Array.from({ length: RANKED_ROWS }, (_v, i) => ({
        productId: i + 1,
        a: 274 + i,
        b: 31 + i,
        delta: 31 + i - (274 + i),
        pctChange: (31 + i - (274 + i)) / (274 + i),
        ...perDayOf(274 + i, 31 + i, 274, 30),
      })),
      unranked: [],
      reasons: {},
      periodCoverage: { a: "full", b: "full" },
      unequalLengths: true,
      rankedBy: "per_day",
      directionCounts: { increased: RANKED_ROWS, decreased: 0, unchanged: 0 },
      excludedUnapprovedProducts: 0,
    });
    const tight = (await runOnce(
      "compare_periods",
      {
        metric: "sales_units",
        periodA: { relativeDays: 274 },
        periodB: { relativeDays: 30 },
        groupBy: "product",
      },
      CRAMPED,
    )) as ExecResult & {
      data?: { rankedBy?: string; counts?: Record<string, number>; coverage?: Record<string, unknown> };
      meta?: { bytes: number };
    };
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.rows!.length).toBeGreaterThan(0);
    expect(tight.data!.rows!.length).toBeLessThan(RANKED_ROWS);
    expect(tight.data!.rankedBy).toBe("per_day");
    expect(tight.data!.counts).toEqual({
      ranked: RANKED_ROWS,
      increased: RANKED_ROWS,
      decreased: 0,
      unchanged: 0,
      unranked: 0,
    });
    expect(typeof tight.data!.coverage!.rateDefinition).toBe("string");
    expect(tight.meta!.bytes).toBeLessThanOrEqual(CRAMPED);
  });
});

// ---------------------------------------------------------------------------
// A2 M3 — one tight-budget case per paged tool M3 grows (plan §4 byte budgets): the
// as-of location echo + coverage keys (C9), the valuation unit prices on every product row
// (C6), and the movement breakdown's counts (C2). Each must still come back as a smaller
// OK page that fits the budget — never the truncation downgrade.
// ---------------------------------------------------------------------------

describe("A2 M3 — the grown envelopes and rows still shrink to fit", () => {
  const LONG = "N".repeat(255);

  it("get_stock_asof with locationId: the location echo + coverage keys ride and the page fits", async () => {
    asOfMock.mockImplementation(async (opts: { dayKey: string; byteBudget: number }) => {
      const page = fitPage(opts.byteBudget, TOTAL, (i) => ({
        productId: i,
        name: `Product ${i}`,
        units: i,
        seriesEndsAt: "2020-01-02",
        possiblyStale: false,
        pairsPresentOnDay: 1,
        knownPairs: 1,
      }));
      return {
        ...page,
        coverage: {
          dayKey: opts.dayKey,
          snapshotWatermark: "2020-01-02",
          snapshotDataStart: "2019-01-01",
          flaggedPairs: 0,
          watermarkScope: "all locations",
          notRecordedHere: 12,
          notRecordedHereNote:
            "products not recorded at this location on or before that day are not listed — " +
            "their stock there is unknown, not zero.",
        },
      };
    });
    const tight = (await runOnce("get_stock_asof", { dayKey: "2020-01-01", locationId: 2 }, TIGHT)) as ExecResult & {
      data?: { location?: { id: number; name: string } };
    };
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(asOfMock.mock.calls[0][0]).toMatchObject({ locationId: 2 });
    expect(tight.data!.location).toEqual({ id: 2, name: "L".repeat(100) });
    expect(tight.data!.rows!.length).toBeLessThan(TOTAL);
    expect(tight.data!.nextOffset).not.toBeNull();
    expect(tight.meta!.bytes).toBeLessThanOrEqual(TIGHT);
  });

  it("get_valuation groupBy product: unit prices on every 255-character-name row, and the page fits", async () => {
    (getValuation as jest.Mock).mockResolvedValue({
      groupBy: "product",
      rows: Array.from({ length: TOTAL }, (_v, i) => ({
        productId: i + 1,
        name: LONG,
        units: 1_000_000,
        atCurrentCostCents: 2_147_483_647,
        atReceiptCostCents: 2_147_483_647,
        atRetailCents: 2_147_483_647,
        marginCents: -2_147_483_647,
        currentUnitCostCents: 2_147_483_647,
        unitRetailCents: 2_147_483_647,
      })),
      coverage: {
        costedProducts: TOTAL, ofProducts: TOTAL, costedUnits: 1, ofUnits: 1, retailPricedProducts: TOTAL,
        retailPricedUnits: 1, receiptCostedProducts: TOTAL, receiptCostedUnits: 1, marginProducts: TOTAL, marginUnits: 1,
      },
    });
    const tight = (await runOnce("get_valuation", { groupBy: "product" }, TIGHT)) as ExecResult & {
      data?: { rows?: Array<Record<string, unknown>> };
    };
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.rows!.length).toBeGreaterThan(0);
    expect(tight.data!.rows!.length).toBeLessThan(TOTAL);
    for (const row of tight.data!.rows!) {
      expect(row).toHaveProperty("currentUnitCostCents");
      expect(row).toHaveProperty("unitRetailCents");
    }
    expect(tight.meta!.bytes).toBeLessThanOrEqual(TIGHT);
  });

  it("get_movement_series breakdownBy product: whole-result counts ride beside a shrunk page that fits", async () => {
    const zero = {
      stockIn: 0, correctionIn: 0, adjustmentIn: 0, countIn: 0, sale: 0, classifiedLoss: 0,
      adjustmentUnclassified: 0, correctionUnclassified: 0, countOut: 0, transferIn: 0, transferOut: 0, net: 0,
    };
    (getMovementByProduct as jest.Mock).mockResolvedValue({
      mode: "by_product",
      window: { from: "2020-01-01", to: "2020-01-30", days: 30, source: "relative" },
      filters: { productId: null, productIds: null, locationId: 2, locationName: "L".repeat(100), mode: "by_product" },
      rows: Array.from({ length: TOTAL }, (_v, i) => ({
        productId: i + 1,
        name: LONG,
        lifecycle: "active",
        outboundUnits: i % 2 === 0 ? 5 : 0,
        ...zero,
        sale: i % 2 === 0 ? -5 : 0,
        stockIn: i % 3 === 0 ? 4 : 0,
        net: (i % 2 === 0 ? -5 : 0) + (i % 3 === 0 ? 4 : 0),
      })),
      coverage: {
        unclassifiedLegacyNote: UNCLASSIFIED_LEGACY_NOTE,
        reasonCodeNullRows: 3,
        excludedUnapprovedProducts: 0,
        archivedProductsIncluded: 0,
        approvalNote: "approved products only",
      },
    });
    const tight = (await runOnce("get_movement_series", { breakdownBy: "product", locationId: 2 }, TIGHT)) as ExecResult & {
      data?: { counts?: Record<string, number>; countsNote?: string };
    };
    expect(tight.status).toBe("ok");
    expect(tight.notice).toBeUndefined();
    expect(tight.data!.rows!.length).toBeGreaterThan(0);
    expect(tight.data!.rows!.length).toBeLessThan(TOTAL);
    expect(tight.data!.counts).toEqual({ products: TOTAL, withOutbound: TOTAL / 2, withInbound: TOTAL / 3 });
    expect(typeof tight.data!.countsNote).toBe("string");
    expect(tight.meta!.bytes).toBeLessThanOrEqual(TIGHT);
  });
});
