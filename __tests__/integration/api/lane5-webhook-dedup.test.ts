/**
 * @jest-environment node
 *
 * Lane 5 S2 — webhook replay-dedup claim lifecycle (codex #7/#8/#9).
 * Dedup key = (integrationId, sha256(rawBody)); the eventId header is NEVER the
 * key. Full matrix: first-delivery PROCESSED, duplicate no-op, missing-eventId
 * dedup, processing-throw FAILED + retry reprocess, stale-lease reprocess, the
 * retake race, the late-loser claimedAt fence, fail-open, ignored-topic (no
 * claim), and the bounded prune boundary.
 *
 * upsertOrderWithItems and recordIngestion are mocked — this suite exercises the
 * dedup fence, not the order upsert (covered in external-orders-recording.test.ts).
 */

jest.mock("@/lib/api-utils", () => ({ apiHandler: (fn: any) => fn }));
jest.mock("@/lib/encryption", () => ({
  decryptValue: (v: string) => v,
  isEncrypted: () => false,
}));
jest.mock("@/lib/platforms/core/registry", () => ({ getPlatformAdapter: jest.fn() }));
jest.mock("@/lib/external-orders/shared", () => ({ upsertOrderWithItems: jest.fn() }));
jest.mock("@/lib/change-tracking", () => ({ recordIngestion: jest.fn(async () => true) }));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    integration: { findUnique: jest.fn(), update: jest.fn() },
    externalOrder: { findUnique: jest.fn(), delete: jest.fn() },
    externalOrderItem: { deleteMany: jest.fn() },
    webhookDelivery: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getPlatformAdapter } from "@/lib/platforms/core/registry";
import { upsertOrderWithItems } from "@/lib/external-orders/shared";
import { POST } from "@/app/api/webhooks/[integrationId]/route";

const db = prisma as unknown as {
  integration: { findUnique: jest.Mock; update: jest.Mock };
  webhookDelivery: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    findMany: jest.Mock;
    deleteMany: jest.Mock;
  };
};

const CLAIMED_AT = new Date("2026-07-13T12:00:00.000Z");

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    companyId: "c1",
    isActive: true,
    platform: "WOOCOMMERCE",
    storeUrl: "https://store.test",
    webhookSecret: "shh",
    encryptedApiSecret: null,
    company: { id: "c1" },
    ...overrides,
  };
}

let fakeAdapter: any;

function req(body: unknown = { id: "ext-1" }) {
  return new NextRequest("http://x/api/webhooks/int-1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = { params: { integrationId: "int-1" } } as any;

const P2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });

/** The PROCESSED/FAILED finalize updateMany calls, split by status. */
function updateCallsByStatus(status: string) {
  return db.webhookDelivery.updateMany.mock.calls.filter(
    (c) => c[0]?.data?.status === status
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  fakeAdapter = {
    platform: "WOOCOMMERCE",
    extractWebhookHeaders: jest.fn(() => ({
      topic: "order.updated",
      signature: "sig",
      source: undefined,
      eventId: "evt-1",
    })),
    verifyWebhook: jest.fn(() => ({ isValid: true })),
    parseOrderWebhook: jest.fn(() => ({ externalId: "ext-1", externalOrderNumber: "#1" })),
  };
  (getPlatformAdapter as jest.Mock).mockReturnValue(fakeAdapter);
  db.integration.findUnique.mockResolvedValue(integration());
  db.integration.update.mockResolvedValue({});
  (upsertOrderWithItems as jest.Mock).mockResolvedValue({
    orderId: "order-1",
    orderNumber: "#1",
    changed: true,
    created: true,
    changes: {},
    prunedItems: [],
    itemsProcessed: 1,
    itemsMapped: 0,
  });
  db.webhookDelivery.create.mockResolvedValue({ id: 5, claimedAt: CLAIMED_AT });
  db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
  db.webhookDelivery.findMany.mockResolvedValue([]);
  db.webhookDelivery.deleteMany.mockResolvedValue({ count: 0 });
});

describe("S2 first delivery", () => {
  it("claims, processes, and finalizes PROCESSED (fenced by claimedAt)", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(upsertOrderWithItems).toHaveBeenCalledTimes(1);

    // dedup key is the body digest (a 64-char hex), eventId is informational only.
    const created = db.webhookDelivery.create.mock.calls[0][0].data;
    expect(created.integrationId).toBe("int-1");
    expect(created.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.eventId).toBe("evt-1");

    const processed = updateCallsByStatus("PROCESSED");
    expect(processed).toHaveLength(1);
    expect(processed[0][0].where).toEqual({ id: 5, claimedAt: CLAIMED_AT });
  });
});

describe("S2 duplicate delivery", () => {
  it("identical rawBody again (already PROCESSED) → 200 duplicate no-op, NO upsert", async () => {
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockResolvedValue({
      id: 5,
      status: "PROCESSED",
      claimedAt: CLAIMED_AT,
    });

    const res = await POST(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(upsertOrderWithItems).not.toHaveBeenCalled();
  });

  it("a live PROCESSING lease (within window) → 200 duplicate, NO upsert", async () => {
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockResolvedValue({
      id: 5,
      status: "PROCESSING",
      claimedAt: new Date(Date.now() - 1000), // 1s ago — still leased
    });

    const res = await POST(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(upsertOrderWithItems).not.toHaveBeenCalled();
  });
});

describe("S2 missing eventId", () => {
  it("still dedups on the body digest when no eventId header is present", async () => {
    fakeAdapter.extractWebhookHeaders.mockReturnValue({
      topic: "order.updated",
      signature: "sig",
      source: undefined,
      // no eventId
    });

    // first delivery: claim stores eventId null, processes.
    const first = await POST(req(), ctx);
    expect(first.status).toBe(200);
    expect(db.webhookDelivery.create.mock.calls[0][0].data.eventId).toBeNull();

    // second identical delivery: P2002 on the digest → duplicate, despite no eventId.
    (upsertOrderWithItems as jest.Mock).mockClear();
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockResolvedValue({
      id: 5,
      status: "PROCESSED",
      claimedAt: CLAIMED_AT,
    });
    const second = await POST(req(), ctx);
    expect((await second.json()).duplicate).toBe(true);
    expect(upsertOrderWithItems).not.toHaveBeenCalled();
  });
});

describe("S2 processing failure", () => {
  it("upsert throw → claim FAILED (fenced) + rethrow", async () => {
    db.webhookDelivery.create.mockResolvedValue({ id: 7, claimedAt: CLAIMED_AT });
    (upsertOrderWithItems as jest.Mock).mockRejectedValue(new Error("boom"));

    await expect(POST(req(), ctx)).rejects.toThrow(/boom/);

    const failed = updateCallsByStatus("FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0][0].where).toEqual({ id: 7, claimedAt: CLAIMED_AT });
    expect(updateCallsByStatus("PROCESSED")).toHaveLength(0);
  });

  it("a retry after FAILED retakes the claim and reprocesses", async () => {
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockResolvedValue({
      id: 7,
      status: "FAILED",
      claimedAt: CLAIMED_AT,
    });
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 }); // retake wins

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(upsertOrderWithItems).toHaveBeenCalledTimes(1);

    // The retake targeted the FAILED row's exact status+claimedAt.
    const retake = db.webhookDelivery.updateMany.mock.calls.find(
      (c) => c[0]?.data?.status === "PROCESSING"
    );
    expect(retake[0].where).toMatchObject({
      id: 7,
      status: "FAILED",
      claimedAt: CLAIMED_AT,
    });
  });
});

describe("S2 stale lease", () => {
  it("a stale PROCESSING lease (past the window) is retaken and reprocessed", async () => {
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockResolvedValue({
      id: 8,
      status: "PROCESSING",
      claimedAt: new Date(Date.now() - 6 * 60_000), // 6 min ago — lease expired
    });
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(upsertOrderWithItems).toHaveBeenCalledTimes(1);
  });
});

describe("S2 concurrency fences", () => {
  it("RETAKE RACE: the retake updateMany returns count 0 → duplicate, NO upsert", async () => {
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockResolvedValue({
      id: 9,
      status: "FAILED",
      claimedAt: CLAIMED_AT,
    });
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 0 }); // lost the retake race

    const res = await POST(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(upsertOrderWithItems).not.toHaveBeenCalled();
  });

  it("LATE LOSER: the PROCESSED finalize is claimedAt-fenced, so a stale flip is a harmless no-op", async () => {
    db.webhookDelivery.create.mockResolvedValue({ id: 10, claimedAt: CLAIMED_AT });
    // Simulate the row having been retaken by another worker: our fenced update
    // matches 0 rows. The route must still answer 200 (never crash on count 0).
    db.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);

    const processed = updateCallsByStatus("PROCESSED");
    expect(processed).toHaveLength(1);
    // The flip targeted OUR claim (id + claimedAt) — it cannot touch a retaker's row.
    expect(processed[0][0].where).toEqual({ id: 10, claimedAt: CLAIMED_AT });
  });
});

describe("S2 fail-open", () => {
  it("a non-P2002 claim-write failure → process anyway (no claim, no finalize)", async () => {
    db.webhookDelivery.create.mockRejectedValue(new Error("db down"));

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(upsertOrderWithItems).toHaveBeenCalledTimes(1);
    // No claim was taken, so nothing is finalized.
    expect(db.webhookDelivery.updateMany).not.toHaveBeenCalled();
  });

  it("a P2002 whose lookup then throws → fail-open (process anyway)", async () => {
    db.webhookDelivery.create.mockRejectedValue(P2002);
    db.webhookDelivery.findUnique.mockRejectedValue(new Error("lookup down"));

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(upsertOrderWithItems).toHaveBeenCalledTimes(1);
    expect(db.webhookDelivery.updateMany).not.toHaveBeenCalled();
  });
});

describe("S2 ignored topic", () => {
  it("an unsupported topic returns before the claim — NO webhook_deliveries row", async () => {
    fakeAdapter.extractWebhookHeaders.mockReturnValue({
      topic: "product.updated",
      signature: "sig",
      source: undefined,
      eventId: "evt-x",
    });

    const res = await POST(req(), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
    expect(db.webhookDelivery.create).not.toHaveBeenCalled();
  });
});

describe("S2 bounded prune", () => {
  it("prunes on a claim id divisible by 100 with a 30-day cutoff (31d deleted, 29d kept)", async () => {
    db.webhookDelivery.create.mockResolvedValue({ id: 100, claimedAt: CLAIMED_AT });
    db.webhookDelivery.findMany.mockResolvedValue([{ id: 200 }]); // a >30d-old row

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);

    expect(db.webhookDelivery.findMany).toHaveBeenCalledTimes(1);
    const findArgs = db.webhookDelivery.findMany.mock.calls[0][0];
    expect(findArgs.take).toBe(500);
    const cutoff: Date = findArgs.where.receivedAt.lt;
    const ageDays = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
    // ~30-day boundary: a 31-day row is < cutoff (deleted), a 29-day row is not (kept).
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);

    expect(db.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [200] } },
    });
  });

  it("does NOT prune when the claim id is not divisible by 100", async () => {
    db.webhookDelivery.create.mockResolvedValue({ id: 101, claimedAt: CLAIMED_AT });

    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(db.webhookDelivery.findMany).not.toHaveBeenCalled();
    expect(db.webhookDelivery.deleteMany).not.toHaveBeenCalled();
  });
});
