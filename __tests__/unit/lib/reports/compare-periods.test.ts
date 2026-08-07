/**
 * @jest-environment node
 *
 * assistant toolsuite breadth — W2-CMP: the cross-period compare module
 * (lib/reports/compare-periods.ts, spec §5 T-CMP REV-2 zero-vs-unknown rule).
 *
 * Pins:
 *   - the zero-vs-unknown rule: a period with no matching rows is `0` ONLY when
 *     the metric's dataStart <= the period's start day-key; otherwise it is
 *     `null` + a named "predates data" reason (growth from pre-history must read
 *     unknown, never growth-from-zero);
 *   - delta/pctChange only compute when BOTH periods are known, and pctChange is
 *     null (with a reason) when period A is exactly zero;
 *   - unequalLengths is a disclosure-only flag (comparison still runs);
 *   - MANDATORY companyIds scoping on sales_units/sales_revenue (never leaks
 *     another company's facts);
 *   - the exact ledger predicate per metric (outbound_units = PHYSICAL_OUTBOUND_WHERE,
 *     inbound_units = positive-delta non-TRANSFER, stated inline in the module).
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import type { ResolvedWindow } from "@/lib/assistant/window";

jest.mock("@/lib/prisma", () => {
  const { mockDeep } = require("jest-mock-extended");
  return { __esModule: true, default: mockDeep() };
});

import prisma from "@/lib/prisma";
import { comparePeriods, comparePeriodsByProduct } from "@/lib/reports/compare-periods";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

/** Inclusive day-key window fixture, mirroring lib/assistant/window.ts's ResolvedWindow shape. */
const win = (from: string, to: string): ResolvedWindow => ({
  from,
  to,
  days:
    Math.round(
      (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
    ) + 1,
  source: "explicit",
});

/** Sales aggregate mock: dataStart call then two value calls, in that call order. */
function mockSales(dataStartDayKey: string | null, sumA: number | null, sumB: number | null, field: "orderedQty" | "revenue") {
  db.productSalesFact.aggregate
    .mockResolvedValueOnce({ _min: { dayKey: dataStartDayKey } } as never)
    .mockResolvedValueOnce({ _sum: { [field]: sumA } } as never)
    .mockResolvedValueOnce({ _sum: { [field]: sumB } } as never);
}

/** Ledger aggregate mock: dataStart call then two value calls, in that call order. */
function mockLedger(dataStartChangeTime: Date | null, deltaA: number | null, deltaB: number | null) {
  db.inventory_logs.aggregate
    .mockResolvedValueOnce({ _min: { changeTime: dataStartChangeTime } } as never)
    .mockResolvedValueOnce({ _sum: { delta: deltaA } } as never)
    .mockResolvedValueOnce({ _sum: { delta: deltaB } } as never);
}

beforeEach(() => {
  mockReset(db);
});

describe("zero-vs-unknown rule", () => {
  it("periodA predating dataStart -> a is null with a named reason; delta/pctChange null", async () => {
    // dataStart 2026-06-01; periodA entirely before it; periodB entirely after.
    mockSales("2026-06-01", null, 50, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-05-01", "2026-05-07"),
      periodB: win("2026-06-10", "2026-06-16"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBeNull();
    expect(res.b).toBe(50);
    expect(res.delta).toBeNull();
    expect(res.pctChange).toBeNull();
    expect(res.reasons.a).toBe("periodA predates sales_units data (starts 2026-06-01)");
    expect(res.reasons.b).toBeUndefined();
  });

  it("periodB predating dataStart -> b is null with a named reason (symmetric)", async () => {
    mockLedger(new Date("2026-06-01T00:00:00.000Z"), 100, null);

    const res = await comparePeriods({
      metric: "outbound_units",
      periodA: win("2026-06-10", "2026-06-16"),
      periodB: win("2026-05-01", "2026-05-07"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBe(100);
    expect(res.b).toBeNull();
    expect(res.delta).toBeNull();
    expect(res.pctChange).toBeNull();
    expect(res.reasons.b).toBe("periodB predates outbound_units data (starts 2026-06-01)");
  });

  it("absent rows count as 0 when dataStart <= periodStart (source complete for the interval)", async () => {
    // dataStart before both periods; periodA has literally no matching rows.
    mockSales("2026-01-01", null, 20, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-10", "2026-06-16"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBe(0);
    expect(res.reasons.a).toBeUndefined();
    expect(res.b).toBe(20);
    expect(res.delta).toBe(20);
  });

  it("no data at all ever recorded (dataStart null) -> both periods null with a reason, no fabricated date", async () => {
    mockSales(null, null, null, "revenue");

    const res = await comparePeriods({
      metric: "sales_revenue",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-10", "2026-06-16"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBeNull();
    expect(res.b).toBeNull();
    expect(res.reasons.a).toBe("no sales_revenue data recorded");
    expect(res.reasons.b).toBe("no sales_revenue data recorded");
  });

  it("periodA straddles dataStart (window.from < dataStart <= window.to) WITH matching rows -> null + not-fully-covered reason, never the partial sum", async () => {
    // dataStart 2026-06-05 lands strictly inside periodA's 2026-06-01..2026-06-10 span.
    // Some rows exist (the covered tail), but the source does not cover the WHOLE
    // interval, so the partial sum must never be surfaced as an authoritative value.
    mockSales("2026-06-05", 30, 50, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-10"),
      periodB: win("2026-06-11", "2026-06-20"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBeNull();
    expect(res.reasons.a).toBe("period A is not fully covered by sales_units data (starts 2026-06-05)");
    expect(res.b).toBe(50);
    expect(res.delta).toBeNull();
    expect(res.pctChange).toBeNull();
  });

  it("periodA straddles dataStart WITH zero matching rows -> null + not-fully-covered reason, never a manufactured 0", async () => {
    // Same straddling window, but literally no rows landed anywhere in it (covered or not).
    mockSales("2026-06-05", null, 50, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-10"),
      periodB: win("2026-06-11", "2026-06-20"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBeNull();
    expect(res.reasons.a).toBe("period A is not fully covered by sales_units data (starts 2026-06-05)");
    expect(res.b).toBe(50);
  });
});

describe("both periods known", () => {
  it("computes delta = b - a and pctChange = (b-a)/a", async () => {
    mockLedger(new Date("2026-01-01T00:00:00.000Z"), 100, 150);

    const res = await comparePeriods({
      metric: "outbound_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBe(100);
    expect(res.b).toBe(150);
    expect(res.delta).toBe(50);
    expect(res.pctChange).toBeCloseTo(0.5);
    expect(res.reasons).toEqual({});
  });
});

describe("percent-change undefined when period A is zero", () => {
  it("a === 0 (real absence counted as 0) -> pctChange null with the exact reason, delta still computed", async () => {
    mockLedger(new Date("2026-01-01T00:00:00.000Z"), null, 30);

    const res = await comparePeriods({
      metric: "inbound_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });

    expect(res.a).toBe(0);
    expect(res.b).toBe(30);
    expect(res.delta).toBe(30);
    expect(res.pctChange).toBeNull();
    expect(res.reasons.pctChange).toBe("period A is zero — percent change undefined");
  });
});

describe("unequalLengths", () => {
  it("flags when the two windows span a different number of days, but still computes the comparison", async () => {
    mockSales("2026-01-01", 10, 20, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"), // 7 days
      periodB: win("2026-06-08", "2026-06-21"), // 14 days
      companyIds: ["co-1"],
    });

    expect(res.unequalLengths).toBe(true);
    expect(res.a).toBe(10);
    expect(res.b).toBe(20);
    expect(res.delta).toBe(10);
  });

  it("does not flag when both windows span the same number of days", async () => {
    mockSales("2026-01-01", 10, 20, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });

    expect(res.unequalLengths).toBe(false);
  });
});

describe("caller scoping — sales metrics never leak other companies", () => {
  it("every productSalesFact.aggregate call is constrained to companyId IN companyIds", async () => {
    mockSales("2026-01-01", 5, 8, "orderedQty");

    await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1", "co-2"],
    });

    expect(db.productSalesFact.aggregate).toHaveBeenCalledTimes(3);
    for (const call of db.productSalesFact.aggregate.mock.calls) {
      const where = (call[0] as { where: { companyId: { in: string[] } } }).where;
      expect(where.companyId).toEqual({ in: ["co-1", "co-2"] });
    }
  });

  it("empty companyIds never reaches the DB and reads as no data (hard isolation)", async () => {
    const res = await comparePeriods({
      metric: "sales_revenue",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: [],
    });

    expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
    expect(res.a).toBeNull();
    expect(res.b).toBeNull();
    expect(res.reasons.a).toBe("no sales_revenue data recorded");
  });
});

describe("productId narrowing", () => {
  // FD2-1 reshaped this read graph: a product-scoped call now issues TWO `_min` reads —
  // the SOURCE-level one behind the per-company coverage question (never product-scoped,
  // see the FD2-1 describe) and the CALLER-WIDE one that keeps its product scope because
  // it is the date the predates/straddles reasons quote. So the mock dispatches on shape
  // rather than on call order, and the assertion is about the PRODUCT-SCOPED reads.
  it("narrows sales aggregates by productId when provided", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args?._min
          ? { _min: { dayKey: "2026-01-01" } }
          : { _sum: { orderedQty: args?.where?.dayKey?.gte === "2026-06-01" ? 3 : 4 } },
      ) as never,
    );

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      productId: 42,
      companyIds: ["co-1"],
    });
    expect(res.a).toBe(3);
    expect(res.b).toBe(4);

    // quality+reach Task 3.1: productId and the G5 approved-id set narrow the SAME
    // column, so the read builds ONE IntFilter (`equals` + `in`) rather than two
    // `productId` keys where the second silently overwrites the first.
    const scoped = db.productSalesFact.aggregate.mock.calls
      .map((call) => call[0] as { _min?: unknown; where: { productId?: { equals?: number; in?: number[] } } })
      .filter((args) => args.where.productId?.equals != null);
    // The two VALUE reads plus the caller-wide start: every product-scoped read carries
    // BOTH halves of the filter.
    expect(scoped).toHaveLength(3);
    expect(scoped.filter((args) => args._min != null)).toHaveLength(1);
    for (const args of scoped) {
      expect(args.where.productId?.equals).toBe(42);
      expect(Array.isArray(args.where.productId?.in)).toBe(true);
    }
  });

  it("narrows ledger aggregates by productId when provided", async () => {
    mockLedger(new Date("2026-01-01T00:00:00.000Z"), 3, 4);

    await comparePeriods({
      metric: "outbound_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      productId: 7,
      companyIds: ["co-1"],
    });

    for (const call of db.inventory_logs.aggregate.mock.calls) {
      expect((call[0] as { where: { productId?: { equals?: number } } }).where.productId?.equals).toBe(7);
    }
  });
});

describe("per-metric predicate", () => {
  it("outbound_units uses PHYSICAL_OUTBOUND_WHERE (delta<0, logType != TRANSFER)", async () => {
    mockLedger(new Date("2026-01-01T00:00:00.000Z"), 3, 4);

    await comparePeriods({
      metric: "outbound_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });

    const dataStartCall = db.inventory_logs.aggregate.mock.calls[0][0] as {
      where: { delta: unknown; logType: unknown };
    };
    expect(dataStartCall.where.delta).toEqual({ lt: 0 });
    expect(dataStartCall.where.logType).toEqual({ not: "TRANSFER" });
  });

  it("inbound_units uses positive-delta non-TRANSFER (delta>0, logType != TRANSFER)", async () => {
    mockLedger(new Date("2026-01-01T00:00:00.000Z"), 3, 4);

    await comparePeriods({
      metric: "inbound_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });

    const dataStartCall = db.inventory_logs.aggregate.mock.calls[0][0] as {
      where: { delta: unknown; logType: unknown };
    };
    expect(dataStartCall.where.delta).toEqual({ gt: 0 });
    expect(dataStartCall.where.logType).toEqual({ not: "TRANSFER" });
  });

  it("sales_units sums orderedQty; sales_revenue sums revenue — distinct fields, same scope shape", async () => {
    mockSales("2026-01-01", 1, 2, "orderedQty");
    await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });
    const unitsValueCall = db.productSalesFact.aggregate.mock.calls[1][0] as { _sum: Record<string, unknown> };
    expect(unitsValueCall._sum).toEqual({ orderedQty: true });

    db.productSalesFact.aggregate.mockReset();
    mockSales("2026-01-01", 1, 2, "revenue");
    await comparePeriods({
      metric: "sales_revenue",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      companyIds: ["co-1"],
    });
    const revenueValueCall = db.productSalesFact.aggregate.mock.calls[1][0] as { _sum: Record<string, unknown> };
    expect(revenueValueCall._sum).toEqual({ revenue: true });
  });
});

// ---------------------------------------------------------------------------
// FD-1 — STAGGERED COMPANY STARTS, in BOTH modes (seam S8).
//
// get_sales classifies a multi-membership caller's window PER COMPANY: the
// latest-starting company governs, because a silence in a company that was not yet
// recording is not a measured zero. compare_periods read the CALLER-WIDE minimum alone,
// so the same seeded source was "fully covered" here and "partial" there — and the
// disagreement was not cosmetic: it decided whether a period's absent sum became a
// measured 0 (scalar delta computed from a manufactured base) and whether a by_product
// row got a measured 0 for a company that had no data in that window.
//
// Both modes now route through the SAME classifier (`callerWindowCoverage`), so one
// seeded source can only ever produce one verdict.
//
// FD2-2 NARROWED WHAT THAT VERDICT DOES (assertions below were INVERTED where they
// pinned the over-reach): a degraded window governs ZERO LEGALITY only. No measured zero
// may be synthesized and no growth-from-zero may be computed, but a MEASURED sum over
// rows that really were recorded is a true statement about recorded facts and is
// RETURNED, with the per-company disclosure beside it. Discarding it invented a second
// failure — "we recorded these sales but will not tell you" — out of the fix for the
// first, and made compare contradict get_sales, which has always returned its measured
// rows under a partial window and nulled only the SYNTHESIZED ones.
// ---------------------------------------------------------------------------

describe("FD-1 staggered company starts — the latest company governs in BOTH modes", () => {
  const PERIOD_A = win("2026-06-01", "2026-06-07");
  const PERIOD_B = win("2026-06-08", "2026-06-14");

  /** One seeded sales source: a caller-wide start plus the per-company starts, and (for
   *  by_product) the per-product sums. The groupBy delegate is shared by the per-company
   *  starts read and the per-product sums, so it dispatches on the SHAPE each one sends.
   *
   *  FD2-2: the SCALAR sums are seeded too (`sumA`/`sumB`, default null = NO rows in the
   *  period). Degraded coverage now only decides whether ABSENCE may read as zero, so
   *  "did this period have rows?" is the question these fixtures have to be able to ask. */
  function seedStaggered(opts: {
    callerWide: string | null;
    companyStarts: Array<{ companyId: string; _min: { dayKey: string | null } }>;
    sumA?: number | null;
    sumB?: number | null;
    a?: Array<{ productId: number; _sum: { orderedQty: number } }>;
    b?: Array<{ productId: number; _sum: { orderedQty: number } }>;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args?._min
          ? { _min: { dayKey: opts.callerWide } }
          : {
              _sum: {
                orderedQty:
                  args?.where?.dayKey?.gte === PERIOD_A.from ? opts.sumA ?? null : opts.sumB ?? null,
              },
            },
      ) as never,
    );
    let periodCall = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) => {
      if (args?.by?.[0] === "companyId") return Promise.resolve(opts.companyStarts) as never;
      return Promise.resolve((periodCall++ === 0 ? opts.a : opts.b) ?? []) as never;
    });
    db.product.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }] as never);
  }

  // FD2-2 (inversion, scope): this case is now pinned for what it always WAS — a
  // degraded window with NO rows in either period (the seed sums default to null). The
  // title used to claim degradation nulls both periods outright; it nulls them because
  // absence under degradation is UNKNOWN, never because the sums were thrown away. The
  // measured-sum half of the rule is pinned in the FD2-2 describe below.
  it("SCALAR: with NO rows in either period, a late-starting company leaves both null + a per-company reason", async () => {
    seedStaggered({
      // c1 has recorded since 2020 — the caller-wide minimum says "fully covered".
      callerWide: "2020-01-01",
      companyStarts: [
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2099-01-01" } },
      ],
    });

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBeNull();
    expect(res.b).toBeNull();
    expect(res.delta).toBeNull();
    expect(res.pctChange).toBeNull();
    // The reason names the REAL cause: not "predates the data" (the caller-wide start is
    // six years before the window), but a member company that was not recording.
    expect(res.reasons.a).toContain("in every company");
    expect(res.reasons.a).toContain("latest-starting company governs");
    expect(res.reasons.b).toContain("in every company");
  });

  // FD2-2 (inversion, scope): same narrowing — a factless company degrades ZERO legality
  // just as hard, and with no rows in either period that is exactly a null + reason.
  it("SCALAR: a company with NO facts at all governs zero legality just as hard", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      // c2 has no facts, so the per-company read returns no group for it.
      companyStarts: [{ companyId: "c1", _min: { dayKey: "2020-01-01" } }],
    });

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBeNull();
    expect(res.b).toBeNull();
    expect(res.reasons.a).toContain("in every company");
  });

  it("SCALAR: a staggered set whose LATEST start still covers the window measures normally", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      companyStarts: [
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2021-06-01" } }, // still well before the window
      ],
      sumA: 10,
      sumB: 15,
    });

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBe(10);
    expect(res.b).toBe(15);
    expect(res.delta).toBe(5);
    expect(res.reasons.a).toBeUndefined();
    // FD3-1: the staggering is DISCLOSED (the starts really do differ)...
    expect(res.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01" },
      { companyId: "c2", salesDataStart: "2021-06-01" },
    ]);
    expect(res.companyCoverageNote).toContain("latest-starting company governs zero legality");
    // ...but NEITHER period classified "partial", so the MEASURED-note sentence — which
    // says "a period with no matching rows reads null + a reason instead of 0" — describes
    // a rule that did not fire here. It is a true sentence about degraded coverage attached
    // to a result whose coverage is not degraded, i.e. a false claim about THIS answer.
    expect(res.companyCoverageNote).not.toContain("MEASURED");
    expect(res.companyCoverageNote).not.toContain("ZERO legality");
    expect(res.periodCoverage).toEqual({ a: "full", b: "full" });
  });

  // FD2-2 INVERSION (this test previously pinned the discard). It asserted that a
  // degraded window left EVERY row unknown, INCLUDING product 1 — whose 10 and 30 units
  // are rows that were really recorded in the company that really was recording. That is
  // the defect: degradation kills the manufactured zero (product 2's absent period A),
  // never the measured sum. The assertions are inverted accordingly; the manufactured-
  // zero half is still pinned, on the row it actually applies to.
  it("BY_PRODUCT: a degraded window keeps MEASURED rows ranked and unranks only the ABSENT ones", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      companyStarts: [
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2099-01-01" } },
      ],
      a: [{ productId: 1, _sum: { orderedQty: 10 } }],
      // Product 2 sold in B only. Under the caller-wide start alone it was a RANKED
      // "started moving" row with a MEASURED a of 0 — growth from a base nobody measured.
      b: [
        { productId: 1, _sum: { orderedQty: 30 } },
        { productId: 2, _sum: { orderedQty: 12 } },
      ],
    });

    const res = await comparePeriodsByProduct({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    // The window IS degraded — the disclosure is unchanged.
    expect(res.periodCoverage).toEqual({ a: "partial", b: "partial" });
    // Product 1 has real rows in BOTH periods: measured, ranked, delta computed.
    expect(res.ranked).toHaveLength(1);
    expect(res.ranked[0]).toMatchObject({ productId: 1, a: 10, b: 30, delta: 20 });
    // Product 2 has NO row in period A. Under degradation that absence is UNKNOWN, so it
    // must never become the measured 0 a "started moving" claim would be computed from.
    expect(res.unranked.map((r) => r.productId)).toEqual([2]);
    expect(res.unranked[0].a).toBeNull();
    expect(res.unranked[0].b).toBe(12);
    expect(res.unranked[0].delta).toBeNull();
    expect(res.unranked[0].pctChange).toBeNull();
    expect(res.reasons.a).toContain("in every company");
    // The null-start/late company is NAMED, not just alluded to.
    expect(res.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01" },
      { companyId: "c2", salesDataStart: "2099-01-01" },
    ]);
  });

  it("BY_PRODUCT: an un-staggered caller still measures zeros (the rule only DEGRADES)", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      companyStarts: [
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2020-01-01" } },
      ],
      a: [],
      b: [{ productId: 2, _sum: { orderedQty: 12 } }],
    });

    const res = await comparePeriodsByProduct({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.periodCoverage).toEqual({ a: "full", b: "full" });
    expect(res.unranked).toEqual([]);
    expect(res.ranked).toHaveLength(1);
    expect(res.ranked[0].a).toBe(0); // a MEASURED zero: both companies covered period A
    expect(res.ranked[0].b).toBe(12);
  });

  // -------------------------------------------------------------------------
  // FD2-2 — degraded coverage governs ZERO LEGALITY ONLY.
  //
  // The FD-1 fix classified per company (right) and then discarded every value the
  // degraded classification touched (wrong). A sum over rows that were recorded is a
  // TRUE statement about recorded facts; the only thing per-company degradation may
  // take away is the right to turn SILENCE into a measured zero. get_sales has always
  // had this shape — real rows are returned under a 'partial' window and only the
  // SYNTHESIZED zero rows go null-with-a-reason — so this is also what makes the two
  // surfaces agree about one seeded source (seam S8).
  // -------------------------------------------------------------------------

  it("SCALAR: a FACTLESS member company degrades coverage but the MEASURED sums survive", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      // c2 has no facts at all — the strongest degradation there is.
      companyStarts: [{ companyId: "c1", _min: { dayKey: "2020-01-01" } }],
      sumA: 40,
      sumB: 60,
    });

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    // 40 and 60 units really were recorded in c1's window. Refusing to report them is not
    // caution, it is a second falsehood.
    expect(res.a).toBe(40);
    expect(res.b).toBe(60);
    expect(res.delta).toBe(20);
    expect(res.pctChange).toBeCloseTo(0.5);
    // A measured value carries NO reason...
    expect(res.reasons.a).toBeUndefined();
    expect(res.reasons.b).toBeUndefined();
    // ...the degradation rides as a DISCLOSURE instead, naming the null-start company.
    expect(res.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01" },
      { companyId: "c2", salesDataStart: null },
    ]);
    expect(res.companyCoverageNote).toContain("c2");
    expect(res.companyCoverageNote).toContain("latest-starting company governs zero legality");
    // FD3-1 (the other direction): here a period REALLY IS partial, so the measured-note
    // sentence is a true statement about this answer and must ship.
    expect(res.periodCoverage).toEqual({ a: "partial", b: "partial" });
    expect(res.companyCoverageNote).toContain("MEASURED");
  });

  it("SCALAR: under degradation a period with NO rows is null + a reason (the zero is never manufactured)", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      companyStarts: [{ companyId: "c1", _min: { dayKey: "2020-01-01" } }],
      sumA: null, // no rows at all in period A
      sumB: 60,
    });

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBeNull();
    expect(res.reasons.a).toContain("in every company");
    expect(res.reasons.a).toContain("c2");
    // ...and B, which HAS rows, keeps its measured sum. No delta: one side is unknown, so
    // "growth from zero" is exactly what must not be computed.
    expect(res.b).toBe(60);
    expect(res.reasons.b).toBeUndefined();
    expect(res.delta).toBeNull();
    expect(res.pctChange).toBeNull();
  });

  it("an UN-degraded caller carries no companyCoverage disclosure at all", async () => {
    seedStaggered({
      callerWide: "2020-01-01",
      companyStarts: [
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2020-01-01" } },
      ],
      sumA: 5,
      sumB: 9,
    });

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBe(5);
    expect(res.companyCoverage).toBeUndefined();
    expect(res.companyCoverageNote).toBeUndefined();
  });

  it("LEDGER metrics have no company dimension, so the per-company rule never fires", async () => {
    // Same staggered membership; an inventory metric is global, so the ledger dataStart
    // alone decides — and no per-company read is issued for it at all.
    db.productSalesFact.groupBy.mockResolvedValue([] as never);
    mockLedger(new Date("2020-01-01T00:00:00.000Z"), -10, -25);
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);

    const res = await comparePeriods({
      metric: "outbound_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBe(10);
    expect(res.b).toBe(25);
    expect(db.productSalesFact.groupBy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FD2-1 — the per-company coverage question is asked SOURCE-LEVEL.
//
// `productId` narrows which VALUES are summed. It must never narrow "was this company
// recording sales at all?" — folding it into the per-company starts turned a company
// that simply never sold THAT product into a company with no coverage, degraded the
// window on that basis, and (pre-FD2-2) nulled the sums of the company that WAS
// recording. get_sales asks the identical question source-level (`salesDataStart`
// carries no productId), so seam S8 only holds if compare asks it the same way.
// ---------------------------------------------------------------------------

describe("FD2-1 per-company coverage is SOURCE-level, never product-narrowed", () => {
  const PERIOD_A = win("2026-06-01", "2026-06-07");
  const PERIOD_B = win("2026-06-08", "2026-06-14");

  /** Two RECORDING companies; product 42 has only ever sold in c1. The delegates
   *  dispatch on whether the read carries the productId equality, so the source-level
   *  question and the product-scoped one can answer differently — which is the whole
   *  point of the finding. */
  function seedProductNarrowed() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) => {
      if (args?._min) {
        // Product-scoped: the product's own first fact. Source-level: the company's.
        return Promise.resolve({
          _min: { dayKey: args?.where?.productId?.equals === 42 ? "2026-01-01" : "2020-01-01" },
        }) as never;
      }
      const from = args?.where?.dayKey?.gte;
      return Promise.resolve({ _sum: { orderedQty: from === PERIOD_A.from ? 10 : 15 } }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) => {
      if (args?.where?.productId?.equals === 42) {
        // c2 never sold this product, so a product-scoped per-company read omits it.
        return Promise.resolve([{ companyId: "c1", _min: { dayKey: "2026-01-01" } }]) as never;
      }
      return Promise.resolve([
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2021-01-01" } },
      ]) as never;
    });
    db.product.findMany.mockResolvedValue([{ id: 42 }] as never);
  }

  it("a product absent from one company is NOT a coverage gap there — both periods stay MEASURED", async () => {
    seedProductNarrowed();

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      productId: 42,
      companyIds: ["c1", "c2"],
    });

    // Both companies were recording throughout both windows; the product simply never
    // sold in c2. That is a measured zero contribution, not an unknown.
    expect(res.a).toBe(10);
    expect(res.b).toBe(15);
    expect(res.delta).toBe(5);
    expect(res.pctChange).toBeCloseTo(0.5);
    expect(res.reasons.a).toBeUndefined();
    expect(res.reasons.b).toBeUndefined();
  });

  it("the per-company coverage read carries NO productId equality; the VALUE reads carry it", async () => {
    seedProductNarrowed();

    await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      productId: 42,
      companyIds: ["c1", "c2"],
    });

    const perCompanyCalls = db.productSalesFact.groupBy.mock.calls
      .map((call) => call[0] as { by?: string[]; where?: { productId?: { equals?: number; in?: number[] } } })
      .filter((args) => args?.by?.[0] === "companyId");
    expect(perCompanyCalls.length).toBeGreaterThan(0);
    for (const args of perCompanyCalls) {
      // The APPROVED-universe narrowing stays (G5); the productId equality does not.
      expect(args.where?.productId?.equals).toBeUndefined();
      expect(Array.isArray(args.where?.productId?.in)).toBe(true);
    }

    // The VALUE reads are still product-scoped — that is what the caller asked for.
    const valueCalls = db.productSalesFact.aggregate.mock.calls
      .map((call) => call[0] as { _sum?: unknown; where: { productId?: { equals?: number } } })
      .filter((args) => args._sum != null);
    expect(valueCalls).toHaveLength(2);
    for (const args of valueCalls) expect(args.where.productId?.equals).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// FD3-3 — a DELTA across periods whose coverage differs is not like-for-like.
//
// FD2-2 made the right call for the values (a measured sum is a true statement about
// recorded facts, so it is reported) and left the DERIVED figure unqualified: with c2's
// facts beginning inside period B, `delta` silently compares "c1 alone" against
// "c1 + c2" and reads as growth. Nulling the delta would re-break FD2-2 — the sums are
// real — so the fix is a NAMED qualification riding beside a delta that still computes.
// ---------------------------------------------------------------------------

describe("FD3-3 coverage shift between the two periods", () => {
  const PERIOD_A = win("2026-06-01", "2026-06-07");
  const PERIOD_B = win("2026-06-08", "2026-06-14");

  /** The finding's scenario: c1 has always recorded; c2's first fact lands on the first
   *  day of period B. Both periods have MEASURED sums (FD2-2), so the delta computes. */
  function seedShift(companyStarts: Array<{ companyId: string; _min: { dayKey: string | null } }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args?._min
          ? { _min: { dayKey: "2020-01-01" } }
          : { _sum: { orderedQty: args?.where?.dayKey?.gte === PERIOD_A.from ? 100 : 160 } },
      ) as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      args?.by?.[0] === "companyId" ? (Promise.resolve(companyStarts) as never) : (Promise.resolve([]) as never),
    );
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);
  }

  it("c2's facts begin inside period B: the delta stands, qualified by reasons.delta + coverageShift", async () => {
    seedShift([
      { companyId: "c1", _min: { dayKey: "2020-01-01" } },
      { companyId: "c2", _min: { dayKey: "2026-06-08" } },
    ]);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    // FD2-2 stays intact: measured sums, and a delta that is NEVER nulled.
    expect(res.a).toBe(100);
    expect(res.b).toBe(160);
    expect(res.delta).toBe(60);
    // Parity with by_product (FD3-3): totals mode classifies both periods too — and here
    // the two classifications DIFFER, which is the machine-readable half of the signal.
    expect(res.periodCoverage).toEqual({ a: "partial", b: "full" });
    // The prose half NAMES the company and its date, and says what the delta is not.
    expect(res.coverageShift).toContain("c2");
    expect(res.coverageShift).toContain("2026-06-08");
    expect(res.coverageShift).toContain("period B");
    expect(res.coverageShift).toContain("period A");
    expect(res.coverageShift).toContain("not like-for-like");
    expect(res.reasons.delta).toBe(res.coverageShift);
  });

  it("a start landing STRICTLY INSIDE a period shifts it too (equal classifications are not enough)", async () => {
    // 2026-06-10 is inside period B but covers neither period's start, so BOTH periods
    // classify "partial" — the classification comparison alone cannot see this one.
    seedShift([
      { companyId: "c1", _min: { dayKey: "2020-01-01" } },
      { companyId: "c2", _min: { dayKey: "2026-06-10" } },
    ]);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.periodCoverage).toEqual({ a: "partial", b: "partial" });
    expect(res.delta).toBe(60);
    expect(res.coverageShift).toContain("c2");
    expect(res.coverageShift).toContain("2026-06-10");
    expect(res.reasons.delta).toBe(res.coverageShift);
  });

  it("equally-covered periods carry NO shift keys (the qualification is not boilerplate)", async () => {
    // Staggered starts — but both are years before period A, so each period sees exactly
    // the same set of recording companies. Nothing shifted.
    seedShift([
      { companyId: "c1", _min: { dayKey: "2020-01-01" } },
      { companyId: "c2", _min: { dayKey: "2021-06-01" } },
    ]);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.periodCoverage).toEqual({ a: "full", b: "full" });
    expect(res.delta).toBe(60);
    expect(res.coverageShift).toBeUndefined();
    expect(res.reasons.delta).toBeUndefined();
  });

  it("a LEDGER metric (no company dimension) carries periodCoverage and no shift", async () => {
    mockLedger(new Date("2020-01-01T00:00:00.000Z"), -10, -25);
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);

    const res = await comparePeriods({
      metric: "outbound_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.periodCoverage).toEqual({ a: "full", b: "full" });
    expect(res.coverageShift).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FD3-4 / FD3-7 — a PRODUCT-scoped comparison says which question it answered.
//
// `productId` narrows the VALUES, never the per-company coverage question (FD2-1). Two
// consequences were left unsaid: a product with no facts at all still dragged the
// caller's staggered-company disclosure along (a coverage explanation for a nullity that
// coverage did not cause), and the predates/straddles reasons quoted the PRODUCT's own
// first fact under a sentence that reads like a statement about the data source.
// ---------------------------------------------------------------------------

describe("FD3-4/FD3-7 product-scoped reasons name the product, not the source", () => {
  const PERIOD_A = win("2026-01-01", "2026-01-31");
  const PERIOD_B = win("2026-06-01", "2026-06-30");

  /** Staggered companies (so the disclosure WOULD ride) + a product-scoped first fact. */
  function seedProduct(productStart: string | null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) => {
      if (args?._min) {
        // Product-scoped read -> the product's own first fact; source-level -> the caller's.
        return Promise.resolve({
          _min: { dayKey: args?.where?.productId?.equals === 42 ? productStart : "2020-01-01" },
        }) as never;
      }
      return Promise.resolve({ _sum: { orderedQty: args?.where?.dayKey?.gte === PERIOD_A.from ? null : 12 } }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      args?.by?.[0] === "companyId"
        ? (Promise.resolve([
            { companyId: "c1", _min: { dayKey: "2020-01-01" } },
            { companyId: "c2", _min: { dayKey: "2021-06-01" } },
          ]) as never)
        : (Promise.resolve([]) as never),
    );
    db.product.findMany.mockResolvedValue([{ id: 42 }] as never);
  }

  it("FD3-4: a product with NO facts reads 'for this product' and drops the companyCoverage disclosure", async () => {
    seedProduct(null);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      productId: 42,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBeNull();
    expect(res.b).toBeNull();
    // The reason is about THIS PRODUCT — the caller's companies have recorded sales since
    // 2020, so the unscoped sentence read as "we have no sales data", which is false.
    expect(res.reasons.a).toBe("no sales_units data recorded for this product");
    expect(res.reasons.b).toBe("no sales_units data recorded for this product");
    // ...and the staggered-company disclosure does not ride along: it explains a
    // degradation that had nothing to do with these nulls.
    expect(res.companyCoverage).toBeUndefined();
    expect(res.companyCoverageNote).toBeUndefined();
  });

  it("FD3-7: the predates reason names the product's first fact AND the source start", async () => {
    seedProduct("2026-05-01");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      productId: 42,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBeNull();
    expect(res.reasons.a).toBe(
      "periodA predates this product's recorded sales (first fact 2026-05-01; " +
        "your companies' sales data starts 2020-01-01)",
    );
    // The measured period is untouched.
    expect(res.b).toBe(12);
  });

  it("FD3-7: an UNSCOPED comparison keeps the source-level wording verbatim", async () => {
    mockSales("2026-06-01", null, 50, "orderedQty");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-05-01", "2026-05-07"),
      periodB: win("2026-06-10", "2026-06-16"),
      companyIds: ["co-1"],
    });

    expect(res.reasons.a).toBe("periodA predates sales_units data (starts 2026-06-01)");
  });
});

describe("FD3-3 mirrored to by_product (orchestrator seam-fix): the shift is envelope-level", () => {
  const PERIOD_A = win("2026-06-01", "2026-06-07");
  const PERIOD_B = win("2026-06-08", "2026-06-14");

  /** The FD3-3 c1/c2 scenario driven through by_product: seed the per-company starts
   *  groupBy and one product's sums in both windows (idiom copied from the FD2-1 suite:
   *  delegates dispatch on where-shape, never call order). */
  function seedShift(c2Start: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) => {
      if (args?.by?.includes?.("companyId")) {
        return Promise.resolve([
          { companyId: "c1", _min: { dayKey: "2020-01-01" } },
          { companyId: "c2", _min: { dayKey: c2Start } },
        ]) as never;
      }
      const from = args?.where?.dayKey?.gte;
      return Promise.resolve([
        { productId: 1, _sum: { orderedQty: from === PERIOD_A.from ? 10 : 25 } },
      ]) as never;
    });
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2020-01-01" } } as never);
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);
  }

  it("emits coverageShift + reasons.delta when a company's start falls inside a period", async () => {
    seedShift("2026-06-08");
    const res = await comparePeriodsByProduct({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });
    expect(res.coverageShift).toEqual(expect.stringContaining("c2"));
    expect(res.reasons.delta).toBe(res.coverageShift);
  });

  it("carries NO shift keys when both periods share one coverage", async () => {
    seedShift("2020-02-01");
    const res = await comparePeriodsByProduct({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });
    expect(res.coverageShift).toBeUndefined();
    expect(res.reasons.delta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FD4-1 — the disclosure pair discriminates a REAL per-company degradation from a
// WINDOW-level partial.
//
// `periods.includes("partial")` could not tell the two apart. A period whose CALLER-WIDE
// classification is already not "full" is partial because the metric's own source
// straddles or predates it; the staggered memberships had no hand in that. FD3-1 stopped
// the measured-note sentence from riding on a result whose coverage was not degraded, and
// left this second case — where a period IS partial, for a reason the disclosure does not
// describe — still attaching both the note and the sentence.
// ---------------------------------------------------------------------------

describe("FD4-1 the companyCoverage pair follows PER-COMPANY degradation, not any 'partial'", () => {
  const PERIOD_A = win("2026-01-01", "2026-01-31");
  const PERIOD_B = win("2026-06-01", "2026-06-30");

  /** The FD3-7 fixture verbatim: staggered companies (so the pair WOULD ride) and a
   *  PRODUCT-scoped first fact that leaves period A window-level partial. */
  function seedProductScoped(productStart: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) => {
      if (args?._min) {
        return Promise.resolve({
          _min: { dayKey: args?.where?.productId?.equals === 42 ? productStart : "2020-01-01" },
        }) as never;
      }
      return Promise.resolve({
        _sum: { orderedQty: args?.where?.dayKey?.gte === PERIOD_A.from ? null : 12 },
      }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      args?.by?.[0] === "companyId"
        ? (Promise.resolve([
            { companyId: "c1", _min: { dayKey: "2020-01-01" } },
            { companyId: "c2", _min: { dayKey: "2021-06-01" } },
          ]) as never)
        : (Promise.resolve([]) as never),
    );
    db.product.findMany.mockResolvedValue([{ id: 42 }] as never);
  }

  it("a WINDOW-level partial drops the WHOLE pair (the staggering did not cause it)", async () => {
    // The product's first fact is 2026-05-01: period A predates it outright, period B is
    // covered. Both companies have been recording since 2020/2021, so they cover period B
    // and every day of period A that the PRODUCT does not — the degradation the disclosure
    // describes played no part in period A being null.
    seedProductScoped("2026-05-01");

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      productId: 42,
      companyIds: ["c1", "c2"],
    });

    expect(res.periodCoverage).toEqual({ a: "partial", b: "full" });
    expect(res.a).toBeNull();
    expect(res.reasons.a).toContain("predates this product's recorded sales");
    // Neither half of the pair: the note would explain the wrong thing, and the raw
    // per-company starts beside a nullity they did not cause read as its cause.
    expect(res.companyCoverage).toBeUndefined();
    expect(res.companyCoverageNote).toBeUndefined();
  });

  it("a REAL per-company degradation still ships BOTH halves with the measured note", async () => {
    // Same staggered companies, no productId: the source covers both windows (caller-wide
    // "full"), and c2's 2021 start is the only thing making period A partial — which is
    // exactly what the pair exists to say.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args?._min ? { _min: { dayKey: "2020-01-01" } } : { _sum: { orderedQty: 30 } },
      ) as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      args?.by?.[0] === "companyId"
        ? (Promise.resolve([
            { companyId: "c1", _min: { dayKey: "2020-01-01" } },
            { companyId: "c2", _min: { dayKey: "2026-01-15" } },
          ]) as never)
        : (Promise.resolve([]) as never),
    );
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    expect(res.periodCoverage).toEqual({ a: "partial", b: "full" });
    expect(res.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2020-01-01" },
      { companyId: "c2", salesDataStart: "2026-01-15" },
    ]);
    expect(res.companyCoverageNote).toContain("MEASURED");
  });
});

// ---------------------------------------------------------------------------
// FD4-2 — the shift qualification rides only where a DELTA exists, and never as the
// nameless fallback.
//
// `coverageShift`'s whole content is "this delta is not like-for-like growth". Two ways it
// used to be emitted with nothing to qualify: a period the source does not cover nulls its
// value (and the delta with it) while still classifying differently from the other, and
// the `shifted.length === 0` fallback quoted the two classifications when no company was
// nameable — including for two IDENTICAL windows, where nothing can have moved at all.
// ---------------------------------------------------------------------------

describe("FD4-2 no shift keys without a delta to qualify", () => {
  const PERIOD_A = win("2026-06-01", "2026-06-07");
  const PERIOD_B = win("2026-06-08", "2026-06-14");

  it("LEDGER metric whose source starts BETWEEN the two periods: no shift keys", async () => {
    // dataStart 2026-06-05 — after period A began, before period B did. The two periods
    // really do classify differently, and no company is nameable (ledger metrics have no
    // company dimension), which is exactly the fallback's case. Period A is null, so
    // there is no delta the sentence could be about; reasons.a already says why.
    mockLedger(new Date("2026-06-05T00:00:00.000Z"), -10, -25);
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);

    const res = await comparePeriods({
      metric: "outbound_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1"],
    });

    expect(res.periodCoverage).toEqual({ a: "partial", b: "full" });
    expect(res.a).toBeNull();
    expect(res.delta).toBeNull();
    expect(res.reasons.a).toContain("not fully covered");
    expect(res.coverageShift).toBeUndefined();
    expect(res.reasons.delta).toBeUndefined();
  });

  it("a nameable shift on a NULL delta carries no keys either (sales)", async () => {
    // c2 joins inside period B — nameable — but the PRODUCT's own first fact leaves period
    // A predating the data, so `delta` is null. A "not like-for-like growth" note here
    // qualifies a comparison nobody made.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) => {
      if (args?._min) {
        return Promise.resolve({
          _min: { dayKey: args?.where?.productId?.equals === 42 ? "2026-06-08" : "2020-01-01" },
        }) as never;
      }
      return Promise.resolve({
        _sum: { orderedQty: args?.where?.dayKey?.gte === PERIOD_A.from ? null : 12 },
      }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      args?.by?.[0] === "companyId"
        ? (Promise.resolve([
            { companyId: "c1", _min: { dayKey: "2020-01-01" } },
            { companyId: "c2", _min: { dayKey: "2026-06-08" } },
          ]) as never)
        : (Promise.resolve([]) as never),
    );
    db.product.findMany.mockResolvedValue([{ id: 42 }] as never);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      productId: 42,
      companyIds: ["c1", "c2"],
    });

    expect(res.a).toBeNull();
    expect(res.delta).toBeNull();
    expect(res.coverageShift).toBeUndefined();
    expect(res.reasons.delta).toBeUndefined();
  });

  it("IDENTICAL windows with a company start inside them: nothing MOVED, so no shift", async () => {
    // The fallback's other reachable shape, and the one with a real delta: c2's start sits
    // strictly inside a window both periods share. `insidePeriod` fires, no company's
    // contribution DIFFERS between the periods, and the old fallback answered with
    // "period A and period B are not equally covered (period A: partial, period B:
    // partial)" — a sentence that contradicts itself.
    const SAME = win("2026-06-01", "2026-06-30");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args?._min ? { _min: { dayKey: "2020-01-01" } } : { _sum: { orderedQty: 40 } },
      ) as never,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      args?.by?.[0] === "companyId"
        ? (Promise.resolve([
            { companyId: "c1", _min: { dayKey: "2020-01-01" } },
            { companyId: "c2", _min: { dayKey: "2026-06-15" } },
          ]) as never)
        : (Promise.resolve([]) as never),
    );
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);

    const res = await comparePeriods({
      metric: "sales_units",
      periodA: SAME,
      periodB: SAME,
      companyIds: ["c1", "c2"],
    });

    // Both sums measured, so a delta exists — the gate is not what suppresses this one.
    expect(res.delta).toBe(0);
    expect(res.periodCoverage).toEqual({ a: "partial", b: "partial" });
    expect(res.coverageShift).toBeUndefined();
    expect(res.reasons.delta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FD4-3 — an unranked row's `reasons` is a SNAPSHOT, never the envelope's object.
//
// The rows aliased the envelope's `reasons`, and `reasons.delta` is added AFTER the split.
// Every unranked row therefore grew a delta qualification for a delta that is null by
// construction — and paid for the sentence once per row on the wire.
// ---------------------------------------------------------------------------

describe("FD4-3 row reasons carry the PERIOD vocabulary only", () => {
  const PERIOD_A = win("2026-06-01", "2026-06-07");
  const PERIOD_B = win("2026-06-08", "2026-06-14");

  /** Degraded (c2 joins at period B's first day) with TWO products absent from period A —
   *  so the envelope carries a real shift, one ranked row, and more than one unranked row
   *  (a single row cannot tell a snapshot from an alias by byte count). */
  function seedDegradedShift() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) => {
      if (args?.by?.includes?.("companyId")) {
        return Promise.resolve([
          { companyId: "c1", _min: { dayKey: "2020-01-01" } },
          { companyId: "c2", _min: { dayKey: "2026-06-08" } },
        ]) as never;
      }
      return Promise.resolve(
        args?.where?.dayKey?.gte === PERIOD_A.from
          ? [{ productId: 1, _sum: { orderedQty: 10 } }]
          : [
              { productId: 1, _sum: { orderedQty: 25 } },
              { productId: 2, _sum: { orderedQty: 12 } },
              { productId: 3, _sum: { orderedQty: 5 } },
            ],
      ) as never;
    });
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2020-01-01" } } as never);
    db.product.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }] as never);
  }

  /** Occurrences of `needle` in `haystack` — the byte-cost question, counted. */
  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("unranked rows carry a/b only; the envelope alone carries reasons.delta", async () => {
    seedDegradedShift();

    const res = await comparePeriodsByProduct({
      metric: "sales_units",
      periodA: PERIOD_A,
      periodB: PERIOD_B,
      companyIds: ["c1", "c2"],
    });

    // The fixture really is the degraded-with-a-shift case: one measured row, two unknown.
    expect(res.ranked.map((r) => r.productId)).toEqual([1]);
    expect(res.unranked.map((r) => r.productId)).toEqual([2, 3]);
    expect(res.coverageShift).toBeDefined();
    expect(res.reasons.delta).toBe(res.coverageShift);

    // Every unranked row: PERIOD keys only, and never the envelope's own object.
    for (const row of res.unranked) {
      expect(Object.keys(row.reasons ?? {}).sort()).toEqual(["a"]);
      expect(row.reasons).not.toHaveProperty("delta");
      expect(row.reasons).not.toBe(res.reasons);
    }
    // The ranked row agrees: neither array carries a delta reason.
    expect(res.ranked[0].reasons).toBeUndefined();

    // Byte cost: the sentence is paid for by the ENVELOPE — once in `coverageShift` and
    // once in its `reasons.delta` mirror (FD3-3's deliberate pair) — and not once more per
    // unranked row, which is what the alias was costing.
    const shift = res.coverageShift as string;
    expect(occurrences(JSON.stringify(res.unranked), shift)).toBe(0);
    expect(occurrences(JSON.stringify(res), shift)).toBe(2);
  });
});
