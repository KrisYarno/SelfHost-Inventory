/**
 * @jest-environment node
 *
 * W2-ASOF (spec §5 T-ASOF REV-2 NARROWED) + W2 seam-fix item 1: `lib/analytics/
 * stock-asof.ts` — exact-day as-of stock from ProductStockSnapshot, over a mocked
 * prisma. The narrowing is the point of this suite: the table has no per-row validity
 * marker and a flagged rebuild PRESERVES stale rows, so the module may only be truthful
 * about (1) the exact-day value (null + reason when a product has NO row that day —
 * NEVER a fabricated 0; a partial day sum is DISCLOSED partial), (2) each product's
 * series-end FLOOR (MIN over its per-location pairs, so a fresh location can't mask a
 * stale one), and (3) a LABELED possiblyStale heuristic.
 *
 * Pins:
 *   * missing-day => units null + the exact reason; a present 0-on-hand day => units 0
 *     (real, distinct from absent)
 *   * PAIR-LEVEL truthfulness (item 1): a fresh location does NOT mask a stale one —
 *     seriesEndsAt is the MIN over pairs' maxes, possiblyStale keys off that floor, and
 *     a day with SOME (not all) known locations present is a DISCLOSED partial total
 *   * possiblyStale true/false against the global watermark (incl. the watermark being
 *     the LATER of MAX(dayKey) and the snapshots-job lastWindowTo)
 *   * today / future / malformed dayKeys rejected with AppError(VALIDATION, 400)
 *   * multi-location summation (the DB _sum flows through to units)
 *   * DB-side pagination via pageFromDb (count drives totalRows; fetch gets skip/take)
 *   * unknown product in catalog mode is simply absent; an out-of-scope productId
 *     yields an empty page (not-found is the tool's job)
 *   * coverage block (dayKey / snapshotWatermark / snapshotDataStart / flaggedPairs)
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    product: { count: jest.fn(), findMany: jest.fn() },
    productStockSnapshot: { aggregate: jest.fn(), groupBy: jest.fn() },
    analyticsRebuildState: { findUnique: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { PER_TOOL_RESULT_CAP_BYTES } from "@/lib/assistant/tools";
import { getStockAsOf, NO_SNAPSHOT_REASON, partialDayReason } from "@/lib/analytics/stock-asof";

const m = prisma as unknown as {
  product: { count: jest.Mock; findMany: jest.Mock };
  productStockSnapshot: { aggregate: jest.Mock; groupBy: jest.Mock };
  analyticsRebuildState: { findUnique: jest.Mock };
};

/** 2026-07-15 noon UTC => today = 2026-07-15, last completed day = 2026-07-14. */
const NOW = new Date("2026-07-15T12:00:00.000Z");
const DAY = "2026-07-10"; // a completed day
const EARLY = "2026-01-01"; // a pair start well before DAY (so a pair is "known" by DAY)
const BUDGET = PER_TOOL_RESULT_CAP_BYTES;

/** A day-sum group: SUM(quantity) over day-D rows + `_count` = day-D rows = locations present on day D. */
type DaySum = { productId: number; _sum: { quantity: number | null }; _count: number };
/** A per-(product,location) span group: the pair's MAX and MIN snapshot dayKey over all days. */
type PairInfo = {
  productId: number;
  locationId: number;
  _max: { dayKey: string | null };
  _min: { dayKey: string | null };
};
type Prod = { id: number; name: string | null };

/** Day-sum for a product present on day D across `count` locations, summing to `quantity`. */
const daySum = (productId: number, quantity: number | null, count = 1): DaySum => ({
  productId,
  _sum: { quantity },
  _count: count,
});
/** One single-location pair per product, its series ending at `end`, existing since `start`. */
const onePairEach = (ids: number[], end: string, start = EARLY): PairInfo[] =>
  ids.map((id) => ({ productId: id, locationId: 1, _max: { dayKey: end }, _min: { dayKey: start } }));

function setup(f: {
  products?: Prod[];
  count?: number;
  daySums?: DaySum[];
  pairInfo?: PairInfo[];
  snapMin?: string | null;
  snapMax?: string | null;
  state?: { lastWindowTo: string | null; flaggedPairs: number } | null;
}) {
  const all = f.products ?? [];
  m.product.count.mockResolvedValue(f.count ?? all.length);
  // Honor skip/take so pageFromDb paging is exercised realistically (the DB slices).
  m.product.findMany.mockImplementation(async (args: any) => {
    const skip = args?.skip ?? 0;
    const take = args?.take ?? all.length;
    return all.slice(skip, skip + take);
  });
  m.productStockSnapshot.aggregate.mockResolvedValue({
    _min: { dayKey: f.snapMin ?? null },
    _max: { dayKey: f.snapMax ?? null },
  });
  // groupBy is called twice: once with `_sum` (exact-day sums + _count) and once with
  // `_max`/`_min` (per-pair spans). Branch on which aggregate the caller asked for.
  m.productStockSnapshot.groupBy.mockImplementation(async (args: any) => {
    if (args?._sum) return f.daySums ?? [];
    if (args?._max) return f.pairInfo ?? [];
    return [];
  });
  m.analyticsRebuildState.findUnique.mockResolvedValue(f.state ?? null);
}

beforeEach(() => jest.clearAllMocks());

describe("getStockAsOf — missing day is null + reason, NEVER a fabricated 0", () => {
  test("a product with no day-D row => units null + the exact reason; a genuine 0-on-hand day => units 0", async () => {
    setup({
      products: [
        { id: 1, name: "Has 25" },
        { id: 2, name: "Missing" },
        { id: 3, name: "Genuinely zero" },
      ],
      daySums: [
        daySum(1, 25),
        // product 2 absent => no row that day
        daySum(3, 0), // present row summing to 0 (real answer)
      ],
      pairInfo: onePairEach([1, 2, 3], DAY),
      snapMax: DAY,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    const byId = Object.fromEntries(page.rows.map((r) => [r.productId, r]));

    expect(byId[1].units).toBe(25);
    expect(byId[1].reason).toBeUndefined();

    expect(byId[2].units).toBeNull();
    expect(byId[2].reason).toBe(NO_SNAPSHOT_REASON);

    // The critical distinction: a real 0 is NOT null and carries NO absence reason.
    expect(byId[3].units).toBe(0);
    expect(byId[3].reason).toBeUndefined();
  });
});

describe("getStockAsOf — PAIR-LEVEL truthfulness (item 1): a fresh location never masks a stale one", () => {
  test("stale-L2: fresh L1 does NOT hide L2's staleness => possiblyStale true + DISCLOSED partial total", async () => {
    const WATERMARK = "2026-07-14";
    setup({
      products: [{ id: 1, name: "L1 fresh, L2 stale" }],
      // Only L1 has a row on day D (units is L1's on-hand alone — a REAL but partial total).
      daySums: [daySum(1, 10, /* pairsPresentOnDay */ 1)],
      pairInfo: [
        { productId: 1, locationId: 1, _max: { dayKey: WATERMARK }, _min: { dayKey: EARLY } }, // fresh
        { productId: 1, locationId: 2, _max: { dayKey: "2026-07-01" }, _min: { dayKey: EARLY } }, // stale
      ],
      snapMax: WATERMARK,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    const row = page.rows[0];

    // seriesEndsAt is the FLOOR (MIN over pairs) — the stale L2, not the fresh L1 max.
    expect(row.seriesEndsAt).toBe("2026-07-01");
    // Had we grouped by product and taken MAX, this would be false (masked). The floor
    // catches it: the product's series-end lags the watermark.
    expect(row.possiblyStale).toBe(true);
    // 2 known locations, 1 present on day D => the day sum is DISCLOSED partial.
    expect(row.knownPairs).toBe(2);
    expect(row.pairsPresentOnDay).toBe(1);
    expect(row.units).toBe(10); // stays the real (partial) day sum
    expect(row.reason).toBe(partialDayReason(1, 2));
    expect(row.reason).toBe("1 of 2 locations have no snapshot for that day — total may be partial");
  });

  test("all-pairs-fresh: every known location present on day D and current => unchanged (no stale, no partial)", async () => {
    const WATERMARK = "2026-07-14";
    setup({
      products: [{ id: 1, name: "Both locations fresh" }],
      daySums: [daySum(1, 12, /* pairsPresentOnDay */ 2)], // loc1 + loc2 both present on day D
      pairInfo: [
        { productId: 1, locationId: 1, _max: { dayKey: WATERMARK }, _min: { dayKey: EARLY } },
        { productId: 1, locationId: 2, _max: { dayKey: WATERMARK }, _min: { dayKey: EARLY } },
      ],
      snapMax: WATERMARK,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    const row = page.rows[0];

    expect(row.seriesEndsAt).toBe(WATERMARK);
    expect(row.possiblyStale).toBe(false);
    expect(row.knownPairs).toBe(2);
    expect(row.pairsPresentOnDay).toBe(2);
    expect(row.units).toBe(12);
    expect(row.reason).toBeUndefined(); // no partial disclosure when all known locations present
  });

  test("a location added AFTER day D is not counted as a missing known location", async () => {
    // L2's earliest snapshot is AFTER day D, so it did not exist by D and must not make
    // the day total look partial.
    const WATERMARK = "2026-07-14";
    setup({
      products: [{ id: 1, name: "L2 added later" }],
      daySums: [daySum(1, 5, 1)], // only L1 present on day D
      pairInfo: [
        { productId: 1, locationId: 1, _max: { dayKey: WATERMARK }, _min: { dayKey: EARLY } },
        // L2 first appears on 2026-07-12 (> DAY 2026-07-10) => not "known" as of day D.
        { productId: 1, locationId: 2, _max: { dayKey: WATERMARK }, _min: { dayKey: "2026-07-12" } },
      ],
      snapMax: WATERMARK,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    const row = page.rows[0];
    expect(row.knownPairs).toBe(1); // only L1 existed by day D
    expect(row.pairsPresentOnDay).toBe(1);
    expect(row.reason).toBeUndefined(); // 1 present of 1 known => NOT partial
  });
});

describe("getStockAsOf — possiblyStale is a labeled heuristic vs the global watermark", () => {
  test("seriesEndsAt == watermark => false; < watermark => true; no series => false", async () => {
    const WATERMARK = "2026-07-14";
    setup({
      products: [
        { id: 1, name: "Fresh" },
        { id: 2, name: "Stale" },
        { id: 3, name: "No series" },
      ],
      daySums: [
        daySum(1, 10),
        daySum(2, 5),
        // product 3 has no day-D row AND no snapshots at all
      ],
      pairInfo: [
        { productId: 1, locationId: 1, _max: { dayKey: WATERMARK }, _min: { dayKey: EARLY } }, // at the frontier
        { productId: 2, locationId: 1, _max: { dayKey: "2026-07-10" }, _min: { dayKey: EARLY } }, // lags
        // product 3 absent => no pairs => seriesEndsAt null
      ],
      snapMax: WATERMARK,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    const byId = Object.fromEntries(page.rows.map((r) => [r.productId, r]));

    expect(byId[1].seriesEndsAt).toBe(WATERMARK);
    expect(byId[1].possiblyStale).toBe(false);

    expect(byId[2].seriesEndsAt).toBe("2026-07-10");
    expect(byId[2].possiblyStale).toBe(true);

    // No series to be stale — null end never flags (absence is conveyed by units/reason).
    expect(byId[3].seriesEndsAt).toBeNull();
    expect(byId[3].possiblyStale).toBe(false);
    expect(byId[3].units).toBeNull();
    expect(byId[3].reason).toBe(NO_SNAPSHOT_REASON);

    expect(page.coverage.snapshotWatermark).toBe(WATERMARK);
  });

  test("the watermark is the LATER of MAX(dayKey) and the snapshots-job lastWindowTo (catches the all-flagged run)", async () => {
    // Degenerate case: every pair was flagged this run, so nothing new was written and
    // MAX(dayKey) looks old — but lastWindowTo shows the rebuild INTENDED to reach a
    // newer day, so a product ending at the old max IS possibly stale.
    setup({
      products: [{ id: 1, name: "Ends at old max" }],
      daySums: [daySum(1, 3)],
      pairInfo: onePairEach([1], "2026-07-10"),
      snapMax: "2026-07-10", // data frontier looks old
      state: { lastWindowTo: "2026-07-14", flaggedPairs: 2 }, // rebuild intended newer
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    expect(page.coverage.snapshotWatermark).toBe("2026-07-14"); // lastWindowTo wins
    expect(page.rows[0].possiblyStale).toBe(true);
  });

  test("no snapshots and no rebuild state => watermark null => nothing flagged", async () => {
    setup({
      products: [{ id: 1, name: "Lonely" }],
      daySums: [],
      pairInfo: [],
      snapMax: null,
      state: null,
    });
    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    expect(page.coverage.snapshotWatermark).toBeNull();
    expect(page.rows[0].possiblyStale).toBe(false);
    expect(page.rows[0].units).toBeNull();
  });
});

describe("getStockAsOf — today/future/malformed dayKeys are rejected (VALIDATION/400)", () => {
  test("today is rejected — snapshots cover completed days only", async () => {
    setup({ products: [] });
    await expect(getStockAsOf({ dayKey: "2026-07-15", byteBudget: BUDGET }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
      statusCode: 400,
      message: "snapshots cover completed days only",
    });
  });

  test("a future day is rejected", async () => {
    setup({ products: [] });
    await expect(getStockAsOf({ dayKey: "2026-08-01", byteBudget: BUDGET }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
      statusCode: 400,
    });
  });

  test("the last completed day (yesterday) is ACCEPTED (boundary)", async () => {
    setup({ products: [{ id: 1, name: "P" }], daySums: [daySum(1, 4)], pairInfo: onePairEach([1], "2026-07-14"), snapMax: "2026-07-14" });
    const page = await getStockAsOf({ dayKey: "2026-07-14", byteBudget: BUDGET }, NOW);
    expect(page.coverage.dayKey).toBe("2026-07-14");
    expect(page.rows[0].units).toBe(4);
  });

  test("a malformed dayKey is rejected before any query", async () => {
    setup({ products: [] });
    await expect(getStockAsOf({ dayKey: "2026-7-1", byteBudget: BUDGET }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
      statusCode: 400,
    });
    await expect(getStockAsOf({ dayKey: "not-a-day", byteBudget: BUDGET }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(m.product.count).not.toHaveBeenCalled();
    expect(m.productStockSnapshot.aggregate).not.toHaveBeenCalled();
  });

  test("a rolled-over calendar day (2026-02-30) fails the round-trip check", async () => {
    setup({ products: [] });
    await expect(getStockAsOf({ dayKey: "2026-02-30", byteBudget: BUDGET }, NOW)).rejects.toMatchObject({
      code: "VALIDATION",
      statusCode: 400,
    });
  });
});

describe("getStockAsOf — multi-location summation", () => {
  test("units reflects the DB _sum across a product's locations, and the sum query is scoped to the exact day", async () => {
    // The DB does the cross-location sum; the module surfaces _sum.quantity. This value
    // models loc1=5 + loc2=7 = 12 for the exact day (both locations present => count 2).
    setup({
      products: [{ id: 1, name: "Two-location product" }],
      daySums: [daySum(1, 12, 2)],
      pairInfo: [
        { productId: 1, locationId: 1, _max: { dayKey: DAY }, _min: { dayKey: EARLY } },
        { productId: 1, locationId: 2, _max: { dayKey: DAY }, _min: { dayKey: EARLY } },
      ],
      snapMax: DAY,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    expect(page.rows[0].units).toBe(12);
    expect(page.rows[0].reason).toBeUndefined(); // both locations present => not partial

    // The exact-day sum query filters by dayKey and aggregates _sum.quantity.
    expect(m.productStockSnapshot.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["productId"],
        where: expect.objectContaining({ dayKey: DAY }),
        _sum: { quantity: true },
      }),
    );
  });
});

describe("getStockAsOf — DB-side pagination via pageFromDb", () => {
  test("count drives totalRows; a page returns `limit` rows with nextOffset; the next page advances", async () => {
    const products: Prod[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `P${i + 1}` }));
    const daySums: DaySum[] = products.map((p) => daySum(p.id, p.id));
    const pairInfo = onePairEach(products.map((p) => p.id), DAY);
    setup({ products, daySums, pairInfo, snapMax: DAY });

    const page1 = await getStockAsOf({ dayKey: DAY, limit: 2, offset: 0, byteBudget: BUDGET }, NOW);
    expect(page1.totalRows).toBe(6);
    expect(page1.returned).toBe(2);
    expect(page1.rows.map((r) => r.productId)).toEqual([1, 2]);
    expect(page1.nextOffset).toBe(2);
    // fetch received the DB skip/take, not a post-hoc slice.
    expect(m.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 2, orderBy: { id: "asc" } }));

    setup({ products, daySums, pairInfo, snapMax: DAY });
    const page2 = await getStockAsOf({ dayKey: DAY, limit: 2, offset: 2, byteBudget: BUDGET }, NOW);
    expect(page2.rows.map((r) => r.productId)).toEqual([3, 4]);
    expect(page2.nextOffset).toBe(4);
    expect(m.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 2, take: 2 }));
  });
});

describe("getStockAsOf — scope + coverage", () => {
  test("catalog mode returns only in-scope products (an out-of-catalog id is simply absent)", async () => {
    setup({
      products: [
        { id: 1, name: "A" },
        { id: 4, name: "D" },
      ],
      daySums: [daySum(1, 2), daySum(4, 9)],
      pairInfo: onePairEach([1, 4], DAY),
      snapMax: DAY,
    });
    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    expect(page.rows.map((r) => r.productId)).toEqual([1, 4]); // no phantom ids
  });

  test("an out-of-scope productId yields an empty page (not-found is the tool's job)", async () => {
    setup({ products: [], count: 0, snapMax: DAY, state: { lastWindowTo: DAY, flaggedPairs: 0 } });
    const page = await getStockAsOf({ dayKey: DAY, productId: 999, byteBudget: BUDGET }, NOW);
    expect(page.rows).toEqual([]);
    expect(page.returned).toBe(0);
    expect(page.totalRows).toBe(0);
    expect(page.nextOffset).toBeNull();
    // coverage is still populated for the tool layer.
    expect(page.coverage.dayKey).toBe(DAY);
    // the scope predicate matches valuation.ts and narrows by id.
    expect(m.product.count).toHaveBeenCalledWith({
      where: { deletedAt: null, approvalStatus: "APPROVED", id: 999 },
    });
  });

  test("coverage surfaces the global flaggedPairs count and snapshot dataStart for W2-INT", async () => {
    setup({
      products: [{ id: 1, name: "A" }],
      daySums: [daySum(1, 1)],
      pairInfo: onePairEach([1], "2026-07-14"),
      snapMin: "2026-01-01",
      snapMax: "2026-07-14",
      state: { lastWindowTo: "2026-07-14", flaggedPairs: 7 },
    });
    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    expect(page.coverage).toEqual({
      dayKey: DAY,
      snapshotWatermark: "2026-07-14",
      snapshotDataStart: "2026-01-01",
      flaggedPairs: 7,
    });
  });
});
