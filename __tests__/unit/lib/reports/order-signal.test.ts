/**
 * @jest-environment node
 *
 * A2 pack C4 — lib/reports/order-signal.ts: the recorded-order figures the reorder report
 * shows beside a product it cannot size (Kris: flag + figures, never a quantity).
 *
 * Pins:
 *  - ONE grouped read of ProductSalesFact over the given products, the caller's companies
 *    and the window's day keys, summing orderedQty + orderCount;
 *  - coverage from the per-company first-fact days over the APPROVED-ACTIVE scope, so an
 *    unapproved product's older fact never moves the start (and so never turns an unknown
 *    into a measured zero);
 *  - the two kinds of `partial`: the source itself starts inside the window ("window") vs a
 *    member company not recording ("company");
 *  - the reason is get_sales' own sentence (salesCoverageReason), never a new paraphrase;
 *  - empty products or companies: no query at all.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import prisma from "@/lib/prisma";
import { orderSignal, ORDER_SIGNAL_WINDOW_DAYS } from "@/lib/reports/order-signal";
import { salesCoverageReason } from "@/lib/assistant/sales-coverage";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const WINDOW = { from: "2026-07-30", to: "2026-10-27" };

type Fact = { productId: number; companyId: string; dayKey: string; orderedQty: number; orderCount: number };

/**
 * A fact table the mocks answer FROM, honoring the where clauses the module sends — so a
 * read that forgot a filter returns the wrong answer instead of the fixture's intent.
 */
function seed(opts: { facts: Fact[]; approvedActiveIds: number[] }) {
  // approvedProductIds({ includeArchived: false }) — the coverage scope.
  db.product.findMany.mockResolvedValue(opts.approvedActiveIds.map((id) => ({ id })) as never);
  // A2 C8: the per-company starts carry each company's name (one company read).
  db.company.findMany.mockResolvedValue([
    { id: "c1", name: "Acme Peptides" },
    { id: "c2", name: "Beta Labs" },
  ] as never);
  const inScope = (where: Record<string, any>) =>
    opts.facts.filter(
      (f) =>
        (where.companyId?.in == null || where.companyId.in.includes(f.companyId)) &&
        (where.productId?.in == null || where.productId.in.includes(f.productId)) &&
        (where.dayKey?.gte == null || f.dayKey >= where.dayKey.gte) &&
        (where.dayKey?.lte == null || f.dayKey <= where.dayKey.lte),
    );
  db.productSalesFact.aggregate.mockImplementation((async (args: { where: Record<string, any> }) => {
    const days = inScope(args.where).map((f) => f.dayKey).sort();
    return { _min: { dayKey: days[0] ?? null } };
  }) as never);
  db.productSalesFact.groupBy.mockImplementation((async (args: { by: string[]; where: Record<string, any> }) => {
    const rows = inScope(args.where);
    if (args.by[0] === "companyId") {
      const starts = new Map<string, string>();
      for (const f of rows) {
        const cur = starts.get(f.companyId);
        if (cur == null || f.dayKey < cur) starts.set(f.companyId, f.dayKey);
      }
      return Array.from(starts, ([companyId, dayKey]) => ({ companyId, _min: { dayKey } }));
    }
    const sums = new Map<number, { orderedQty: number; orderCount: number }>();
    for (const f of rows) {
      const cur = sums.get(f.productId) ?? { orderedQty: 0, orderCount: 0 };
      sums.set(f.productId, { orderedQty: cur.orderedQty + f.orderedQty, orderCount: cur.orderCount + f.orderCount });
    }
    return Array.from(sums, ([productId, s]) => ({ productId, _sum: s }));
  }) as never);
}

/** The productId-grouped call (the signal itself), as opposed to the per-company starts. */
function signalReadArgs() {
  return db.productSalesFact.groupBy.mock.calls
    .map((c) => c[0] as unknown as { by: string[] })
    .filter((a) => a.by[0] === "productId");
}

beforeEach(() => mockReset(db));

describe("A2 C4 orderSignal — the read", () => {
  it("the window is 90 calendar days", () => {
    expect(ORDER_SIGNAL_WINDOW_DAYS).toBe(90);
  });

  it("issues ONE grouped read: these products, these companies, these day keys, two sums", async () => {
    seed({ facts: [], approvedActiveIds: [1, 2] });
    await orderSignal([1, 2], ["c1", "c2"], WINDOW);
    expect(signalReadArgs()).toEqual([
      {
        by: ["productId"],
        where: {
          productId: { in: [1, 2] },
          companyId: { in: ["c1", "c2"] },
          dayKey: { gte: WINDOW.from, lte: WINDOW.to },
        },
        _sum: { orderedQty: true, orderCount: true },
      },
    ]);
  });

  it("measures coverage over the APPROVED-ACTIVE scope (deletedAt null), caller companies only", async () => {
    seed({ facts: [], approvedActiveIds: [1, 2, 3] });
    await orderSignal([1], ["c1"], WINDOW);
    const scopeRead = db.product.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(scopeRead.where).toEqual({ approvalStatus: "APPROVED", deletedAt: null });
    const startRead = db.productSalesFact.aggregate.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(startRead.where).toEqual({ productId: { in: [1, 2, 3] }, companyId: { in: ["c1"] } });
  });

  it("empty products or empty companies: NO query, an empty map, coverage none", async () => {
    for (const [ids, companies] of [
      [[], ["c1"]],
      [[1], []],
    ] as Array<[number[], string[]]>) {
      mockReset(db);
      const out = await orderSignal(ids, companies, WINDOW);
      expect(out.byProduct.size).toBe(0);
      expect(out.windowCoverage).toBe("none");
      expect(out.salesDataStart).toBeNull();
      expect(out.partialKind).toBeUndefined();
      expect(db.product.findMany).not.toHaveBeenCalled();
      expect(db.productSalesFact.aggregate).not.toHaveBeenCalled();
      expect(db.productSalesFact.groupBy).not.toHaveBeenCalled();
    }
  });
});

describe("A2 C4 orderSignal — sums and coverage", () => {
  it("full coverage: the sums per product (14 units over 7 orders), no reason", async () => {
    seed({
      approvedActiveIds: [1, 2],
      facts: [
        { productId: 1, companyId: "c1", dayKey: "2020-01-01", orderedQty: 3, orderCount: 1 },
        { productId: 1, companyId: "c1", dayKey: "2026-08-01", orderedQty: 6, orderCount: 3 },
        { productId: 1, companyId: "c1", dayKey: "2026-10-20", orderedQty: 8, orderCount: 4 },
      ],
    });
    const out = await orderSignal([1, 2], ["c1"], WINDOW);
    expect(out.windowCoverage).toBe("full");
    expect(out.salesDataStart).toBe("2020-01-01");
    expect(out.partialKind).toBeUndefined();
    expect(out.reason).toBeUndefined();
    // The 2020 fact is outside the window: only the two in-window facts are summed.
    expect(out.byProduct.get(1)).toEqual({ orderedUnits: 14, orders: 7 });
    // No fact row in the window = no entry (the TOOL decides what silence means).
    expect(out.byProduct.has(2)).toBe(false);
  });

  it("null sums read 0, never undefined", async () => {
    seed({ approvedActiveIds: [1], facts: [] });
    db.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2020-01-01" } } as never);
    db.productSalesFact.groupBy.mockImplementation((async (args: { by: string[] }) =>
      args.by[0] === "companyId"
        ? [{ companyId: "c1", _min: { dayKey: "2020-01-01" } }]
        : [{ productId: 1, _sum: { orderedQty: null, orderCount: null } }]) as never);
    const out = await orderSignal([1], ["c1"], WINDOW);
    expect(out.byProduct.get(1)).toEqual({ orderedUnits: 0, orders: 0 });
  });

  it("window-kind partial: the records themselves begin inside the window", async () => {
    seed({
      approvedActiveIds: [1],
      facts: [{ productId: 1, companyId: "c1", dayKey: "2026-09-15", orderedQty: 5, orderCount: 2 }],
    });
    const out = await orderSignal([1], ["c1"], WINDOW);
    expect(out.windowCoverage).toBe("partial");
    expect(out.partialKind).toBe("window");
    expect(out.salesDataStart).toBe("2026-09-15");
    expect(out.reason).toBe(salesCoverageReason("2026-09-15", WINDOW.from));
    expect(out.byProduct.get(1)).toEqual({ orderedUnits: 5, orders: 2 });
    // One company: nothing staggered, so no per-company list.
    expect(out.companyCoverage).toBeUndefined();
  });

  it("company-kind partial: covered caller-wide, but a member company is not recording", async () => {
    seed({
      approvedActiveIds: [1],
      facts: [{ productId: 1, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 }],
    });
    const out = await orderSignal([1], ["c1", "c2"], WINDOW);
    const perCompany = [
      { companyId: "c1", salesDataStart: "2020-01-01", name: "Acme Peptides" },
      { companyId: "c2", salesDataStart: null, name: "Beta Labs" },
    ];
    expect(out.windowCoverage).toBe("partial");
    expect(out.partialKind).toBe("company");
    expect(out.companyCoverage).toEqual(perCompany);
    expect(out.reason).toBe(salesCoverageReason("2020-01-01", WINDOW.from, perCompany));
    // A2 C8: the not-recording company is named, never shown by its id.
    expect(out.reason).toContain("no sales data recorded for Beta Labs");
  });

  it("window-kind wins when BOTH hold: the caller-wide start is itself inside the window", async () => {
    seed({
      approvedActiveIds: [1],
      facts: [{ productId: 1, companyId: "c1", dayKey: "2026-09-01", orderedQty: 2, orderCount: 1 }],
    });
    const out = await orderSignal([1], ["c1", "c2"], WINDOW);
    expect(out.partialKind).toBe("window");
    expect(out.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2026-09-01", name: "Acme Peptides" },
      { companyId: "c2", salesDataStart: null, name: "Beta Labs" },
    ]);
  });

  it("none: the companies have no facts at all -> no start, the no-data sentence", async () => {
    seed({ approvedActiveIds: [1], facts: [] });
    const out = await orderSignal([1], ["c1"], WINDOW);
    expect(out.windowCoverage).toBe("none");
    expect(out.salesDataStart).toBeNull();
    expect(out.reason).toBe(salesCoverageReason(null, WINDOW.from));
    expect(out.byProduct.size).toBe(0);
  });

  it("an UNAPPROVED product's older fact does not move the start (it would have made this full)", async () => {
    const facts: Fact[] = [
      // The unapproved product's fact predates the window...
      { productId: 99, companyId: "c1", dayKey: "2019-01-01", orderedQty: 50, orderCount: 5 },
      // ...while the approved catalog's records begin inside it.
      { productId: 1, companyId: "c1", dayKey: "2026-09-20", orderedQty: 4, orderCount: 2 },
    ];
    seed({ approvedActiveIds: [1], facts });
    const out = await orderSignal([1], ["c1"], WINDOW);
    expect(out.salesDataStart).toBe("2026-09-20");
    expect(out.windowCoverage).toBe("partial");
    expect(out.partialKind).toBe("window");
    // Non-vacuity: with the unapproved product in scope the start WOULD be 2019 (full).
    seed({ approvedActiveIds: [1, 99], facts });
    expect((await orderSignal([1], ["c1"], WINDOW)).windowCoverage).toBe("full");
  });
});
