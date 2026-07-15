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
import { comparePeriods } from "@/lib/reports/compare-periods";

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
  it("narrows sales aggregates by productId when provided", async () => {
    mockSales("2026-01-01", 3, 4, "orderedQty");

    await comparePeriods({
      metric: "sales_units",
      periodA: win("2026-06-01", "2026-06-07"),
      periodB: win("2026-06-08", "2026-06-14"),
      productId: 42,
      companyIds: ["co-1"],
    });

    for (const call of db.productSalesFact.aggregate.mock.calls) {
      expect((call[0] as { where: { productId?: number } }).where.productId).toBe(42);
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
      expect((call[0] as { where: { productId?: number } }).where.productId).toBe(7);
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
