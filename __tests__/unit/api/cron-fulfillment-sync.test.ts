/**
 * @jest-environment node
 */

/**
 * Lane 6 (L-WOO) — the fulfillment poll cron route. Thin plumbing: CRON_SECRET
 * gate + Woo-only fan-out to the observation module (mocked here — its behavior
 * is covered by fulfillment-observations.test.ts).
 */

jest.mock("@/lib/api-utils", () => ({ apiHandler: (fn: unknown) => fn }));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { integration: { findMany: jest.fn() } },
}));

const mockRun = jest.fn();
const mockBackfill = jest.fn();
const mockReconcile = jest.fn();
jest.mock("@/lib/external-orders/fulfillment-observations", () => ({
  __esModule: true,
  runFulfillmentSync: (...a: unknown[]) => mockRun(...a),
  backfillFulfillmentObservations: (...a: unknown[]) => mockBackfill(...a),
  reconcileFulfillmentTombstones: (...a: unknown[]) => mockReconcile(...a),
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { GET } from "@/app/api/cron/fulfillment-sync/route";

const db = prisma as unknown as { integration: { findMany: jest.Mock } };

function req(auth?: string, url = "http://x/api/cron/fulfillment-sync") {
  return new NextRequest(url, {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  db.integration.findMany.mockResolvedValue([
    { id: "int-1", name: "Store", platform: "WOOCOMMERCE" },
  ]);
  mockRun.mockResolvedValue({ integrationId: "int-1", hints: {}, incremental: {} });
  mockBackfill.mockResolvedValue({ integrationId: "int-1", done: true });
  mockReconcile.mockResolvedValue({ integrationId: "int-1", tombstoned: 0 });
});

it("401s without a valid CRON_SECRET bearer", async () => {
  const res = await GET(req(), {} as never);
  expect(res.status).toBe(401);
  expect(mockRun).not.toHaveBeenCalled();
});

it("only queries active WooCommerce integrations", async () => {
  await GET(req("Bearer s3cret"), {} as never);
  expect(db.integration.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { isActive: true, platform: "WOOCOMMERCE" } })
  );
});

it("default mode runs the incremental sync (hints + poll)", async () => {
  const res = await GET(req("Bearer s3cret"), {} as never);
  const body = await res.json();
  expect(mockRun).toHaveBeenCalledWith("int-1");
  expect(body.mode).toBe("incremental");
  expect(body.integrations).toBe(1);
});

it("mode=backfill runs a bounded backfill step", async () => {
  await GET(req("Bearer s3cret", "http://x/api/cron/fulfillment-sync?mode=backfill&maxPages=5"), {} as never);
  expect(mockBackfill).toHaveBeenCalledWith("int-1", { maxPages: 5 });
  expect(mockRun).not.toHaveBeenCalled();
});

it("mode=reconcile runs tombstone reconciliation", async () => {
  await GET(req("Bearer s3cret", "http://x/api/cron/fulfillment-sync?mode=reconcile"), {} as never);
  expect(mockReconcile).toHaveBeenCalledWith("int-1");
  expect(mockRun).not.toHaveBeenCalled();
});

it("a per-integration failure is captured, not thrown", async () => {
  mockRun.mockRejectedValueOnce(new Error("woo down"));
  const res = await GET(req("Bearer s3cret"), {} as never);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.results[0].error).toBe("woo down");
});
