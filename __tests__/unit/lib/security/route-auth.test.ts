// @jest-environment node
/**
 * Lane 5 S1 route-adoption behavior (spec §3 S1; plan Task 3 Step 5).
 *
 * Proves that a representative cron route (Bearer CRON_SECRET) and external-sync
 * (raw x-internal-sync-token) actually reject wrong secrets with 401 and accept
 * the right secret with 200 AFTER adopting lib/security/secret-compare.ts.
 * Handler internals are mocked so only the auth boundary is exercised.
 */

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
}));
jest.mock("@/lib/stock-checker", () => ({
  __esModule: true,
  stockChecker: {
    runDailyCheck: jest.fn(async () => ({ lowStock: 0 })),
    runMinimumsCheck: jest.fn(async () => ({ minimums: 0 })),
  },
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { integration: { findMany: jest.fn(async () => []) } },
}));
jest.mock("@/lib/external-orders/sync", () => ({
  __esModule: true,
  syncIntegrationOrders: jest.fn(),
}));

import { NextRequest } from "next/server";
import { GET as stockCheckGET } from "@/app/api/cron/stock-check/route";
import { POST as externalSyncPOST } from "@/app/api/cron/external-sync/route";
import { stockChecker } from "@/lib/stock-checker";
import prisma from "@/lib/prisma";

const CRON_SECRET = "cron-secret-value";
const SYNC_TOKEN = "internal-sync-token-value";

function cronReq(auth?: string): NextRequest {
  return new NextRequest("http://x/api/cron/stock-check", {
    headers: auth ? { authorization: auth } : {},
  });
}

function syncReq(token?: string): NextRequest {
  return new NextRequest("http://x/api/cron/external-sync", {
    method: "POST",
    headers: token ? { "x-internal-sync-token": token } : {},
    body: JSON.stringify({}),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.INTERNAL_SYNC_TOKEN = SYNC_TOKEN;
});

describe("cron/stock-check Bearer auth (bearerAuthorized adoption)", () => {
  const daily = stockChecker.runDailyCheck as jest.Mock;

  test("no header => 401, checker not run", async () => {
    const res = await stockCheckGET(cronReq());
    expect(res.status).toBe(401);
    expect(daily).not.toHaveBeenCalled();
  });

  test("wrong secret => 401", async () => {
    const res = await stockCheckGET(cronReq("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(daily).not.toHaveBeenCalled();
  });

  test("secret without the Bearer prefix => 401", async () => {
    const res = await stockCheckGET(cronReq(CRON_SECRET));
    expect(res.status).toBe(401);
  });

  test("correct Bearer secret => 200, checker runs", async () => {
    const res = await stockCheckGET(cronReq(`Bearer ${CRON_SECRET}`));
    expect(res.status).toBe(200);
    expect(daily).toHaveBeenCalledTimes(1);
  });
});

describe("cron/external-sync x-internal-sync-token auth (headerTokenAuthorized adoption)", () => {
  const findMany = (prisma as unknown as { integration: { findMany: jest.Mock } })
    .integration.findMany;

  test("no token header => 401, prisma not queried", async () => {
    const res = await externalSyncPOST(syncReq());
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  test("wrong token => 401", async () => {
    const res = await externalSyncPOST(syncReq("wrong-token"));
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  test("correct token => 200", async () => {
    const res = await externalSyncPOST(syncReq(SYNC_TOKEN));
    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
