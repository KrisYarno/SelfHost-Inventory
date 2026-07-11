// @jest-environment node
//
// Lane 3 (Task 6, R-L14/R-L15): the analytics-rebuild RUN LIFECYCLE that owns the
// cross-process lock — beginRebuildRun (acquire + RUNNING row) and
// finalizeRebuildRun (terminal run row + state mirror + keep-100 retention +
// fenced release, in ONE transaction). House prisma-mock conventions: the module
// under test is real; only @/lib/prisma is mocked.
jest.mock("@/lib/prisma", () => {
  const db: any = {
    analyticsRebuildState: { updateMany: jest.fn(), update: jest.fn() },
    analyticsRebuildRun: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  db.$transaction = jest.fn(async (cb: (t: typeof db) => unknown) => cb(db));
  return { __esModule: true, default: db };
});

import prisma from "@/lib/prisma";
import { beginRebuildRun, finalizeRebuildRun, REBUILD_RUN_RETENTION } from "@/lib/analytics/rebuild-lock";

const m = prisma as unknown as {
  analyticsRebuildState: { updateMany: jest.Mock; update: jest.Mock };
  analyticsRebuildRun: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  m.$transaction.mockImplementation(async (cb: any) => cb(m));
  m.analyticsRebuildRun.findMany.mockResolvedValue([]); // no retention prune unless a test overrides
});

// ---------------------------------------------------------------------------
// beginRebuildRun
// ---------------------------------------------------------------------------

describe("beginRebuildRun", () => {
  test("lock free (acquire count===1) => opens a RUNNING row and returns the token", async () => {
    m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 1 }); // acquire succeeds
    m.analyticsRebuildRun.create.mockResolvedValue({ id: 42 });

    const res = await beginRebuildRun("sales", { mode: "nightly", source: "manual", requestedByUserId: 7 });

    expect(res).toEqual({ acquired: true, runId: 42, token: expect.any(Date) });
    const data = m.analyticsRebuildRun.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      job: "sales",
      mode: "nightly",
      source: "manual",
      requestedByUserId: 7,
      status: "RUNNING",
    });
    expect(data.startedAt).toBeInstanceOf(Date);
    // A RUNNING row has no terminal fields yet.
    expect(data.finishedAt).toBeUndefined();
    expect(data.skippedReason).toBeUndefined();
  });

  test("lock held (acquire count===0) => a self-finalized ABORTED/'lock-held' row, acquired:false", async () => {
    m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 0 }); // contended
    m.analyticsRebuildRun.create.mockResolvedValue({ id: 9 });

    const res = await beginRebuildRun("snapshots", { mode: "full", source: "cron" });

    expect(res).toEqual({ acquired: false, runId: 9 });
    const data = m.analyticsRebuildRun.create.mock.calls[0][0].data;
    expect(data.status).toBe("ABORTED");
    expect(data.skippedReason).toBe("lock-held");
    expect(data.durationMs).toBe(0);
    expect(data.finishedAt).toBeInstanceOf(Date);
    expect(data.requestedByUserId).toBeNull(); // no user for a cron trigger
  });
});

// ---------------------------------------------------------------------------
// finalizeRebuildRun
// ---------------------------------------------------------------------------

describe("finalizeRebuildRun", () => {
  const TOKEN = new Date("2026-06-04T00:00:00.000Z");

  test("FAILED preserves partial counters, writes the state mirror, computes durationMs, and releases via the token", async () => {
    m.analyticsRebuildRun.findUnique.mockResolvedValue({ job: "sales", startedAt: new Date(Date.now() - 5000) });

    await finalizeRebuildRun(1, TOKEN, { status: "FAILED", rowsInserted: 5, flaggedPairs: 1, lastError: "boom" });

    // Run row: terminal status + partial counters + error column (NOT lastError) + duration.
    const runData = m.analyticsRebuildRun.update.mock.calls[0][0];
    expect(runData.where).toEqual({ id: 1 });
    expect(runData.data).toMatchObject({ status: "FAILED", rowsInserted: 5, flaggedPairs: 1, error: "boom", skippedReason: null });
    expect(runData.data.finishedAt).toBeInstanceOf(Date);
    expect(runData.data.durationMs).toBeGreaterThanOrEqual(0);

    // State mirror: RebuildRunFields keys 1:1 + lastRunAt.
    const stateData = m.analyticsRebuildState.update.mock.calls[0][0];
    expect(stateData.where).toEqual({ job: "sales" });
    expect(stateData.data).toMatchObject({ rowsInserted: 5, flaggedPairs: 1, lastError: "boom" });
    expect(stateData.data.lastRunAt).toBeInstanceOf(Date);

    // Fenced lock release with the token (outside the tx).
    expect(m.analyticsRebuildState.updateMany).toHaveBeenCalledWith({
      where: { job: "sales", lockedAt: TOKEN },
      data: { lockedAt: null, heartbeatAt: null },
    });
  });

  test("SUCCEEDED maps window fields onto both the run row (windowFrom/To) and the state mirror (lastWindowFrom/To)", async () => {
    m.analyticsRebuildRun.findUnique.mockResolvedValue({ job: "snapshots", startedAt: new Date("2026-06-05T02:00:00Z") });

    await finalizeRebuildRun(2, TOKEN, {
      status: "SUCCEEDED",
      lastWindowFrom: "2026-06-01",
      lastWindowTo: "2026-06-05",
      rowsInserted: 9,
      lastError: null,
    });

    const runData = m.analyticsRebuildRun.update.mock.calls[0][0].data;
    expect(runData).toMatchObject({ status: "SUCCEEDED", windowFrom: "2026-06-01", windowTo: "2026-06-05", rowsInserted: 9, error: null });

    const stateData = m.analyticsRebuildState.update.mock.calls[0][0].data;
    expect(stateData).toMatchObject({ lastWindowFrom: "2026-06-01", lastWindowTo: "2026-06-05", rowsInserted: 9, lastError: null });
  });

  test("retention prunes everything past the newest 100 rows per job (skip:100 -> deleteMany)", async () => {
    m.analyticsRebuildRun.findUnique.mockResolvedValue({ job: "sales", startedAt: new Date() });
    m.analyticsRebuildRun.findMany.mockResolvedValue([{ id: 200 }, { id: 201 }]);

    await finalizeRebuildRun(3, TOKEN, { status: "SUCCEEDED" });

    expect(m.analyticsRebuildRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { job: "sales" }, orderBy: { startedAt: "desc" }, skip: REBUILD_RUN_RETENTION }),
    );
    expect(REBUILD_RUN_RETENTION).toBe(100);
    expect(m.analyticsRebuildRun.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [200, 201] } } });
  });

  test("nothing to prune (findMany empty) => deleteMany not called", async () => {
    m.analyticsRebuildRun.findUnique.mockResolvedValue({ job: "sales", startedAt: new Date() });
    await finalizeRebuildRun(4, TOKEN, { status: "SUCCEEDED" });
    expect(m.analyticsRebuildRun.deleteMany).not.toHaveBeenCalled();
  });

  test("null token (never acquired) => no fenced lock release", async () => {
    m.analyticsRebuildRun.findUnique.mockResolvedValue({ job: "sales", startedAt: new Date() });
    await finalizeRebuildRun(5, null, { status: "ABORTED", skippedReason: "lock-held" });
    // The state mirror still updates inside the tx, but the release updateMany never runs.
    expect(m.analyticsRebuildState.updateMany).not.toHaveBeenCalled();
  });
});
