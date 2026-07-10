// @jest-environment node
/**
 * Task 6 characterization tests — locations CRUD + D7 (stop destroying history)
 * migration to @/lib/change-tracking (Phase B plan Task 6).
 *
 * Same mock-Prisma pattern as change-tracking-users/companies.test.ts: a single
 * `tx` object is handed to every $transaction closure (exposed as db.__tx), the
 * REAL recordChange runs against it, so every assertion is on the ACTUAL
 * audit_logs create payload. Proves:
 *   - LOCATION_CREATE / LOCATION_DELETE events write on the SAME tx as the
 *     mutation, entityId normalized to a STRING,
 *   - POST wraps dup-check + max-id read + create + record in ONE Serializable tx
 *     (P-B11 — closes the read-max-then-assign id race),
 *   - D7 DELETE: each of the six referencing tables ALONE blocks with a 409 that
 *     names it; multiple blockers list all; zero-quantity product_locations rows
 *     are removable (delete succeeds, deleteMany called, LOCATION_DELETE recorded
 *     with removedZeroQtyRows),
 *   - inventory_logs.deleteMany is NEVER called (the old history-destroyer is gone),
 *   - id=1 main-location guard stays a 400,
 *   - ER-B2 race: a P2003 from location.delete maps to a 409, never a raw 500.
 */
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

// Keep the REAL apiHandler (ZodError/AppError mapping) + requireCSRF; stub only
// the admin guard.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn() };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock("@/lib/rateLimit", () => {
  const actual = jest.requireActual("@/lib/rateLimit");
  return {
    __esModule: true,
    ...actual,
    enforceRateLimit: jest.fn(() => ({})),
    applyRateLimitHeaders: jest.fn((r: unknown) => r),
  };
});

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// REAL change-tracking (recordChange runs for real) with only newBatchId pinned
// for determinism (unused here, harmless).
jest.mock("@/lib/change-tracking", () => {
  const actual = jest.requireActual("@/lib/change-tracking");
  return { __esModule: true, ...actual, newBatchId: jest.fn(() => "test-batch-0001") };
});

// One tx object per run, shared by the mutations and the audit write.
jest.mock("@/lib/prisma", () => {
  const tx = {
    location: {
      findFirst: jest.fn(),
      aggregate: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
    product_locations: { findMany: jest.fn(), deleteMany: jest.fn() },
    inventory_logs: { count: jest.fn(), deleteMany: jest.fn() },
    notificationHistory: { count: jest.fn() },
    productStockSnapshot: { count: jest.fn() },
    stagingItem: { count: jest.fn() },
    user: { count: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    location: { findUnique: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { POST as locationPOST } from "@/app/api/admin/locations/route";
import { DELETE as locationDELETE } from "@/app/api/admin/locations/[id]/route";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const tx = db.__tx;
const ADMIN = { id: 7, isAdmin: true, isApproved: true };

function mkReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

/** All create() payloads written to the shared tx this run. */
function auditRows(): any[] {
  return tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
}

function del(id: string) {
  return locationDELETE(mkReq(`http://t/api/admin/locations/${id}`, "DELETE"), {
    params: { id },
  } as any);
}

/** Reset all six referencing tables to "no history" for a clean delete. */
function seedEmpty() {
  db.location.findUnique.mockResolvedValue({ id: 2, name: "Backroom" });
  tx.product_locations.findMany.mockResolvedValue([]);
  tx.inventory_logs.count.mockResolvedValue(0);
  tx.notificationHistory.count.mockResolvedValue(0);
  tx.productStockSnapshot.count.mockResolvedValue(0);
  tx.stagingItem.count.mockResolvedValue(0);
  tx.user.count.mockResolvedValue(0);
  tx.product_locations.deleteMany.mockResolvedValue({ count: 0 });
  tx.location.delete.mockResolvedValue({});
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
});

// ---------------------------------------------------------------------------
// POST /api/admin/locations — LOCATION_CREATE (P-B11: Serializable tx)
// ---------------------------------------------------------------------------
describe("POST locations — LOCATION_CREATE (Serializable tx, no id race)", () => {
  it("dup-check + max-id + create + record all inside ONE Serializable tx", async () => {
    tx.location.findFirst.mockResolvedValue(null); // name free
    tx.location.aggregate.mockResolvedValue({ _max: { id: 2 } });
    tx.location.create.mockResolvedValue({ id: 3, name: "New Shelf" });

    const resp = await locationPOST(
      mkReq("http://t/api/admin/locations", "POST", { name: "New Shelf" })
    );

    expect(resp.status).toBe(200);
    // Same-tx proof: dup-check, id read, create + audit all in ONE $transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.location.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.location.aggregate).toHaveBeenCalledTimes(1);
    expect(tx.location.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    // P-B11: the tx is Serializable (closes the concurrent-id race).
    expect(db.$transaction.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
    // nextId = max + 1
    expect(tx.location.create.mock.calls[0][0].data.id).toBe(3);

    const [row] = auditRows();
    expect(row.actionType).toBe("LOCATION_CREATE");
    expect(row.entityType).toBe("LOCATION");
    expect(row.entityId).toBe("3"); // normalized number -> string
    expect(typeof row.entityId).toBe("string");
    expect(row.userId).toBe(7);
    expect(row.actorKind).toBe("USER");
    expect(row.details.name).toBe("New Shelf");
  });

  it("duplicate name -> 400, no create, no event", async () => {
    tx.location.findFirst.mockResolvedValue({ id: 5, name: "Backroom" });

    const resp = await locationPOST(
      mkReq("http://t/api/admin/locations", "POST", { name: "Backroom" })
    );

    expect(resp.status).toBe(400);
    expect(tx.location.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/locations/[id] — D7 block matrix
// ---------------------------------------------------------------------------
describe("DELETE locations/[id] — D7 block matrix (each blocker names itself)", () => {
  beforeEach(seedEmpty);

  it("id=1 (main location) -> 400, no tx", async () => {
    const resp = await del("1");
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/main location/i);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("404 on missing location, no tx, no event", async () => {
    db.location.findUnique.mockResolvedValue(null);
    const resp = await del("2");
    expect(resp.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("ledger entries alone block (409 names ledger)", async () => {
    tx.inventory_logs.count.mockResolvedValue(5);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/ledger/i);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.location.delete).not.toHaveBeenCalled();
  });

  it("stocked product-location rows alone block (409 names stock; qty-0 rows ignored)", async () => {
    tx.product_locations.findMany.mockResolvedValue([{ quantity: 3 }, { quantity: 0 }]);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/stocked product-location/i);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("notification-history entries alone block (409 names notifications)", async () => {
    tx.notificationHistory.count.mockResolvedValue(2);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/notification-history/i);
  });

  it("stock snapshots alone block (409 names snapshots)", async () => {
    tx.productStockSnapshot.count.mockResolvedValue(4);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/stock snapshots/i);
  });

  it("staging items alone block (409 names staging)", async () => {
    tx.stagingItem.count.mockResolvedValue(1);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/staging items/i);
  });

  it("users with this as default location alone block (409 names default location)", async () => {
    tx.user.count.mockResolvedValue(1);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/default location/i);
  });

  it("multiple blockers list ALL of them in the 409 message", async () => {
    tx.inventory_logs.count.mockResolvedValue(5);
    tx.stagingItem.count.mockResolvedValue(2);
    const resp = await del("2");
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/ledger/i);
    expect(body.error).toMatch(/staging items/i);
  });

  it("NEVER destroys ledger history — inventory_logs.deleteMany is not called on a blocked delete", async () => {
    tx.inventory_logs.count.mockResolvedValue(5);
    await del("2");
    expect(tx.inventory_logs.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE — happy path: zero-quantity debris removable, LOCATION_DELETE recorded
// ---------------------------------------------------------------------------
describe("DELETE locations/[id] — zero-history delete succeeds + LOCATION_DELETE", () => {
  it("qty-0 product_locations rows are removed, location deleted, event recorded same-tx", async () => {
    seedEmpty();
    tx.product_locations.findMany.mockResolvedValue([{ quantity: 0 }, { quantity: 0 }]);
    tx.product_locations.deleteMany.mockResolvedValue({ count: 2 });

    const resp = await del("2");

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.product_locations.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.location.delete).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    // The old history-destroyer must be gone: ledger rows are NEVER deleted.
    expect(tx.inventory_logs.deleteMany).not.toHaveBeenCalled();

    const [row] = auditRows();
    expect(row.actionType).toBe("LOCATION_DELETE");
    expect(row.entityType).toBe("LOCATION");
    expect(row.entityId).toBe("2");
    expect(typeof row.entityId).toBe("string");
    expect(row.userId).toBe(7);
    // R-D11 snapshot = the full location row (id + name).
    expect(row.details.snapshot.name).toBe("Backroom");
    expect(row.details.removedZeroQtyRows).toBe(2);
  });

  it("no product_locations rows at all -> still deletes + records", async () => {
    seedEmpty();
    tx.product_locations.deleteMany.mockResolvedValue({ count: 0 });

    const resp = await del("2");

    expect(resp.status).toBe(200);
    expect(tx.location.delete).toHaveBeenCalledTimes(1);
    const [row] = auditRows();
    expect(row.actionType).toBe("LOCATION_DELETE");
    expect(row.details.removedZeroQtyRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DELETE — ER-B2 race mapping: P2003 between the counts and the delete -> 409
// ---------------------------------------------------------------------------
describe("DELETE locations/[id] — ER-B2 P2003 race maps to 409 (never a raw 500)", () => {
  it("a reference gained mid-delete (P2003) becomes a 409, not a 500", async () => {
    seedEmpty();
    tx.product_locations.deleteMany.mockResolvedValue({ count: 0 });
    tx.location.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("FK constraint failed", {
        code: "P2003",
        clientVersion: "6.10.0",
      })
    );

    const resp = await del("2");

    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/gained new references/i);
  });
});
