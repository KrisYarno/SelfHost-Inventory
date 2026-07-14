jest.mock("@/lib/analytics/rebuild-lock", () => ({
  beginRebuildRun: jest.fn(), finalizeRebuildRun: jest.fn(), heartbeatRebuildLock: jest.fn(),
}));
// P3 (Lane 5): the writer no longer upserts per (pair×day); it runs one array-form
// $transaction per pair (deleteMany the recompute window + createMany in chunks of
// 500). The manual mock exposes deleteMany/createMany/$transaction accordingly, with
// $transaction awaiting the ops array so ordering is faithful.
jest.mock("@/lib/prisma", () => {
  const db: any = {
    inventory_logs: { aggregate: jest.fn(), findMany: jest.fn() },
    product_locations: { findMany: jest.fn() },
    productStockSnapshot: {
      deleteMany: jest.fn(() => ({ __op: "deleteMany" })),
      createMany: jest.fn(() => ({ __op: "createMany" })),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  };
  return { __esModule: true, default: db };
});

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
    const createMany = (prisma as any).productStockSnapshot.createMany as jest.Mock;
    const deleteMany = (prisma as any).productStockSnapshot.deleteMany as jest.Mock;
    // baseFrom would be 2025-04-15 (earliest log), but the cutoff floors emission at 2025-05-02.
    const res = await rebuildStockSnapshots({ to: "2025-05-04" });
    expect(res.nullLocationCutoff).toBe("2025-05-02");
    expect(res.skipped).toBe(false); // a real completed run (lock held only short-circuits)
    const dayKeysWritten = createMany.mock.calls.flatMap((c) => c[0].data.map((row: any) => row.dayKey));
    expect(dayKeysWritten.length).toBeGreaterThan(0);
    // Every emitted day is >= the cutoff; the pre-cutoff legacy era is excluded.
    expect(dayKeysWritten.every((k: string) => k >= "2025-05-02")).toBe(true);
    expect(dayKeysWritten.some((k: string) => k < "2025-05-02")).toBe(false);
    expect(dayKeysWritten).not.toContain("2025-04-15"); // a concrete pre-cutoff day, excluded
    expect(dayKeysWritten).toContain("2025-05-02"); // first post-cutoff day, emitted
    // Delete-scope == recompute-scope: the window floor is the applied cutoff.
    expect(deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ dayKey: expect.objectContaining({ gte: "2025-05-02" }) }),
      }),
    );
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
  test("negative reconstruction flags the pair, never deletes or creates, and finalizes (fenced release)", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 1 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }]);
    const res = await rebuildStockSnapshots({ from: "2026-06-03", to: "2026-06-04" });
    expect(res).toEqual({ rowsInserted: 0, flaggedPairs: 1, nullLocationCutoff: null, skipped: false });
    // The negative-guard `continue` must NEVER delete a flagged pair's existing window.
    expect((prisma as any).productStockSnapshot.deleteMany).not.toHaveBeenCalled();
    expect((prisma as any).productStockSnapshot.createMany).not.toHaveBeenCalled();
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
    // A flagged pair is still a completed run: SUCCEEDED with flaggedPairs counted.
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledWith(1, TOKEN, expect.objectContaining({ status: "SUCCEEDED", flaggedPairs: 1 }));
    expect(finalizeRebuildRun as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test("happy path writes one snapshot row via createMany inside a $transaction and records a clean run", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (prisma as any).product_locations.findMany.mockResolvedValueOnce([{ productId: 1, locationId: 1, quantity: 10 }]);
    (prisma as any).inventory_logs.findMany.mockResolvedValueOnce([{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 }]);
    const res = await rebuildStockSnapshots({ from: "2026-06-04", to: "2026-06-04" });
    expect(res).toEqual({ rowsInserted: 1, flaggedPairs: 0, nullLocationCutoff: null, skipped: false });
    // Per-pair: deleteMany the window then createMany the reconstructed rows, in ONE $transaction.
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
    expect((prisma as any).productStockSnapshot.deleteMany).toHaveBeenCalledWith({
      where: { productId: 1, locationId: 1, dayKey: { gte: "2026-06-04", lte: "2026-06-04" } },
    });
    expect((prisma as any).productStockSnapshot.createMany).toHaveBeenCalledTimes(1);
    expect((prisma as any).productStockSnapshot.createMany).toHaveBeenCalledWith({
      data: [{ productId: 1, locationId: 1, dayKey: "2026-06-04", quantity: 10 }],
    });
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
    const createMany = (prisma as any).productStockSnapshot.createMany as jest.Mock;
    await rebuildStockSnapshots();
    const dayKeysWritten = createMany.mock.calls.flatMap((c) => c[0].data.map((row: any) => row.dayKey));
    expect(dayKeysWritten).not.toContain("2026-06-05"); // never writes today's partial
    expect(dayKeysWritten[dayKeysWritten.length - 1]).toBe("2026-06-04"); // last completed day is the latest row
    jest.useRealTimers();
  });

  // P3 golden equivalence (codex #19): the batched delete+createMany path must write
  // exactly the rows the old per-day upsert path wrote, keyed by
  // (productId, locationId, dayKey, quantity). The oracle is reconstructLevels —
  // the same pure function the old path fed into upsert — so this pins the plumbing
  // between reconstruction and persistence, not the arithmetic (covered above).
  test("golden: batched createMany rows equal the reconstructed levels for every pair", async () => {
    (beginRebuildRun as jest.Mock).mockResolvedValue(acquired);
    (heartbeatRebuildLock as jest.Mock).mockResolvedValue(true);
    const pairA = { productId: 1, locationId: 1, quantity: 10 };
    const pairB = { productId: 2, locationId: 1, quantity: 3 };
    const logsA = [
      { changeTime: new Date("2026-06-04T10:00:00Z"), delta: 5 },
      { changeTime: new Date("2026-06-03T10:00:00Z"), delta: -2 },
    ];
    const logsB = [{ changeTime: new Date("2026-06-04T10:00:00Z"), delta: 1 }];
    (prisma as any).product_locations.findMany.mockResolvedValue([pairA, pairB]);
    (prisma as any).inventory_logs.findMany
      .mockResolvedValueOnce(logsA)
      .mockResolvedValueOnce(logsB);

    const from = "2026-06-02";
    const to = "2026-06-04";
    await rebuildStockSnapshots({ from, to });

    // Independently reconstruct what the OLD path would have written for each pair.
    const expected = [
      ...reconstructLevels({ current: pairA.quantity, deltas: logsA, fromDayKey: from, toDayKey: to }).levels.map(
        (lvl) => ({ productId: pairA.productId, locationId: pairA.locationId, dayKey: lvl.dayKey, quantity: lvl.quantity }),
      ),
      ...reconstructLevels({ current: pairB.quantity, deltas: logsB, fromDayKey: from, toDayKey: to }).levels.map(
        (lvl) => ({ productId: pairB.productId, locationId: pairB.locationId, dayKey: lvl.dayKey, quantity: lvl.quantity }),
      ),
    ];

    const createMany = (prisma as any).productStockSnapshot.createMany as jest.Mock;
    const actual = createMany.mock.calls.flatMap((c) =>
      c[0].data.map((row: any) => ({
        productId: row.productId,
        locationId: row.locationId,
        dayKey: row.dayKey,
        quantity: row.quantity,
      })),
    );

    const sortKey = (r: { productId: number; locationId: number; dayKey: string }) =>
      `${r.productId}:${r.locationId}:${r.dayKey}`;
    const bySort = (a: any, b: any) => sortKey(a).localeCompare(sortKey(b));
    expect(actual.slice().sort(bySort)).toEqual(expected.slice().sort(bySort));
    // Sanity: the fixture actually produced rows for both pairs (3 days each over [06-02..06-04]).
    expect(expected.length).toBe(6);
    expect(actual.length).toBe(expected.length);
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
