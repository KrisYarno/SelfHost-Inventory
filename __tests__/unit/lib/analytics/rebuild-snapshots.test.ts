jest.mock("@/lib/analytics/rebuild-lock", () => ({
  beginRebuildRun: jest.fn(), finalizeRebuildRun: jest.fn(), heartbeatRebuildLock: jest.fn(),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: { inventory_logs: { aggregate: jest.fn(), findMany: jest.fn() }, product_locations: { findMany: jest.fn() }, productStockSnapshot: { upsert: jest.fn() } } }));

import { reconstructLevels, rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { beginRebuildRun, finalizeRebuildRun, heartbeatRebuildLock } from "@/lib/analytics/rebuild-lock";
import prisma from "@/lib/prisma";

// Lifecycle helpers: begin acquires the lock + opens a RUNNING row; finalize
// writes the terminal row + state mirror + retention + fenced release. These are
// mocked here (unit-tested directly in lane3-rebuild-lifecycle.test.ts).
const TOKEN = new Date("2026-06-04T00:00:00Z");
const acquired = { acquired: true as const, runId: 1, token: TOKEN };

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
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no null-location legacy logs => no cutoff => unchanged behavior. Tests that exercise the
    // floor override this with an explicit _max.changeTime.
    (prisma as any).inventory_logs.aggregate.mockResolvedValue({ _max: { changeTime: null } });
  });
  test("short-circuits when the lock is held (begin acquired:false) -> skipped:true, never queries product_locations", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue({ acquired: false, runId: 9 });
    const res = await rebuildStockSnapshots();
    expect(res).toEqual({ rowsInserted: 0, flaggedPairs: 0, nullLocationCutoff: null, skipped: true });
    expect((prisma as any).product_locations.findMany).not.toHaveBeenCalled();
    expect((prisma as any).inventory_logs.aggregate).not.toHaveBeenCalled();
    // The ABORTED/'lock-held' row is opened+finalized inside begin; the caller does NOT finalize.
    expect(finalizeRebuildRun as jest.Mock).not.toHaveBeenCalled();
  });

  // Replaces the old global tripwire (which threw on any null-location log). The code now DATE-BOUNDS instead:
  // it floors the backfill at (max null-location-log day + 1), so the emitted range is unambiguously trustworthy
  // and pre-cutoff days (legacy gap) are simply not emitted.
  test("floors backfill at (max null-location day + 1) when legacy null-location logs exist", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    // Last legacy null-location log is 2025-05-01 => cutoff floors at 2025-05-02.
    (prisma as any).inventory_logs.aggregate.mockResolvedValue({ _max: { changeTime: new Date("2025-05-01T21:52:12Z") } });
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 10 }]);
    // Pair has located logs spanning before AND after the cutoff.
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([
      { changeTime: new Date("2025-04-15T10:00:00Z"), delta: 2 },
      { changeTime: new Date("2025-05-03T10:00:00Z"), delta: 1 },
    ]);
    const upsert = (prisma as any).productStockSnapshot.upsert as jest.Mock;
    // baseFrom would be 2025-04-15 (earliest log), but the cutoff floors emission at 2025-05-02.
    const res = await rebuildStockSnapshots({ to: "2025-05-04" });
    expect(res.nullLocationCutoff).toBe("2025-05-02");
    expect(res.skipped).toBe(false); // a real completed run (lock held only short-circuits)
    const dayKeysWritten = upsert.mock.calls.map((c) => c[0].where.productId_locationId_dayKey.dayKey);
    expect(dayKeysWritten.length).toBeGreaterThan(0);
    // Every emitted day is >= the cutoff; the pre-cutoff legacy era is excluded.
    expect(dayKeysWritten.every((k: string) => k >= "2025-05-02")).toBe(true);
    expect(dayKeysWritten.some((k: string) => k < "2025-05-02")).toBe(false);
    expect(dayKeysWritten).not.toContain("2025-04-15"); // a concrete pre-cutoff day, excluded
    expect(dayKeysWritten).toContain("2025-05-02"); // first post-cutoff day, emitted
    // Finalize reflects the EFFECTIVE floor (the applied cutoff), not opts.from, and a clean SUCCEEDED status.
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledWith(
      1,
      TOKEN,
      expect.objectContaining({ status: "SUCCEEDED", lastWindowFrom: "2025-05-02", lastError: null }),
    );
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledTimes(1);
  });

  // Window spans the day BEFORE the +5 delta so reconstruction of 2026-06-03 = current(1) - 5 = -4 (negative).
  // An explicit window (vs. the clock-dependent default `from`=earliest-log-day / `to`=today) makes the negative deterministic.
  test("negative reconstruction flags the pair, never upserts, and finalizes (fenced release)", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 1 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }]);
    const res = await rebuildStockSnapshots({ from: "2026-06-03", to: "2026-06-04" });
    expect(res).toEqual({ rowsInserted: 0, flaggedPairs: 1, nullLocationCutoff: null, skipped: false });
    expect((prisma as any).productStockSnapshot.upsert).not.toHaveBeenCalled();
    // A flagged pair is still a completed run: SUCCEEDED with flaggedPairs counted.
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledWith(1, TOKEN, expect.objectContaining({ status: "SUCCEEDED", flaggedPairs: 1 }));
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("happy path upserts one snapshot row with the composite key and records a clean run", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 10 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }]);
    const res = await rebuildStockSnapshots({ from: "2026-06-04", to: "2026-06-04" });
    expect(res).toEqual({ rowsInserted: 1, flaggedPairs: 0, nullLocationCutoff: null, skipped: false });
    expect((prisma as any).productStockSnapshot.upsert).toHaveBeenCalledTimes(1);
    expect((prisma as any).productStockSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { productId_locationId_dayKey: { productId: 1, locationId: 1, dayKey: "2026-06-04" } },
        create: expect.objectContaining({ quantity: 10 }),
      }),
    );
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledWith(
      1,
      TOKEN,
      expect.objectContaining({ status: "SUCCEEDED", lastError: null }),
    );
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("default 'to' is the last COMPLETED day (yesterday), never today's partial level", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-06-05T03:10:00Z")); // nightly cron time
    // acquire token, no null-loc legacy logs (aggregate default from beforeEach), one pair, one same-day delta on 2026-06-04 (last completed day)
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    (prisma as any).product_locations.findMany.mockResolvedValue([{ productId: 1, locationId: 1, quantity: 10 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValue([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 4 }]);
    const upsert = (prisma as any).productStockSnapshot.upsert as jest.Mock;
    await rebuildStockSnapshots();
    const dayKeysWritten = upsert.mock.calls.map((c) => c[0].where.productId_locationId_dayKey.dayKey);
    expect(dayKeysWritten).not.toContain("2026-06-05"); // never writes today's partial
    expect(dayKeysWritten[dayKeysWritten.length - 1]).toBe("2026-06-04"); // last completed day is the latest row
    jest.useRealTimers();
  });

  test("a query throw mid-run finalizes FAILED (non-null error) and still releases the lock", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (prisma as any).product_locations.findMany.mockRejectedValueOnce(new Error("db exploded"));
    await expect(rebuildStockSnapshots()).rejects.toThrow();
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledWith(
      1,
      TOKEN,
      expect.objectContaining({ status: "FAILED", lastError: expect.stringMatching(/.+/) }),
    );
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledTimes(1);
  });
});
