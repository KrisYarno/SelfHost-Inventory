// @jest-environment node
//
// CRON_SECRET-gated route that triggers analytics rebuilds (nightly AND full).
// Auth mirrors app/api/cron/weekly-report/route.ts EXACTLY: a Bearer CRON_SECRET
// header check, no session / CSRF. Flag-gated via SystemSetting
// `analyticsRebuildEnabled`. mode=full is safe over this route because the
// scheduled caller is a Docker sidecar curling the INTERNAL app URL (no proxy =>
// no HTTP timeout). Covers all 4 job/mode combos below.
jest.mock("@/lib/api-utils", () => ({
  apiHandler: (fn: any) => fn,
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { systemSetting: { findUnique: jest.fn() } },
}));
jest.mock("@/lib/analytics/rebuild-snapshots", () => ({
  rebuildStockSnapshots: jest.fn(),
}));
jest.mock("@/lib/analytics/rebuild-sales", () => ({
  rebuildSalesFacts: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/analytics-rebuild/route";
import prisma from "@/lib/prisma";
import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";

const m = prisma as unknown as {
  systemSetting: { findUnique: jest.Mock };
};
const snapshotsMock = rebuildStockSnapshots as jest.Mock;
const salesMock = rebuildSalesFacts as jest.Mock;

const SECRET = "test-secret";

function req(query = "", auth?: string): NextRequest {
  return new NextRequest(`http://x/api/cron/analytics-rebuild${query}`, {
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = SECRET;
});

test("missing / wrong Authorization => 401, neither rebuild fn called", async () => {
  // no header
  let res = await GET(req(""));
  expect(res.status).toBe(401);

  // wrong secret
  res = await GET(req("", "Bearer nope"));
  expect(res.status).toBe(401);

  // not a Bearer token
  res = await GET(req("", SECRET));
  expect(res.status).toBe(401);

  expect(snapshotsMock).not.toHaveBeenCalled();
  expect(salesMock).not.toHaveBeenCalled();
  // gate must never even be consulted on an unauthenticated request
  expect(m.systemSetting.findUnique).not.toHaveBeenCalled();
});

test("valid Bearer but analyticsRebuildEnabled != 'true' => 200 skipped, no rebuild", async () => {
  m.systemSetting.findUnique.mockResolvedValue({ value: "false" });

  const res = await GET(req("?job=sales", `Bearer ${SECRET}`));

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.skipped).toBe(true);
  expect(m.systemSetting.findUnique).toHaveBeenCalledWith({
    where: { key: "analyticsRebuildEnabled" },
  });
  expect(snapshotsMock).not.toHaveBeenCalled();
  expect(salesMock).not.toHaveBeenCalled();
});

test("valid Bearer + enabled + job=snapshots&mode=nightly => snapshots called with a recent-window `from` (NOT a full backfill)", async () => {
  m.systemSetting.findUnique.mockResolvedValue({ value: "true" });
  snapshotsMock.mockResolvedValue({ rowsInserted: 12, flaggedPairs: 1 });

  const res = await GET(
    req("?job=snapshots&mode=nightly", `Bearer ${SECRET}`)
  );

  expect(res.status).toBe(200);
  expect(snapshotsMock).toHaveBeenCalledTimes(1);
  // CHEAP nightly: a recent-window `from` (YYYY-MM-DD), NOT a full {} backfill.
  const arg = snapshotsMock.mock.calls[0][0];
  expect(arg).toHaveProperty("from");
  expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(salesMock).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.job).toBe("snapshots");
  expect(body.mode).toBe("nightly");
  expect(body.result).toEqual({ rowsInserted: 12, flaggedPairs: 1 });
});

test("valid Bearer + enabled + job=snapshots&mode=full => snapshots called with {} (full history backfill)", async () => {
  m.systemSetting.findUnique.mockResolvedValue({ value: "true" });
  snapshotsMock.mockResolvedValue({ rowsInserted: 9000, flaggedPairs: 0 });

  const res = await GET(req("?job=snapshots&mode=full", `Bearer ${SECRET}`));

  expect(res.status).toBe(200);
  expect(snapshotsMock).toHaveBeenCalledTimes(1);
  // full: no `from` => per-pair earliest = FULL history backfill.
  expect(snapshotsMock).toHaveBeenCalledWith({});
  expect(salesMock).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.job).toBe("snapshots");
  expect(body.mode).toBe("full");
});

test("valid Bearer + enabled + job=sales&mode=nightly => rebuildSalesFacts called with {} (nightly ~36h window)", async () => {
  m.systemSetting.findUnique.mockResolvedValue({ value: "true" });
  salesMock.mockResolvedValue({
    rowsDeleted: 4,
    rowsInserted: 9,
    unattributed: 0,
  });

  const res = await GET(req("?job=sales&mode=nightly", `Bearer ${SECRET}`));

  expect(res.status).toBe(200);
  expect(salesMock).toHaveBeenCalledTimes(1);
  // nightly: rebuild-sales defaults to its own 36h updatedAt window when called with {}
  expect(salesMock).toHaveBeenCalledWith({});
  expect(snapshotsMock).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.job).toBe("sales");
  expect(body.mode).toBe("nightly");
  expect(body.result).toEqual({
    rowsDeleted: 4,
    rowsInserted: 9,
    unattributed: 0,
  });
});

test("valid Bearer + enabled + job=sales&mode=full => rebuildSalesFacts called with { full: true }", async () => {
  m.systemSetting.findUnique.mockResolvedValue({ value: "true" });
  salesMock.mockResolvedValue({
    rowsDeleted: 100,
    rowsInserted: 500,
    unattributed: 2,
  });

  const res = await GET(req("?job=sales&mode=full", `Bearer ${SECRET}`));

  expect(res.status).toBe(200);
  expect(salesMock).toHaveBeenCalledTimes(1);
  // full: re-scan every dayKey to reconcile late reversals.
  expect(salesMock).toHaveBeenCalledWith({ full: true });
  expect(snapshotsMock).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.job).toBe("sales");
  expect(body.mode).toBe("full");
});
