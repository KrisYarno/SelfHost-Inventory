jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {
  externalOrder: { findMany: jest.fn(), findFirst: jest.fn() },
  externalOrderItem: { findMany: jest.fn() },
  productSalesFact: { deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: jest.fn(),
} }));
jest.mock("@/lib/analytics/rebuild-lock", () => ({
  acquireRebuildLock: jest.fn(), heartbeatRebuildLock: jest.fn(), releaseRebuildLock: jest.fn(), recordRebuildRun: jest.fn(),
}));
import prisma from "@/lib/prisma";
import { acquireRebuildLock, heartbeatRebuildLock, releaseRebuildLock, recordRebuildRun } from "@/lib/analytics/rebuild-lock";
import { collectTouchedDayKeys, factRowsFor, rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";

beforeEach(() => jest.clearAllMocks());

describe("collectTouchedDayKeys (pure)", () => {
  test("distinct sorted saleDayKeys from orders (externalCreatedAt ?? createdAt, UTC)", () => {
    const out = collectTouchedDayKeys([
      { externalCreatedAt: new Date("2026-06-04T23:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") },
      { externalCreatedAt: null, createdAt: new Date("2026-06-03T10:00:00Z") },
      { externalCreatedAt: new Date("2026-06-04T01:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    expect(out).toEqual(["2026-06-03", "2026-06-04"]);
  });

  test("empty input -> empty array", () => {
    expect(collectTouchedDayKeys([])).toEqual([]);
  });
});

describe("factRowsFor (pure: cents->Decimal string, orderIds.size->orderCount)", () => {
  test("converts attribution accumulators to insertable rows", () => {
    const { rows } = factRowsFor([{ quantity: 3, fulfilledQty: 2, price: "5.00",
      productLink: { internalProductId: 42, isBundle: false }, bundleComponentSnapshot: null,
      order: { companyId: "c1", integrationId: "i1", internalStatus: "processing",
               externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), id: "o1" } }]);
    expect(rows).toEqual([{ productId: 42, companyId: "c1", integrationId: "i1", dayKey: "2026-06-04",
      orderedQty: 3, fulfilledQty: 2, revenue: "15.00", orderCount: 1 }]);
  });

  test("bubbles up unattributed from the attribution layer (e.g. malformed bundle snapshot)", () => {
    const { rows, unattributed } = factRowsFor([{ quantity: 1, fulfilledQty: 1, price: "9.00",
      productLink: { internalProductId: 7, isBundle: true }, bundleComponentSnapshot: [{ internalProductId: 0, quantity: 1 }],
      order: { companyId: "c1", integrationId: "i1", internalStatus: "processing",
               externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), id: "o1" } }]);
    expect(rows).toEqual([]);
    expect(unattributed).toBe(1);
  });
});

describe("rebuildSalesFacts (orchestration)", () => {
  test("short-circuits when the sales lock is held -> skipped:true (no work, marker must NOT advance)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(null);
    const res = await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    expect(res).toEqual({ rowsDeleted: 0, rowsInserted: 0, unattributed: 0, skipped: true });
    expect((prisma as any).externalOrder.findMany).not.toHaveBeenCalled();
    expect(releaseRebuildLock as jest.Mock).not.toHaveBeenCalled();
  });

  test("nightly: delete-scope == recompute-scope per touched dayKey (delete by dayKey, reinsert from all orders of that day)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // Pin "now" so the rolling window is deterministic. The touched order sits at 2026-06-04 — OUTSIDE the
    // 14-day rolling window (2026-06-06..2026-06-20) — proving the union also recomputes an updatedAt-touched
    // day that falls before the rolling window. Per-dayKey delete+re-scan structure is asserted on that day.
    jest.useFakeTimers().setSystemTime(new Date("2026-06-20T03:00:00Z"));
    // one touched order -> dayKey 2026-06-04
    (prisma as any).externalOrder.findMany.mockResolvedValue([{ externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T13:00:00Z") }]);
    // $transaction runs its callback with a tx exposing the same model methods. The triggering item belongs to
    // the touched day (2026-06-04); rolling-window days re-scan to no items here, so only one row is inserted.
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txCreate = jest.fn().mockResolvedValue({ count: 1 });
    const txItems = jest.fn().mockImplementation(async (args: any) => {
      const lo = args.where.order.OR[0].externalCreatedAt.gte as Date;
      // Only the 2026-06-04 window returns the order item; rolling-window days are empty.
      return lo.getTime() === new Date("2026-06-04T00:00:00.000Z").getTime()
        ? [{ quantity: 1, fulfilledQty: 0, price: "9.00", productLink: { internalProductId: 5, isBundle: false }, bundleComponentSnapshot: null,
            order: { companyId: "c1", integrationId: "i1", internalStatus: "processing", externalCreatedAt: new Date("2026-06-04T08:00:00Z"), createdAt: new Date("2026-06-04T08:00:00Z"), id: "oX" } }]
        : [];
    });
    let res: any;
    try {
      (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
        productSalesFact: { deleteMany: txDelete, createMany: txCreate }, externalOrderItem: { findMany: txItems },
      }));
      res = await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    } finally {
      jest.useRealTimers();
    }
    // The touched day (2026-06-04) is recomputed via a delete scoped to that dayKey...
    expect(txDelete).toHaveBeenCalledWith({ where: { dayKey: "2026-06-04" } });
    // ...and 15 rolling days (2026-06-06..2026-06-20 inclusive) are ALSO recomputed (the union).
    const deletedKeys = txDelete.mock.calls.map((c) => c[0].where.dayKey);
    expect(deletedKeys).toContain("2026-06-04"); // updatedAt-touched, outside rolling window
    expect(deletedKeys).toContain("2026-06-06"); // first rolling day
    expect(deletedKeys).toContain("2026-06-20"); // last rolling day (today)
    expect(deletedKeys).not.toContain("2026-06-05"); // gap between touched day and rolling window is NOT recomputed
    expect(txDelete).toHaveBeenCalledTimes(16); // 1 touched + 15 rolling, deduped + sorted
    // The dayKeys are deduped + sorted ascending.
    expect(deletedKeys).toEqual([...deletedKeys].sort());
    // items query re-scans ALL orders of the touched day via the UTC range (not just the triggering order)
    const touchedItemsCall = txItems.mock.calls.find((c) => (c[0].where.order.OR[0].externalCreatedAt.gte as Date).getTime() === new Date("2026-06-04T00:00:00.000Z").getTime());
    const itemsWhere = touchedItemsCall![0].where;
    expect(itemsWhere.order.OR).toBeDefined();
    expect(itemsWhere.order.OR[0].externalCreatedAt).toEqual({ gte: new Date("2026-06-04T00:00:00.000Z"), lt: new Date("2026-06-05T00:00:00.000Z") });
    expect(itemsWhere.order.OR[1]).toEqual({ externalCreatedAt: null, createdAt: { gte: new Date("2026-06-04T00:00:00.000Z"), lt: new Date("2026-06-05T00:00:00.000Z") } });
    // inserted the attributed row (only the touched day produced items)
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(res.rowsInserted).toBe(1);
    expect(res.skipped).toBe(false);
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("companyId scope: delete and re-scan are both narrowed to that company", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // Pin "now" to the touched day so the rolling window includes 2026-06-04; the company scoping below
    // holds for every recomputed dayKey (touched + rolling alike).
    jest.useFakeTimers().setSystemTime(new Date("2026-06-04T03:00:00Z"));
    (prisma as any).externalOrder.findMany.mockResolvedValue([{ externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T13:00:00Z") }]);
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txItems = jest.fn().mockResolvedValue([]);
    try {
      (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
        productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: txItems },
      }));
      await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z"), companyId: "c9" });
    } finally {
      jest.useRealTimers();
    }
    // touched-order scan filtered by company
    expect((prisma as any).externalOrder.findMany.mock.calls[0][0].where.companyId).toBe("c9");
    // delete scoped to dayKey AND company (asserted on the touched day)
    expect(txDelete).toHaveBeenCalledWith({ where: { dayKey: "2026-06-04", companyId: "c9" } });
    // re-scan scoped to the same company on EVERY recomputed day (delete-scope == recompute-scope)
    expect(txItems.mock.calls.every((c) => c[0].where.order.companyId === "c9")).toBe(true);
  });

  test("weekly full: TRUE full range starts at the earliest SALE day (min across both branches), not earliest createdAt", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // F4 bug scenario: an IMPORTED order has a LATER createdAt (2026-06-15) but an OLDER externalCreatedAt
    // (2026-06-01 = its true sale day). The old code keyed the floor off `orderBy createdAt asc` and would have
    // started at 2026-06-03 (the earliest-createdAt order's sale day), MISSING 2026-06-01/02. The fix takes the
    // MIN saleDayKey across BOTH findFirst branches.
    //   call 1 (earliest externalCreatedAt): the imported order -> saleDayKey 2026-06-01
    //   call 2 (earliest createdAt):         a normal order     -> saleDayKey 2026-06-03
    (prisma as any).externalOrder.findFirst
      .mockResolvedValueOnce({ externalCreatedAt: new Date("2026-06-01T09:00:00Z"), createdAt: new Date("2026-06-15T00:00:00Z") })
      .mockResolvedValueOnce({ externalCreatedAt: new Date("2026-06-03T09:00:00Z"), createdAt: new Date("2026-06-03T00:00:00Z") });
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txItems = jest.fn().mockResolvedValue([]);
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: txItems },
    }));
    let res: any;
    jest.useFakeTimers().setSystemTime(new Date("2026-06-04T06:00:00Z"));
    try {
      res = await rebuildSalesFacts({ full: true });
    } finally {
      jest.useRealTimers();
    }
    // min saleDay = 2026-06-01 (NOT 2026-06-03), today = 2026-06-04 -> four consecutive days, one tx per day
    expect(txDelete).toHaveBeenCalledTimes(4);
    expect(txDelete.mock.calls.map((c) => c[0].where.dayKey)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"]);
    // the externalCreatedAt branch is queried with the `not: null` + asc ordering
    expect((prisma as any).externalOrder.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { externalCreatedAt: { not: null } }, orderBy: { externalCreatedAt: "asc" },
    }));
    // full path never uses the updatedAt window
    expect((prisma as any).externalOrder.findMany).not.toHaveBeenCalled();
    expect(res.skipped).toBe(false);
  });

  test("weekly full: when only the createdAt branch has rows (no externalCreatedAt anywhere), floors at that sale day", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // No order has a non-null externalCreatedAt -> call 1 returns null; call 2 returns the earliest-createdAt order.
    (prisma as any).externalOrder.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ externalCreatedAt: null, createdAt: new Date("2026-06-03T09:00:00Z") });
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    }));
    jest.useFakeTimers().setSystemTime(new Date("2026-06-04T06:00:00Z"));
    try {
      await rebuildSalesFacts({ full: true });
    } finally {
      jest.useRealTimers();
    }
    expect(txDelete.mock.calls.map((c) => c[0].where.dayKey)).toEqual(["2026-06-03", "2026-06-04"]);
  });

  test("weekly full with no orders -> no work, clean run (skipped:false — it ran, just found nothing)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).externalOrder.findFirst.mockResolvedValue(null);
    const res = await rebuildSalesFacts({ full: true });
    expect(res).toEqual({ rowsDeleted: 0, rowsInserted: 0, unattributed: 0, skipped: false });
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("heartbeat lost mid-run -> aborts remaining days and records the abort honestly", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(false); // lease lost on first heartbeat (day #10)
    // 12 touched days 2026-06-01..2026-06-12. Pin "now" to 2026-06-30 so the rolling window (2026-06-16..06-30)
    // sorts strictly AFTER the touched days; the first 9 recomputed days are thus 06-01..06-09 and the heartbeat
    // at the 10th iteration aborts before any rolling day runs.
    jest.useFakeTimers().setSystemTime(new Date("2026-06-30T03:00:00Z"));
    const orders = Array.from({ length: 12 }, (_, n) => {
      const d = new Date(Date.UTC(2026, 5, n + 1, 12));
      return { externalCreatedAt: d, createdAt: d, updatedAt: d };
    });
    (prisma as any).externalOrder.findMany.mockResolvedValue(orders);
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txItems = jest.fn().mockResolvedValue([]);
    try {
      (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
        productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: txItems },
      }));
      await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    } finally {
      jest.useRealTimers();
    }
    // 9 days recomputed before the 10th-iteration heartbeat check aborts the loop
    expect(txDelete).toHaveBeenCalledTimes(9);
    expect(txDelete.mock.calls.map((c) => c[0].where.dayKey)).toEqual([
      "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09",
    ]);
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "sales",
      expect.objectContaining({ lastError: expect.stringContaining("lease lost") }),
    );
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("a query throw mid-run records a non-null error and still releases the lock (finally)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).externalOrder.findMany.mockRejectedValue(new Error("db exploded"));
    await expect(rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") })).rejects.toThrow("db exploded");
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "sales",
      expect.objectContaining({ lastError: expect.stringMatching(/.+/) }),
    );
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("clean nightly run records the watermark (max updatedAt) and a null error; window spans the rolling union", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // Pin "now" so the 14-day rolling window is 2026-05-21..2026-06-04 and the touched orders (both on 2026-06-04)
    // fall inside it. The recorded window therefore spans the union [2026-05-21 .. 2026-06-04].
    jest.useFakeTimers().setSystemTime(new Date("2026-06-04T20:00:00Z"));
    (prisma as any).externalOrder.findMany.mockResolvedValue([
      { externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T13:00:00Z") },
      { externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T18:30:00Z") },
    ]);
    let res: any;
    try {
      (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
        productSalesFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn() },
        externalOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
      }));
      res = await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    } finally {
      jest.useRealTimers();
    }
    // watermark is still the updatedAt frontier (the rolling window is time-derived, not order-derived)
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "sales",
      expect.objectContaining({ sourceWatermark: new Date("2026-06-04T18:30:00Z"), lastError: null, lastWindowFrom: "2026-05-21", lastWindowTo: "2026-06-04" }),
    );
    expect(res.skipped).toBe(false);
  });

  test("nightly rolling default: with NO updatedAt-touched orders, still recomputes the last 14 completed days (catches non-updatedAt edits)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    jest.useFakeTimers().setSystemTime(new Date("2026-06-20T03:00:00Z"));
    (prisma as any).externalOrder.findMany.mockResolvedValue([]); // nothing bumped updatedAt
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    let res: any;
    try {
      (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
        productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
      }));
      res = await rebuildSalesFacts({});
    } finally {
      jest.useRealTimers();
    }
    // rolling 14-day window: 2026-06-06..2026-06-20 inclusive = 15 dayKeys
    const deletedKeys = txDelete.mock.calls.map((c) => c[0].where.dayKey);
    expect(deletedKeys).toEqual([
      "2026-06-06", "2026-06-07", "2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11", "2026-06-12", "2026-06-13",
      "2026-06-14", "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20",
    ]);
    // no updatedAt-touched orders -> watermark is null, but the run still did work
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "sales",
      expect.objectContaining({ sourceWatermark: null, lastWindowFrom: "2026-06-06", lastWindowTo: "2026-06-20", lastError: null }),
    );
    expect(res.skipped).toBe(false);
  });
});
