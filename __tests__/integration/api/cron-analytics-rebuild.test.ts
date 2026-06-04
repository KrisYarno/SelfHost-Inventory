// @jest-environment node
//
// Thin CRON_SECRET-gated route that triggers NIGHTLY-SIZE analytics rebuilds.
// Auth mirrors app/api/cron/weekly-report/route.ts EXACTLY: a Bearer CRON_SECRET
// header check, no session / CSRF. Flag-gated via SystemSetting
// `analyticsRebuildEnabled`. The weekly TRUE-FULL rebuild is the standalone
// script (scripts/analytics-rebuild.ts), NOT this route — avoids HTTP timeouts.
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

test("valid Bearer + enabled + job=snapshots&mode=nightly => calls rebuildStockSnapshots, returns its result", async () => {
  m.systemSetting.findUnique.mockResolvedValue({ value: "true" });
  snapshotsMock.mockResolvedValue({ rowsInserted: 12, flaggedPairs: 1 });

  const res = await GET(
    req("?job=snapshots&mode=nightly", `Bearer ${SECRET}`)
  );

  expect(res.status).toBe(200);
  expect(snapshotsMock).toHaveBeenCalledTimes(1);
  // nightly-size: default window (today + per-pair backfill), no full reconcile here
  expect(snapshotsMock).toHaveBeenCalledWith({});
  expect(salesMock).not.toHaveBeenCalled();
  const body = await res.json();
  expect(body.job).toBe("snapshots");
  expect(body.result).toEqual({ rowsInserted: 12, flaggedPairs: 1 });
});

test("valid Bearer + enabled + job=sales&mode=nightly => calls rebuildSalesFacts (nightly window), returns its result", async () => {
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
  expect(body.result).toEqual({
    rowsDeleted: 4,
    rowsInserted: 9,
    unattributed: 0,
  });
});
