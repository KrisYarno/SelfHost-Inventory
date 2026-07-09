// @jest-environment node
/**
 * Task 11 characterization tests — user-admin call-site migration to
 * @/lib/change-tracking (spec Phase A2; recipe step 4).
 *
 * These drive each of the 6 migrated routes with a mocked Prisma whose
 * $transaction hands the handler a single `tx` object (exposed as `db.__tx`).
 * The REAL recordChange runs against that tx, so every assertion is on the
 * ACTUAL audit_logs create payload — proving:
 *   - the event row is written on the SAME tx as the mutation (tx.user.* and
 *     tx.auditLog.create both fire inside the one $transaction closure),
 *   - entityId is normalized to a STRING,
 *   - the isAdmin flip emits an ADDITIONAL USER_ROLE_CHANGE event sharing the
 *     USER_UPDATE event's batchId (spec D6),
 *   - bulk routes emit ONE event carrying R-D14 details.rows (capped at 500).
 */
import { NextRequest } from "next/server";

// Keep the REAL apiHandler (so ZodError -> 400 maps centrally) + requireCSRF;
// stub only the admin guard.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn() };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock("@/lib/rateLimit", () => ({
  __esModule: true,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: unknown) => r),
}));

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// REAL change-tracking (recordChange runs for real) with only newBatchId pinned
// so batchId sharing between the dual events is assertable by value.
jest.mock("@/lib/change-tracking", () => {
  const actual = jest.requireActual("@/lib/change-tracking");
  return { __esModule: true, ...actual, newBatchId: jest.fn(() => "test-batch-0001") };
});

// One tx object per test run, shared by the mutation and the audit write so the
// "same transaction" claim is observable (both mocks live on db.__tx).
jest.mock("@/lib/prisma", () => {
  const tx = {
    user: {
      update: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    userCompany: { deleteMany: jest.fn(), createMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    company: { findMany: jest.fn() },
    location: { findUnique: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { PATCH } from "@/app/api/admin/users/[userId]/route";
import { POST as approvePOST } from "@/app/api/admin/users/[userId]/approve/route";
import { DELETE as rejectDELETE } from "@/app/api/admin/users/[userId]/reject/route";
import { POST as bulkApprovePOST } from "@/app/api/admin/users/bulk-approve/route";
import { POST as bulkRejectPOST } from "@/app/api/admin/users/bulk-reject/route";
import { POST as bulkDeletePOST } from "@/app/api/admin/users/bulk-delete/route";
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

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/users/[userId]
// ---------------------------------------------------------------------------
describe("PATCH [userId] — USER_UPDATE (+ USER_ROLE_CHANGE on isAdmin flip)", () => {
  const baseTarget = {
    id: 5,
    email: "u@e.com",
    username: "old",
    deletedAt: null,
    isAdmin: false,
    defaultLocationId: 1,
    emailAlerts: true,
    minLocationEmailAlerts: false,
    minCombinedEmailAlerts: false,
    companies: [],
  };

  it("records USER_UPDATE inside the mutation's transaction, entityId a string", async () => {
    db.user.findUnique.mockResolvedValue(baseTarget);
    tx.user.update.mockResolvedValue({ ...baseTarget, username: "new" });

    const resp = await PATCH(mkReq("http://t/api/admin/users/5", "PATCH", { username: "new" }), {
      params: { userId: "5" },
    } as any);

    expect(resp.status).toBe(200);
    // Same-tx proof: both the mutation and the audit write ran in ONE $transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("USER_UPDATE");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("5"); // normalized number -> string
    expect(typeof row.entityId).toBe("string");
    expect(row.userId).toBe(7);
    expect(row.actorKind).toBe("USER");
    expect(row.batchId).toBe("test-batch-0001");
    expect(row.details.targetEmail).toBe("u@e.com");
    expect(row.details.changes.username).toEqual({ from: "old", to: "new" });
  });

  it("isAdmin flip emits a SECOND USER_ROLE_CHANGE event sharing the batchId (D6)", async () => {
    db.user.findUnique.mockResolvedValue(baseTarget);
    tx.user.update.mockResolvedValue({ ...baseTarget, isAdmin: true });

    const resp = await PATCH(mkReq("http://t/api/admin/users/5", "PATCH", { isAdmin: true }), {
      params: { userId: "5" },
    } as any);

    expect(resp.status).toBe(200);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);

    const rows = auditRows();
    const update = rows.find((r) => r.actionType === "USER_UPDATE");
    const role = rows.find((r) => r.actionType === "USER_ROLE_CHANGE");

    expect(update).toBeDefined();
    expect(role).toBeDefined();
    // Both events address the same user and SHARE the batchId.
    expect(update.entityId).toBe("5");
    expect(role.entityId).toBe("5");
    expect(role.entityType).toBe("USER");
    expect(update.batchId).toBe("test-batch-0001");
    expect(role.batchId).toBe(update.batchId);
    // The role event carries ONLY the isAdmin diff.
    expect(role.details.changes).toEqual({ isAdmin: { from: false, to: true } });
    expect(update.details.changes.isAdmin).toEqual({ from: false, to: true });
  });

  it("no isAdmin change => no USER_ROLE_CHANGE (behavior-preserving)", async () => {
    db.user.findUnique.mockResolvedValue(baseTarget);
    tx.user.update.mockResolvedValue({ ...baseTarget, username: "new" });

    await PATCH(mkReq("http://t/api/admin/users/5", "PATCH", { username: "new" }), {
      params: { userId: "5" },
    } as any);

    const kinds = auditRows().map((r) => r.actionType);
    expect(kinds).toEqual(["USER_UPDATE"]);
  });

  it("no effective change => no event at all (guard preserved)", async () => {
    db.user.findUnique.mockResolvedValue(baseTarget);

    const resp = await PATCH(mkReq("http://t/api/admin/users/5", "PATCH", { username: "old" }), {
      params: { userId: "5" },
    } as any);

    expect(resp.status).toBe(200);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/[userId]/approve
// ---------------------------------------------------------------------------
describe("POST [userId]/approve — USER_APPROVAL", () => {
  it("wraps the bare write in a tx and records USER_APPROVAL in it", async () => {
    tx.user.update.mockResolvedValue({ id: 5, email: "a@e.com", username: "au", isApproved: true });

    const resp = await approvePOST(mkReq("http://t/api/admin/users/5/approve", "POST"), {
      params: { userId: "5" },
    } as any);

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("USER_APPROVAL");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("5");
    expect(row.userId).toBe(7);
    expect(row.details.targetEmail).toBe("a@e.com");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/[userId]/reject
// ---------------------------------------------------------------------------
describe("DELETE [userId]/reject — USER_REJECTION", () => {
  it("soft-deletes and records USER_REJECTION in the same tx", async () => {
    db.user.findUnique.mockResolvedValue({ id: 5, email: "r@e.com" });
    tx.user.update.mockResolvedValue({});

    const resp = await rejectDELETE(mkReq("http://t/api/admin/users/5/reject", "DELETE"), {
      params: { userId: "5" },
    } as any);

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const updateArg = tx.user.update.mock.calls[0][0];
    expect(updateArg.data.deletedAt).toBeInstanceOf(Date);

    const [row] = auditRows();
    expect(row.actionType).toBe("USER_REJECTION");
    expect(row.entityId).toBe("5");
    expect(row.details.targetEmail).toBe("r@e.com");
  });
});

// ---------------------------------------------------------------------------
// Bulk routes — ONE event + R-D14 details.rows
// ---------------------------------------------------------------------------
describe("bulk-approve — USER_BULK_APPROVAL (one event, rows, batchId)", () => {
  it("emits a single event with per-row isApproved diffs and a batchId", async () => {
    db.user.findMany.mockResolvedValue([
      { id: 1, email: "a@e" },
      { id: 2, email: "b@e" },
    ]);
    tx.user.updateMany.mockResolvedValue({ count: 2 });

    const resp = await bulkApprovePOST(
      mkReq("http://t/api/admin/users/bulk-approve", "POST", { userIds: [1, 2, 3] })
    );

    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ approved: 2 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("USER_BULK_APPROVAL");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBeNull(); // bulk op is genuinely unaddressed
    expect(row.affectedCount).toBe(2);
    expect(row.batchId).toBe("test-batch-0001");
    expect(row.details.userIds).toEqual([1, 2]);
    expect(row.details.rows).toEqual([
      { entityId: "1", changes: { isApproved: { from: false, to: true } } },
      { entityId: "2", changes: { isApproved: { from: false, to: true } } },
    ]);
    expect(row.details.rowsTruncated).toBeUndefined();
  });

  it("R-D14 cap: >500 targets => rows truncated to 500 + summary count", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, email: `u${i}@e` }));
    db.user.findMany.mockResolvedValue(many);
    tx.user.updateMany.mockResolvedValue({ count: 501 });

    await bulkApprovePOST(
      mkReq("http://t/api/admin/users/bulk-approve", "POST", {
        userIds: many.map((u) => u.id),
      })
    );

    const [row] = auditRows();
    expect(row.details.rows).toHaveLength(500);
    expect(row.details.rowsTruncated).toBe(true);
    expect(row.details.rowCount).toBe(501);
    expect(row.affectedCount).toBe(501);
  });
});

describe("bulk-reject — USER_BULK_REJECTION (deletedAt transition rows)", () => {
  it("records the deletedAt null->timestamp change the route actually performs", async () => {
    db.user.findMany.mockResolvedValue([{ id: 1, email: "a@e", username: "au" }]);
    tx.user.updateMany.mockResolvedValue({ count: 1 });

    const resp = await bulkRejectPOST(
      mkReq("http://t/api/admin/users/bulk-reject", "POST", { userIds: [1] })
    );

    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("USER_BULK_REJECTION");
    expect(row.affectedCount).toBe(1);
    expect(row.batchId).toBe("test-batch-0001");
    expect(row.details.rows).toHaveLength(1);
    expect(row.details.rows[0].entityId).toBe("1");
    expect(row.details.rows[0].changes.deletedAt.from).toBeNull();
    // The recorded `to` is the SAME timestamp actually written to the row.
    const writtenDeletedAt = tx.user.updateMany.mock.calls[0][0].data.deletedAt;
    expect(row.details.rows[0].changes.deletedAt.to).toBe(writtenDeletedAt);
    expect(writtenDeletedAt).toBeInstanceOf(Date);
  });
});

describe("bulk-delete — USER_DELETION (deletedAt transition rows, self excluded)", () => {
  it("records one event over the non-self targets", async () => {
    db.user.findMany.mockResolvedValue([
      { id: 2, email: "b@e", username: "b" },
      { id: 3, email: "c@e", username: "c" },
    ]);
    tx.user.updateMany.mockResolvedValue({ count: 2 });

    // includes the admin's own id (7) which the route filters out
    const resp = await bulkDeletePOST(
      mkReq("http://t/api/admin/users/bulk-delete", "POST", { userIds: [2, 3, 7] })
    );

    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("USER_DELETION");
    expect(row.affectedCount).toBe(2);
    expect(row.details.userIds).toEqual([2, 3]);
    expect(row.details.rows.map((r: any) => r.entityId)).toEqual(["2", "3"]);
    expect(row.details.rows[0].changes.deletedAt.from).toBeNull();
    expect(row.details.rows[0].changes.deletedAt.to).toBeInstanceOf(Date);
  });
});
