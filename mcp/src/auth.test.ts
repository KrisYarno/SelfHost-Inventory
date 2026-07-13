/**
 * auth.test.ts — the D7 static-Bearer auth matrix (spec D7/D8, codex #17).
 * Every rejection path must yield a generic failure; the constant-time compare is
 * asserted directly (timingSafeHexEqual) and by construction (a stored/computed
 * digest mismatch rejects).
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { createHash, randomBytes } from "node:crypto";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    apiToken: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({ id: "tok_1" })),
    },
  },
}));

import prisma from "@/lib/prisma";
import {
  authenticateToken,
  extractBearer,
  hashToken,
  timingSafeHexEqual,
} from "./auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = prisma;

function makeToken(): string {
  return "invmcp_" + randomBytes(32).toString("base64url");
}

function liveOwner() {
  return { isAdmin: false, isApproved: true, deletedAt: null };
}

function recordFor(rawToken: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "tok_1",
    tokenHash: hashToken(rawToken),
    revokedAt: null,
    ownerUserId: 7,
    owner: liveOwner(),
    ...overrides,
  };
}

beforeEach(() => {
  p.apiToken.findUnique.mockReset();
  p.apiToken.update.mockReset();
  p.apiToken.update.mockResolvedValue({ id: "tok_1" });
});

describe("extractBearer", () => {
  it("pulls the token from a well-formed header", () => {
    expect(extractBearer("Bearer invmcp_abc")).toBe("invmcp_abc");
  });
  it("returns null for missing / malformed scheme", () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer("")).toBeNull();
    expect(extractBearer("Basic xxx")).toBeNull();
    expect(extractBearer("invmcp_abc")).toBeNull();
  });
});

describe("timingSafeHexEqual", () => {
  it("is true for identical digests", () => {
    const h = createHash("sha256").update("x").digest("hex");
    expect(timingSafeHexEqual(h, h)).toBe(true);
  });
  it("is false for differing digests of equal length", () => {
    const a = createHash("sha256").update("a").digest("hex");
    const b = createHash("sha256").update("b").digest("hex");
    expect(timingSafeHexEqual(a, b)).toBe(false);
  });
  it("is false for differing lengths and empty input (no throw)", () => {
    expect(timingSafeHexEqual("abcd", "ab")).toBe(false);
    expect(timingSafeHexEqual("", "")).toBe(false);
  });
});

describe("authenticateToken", () => {
  it("accepts a valid, live, approved token and resolves identity", async () => {
    const raw = makeToken();
    p.apiToken.findUnique.mockResolvedValue(
      recordFor(raw, { ownerUserId: 7, owner: { isAdmin: true, isApproved: true, deletedAt: null } }),
    );
    const result = await authenticateToken(`Bearer ${raw}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token).toEqual({ tokenId: "tok_1", ownerUserId: 7, isAdmin: true });
    }
    // lookup used the sha256 hex of the FULL token via the unique index
    expect(p.apiToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashToken(raw) } }),
    );
    // lastUsedAt best-effort update fired
    expect(p.apiToken.update).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed prefix without touching the DB", async () => {
    const bad = "wrong_" + randomBytes(32).toString("base64url");
    const result = await authenticateToken(`Bearer ${bad}`);
    expect(result.ok).toBe(false);
    expect(p.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a non-base64url / wrong-length body without touching the DB", async () => {
    // contains '+' and '/' (base64, not base64url) and wrong length
    await expect(authenticateToken("Bearer invmcp_not+valid/body==")).resolves.toEqual({ ok: false });
    // right charset, wrong length (too short)
    await expect(authenticateToken("Bearer invmcp_short")).resolves.toEqual({ ok: false });
    expect(p.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unknown token (no row)", async () => {
    p.apiToken.findUnique.mockResolvedValue(null);
    expect((await authenticateToken(`Bearer ${makeToken()}`)).ok).toBe(false);
  });

  it("rejects when the stored hash does not match the computed digest (constant-time guard)", async () => {
    const raw = makeToken();
    // stored hash belongs to a DIFFERENT token — same length, different value
    p.apiToken.findUnique.mockResolvedValue(recordFor(makeToken()));
    expect((await authenticateToken(`Bearer ${raw}`)).ok).toBe(false);
  });

  it("rejects a revoked token", async () => {
    const raw = makeToken();
    p.apiToken.findUnique.mockResolvedValue(recordFor(raw, { revokedAt: new Date() }));
    expect((await authenticateToken(`Bearer ${raw}`)).ok).toBe(false);
  });

  it("rejects a token whose owner is soft-deleted", async () => {
    const raw = makeToken();
    p.apiToken.findUnique.mockResolvedValue(
      recordFor(raw, { owner: { isAdmin: false, isApproved: true, deletedAt: new Date() } }),
    );
    expect((await authenticateToken(`Bearer ${raw}`)).ok).toBe(false);
  });

  it("rejects a token whose owner is unapproved", async () => {
    const raw = makeToken();
    p.apiToken.findUnique.mockResolvedValue(
      recordFor(raw, { owner: { isAdmin: false, isApproved: false, deletedAt: null } }),
    );
    expect((await authenticateToken(`Bearer ${raw}`)).ok).toBe(false);
  });

  it("treats a DB lookup error as a generic failure (never throws)", async () => {
    p.apiToken.findUnique.mockRejectedValue(new Error("db down"));
    await expect(authenticateToken(`Bearer ${makeToken()}`)).resolves.toEqual({ ok: false });
  });

  it("never lets a failed lastUsedAt update block auth", async () => {
    const raw = makeToken();
    p.apiToken.findUnique.mockResolvedValue(recordFor(raw));
    p.apiToken.update.mockRejectedValue(new Error("write failed"));
    const result = await authenticateToken(`Bearer ${raw}`);
    expect(result.ok).toBe(true);
  });
});
