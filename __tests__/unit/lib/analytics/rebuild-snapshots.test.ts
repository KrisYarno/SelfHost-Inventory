jest.mock("@/lib/analytics/rebuild-lock", () => ({
  acquireRebuildLock: jest.fn(), heartbeatRebuildLock: jest.fn(), releaseRebuildLock: jest.fn(), recordRebuildRun: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { inventory_logs: { count: jest.fn(), findMany: jest.fn() }, product_locations: { findMany: jest.fn() }, productStockSnapshot: { upsert: jest.fn() } } }));

import { reconstructLevels, rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { acquireRebuildLock, releaseRebuildLock, recordRebuildRun } from "@/lib/analytics/rebuild-lock";
import prisma from "@/lib/prisma";

// reconstructLevels is pure (only depends on the real dates helpers, not the mocks above), so these pass regardless of the mocks.
describe("reconstructLevels (backfill, baseline-free guard)", () => {
  const deltas = [
    { changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 },
    { changeTime: new Date("2026-06-03T10:00:00Z"), delta: -2 },
  ];
  test("reconstructs end-of-day levels backward from current", () => {
    const r = reconstructLevels({ current: 10, deltas, fromDayKey: "2026-06-02", toDayKey: "2026-06-04" });
    expect(r.ok).toBe(true);
    expect(r.levels).toEqual([
      { dayKey: "2026-06-02", quantity: 7 },
      { dayKey: "2026-06-03", quantity: 5 },
      { dayKey: "2026-06-04", quantity: 10 },
    ]);
  });
  test("flags the pair when reconstruction goes negative (impossible stock => inconsistent deltas)", () => {
    const r = reconstructLevels({ current: 1, deltas: [{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }], fromDayKey: "2026-06-03", toDayKey: "2026-06-04" });
    expect(r.ok).toBe(false);
    expect(r.levels).toEqual([]);
  });
  test("midnight boundary: a delta at 00:00:00Z of D+1 counts as 'after D'", () => {
    const r = reconstructLevels({ current: 10, deltas: [{ changeTime: new Date("2026-06-05T00:00:00Z"), delta: 3 }], fromDayKey: "2026-06-04", toDayKey: "2026-06-04" });
    expect(r.levels).toEqual([{ dayKey: "2026-06-04", quantity: 7 }]);
  });
});

describe("rebuildStockSnapshots (orchestrator)", () => {
  beforeEach(() => jest.clearAllMocks());
  test("short-circuits when the lock is held (acquire returns null) and never queries product_locations", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(null);
    const res = await rebuildStockSnapshots();
    expect(res).toEqual({ rowsInserted: 0, flaggedPairs: 0 });
    expect((prisma as any).product_locations.findMany).not.toHaveBeenCalled();
    expect((prisma as any).inventory_logs.count).not.toHaveBeenCalled();
  });

  test("reconcile tripwire: nonzero null-location log => throws, records null-location error, still releases", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (prisma as any).inventory_logs.count.mockResolvedValueOnce(1);
    await expect(rebuildStockSnapshots()).rejects.toThrow();
    expect((prisma as any).product_locations.findMany).not.toHaveBeenCalled();
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "snapshots",
      expect.objectContaining({ lastError: expect.stringContaining("null-location") }),
    );
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  // Window spans the day BEFORE the +5 delta so reconstruction of 2026-06-03 = current(1) - 5 = -4 (negative).
  // An explicit window (vs. the clock-dependent default `from`=earliest-log-day / `to`=today) makes the negative deterministic.
  test("negative reconstruction flags the pair, never upserts, and releases the lock", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (prisma as any).inventory_logs.count.mockResolvedValueOnce(0);
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 1 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }]);
    const res = await rebuildStockSnapshots({ from: "2026-06-03", to: "2026-06-04" });
    expect(res).toEqual({ rowsInserted: 0, flaggedPairs: 1 });
    expect((prisma as any).productStockSnapshot.upsert).not.toHaveBeenCalled();
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("happy path upserts one snapshot row with the composite key and records a clean run", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (prisma as any).inventory_logs.count.mockResolvedValueOnce(0);
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 10 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }]);
    const res = await rebuildStockSnapshots({ from: "2026-06-04", to: "2026-06-04" });
    expect(res).toEqual({ rowsInserted: 1, flaggedPairs: 0 });
    expect((prisma as any).productStockSnapshot.upsert).toHaveBeenCalledTimes(1);
    expect((prisma as any).productStockSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId_locationId_dayKey: { productId: 1, locationId: 1, dayKey: "2026-06-04" } },
        create: expect.objectContaining({ quantity: 10 }),
      }),
    );
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "snapshots",
      expect.objectContaining({ lastError: null }),
    );
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("a query throw mid-run records a non-null error and still releases the lock (finally)", async () => {
    (acquireRebuildLock as jest.Mock).mockResolvedValue(new Date("2026-06-04T00:00:00Z"));
    (prisma as any).inventory_logs.count.mockResolvedValueOnce(0);
    (prisma as any).product_locations.findMany.mockRejectedValueOnce(new Error("db exploded"));
    await expect(rebuildStockSnapshots()).rejects.toThrow();
    expect(recordRebuildRun as jest.Mock).toHaveBeenCalledWith(
      "snapshots",
      expect.objectContaining({ lastError: expect.stringMatching(/.+/) }),
    );
    expect(releaseRebuildLock as jest.Mock).toHaveBeenCalledTimes(1);
  });
});
