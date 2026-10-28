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
 *
 * A2 pack C14 (A2-OCC-1): a product with no fact row is checked for a LINK on the caller's
 * stores (a ProductLink, or a bundle component of a listing there), the stores coming from
 * the caller's own order records (never the Integration table); the window's orders with an
 * unattributable line are counted. Both only when coverage is not `none` and some product
 * has no fact row.
 *
 * A2 pack C16 (A2-FD1-1): the same link reads also return when each no-fact LINKED product's
 * newest link on the caller's stores was made (`newestLinkAt`) — the listing's own
 * `createdAt`, for a bundle component its bundle listing's — so the tool can tell a link the
 * last full sales rebuild has not seen yet. No rebuild knowledge here.
 *
 * A2 pack C17 (A2-QA-2): a bundle line whose frozen component snapshot is NULL is unattributed
 * too (attribution.ts), so the unattributable-orders count carries that branch.
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import { Prisma, type PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import fs from "fs";
import path from "path";
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

// ===========================================================================
// A2 pack C14 (A2-OCC-1) — an unlinked product or order line is never a measured 0
// ===========================================================================

type Order = {
  companyId: string;
  integrationId: string;
  internalStatus: string;
  externalCreatedAt: Date | null;
  createdAt: Date;
  items: Array<{
    productLinkId: string | null;
    productLink: { isBundle: boolean; internalProductId: number | null } | null;
    /** A2 C17: the frozen bundle snapshot; absent = the column's NULL (as intake leaves it). */
    bundleComponentSnapshot?: unknown;
  }>;
};
type Link = { internalProductId: number | null; integrationId: string; isBundle?: boolean; createdAt?: Date };

/** A2 C16: a seeded listing's creation instant when the fixture does not name one. */
const LISTED_LONG_AGO = new Date("2025-01-01T00:00:00.000Z");

/** An item predicate, evaluated over a seeded order line (the shapes C14 and C17 name only):
 *  every key of one branch must hold (Prisma ANDs them); an unmodelled key or operator throws. */
function itemMatches(item: Order["items"][number], where: Record<string, any>): boolean {
  if (Array.isArray(where.OR)) return where.OR.some((w: Record<string, any>) => itemMatches(item, w));
  return Object.entries(where).every(([key, cond]) => {
    if (key === "productLinkId") return item.productLinkId === cond;
    if (key === "productLink") {
      const link = item.productLink;
      return (
        link != null &&
        Object.entries(cond as Record<string, unknown>).every(([k, v]) => (link as Record<string, unknown>)[k] === v)
      );
    }
    // A2 C17: Prisma.AnyNull matches the column's NULL and a stored JSON null alike.
    if (key === "bundleComponentSnapshot" && Object.keys(cond as object).join() === "equals") {
      if ((cond as { equals: unknown }).equals !== Prisma.AnyNull) throw new Error("unexpected snapshot filter");
      return item.bundleComponentSnapshot == null;
    }
    throw new Error(`unexpected item predicate ${JSON.stringify(where)}`);
  });
}

/** A date predicate ({ gte, lt } or null) over one column. */
function dateMatches(value: Date | null, where: any): boolean {
  if (where === null) return value === null;
  if (value === null) return false;
  return (where.gte == null || value >= where.gte) && (where.lt == null || value < where.lt);
}

/** The order-record + listing reads, answered FROM seeded rows and honoring each where. */
function seedOrders(opts: { orders: Order[]; links?: Link[]; components?: Link[] }) {
  db.externalOrder.groupBy.mockImplementation((async (args: { by: string[]; where: Record<string, any> }) => {
    const ids = new Set(
      opts.orders.filter((o) => args.where.companyId.in.includes(o.companyId)).map((o) => o.integrationId),
    );
    return Array.from(ids, (integrationId) => ({ integrationId }));
  }) as never);
  // A2 C16: each read answers with the columns it SELECTS — the listing's createdAt directly,
  // a component's through its bundle listing (`productLink.createdAt`).
  const listingRead = (rows: Link[], viaBundleListing: boolean) =>
    (async (args: { where: Record<string, any>; select: Record<string, any> }) =>
      rows
        .filter(
          (row) =>
            args.where.internalProductId.in.includes(row.internalProductId) &&
            (args.where.integrationId ?? args.where.productLink.integrationId).in.includes(row.integrationId) &&
            (args.where.isBundle === undefined || (row.isBundle ?? false) === args.where.isBundle),
        )
        .map((row) => {
          const createdAt = row.createdAt ?? LISTED_LONG_AGO;
          return {
            internalProductId: row.internalProductId,
            ...(!viaBundleListing && args.select.createdAt ? { createdAt } : {}),
            ...(viaBundleListing && args.select.productLink?.select?.createdAt ? { productLink: { createdAt } } : {}),
          };
        })) as never;
  db.productLink.findMany.mockImplementation(listingRead(opts.links ?? [], false));
  db.bundleComponent.findMany.mockImplementation(listingRead(opts.components ?? [], true));
  db.externalOrder.count.mockImplementation((async (args: { where: Record<string, any> }) => {
    const w = args.where;
    return opts.orders.filter(
      (o) =>
        w.companyId.in.includes(o.companyId) &&
        o.internalStatus !== w.internalStatus.not &&
        w.OR.some(
          (branch: Record<string, any>) =>
            dateMatches(o.externalCreatedAt, branch.externalCreatedAt) &&
            (branch.createdAt == null || dateMatches(o.createdAt, branch.createdAt)),
        ) &&
        o.items.some((item) => itemMatches(item, w.items.some)),
    ).length;
  }) as never);
}

/** A covered caller (c1 recording since 2020) where product 1 has a fact and 2-4 do not. */
const COVERED: Fact[] = [
  { productId: 9, companyId: "c1", dayKey: "2020-01-01", orderedQty: 1, orderCount: 1 },
  { productId: 1, companyId: "c1", dayKey: "2026-09-01", orderedQty: 4, orderCount: 2 },
];
const at = (iso: string) => new Date(iso);
const order = (over: Partial<Order> & { items?: Order["items"] }): Order => ({
  companyId: "c1",
  integrationId: "store-c1",
  internalStatus: "pending",
  externalCreatedAt: at("2026-10-01T12:00:00.000Z"),
  createdAt: at("2026-10-01T12:00:00.000Z"),
  items: [{ productLinkId: "link-ok", productLink: { isBundle: false, internalProductId: 1 } }],
  ...over,
});
const UNMAPPED = [{ productLinkId: null, productLink: null }];
/** A2 C17: a valid frozen bundle snapshot (what intake writes for a bundle line). */
const SNAPSHOT = [{ internalProductId: 2, internalProductName: "Two", quantity: 1, sortOrder: 0 }];

describe("A2 C14 orderSignal — the link check", () => {
  it("a REAL mix: a linked no-fact product is not in `unlinked`, an unlinked one is (non-vacuity)", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 9], facts: COVERED });
    seedOrders({
      orders: [order({})],
      links: [{ internalProductId: 2, integrationId: "store-c1" }],
    });
    const out = await orderSignal([1, 2, 3], ["c1"], WINDOW);
    expect(out.windowCoverage).toBe("full");
    expect(out.byProduct.get(1)).toEqual({ orderedUnits: 4, orders: 2 });
    // 2 is linked on c1's store; 3 has no listing anywhere; 1 has a fact row (never checked).
    expect(Array.from(out.unlinked)).toEqual([3]);
  });

  it("a product linked ONLY through a bundle component of a listing on the caller's store is linked", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 9], facts: COVERED });
    seedOrders({
      orders: [order({})],
      components: [{ internalProductId: 3, integrationId: "store-c1" }],
    });
    const out = await orderSignal([2, 3], ["c1"], WINDOW);
    expect(Array.from(out.unlinked)).toEqual([2]);
  });

  it("a BUNDLE listing whose own internalProductId names the product is not a direct link (attribution credits direct links only when not a bundle)", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 9], facts: COVERED });
    seedOrders({
      orders: [order({})],
      links: [
        { internalProductId: 2, integrationId: "store-c1", isBundle: true }, // drift: bundle row carrying a product id
        { internalProductId: 3, integrationId: "store-c1", isBundle: false },
      ],
    });
    const out = await orderSignal([2, 3], ["c1"], WINDOW);
    expect(Array.from(out.unlinked)).toEqual([2]);
  });

  it("a product linked ONLY on another company's store is not linked (stores come from the caller's orders)", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 9], facts: COVERED });
    seedOrders({
      orders: [order({}), order({ companyId: "c2", integrationId: "store-c2" })],
      links: [{ internalProductId: 2, integrationId: "store-c2" }],
      components: [{ internalProductId: 3, integrationId: "store-c2" }],
    });
    const out = await orderSignal([2, 3], ["c1"], WINDOW);
    expect(Array.from(out.unlinked).sort()).toEqual([2, 3]);
    // Non-vacuity: for a caller in c2 the same listings ARE linked.
    const both = await orderSignal([2, 3], ["c1", "c2"], WINDOW);
    expect(both.unlinked.size).toBe(0);
  });

  it("the reads: stores by integrationId over the caller's orders; each listing read selects the product id and when the listing was made", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 9], facts: COVERED });
    seedOrders({ orders: [order({})] });
    await orderSignal([1, 2, 3], ["c1"], WINDOW);
    expect(db.externalOrder.groupBy.mock.calls.map((c) => c[0])).toEqual([
      { by: ["integrationId"], where: { companyId: { in: ["c1"] } } },
    ]);
    // A2 C16: the selects exactly — the direct listing's createdAt, and for a component its
    // bundle listing's (a component has no createdAt of its own). No other read changes.
    expect(db.productLink.findMany.mock.calls.map((c) => c[0])).toEqual([
      {
        where: { internalProductId: { in: [2, 3] }, integrationId: { in: ["store-c1"] }, isBundle: false },
        select: { internalProductId: true, createdAt: true },
      },
    ]);
    expect(db.bundleComponent.findMany.mock.calls.map((c) => c[0])).toEqual([
      {
        where: { internalProductId: { in: [2, 3] }, productLink: { integrationId: { in: ["store-c1"] } } },
        select: { internalProductId: true, productLink: { select: { createdAt: true } } },
      },
    ]);
  });

  it("no order on any of the caller's stores: every no-fact product is unlinked, no listing read", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 9], facts: COVERED });
    seedOrders({ orders: [], links: [{ internalProductId: 2, integrationId: "store-c1" }] });
    const out = await orderSignal([2, 3], ["c1"], WINDOW);
    expect(Array.from(out.unlinked).sort()).toEqual([2, 3]);
    expect(db.productLink.findMany).not.toHaveBeenCalled();
    expect(db.bundleComponent.findMany).not.toHaveBeenCalled();
  });

  it("runs ONLY when coverage is not none AND some product has no fact row", async () => {
    // Every requested product has a fact row: nothing to check.
    seed({ approvedActiveIds: [1, 9], facts: COVERED });
    seedOrders({ orders: [order({ items: UNMAPPED })] });
    const allFacts = await orderSignal([1], ["c1"], WINDOW);
    expect(allFacts.unlinked.size).toBe(0);
    expect(allFacts.unlinkedOrders).toBe(0);
    // Coverage none (no facts at all): nothing to check either — absence is already unknown.
    mockReset(db);
    seed({ approvedActiveIds: [2], facts: [] });
    seedOrders({ orders: [order({ items: UNMAPPED })] });
    const none = await orderSignal([2], ["c1"], WINDOW);
    expect(none.windowCoverage).toBe("none");
    expect(none.unlinked.size).toBe(0);
    expect(none.unlinkedOrders).toBe(0);
    for (const read of [db.externalOrder.groupBy, db.externalOrder.count, db.productLink.findMany, db.bundleComponent.findMany]) {
      expect(read).not.toHaveBeenCalled();
    }
    // Empty inputs: the short-circuit carries the two keys too.
    const empty = await orderSignal([], ["c1"], WINDOW);
    expect(empty.unlinked.size).toBe(0);
    expect(empty.unlinkedOrders).toBe(0);
  });

  it("partial coverage runs the check too (a no-fact product there is not_linked or not_recorded)", async () => {
    seed({
      approvedActiveIds: [1, 2],
      facts: [{ productId: 1, companyId: "c1", dayKey: "2026-09-15", orderedQty: 5, orderCount: 2 }],
    });
    seedOrders({ orders: [order({})] });
    const out = await orderSignal([1, 2], ["c1"], WINDOW);
    expect(out.windowCoverage).toBe("partial");
    expect(Array.from(out.unlinked)).toEqual([2]);
  });
});

describe("A2 C16 orderSignal — newestLinkAt: when each no-fact linked product was last linked", () => {
  const OLD = at("2026-03-01T00:00:00.000Z");
  const NEWER = at("2026-10-20T09:30:00.000Z");
  const NEWEST = at("2026-10-26T18:00:00.000Z");

  it("the newest createdAt among a product's links on the caller's stores, direct and through a bundle listing", async () => {
    seed({ approvedActiveIds: [1, 2, 3, 4, 9], facts: COVERED });
    seedOrders({
      orders: [order({}), order({ companyId: "c2", integrationId: "store-c2" })],
      links: [
        { internalProductId: 2, integrationId: "store-c1", createdAt: OLD },
        { internalProductId: 2, integrationId: "store-c1", createdAt: NEWER },
        // Another company's store is not one of the caller's: its later link never counts.
        { internalProductId: 2, integrationId: "store-c2", createdAt: NEWEST },
      ],
      components: [
        // 3 is linked only as a bundle component: its bundle listing's createdAt is used.
        { internalProductId: 3, integrationId: "store-c1", createdAt: NEWER },
        // 2 is also a component of a newer bundle listing on the caller's store.
        { internalProductId: 2, integrationId: "store-c1", createdAt: NEWEST },
      ],
    });
    const out = await orderSignal([1, 2, 3, 4], ["c1"], WINDOW);
    // 1 has a fact row (never checked); 4 has no link at all (unlinked, no instant).
    expect(Array.from(out.unlinked)).toEqual([4]);
    expect(Array.from(out.newestLinkAt.entries()).sort((a, b) => a[0] - b[0])).toEqual([
      [2, NEWEST],
      [3, NEWER],
    ]);
  });

  it("a direct link newer than the bundle listing wins (the newest of either kind)", async () => {
    seed({ approvedActiveIds: [1, 2, 9], facts: COVERED });
    seedOrders({
      orders: [order({})],
      links: [{ internalProductId: 2, integrationId: "store-c1", createdAt: NEWEST }],
      components: [{ internalProductId: 2, integrationId: "store-c1", createdAt: OLD }],
    });
    const out = await orderSignal([2], ["c1"], WINDOW);
    expect(out.newestLinkAt.get(2)).toEqual(NEWEST);
  });

  it("empty whenever the link check does not run, and for unlinked products", async () => {
    // Every requested product has a fact row.
    seed({ approvedActiveIds: [1, 9], facts: COVERED });
    seedOrders({ orders: [order({})], links: [{ internalProductId: 1, integrationId: "store-c1", createdAt: NEWEST }] });
    expect((await orderSignal([1], ["c1"], WINDOW)).newestLinkAt.size).toBe(0);
    // Coverage none.
    mockReset(db);
    seed({ approvedActiveIds: [2], facts: [] });
    seedOrders({ orders: [order({})], links: [{ internalProductId: 2, integrationId: "store-c1", createdAt: NEWEST }] });
    expect((await orderSignal([2], ["c1"], WINDOW)).newestLinkAt.size).toBe(0);
    // No order on any of the caller's stores: everything is unlinked, nothing has an instant.
    mockReset(db);
    seed({ approvedActiveIds: [1, 2, 9], facts: COVERED });
    seedOrders({ orders: [], links: [{ internalProductId: 2, integrationId: "store-c1", createdAt: NEWEST }] });
    const noStores = await orderSignal([2], ["c1"], WINDOW);
    expect(Array.from(noStores.unlinked)).toEqual([2]);
    expect(noStores.newestLinkAt.size).toBe(0);
    // Empty inputs: the short-circuit carries the map too.
    expect((await orderSignal([], ["c1"], WINDOW)).newestLinkAt.size).toBe(0);
  });
});

describe("A2 C14 orderSignal — the window's orders with an unattributable line", () => {
  it("the count's where clause is exactly C14's (attribution's skip + its unattributed branches, the rebuild's day predicate)", async () => {
    seed({ approvedActiveIds: [1, 2, 9], facts: COVERED });
    seedOrders({ orders: [order({})] });
    await orderSignal([1, 2], ["c1", "c2"], WINDOW);
    expect(db.externalOrder.count.mock.calls.map((c) => c[0])).toEqual([
      {
        where: {
          companyId: { in: ["c1", "c2"] },
          internalStatus: { not: "cancelled" },
          OR: [
            { externalCreatedAt: { gte: at("2026-07-30T00:00:00.000Z"), lt: at("2026-10-28T00:00:00.000Z") } },
            {
              externalCreatedAt: null,
              createdAt: { gte: at("2026-07-30T00:00:00.000Z"), lt: at("2026-10-28T00:00:00.000Z") },
            },
          ],
          items: {
            some: {
              OR: [
                { productLinkId: null },
                { productLink: { isBundle: false, internalProductId: null } },
                // A2 C17 (A2-QA-2): a bundle line recorded without its components.
                { productLink: { isBundle: true }, bundleComponentSnapshot: { equals: Prisma.AnyNull } },
              ],
            },
          },
        },
      },
    ]);
    // AnyNull (DB NULL or JSON null) — not DbNull alone, since attribution reads either as none.
    const branch = (db.externalOrder.count.mock.calls[0][0] as any).where.items.some.OR[2];
    expect(branch.bundleComponentSnapshot.equals).toBe(Prisma.AnyNull);
  });

  it("counts an unmapped line and a productless listing in the window; never a cancelled, out-of-window, other-company or attributable order", async () => {
    seed({ approvedActiveIds: [1, 2, 9], facts: COVERED });
    seedOrders({
      orders: [
        order({ items: UNMAPPED }), // counted: no listing
        order({ items: [{ productLinkId: "link-null", productLink: { isBundle: false, internalProductId: null } }] }), // counted
        // counted: createdAt fallback inside the window (externalCreatedAt null)
        order({ externalCreatedAt: null, createdAt: at("2026-10-27T23:59:59.000Z"), items: UNMAPPED }),
        order({ internalStatus: "cancelled", items: UNMAPPED }), // attribution skips it
        order({ externalCreatedAt: at("2026-07-29T23:59:59.000Z"), items: UNMAPPED }), // before the window
        order({ externalCreatedAt: at("2026-10-28T00:00:00.000Z"), items: UNMAPPED }), // after it
        // externalCreatedAt outside wins over a createdAt inside (the rebuild's sale day)
        order({ externalCreatedAt: at("2026-06-01T00:00:00.000Z"), createdAt: at("2026-10-01T00:00:00.000Z"), items: UNMAPPED }),
        order({ companyId: "c2", integrationId: "store-c2", items: UNMAPPED }), // another company
        order({}), // every line attributable
        // a bundle listing with no product is attributed through its frozen snapshot
        order({ items: [{ productLinkId: "bundle", productLink: { isBundle: true, internalProductId: null }, bundleComponentSnapshot: SNAPSHOT }] }),
      ],
    });
    const out = await orderSignal([1, 2], ["c1"], WINDOW);
    expect(out.unlinkedOrders).toBe(3);
  });

  it("A2 C17: a bundle line recorded WITHOUT its components (NULL snapshot) is counted; one with them is not", async () => {
    seed({ approvedActiveIds: [1, 2, 9], facts: COVERED });
    const bundle = { productLinkId: "bundle", productLink: { isBundle: true, internalProductId: null } };
    seedOrders({
      orders: [
        order({ items: [bundle] }), // counted: the column is NULL (a re-sync linked it after intake)
        order({ items: [{ ...bundle, bundleComponentSnapshot: null }] }), // counted: a stored JSON null
        order({ items: [{ ...bundle, bundleComponentSnapshot: SNAPSHOT }] }), // attributed: not counted
        // a non-bundle line with no snapshot is the normal shape — attributed, not counted
        order({ items: [{ productLinkId: "link-ok", productLink: { isBundle: false, internalProductId: 1 } }] }),
        order({ internalStatus: "cancelled", items: [bundle] }), // attribution skips it
        order({ companyId: "c2", integrationId: "store-c2", items: [bundle] }), // another company
      ],
    });
    const out = await orderSignal([1, 2], ["c1"], WINDOW);
    expect(out.unlinkedOrders).toBe(2);
  });

  it("is 0, with no read, when every requested product has a fact row", async () => {
    seed({ approvedActiveIds: [1, 9], facts: COVERED });
    seedOrders({ orders: [order({ items: UNMAPPED })] });
    expect((await orderSignal([1], ["c1"], WINDOW)).unlinkedOrders).toBe(0);
    expect(db.externalOrder.count).not.toHaveBeenCalled();
  });
});

describe("A2 C14 — no read touches the Integration table (source pin)", () => {
  it("order-signal.ts names no `integration` model or relation (the store ids are order columns)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../../lib/reports/order-signal.ts"), "utf8");
    // `integrationId` (an order / listing COLUMN) is fine; the model or the relation is not.
    expect(src).not.toMatch(/\bintegration\b(?!Id)/);
    expect(src).not.toMatch(/prisma\s*\.\s*integration\b/i);
    expect(src).not.toMatch(/\binclude\s*:/);
    // Non-vacuity: the file really does derive the stores from integrationId.
    expect(src).toMatch(/by: \["integrationId"\]/);
  });
});
