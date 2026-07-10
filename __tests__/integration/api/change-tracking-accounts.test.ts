// @jest-environment node
/**
 * Task 2 characterization tests — accounts + identity call-site migration to
 * @/lib/change-tracking (Phase B plan Task 2; event table BINDING).
 *
 * Same mock-Prisma harness as the Phase A change-tracking-users.test.ts: the
 * mocked `$transaction` hands each handler a single `tx` object (exposed as
 * `db.__tx`), and the REAL recordChange runs against that tx, so every assertion
 * is on the ACTUAL audit_logs create payload. This proves:
 *   - the event row is written on the SAME tx as the mutation (both tx.user.*
 *     and tx.auditLog.create fire inside one $transaction closure),
 *   - entityId is normalized to a STRING,
 *   - ACCOUNT_PASSWORD_CHANGE events carry NO password material anywhere,
 *   - preferences/default-location diffs cover ONLY the provided fields and drop
 *     no-op (from===to) changes (ER-B9),
 *   - signup records SIGNUP with the created user as actor,
 *   - users/[userId] DELETE 404s honestly on a missing target and snapshots the
 *     (redacted) row.
 */
import { NextRequest } from "next/server";

// Keep the REAL apiHandler (ZodError/AppError -> status mapping) + requireCSRF;
// stub only the auth guards.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAuth: jest.fn(), requireAdmin: jest.fn() };
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

// Password hashing is opaque here — deterministic stubs so the tests can assert
// the (raw + hashed) material NEVER reaches the event payload.
jest.mock("@/lib/auth-helpers", () => ({
  __esModule: true,
  hashPassword: jest.fn(async () => "HASHEDVALUE"),
  verifyPassword: jest.fn(async () => true),
}));

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// One tx object per test run, shared by the mutation and the audit write so the
// "same transaction" claim is observable (both mocks live on db.__tx).
jest.mock("@/lib/prisma", () => {
  const tx = {
    user: {
      update: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const db = {
    user: { findUnique: jest.fn(), findFirst: jest.fn() },
    location: { findUnique: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { POST as passwordPOST, PATCH as passwordPATCH } from "@/app/api/account/password/route";
import { PATCH as usernamePATCH } from "@/app/api/account/username/route";
import { PATCH as defaultLocationPATCH } from "@/app/api/account/default-location/route";
import { PATCH as preferencesPATCH } from "@/app/api/user/preferences/route";
import { POST as signupPOST } from "@/app/api/auth/signup/route";
import { DELETE as userDELETE } from "@/app/api/admin/users/[userId]/route";
import { requireAuth, requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const tx = db.__tx;
const SELF = { id: 42, email: "u@e.com", name: null, isAdmin: false, isApproved: true, defaultLocationId: 1 };
const ADMIN = { id: 7, email: "admin@e.com", name: null, isAdmin: true, isApproved: true, defaultLocationId: 1 };

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

/** Recursively collect any key (case-insensitive) that is password material. */
const FORBIDDEN = new Set([
  "passwordhash",
  "password",
  "newpassword",
  "currentpassword",
  "confirmpassword",
]);
function forbiddenKeyPaths(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => forbiddenKeyPaths(v, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN.has(k.toLowerCase())) out.push(`${path}.${k}`);
      out.push(...forbiddenKeyPaths(v, `${path}.${k}`));
    }
    return out;
  }
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAuth as jest.Mock).mockResolvedValue({ user: SELF });
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
});

// ---------------------------------------------------------------------------
// account/password POST — ACCOUNT_PASSWORD_CHANGE (OAuth first-password)
// ---------------------------------------------------------------------------
describe("POST account/password — ACCOUNT_PASSWORD_CHANGE (created, NO values)", () => {
  it("records inside the update's tx with mode:created and zero password material", async () => {
    db.user.findUnique.mockResolvedValue({ id: 42, email: "u@e.com", passwordHash: null });
    tx.user.update.mockResolvedValue({ id: 42 });

    const resp = await passwordPOST(
      mkReq("http://t/api/account/password", "POST", {
        newPassword: "BrandNew123",
        confirmPassword: "BrandNew123",
      })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("ACCOUNT_PASSWORD_CHANGE");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("42");
    expect(typeof row.entityId).toBe("string");
    expect(row.userId).toBe(42);
    expect(row.actorKind).toBe("USER");
    expect(row.details).toEqual({ mode: "created" });
    expect(row.details.changes).toBeUndefined();

    // NO password material anywhere — not in a key, not in a value.
    expect(forbiddenKeyPaths(row)).toEqual([]);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("BrandNew123");
    expect(serialized).not.toContain("HASHEDVALUE");
  });
});

// ---------------------------------------------------------------------------
// account/password PATCH — ACCOUNT_PASSWORD_CHANGE (verified change)
// ---------------------------------------------------------------------------
describe("PATCH account/password — ACCOUNT_PASSWORD_CHANGE (changed, NO values)", () => {
  it("records inside the update's tx with mode:changed and zero password material", async () => {
    db.user.findUnique.mockResolvedValue({ id: 42, email: "u@e.com", passwordHash: "OLDHASH" });
    tx.user.update.mockResolvedValue({ id: 42 });

    const resp = await passwordPATCH(
      mkReq("http://t/api/account/password", "PATCH", {
        currentPassword: "OldSecret123",
        newPassword: "NewSecret123",
        confirmPassword: "NewSecret123",
      })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("ACCOUNT_PASSWORD_CHANGE");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("42");
    expect(row.userId).toBe(42);
    expect(row.details).toEqual({ mode: "changed" });

    expect(forbiddenKeyPaths(row)).toEqual([]);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("OldSecret123");
    expect(serialized).not.toContain("NewSecret123");
    expect(serialized).not.toContain("HASHEDVALUE");
    expect(serialized).not.toContain("OLDHASH");
  });
});

// ---------------------------------------------------------------------------
// account/username PATCH — ACCOUNT_USERNAME_CHANGE
// ---------------------------------------------------------------------------
describe("PATCH account/username — ACCOUNT_USERNAME_CHANGE", () => {
  it("records the from/to username in the update's tx", async () => {
    db.user.findUnique.mockResolvedValue({ id: 42, email: "u@e.com", username: "oldname" });
    db.user.findFirst.mockResolvedValue(null);
    tx.user.update.mockResolvedValue({ id: 42, username: "newname" });

    const resp = await usernamePATCH(
      mkReq("http://t/api/account/username", "PATCH", { username: "newname" })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("ACCOUNT_USERNAME_CHANGE");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("42");
    expect(row.userId).toBe(42);
    expect(row.details.changes.username).toEqual({ from: "oldname", to: "newname" });
  });

  it("unchanged username short-circuits with NO event (ER-B9)", async () => {
    db.user.findUnique.mockResolvedValue({ id: 42, email: "u@e.com", username: "samename" });

    const resp = await usernamePATCH(
      mkReq("http://t/api/account/username", "PATCH", { username: "samename" })
    );

    expect(resp.status).toBe(200);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// account/default-location PATCH — ACCOUNT_PREFERENCES_CHANGE
// ---------------------------------------------------------------------------
describe("PATCH account/default-location — ACCOUNT_PREFERENCES_CHANGE", () => {
  it("fetches the before-image inside the tx and records the defaultLocationId change", async () => {
    db.location.findUnique.mockResolvedValue({ id: 5, name: "Warehouse B" });
    tx.user.findUniqueOrThrow.mockResolvedValue({ defaultLocationId: 2 });
    tx.user.update.mockResolvedValue({ defaultLocationId: 5 });

    const resp = await defaultLocationPATCH(
      mkReq("http://t/api/account/default-location", "PATCH", { locationId: 5 })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("ACCOUNT_PREFERENCES_CHANGE");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("42");
    expect(row.userId).toBe(42);
    expect(row.details.changes.defaultLocationId).toEqual({ from: 2, to: 5 });
  });

  it("no-op (same location) writes NO event (ER-B9)", async () => {
    db.location.findUnique.mockResolvedValue({ id: 5, name: "Warehouse B" });
    tx.user.findUniqueOrThrow.mockResolvedValue({ defaultLocationId: 5 });
    tx.user.update.mockResolvedValue({ defaultLocationId: 5 });

    const resp = await defaultLocationPATCH(
      mkReq("http://t/api/account/default-location", "PATCH", { locationId: 5 })
    );

    expect(resp.status).toBe(200);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// user/preferences PATCH — ACCOUNT_PREFERENCES_CHANGE (provided-fields-only diff)
// ---------------------------------------------------------------------------
describe("PATCH user/preferences — ACCOUNT_PREFERENCES_CHANGE", () => {
  it("diffs ONLY the provided fields and drops unchanged ones (ER-B9)", async () => {
    tx.user.findUniqueOrThrow.mockResolvedValue({
      emailAlerts: false,
      defaultLocationId: 1,
      minLocationEmailAlerts: false,
      minCombinedEmailAlerts: false,
    });
    tx.user.update.mockResolvedValue({
      emailAlerts: true,
      defaultLocationId: 1,
      minLocationEmailAlerts: false,
      minCombinedEmailAlerts: false,
    });

    // emailAlerts changes false->true; minLocationEmailAlerts provided but
    // unchanged (false->false) and must NOT appear in changes.
    const resp = await preferencesPATCH(
      mkReq("http://t/api/user/preferences", "PATCH", {
        emailAlerts: true,
        minLocationEmailAlerts: false,
      })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("ACCOUNT_PREFERENCES_CHANGE");
    expect(row.entityId).toBe("42");
    expect(row.userId).toBe(42);
    // ONLY the changed provided field; not defaultLocationId, not the unchanged one.
    expect(row.details.changes).toEqual({ emailAlerts: { from: false, to: true } });
  });

  it("all provided fields unchanged => NO event (ER-B9)", async () => {
    tx.user.findUniqueOrThrow.mockResolvedValue({
      emailAlerts: false,
      defaultLocationId: 1,
      minLocationEmailAlerts: false,
      minCombinedEmailAlerts: false,
    });
    tx.user.update.mockResolvedValue({
      emailAlerts: false,
      defaultLocationId: 1,
      minLocationEmailAlerts: false,
      minCombinedEmailAlerts: false,
    });

    const resp = await preferencesPATCH(
      mkReq("http://t/api/user/preferences", "PATCH", { emailAlerts: false })
    );

    expect(resp.status).toBe(200);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// auth/signup POST — SIGNUP
// ---------------------------------------------------------------------------
describe("POST auth/signup — SIGNUP", () => {
  it("creates the user and records SIGNUP with the created user as actor, no password material", async () => {
    db.user.findFirst.mockResolvedValue(null);
    tx.user.create.mockResolvedValue({
      id: 99,
      email: "new@advancedresearchpep.com",
      username: "newuser",
      isAdmin: false,
      isApproved: false,
    });

    const resp = await signupPOST(
      mkReq("http://t/api/auth/signup", "POST", {
        email: "new@advancedresearchpep.com",
        username: "newuser",
        password: "SignupPass123",
      })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("SIGNUP");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("99");
    expect(row.userId).toBe(99); // actor is the created user
    expect(row.actorKind).toBe("USER");
    expect(row.details.email).toBe("new@advancedresearchpep.com");
    expect(row.details.username).toBe("newuser");
    expect(row.details.changes).toBeUndefined(); // identity only, no diff

    expect(forbiddenKeyPaths(row)).toEqual([]);
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("SignupPass123");
    expect(serialized).not.toContain("HASHEDVALUE");
  });
});

// ---------------------------------------------------------------------------
// admin/users/[userId] DELETE — USER_DELETION (soft delete)
// ---------------------------------------------------------------------------
describe("DELETE admin/users/[userId] — USER_DELETION", () => {
  it("fetches the target inside the tx, soft-deletes, and snapshots the redacted row", async () => {
    tx.user.findUnique.mockResolvedValue({
      id: 5,
      email: "victim@e.com",
      username: "victim",
      passwordHash: "SECRETHASH",
      deletedAt: null,
      isAdmin: false,
    });
    tx.user.update.mockResolvedValue({});

    const resp = await userDELETE(mkReq("http://t/api/admin/users/5", "DELETE"), {
      params: { userId: "5" },
    } as any);

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    // The soft-delete writes a deletedAt timestamp.
    const updateArg = tx.user.update.mock.calls[0][0];
    expect(updateArg.data.deletedAt).toBeInstanceOf(Date);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("USER_DELETION");
    expect(row.entityType).toBe("USER");
    expect(row.entityId).toBe("5");
    expect(row.userId).toBe(7); // the admin actor
    expect(row.details.changes.deletedAt.from).toBeNull();
    expect(row.details.changes.deletedAt.to).toBe(updateArg.data.deletedAt);
    // Full row snapshot with credentials auto-redacted (R-D11).
    expect(row.details.snapshot.email).toBe("victim@e.com");
    expect(row.details.snapshot.passwordHash).toBe("[REDACTED]");
  });

  it("missing target => honest 404, no mutation, no event", async () => {
    tx.user.findUnique.mockResolvedValue(null);

    const resp = await userDELETE(mkReq("http://t/api/admin/users/999", "DELETE"), {
      params: { userId: "999" },
    } as any);

    expect(resp.status).toBe(404);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("cannot delete your own account (guard preserved, no tx)", async () => {
    const resp = await userDELETE(mkReq("http://t/api/admin/users/7", "DELETE"), {
      params: { userId: "7" },
    } as any);

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
