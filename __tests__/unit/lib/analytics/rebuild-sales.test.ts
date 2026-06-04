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
  test("short-circuits when the sales lock is held", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(null);
    const res = await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    expect(res).toEqual({ rowsDeleted: 0, rowsInserted: 0, unattributed: 0 });
    expect((prisma as any).externalOrder.findMany).not.toHaveBeenCalled();
    expect(releaseRebuildLock as jest.Mock).not.toHaveBeenCalled();
  });

  test("nightly: delete-scope == recompute-scope per touched dayKey (delete by dayKey, reinsert from all orders of that day)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // one touched order -> dayKey 2026-06-04
    (prisma as any).externalOrder.findMany.mockResolvedValue([{ externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T13:00:00Z") }]);
    // $transaction runs its callback with a tx exposing the same model methods
    const txDelete = jest.fn().mockResolvedValue({ count: 2 });
    const txCreate = jest.fn().mockResolvedValue({ count: 1 });
    const txItems = jest.fn().mockResolvedValue([{ quantity: 1, fulfilledQty: 0, price: "9.00",
      productLink: { internalProductId: 5, isBundle: false }, bundleComponentSnapshot: null,
      order: { companyId: "c1", integrationId: "i1", internalStatus: "processing", externalCreatedAt: new Date("2026-06-04T08:00:00Z"), createdAt: new Date("2026-06-04T08:00:00Z"), id: "oX" } }]);
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: txDelete, createMany: txCreate }, externalOrderItem: { findMany: txItems },
    }));
    const res = await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    // delete is scoped to the dayKey
    expect(txDelete).toHaveBeenCalledWith({ where: { dayKey: "2026-06-04" } });
    // items query re-scans ALL orders of that day via the UTC range (not just the triggering order)
    const itemsWhere = txItems.mock.calls[0][0].where;
    expect(itemsWhere.order.OR).toBeDefined();
    expect(itemsWhere.order.OR[0].externalCreatedAt).toEqual({ gte: new Date("2026-06-04T00:00:00.000Z"), lt: new Date("2026-06-05T00:00:00.000Z") });
    expect(itemsWhere.order.OR[1]).toEqual({ externalCreatedAt: null, createdAt: { gte: new Date("2026-06-04T00:00:00.000Z"), lt: new Date("2026-06-05T00:00:00.000Z") } });
    // inserted the attributed row
    expect(txCreate).toHaveBeenCalled();
    expect(res.rowsInserted).toBe(1);
    expect(res.rowsDeleted).toBe(2);
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("companyId scope: delete and re-scan are both narrowed to that company", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).externalOrder.findMany.mockResolvedValue([{ externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T13:00:00Z") }]);
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txItems = jest.fn().mockResolvedValue([]);
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: txItems },
    }));
    await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z"), companyId: "c9" });
    // touched-order scan filtered by company
    expect((prisma as any).externalOrder.findMany.mock.calls[0][0].where.companyId).toBe("c9");
    // delete scoped to dayKey AND company
    expect(txDelete).toHaveBeenCalledWith({ where: { dayKey: "2026-06-04", companyId: "c9" } });
    // re-scan scoped to the same company (delete-scope == recompute-scope)
    expect(txItems.mock.calls[0][0].where.order.companyId).toBe("c9");
  });

  test("weekly full: TRUE full range from earliest order day through today", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).externalOrder.findFirst.mockResolvedValue({ externalCreatedAt: new Date("2026-06-02T00:00:00Z"), createdAt: new Date("2026-06-02T00:00:00Z") });
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txItems = jest.fn().mockResolvedValue([]);
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: txItems },
    }));
    jest.useFakeTimers().setSystemTime(new Date("2026-06-04T06:00:00Z"));
    try {
      await rebuildSalesFacts({ full: true });
    } finally {
      jest.useRealTimers();
    }
    // earliest=2026-06-02, today=2026-06-04 -> three consecutive days each recomputed (one tx per day)
    expect(txDelete).toHaveBeenCalledTimes(3);
    expect(txDelete.mock.calls.map((c) => c[0].where.dayKey)).toEqual(["2026-06-02", "2026-06-03", "2026-06-04"]);
    // full path never uses the updatedAt window
    expect((prisma as any).externalOrder.findMany).not.toHaveBeenCalled();
  });

  test("weekly full with no orders -> no work, clean run", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).externalOrder.findFirst.mockResolvedValue(null);
    const res = await rebuildSalesFacts({ full: true });
    expect(res).toEqual({ rowsDeleted: 0, rowsInserted: 0, unattributed: 0 });
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("heartbeat lost mid-run -> aborts remaining days and records the abort honestly", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(false); // lease lost on first heartbeat (day #10)
    // 12 touched days -> first heartbeat fires at the 10th iteration and aborts
    const orders = Array.from({ length: 12 }, (_, n) => {
      const d = new Date(Date.UTC(2026, 5, n + 1, 12));
      return { externalCreatedAt: d, createdAt: d, updatedAt: d };
    });
    (prisma as any).externalOrder.findMany.mockResolvedValue(orders);
    const txDelete = jest.fn().mockResolvedValue({ count: 0 });
    const txItems = jest.fn().mockResolvedValue([]);
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: txDelete, createMany: jest.fn() }, externalOrderItem: { findMany: txItems },
    }));
    await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    // 9 days recomputed before the 10th-iteration heartbeat check aborts the loop
    expect(txDelete).toHaveBeenCalledTimes(9);
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

  test("clean nightly run records the watermark (max updatedAt) and a null error", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).externalOrder.findMany.mockResolvedValue([
      { externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T13:00:00Z") },
      { externalCreatedAt: new Date("2026-06-04T12:00:00Z"), createdAt: new Date("2026-06-04T12:00:00Z"), updatedAt: new Date("2026-06-04T18:30:00Z") },
    ]);
    (prisma as any).$transaction.mockImplementation(async (cb: any) => cb({
      productSalesFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn() },
      externalOrderItem: { findMany: jest.fn().mockResolvedValue([]) },
    }));
    await rebuildSalesFacts({ since: new Date("2026-06-01T00:00:00Z") });
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "sales",
      expect.objectContaining({ sourceWatermark: new Date("2026-06-04T18:30:00Z"), lastError: null, lastWindowFrom: "2026-06-04", lastWindowTo: "2026-06-04" }),
    );
  });
});
