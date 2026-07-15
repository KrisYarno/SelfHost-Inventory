/**
 * @jest-environment node
 *
 * W2-ASOF (spec §5 T-ASOF REV-2 NARROWED): `lib/analytics/stock-asof.ts` — exact-day
 * as-of stock from ProductStockSnapshot, over a mocked prisma. The narrowing is the
 * point of this suite: the table has no per-row validity marker and a flagged rebuild
 * PRESERVES stale rows, so the module may only be truthful about (1) the exact-day
 * value (null + reason when a product has NO row that day — NEVER a fabricated 0),
 * (2) each product's series end, and (3) a LABELED possiblyStale heuristic.
 *
 * Pins (from the brief item 6 + spec §5 T-ASOF):
 *   * missing-day => units null + the exact reason; a present 0-on-hand day => units 0
 *     (real, distinct from absent)
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
import { getStockAsOf, NO_SNAPSHOT_REASON } from "@/lib/analytics/stock-asof";

const m = prisma as unknown as {
  product: { count: jest.Mock; findMany: jest.Mock };
  productStockSnapshot: { aggregate: jest.Mock; groupBy: jest.Mock };
  analyticsRebuildState: { findUnique: jest.Mock };
};

/** 2026-07-15 noon UTC => today = 2026-07-15, last completed day = 2026-07-14. */
const NOW = new Date("2026-07-15T12:00:00.000Z");
const DAY = "2026-07-10"; // a completed day
const BUDGET = PER_TOOL_RESULT_CAP_BYTES;

type Prod = { id: number; name: string | null };
type DaySum = { productId: number; _sum: { quantity: number | null } };
type SeriesEnd = { productId: number; _max: { dayKey: string | null } };

function setup(f: {
  products?: Prod[];
  count?: number;
  daySums?: DaySum[];
  seriesEnds?: SeriesEnd[];
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
  // groupBy is called twice: once with `_sum` (exact-day sums) and once with `_max`
  // (series ends). Branch on which aggregate the caller asked for.
  m.productStockSnapshot.groupBy.mockImplementation(async (args: any) => {
    if (args?._sum) return f.daySums ?? [];
    if (args?._max) return f.seriesEnds ?? [];
    return [];
  });
  m.analyticsRebuildState.findUnique.mockResolvedValue(f.state ?? null);
}

const endAll = (ids: number[], dayKey: string): SeriesEnd[] =>
  ids.map((id) => ({ productId: id, _max: { dayKey } }));

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
        { productId: 1, _sum: { quantity: 25 } },
        // product 2 absent => no row that day
        { productId: 3, _sum: { quantity: 0 } }, // present row summing to 0 (real answer)
      ],
      seriesEnds: endAll([1, 2, 3], DAY),
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
        { productId: 1, _sum: { quantity: 10 } },
        { productId: 2, _sum: { quantity: 5 } },
        // product 3 has no day-D row AND no snapshots at all
      ],
      seriesEnds: [
        { productId: 1, _max: { dayKey: WATERMARK } }, // at the frontier
        { productId: 2, _max: { dayKey: "2026-07-10" } }, // lags the frontier
        // product 3 absent => seriesEndsAt null
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
      daySums: [{ productId: 1, _sum: { quantity: 3 } }],
      seriesEnds: [{ productId: 1, _max: { dayKey: "2026-07-10" } }],
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
      seriesEnds: [],
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
    setup({ products: [{ id: 1, name: "P" }], daySums: [{ productId: 1, _sum: { quantity: 4 } }], seriesEnds: endAll([1], "2026-07-14"), snapMax: "2026-07-14" });
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
    // models loc1=5 + loc2=7 = 12 for the exact day.
    setup({
      products: [{ id: 1, name: "Two-location product" }],
      daySums: [{ productId: 1, _sum: { quantity: 12 } }],
      seriesEnds: endAll([1], DAY),
      snapMax: DAY,
    });

    const page = await getStockAsOf({ dayKey: DAY, byteBudget: BUDGET }, NOW);
    expect(page.rows[0].units).toBe(12);

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
    const daySums: DaySum[] = products.map((p) => ({ productId: p.id, _sum: { quantity: p.id } }));
    const seriesEnds = endAll(products.map((p) => p.id), DAY);
    setup({ products, daySums, seriesEnds, snapMax: DAY });

    const page1 = await getStockAsOf({ dayKey: DAY, limit: 2, offset: 0, byteBudget: BUDGET }, NOW);
    expect(page1.totalRows).toBe(6);
    expect(page1.returned).toBe(2);
    expect(page1.rows.map((r) => r.productId)).toEqual([1, 2]);
    expect(page1.nextOffset).toBe(2);
    // fetch received the DB skip/take, not a post-hoc slice.
    expect(m.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 2, orderBy: { id: "asc" } }));

    setup({ products, daySums, seriesEnds, snapMax: DAY });
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
      daySums: [
        { productId: 1, _sum: { quantity: 2 } },
        { productId: 4, _sum: { quantity: 9 } },
      ],
      seriesEnds: endAll([1, 4], DAY),
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
      daySums: [{ productId: 1, _sum: { quantity: 1 } }],
      seriesEnds: endAll([1], "2026-07-14"),
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
