jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { analyticsRebuildState: { updateMany: jest.fn(), update: jest.fn() } },
}));
import prisma from "@/lib/prisma";
import { acquireRebuildLock, heartbeatRebuildLock, releaseRebuildLock, recordRebuildRun } from "@/lib/analytics/rebuild-lock";
const m = prisma as unknown as { analyticsRebuildState: { updateMany: jest.Mock; update: jest.Mock } };

beforeEach(() => jest.clearAllMocks());

test("acquire returns a token when the row is free (count===1)", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 1 });
  const token = await acquireRebuildLock("sales");
  expect(token).toBeInstanceOf(Date);
  const where = m.analyticsRebuildState.updateMany.mock.calls[0][0].where;
  expect(where.job).toBe("sales");
  expect(where.OR).toEqual(expect.arrayContaining([{ lockedAt: null }]));
});

test("acquire returns null when another run holds a live lease (count===0)", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 0 });
  expect(await acquireRebuildLock("sales")).toBeNull();
});

test("release only clears the lock when the token still matches (fencing)", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 1 });
  const token = new Date("2026-06-04T00:00:00Z");
  await releaseRebuildLock("sales", token);
  const call = m.analyticsRebuildState.updateMany.mock.calls[0][0];
  expect(call.where).toEqual({ job: "sales", lockedAt: token });
  expect(call.data).toEqual({ lockedAt: null, heartbeatAt: null });
});

test("heartbeat refreshes heartbeatAt for the current token holder", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 1 });
  const token = new Date("2026-06-04T00:00:00Z");
  await heartbeatRebuildLock("sales", token);
  const call = m.analyticsRebuildState.updateMany.mock.calls[0][0];
  expect(call.where).toEqual({ job: "sales", lockedAt: token });
  expect(call.data.heartbeatAt).toBeInstanceOf(Date);
});

test("recordRebuildRun writes run fields + stamps lastRunAt", async () => {
  m.analyticsRebuildState.update.mockResolvedValue({});
  await recordRebuildRun("snapshots", { rowsInserted: 5, flaggedPairs: 1, lastError: null });
  const call = m.analyticsRebuildState.update.mock.calls[0][0];
  expect(call.where).toEqual({ job: "snapshots" });
  expect(call.data.rowsInserted).toBe(5);
  expect(call.data.flaggedPairs).toBe(1);
  expect(call.data.lastRunAt).toBeInstanceOf(Date);
});
