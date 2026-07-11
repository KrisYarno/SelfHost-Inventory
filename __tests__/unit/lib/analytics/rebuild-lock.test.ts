jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { analyticsRebuildState: { updateMany: jest.fn(), update: jest.fn() } },
}));
import prisma from "@/lib/prisma";
import { acquireRebuildLock, heartbeatRebuildLock, releaseRebuildLock } from "@/lib/analytics/rebuild-lock";
const m = prisma as unknown as { analyticsRebuildState: { updateMany: jest.Mock; update: jest.Mock } };

beforeEach(() => jest.clearAllMocks());

test("acquire returns a token when the row is free (count===1)", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 1 });
  const token = await acquireRebuildLock("sales");
  expect(token).toBeInstanceOf(Date);
  const where = m.analyticsRebuildState.updateMany.mock.calls[0][0].where;
  expect(where.job).toBe("sales");
  expect(where.OR).toEqual([
    { lockedAt: null },
    { heartbeatAt: { lt: expect.any(Date) } },
    { heartbeatAt: null, lockedAt: { lt: expect.any(Date) } },
  ]);
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

test("heartbeat refreshes heartbeatAt and returns true for the current token holder (count===1)", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 1 });
  const token = new Date("2026-06-04T00:00:00Z");
  expect(await heartbeatRebuildLock("sales", token)).toBe(true);
  const call = m.analyticsRebuildState.updateMany.mock.calls[0][0];
  expect(call.where).toEqual({ job: "sales", lockedAt: token });
  expect(call.data.heartbeatAt).toBeInstanceOf(Date);
});

test("heartbeat returns false when the lease was lost / superseded (count===0)", async () => {
  m.analyticsRebuildState.updateMany.mockResolvedValue({ count: 0 });
  expect(await heartbeatRebuildLock("sales", new Date("2026-06-04T00:00:00Z"))).toBe(false);
});

// beginRebuildRun / finalizeRebuildRun (the run lifecycle that replaced
// recordRebuildRun) are covered in __tests__/unit/lib/lane3-rebuild-lifecycle.test.ts.
