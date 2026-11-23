/**
 * @jest-environment node
 *
 * N0 D0 (replaces C0) — a session can never carry rights the database does not
 * grant.
 *
 * Every session read runs the `jwt` callback (next-auth core/routes/session.js), and
 * before N0 the `trigger: "update"` branch copied isAdmin / isApproved straight from
 * the CLIENT's update payload — so any signed-in user holding a CSRF token could
 * promote themselves to admin. Sessions also SLIDE (every read re-encodes the token
 * with a fresh maxAge), so an escalated token never expired while in use.
 *
 * D0: on EVERY run that is not a sign-in (`!user`), `trigger: "update"` included,
 * the claims are re-read from the database by primary key; the client payload is
 * NEVER read; a missing row, a soft-deleted user, or an unusable token.id holds no
 * rights. Sign-in branches are unchanged.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock("@/lib/auth-helpers", () => ({ verifyPassword: jest.fn() }));

import prisma from "@/lib/prisma";
import { authOptions } from "@/lib/auth";

const findUnique = (prisma as unknown as { user: { findUnique: jest.Mock } }).user.findUnique;
const jwt = authOptions.callbacks!.jwt! as unknown as (args: Record<string, unknown>) => Promise<any>;

const CLAIMS_SELECT = { isAdmin: true, isApproved: true, deletedAt: true, defaultLocationId: true };

function row(overrides: Record<string, unknown> = {}) {
  return { isAdmin: false, isApproved: true, deletedAt: null, defaultLocationId: 3, ...overrides };
}

function memberToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    email: "member@advancedresearchpep.com",
    name: "member",
    isAdmin: false,
    isApproved: true,
    defaultLocationId: 3,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("D0: claims come from the database on every non-sign-in run", () => {
  it("a token claiming isAdmin:true for a NON-admin row is downgraded on the next plain read", async () => {
    findUnique.mockResolvedValue(row({ isAdmin: false }));
    const token = await jwt({ token: memberToken({ isAdmin: true }) });
    expect(token.isAdmin).toBe(false);
    expect(token.isApproved).toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 7 }, select: CLAIMS_SELECT });
  });

  it("the client update payload { user: { isAdmin: true, isApproved: true } } is IGNORED", async () => {
    findUnique.mockResolvedValue(row({ isAdmin: false, isApproved: false }));
    const token = await jwt({
      token: memberToken({ isApproved: false }),
      trigger: "update",
      session: { user: { isAdmin: true, isApproved: true } },
    });
    expect(token.isAdmin).toBe(false);
    expect(token.isApproved).toBe(false);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 7 }, select: CLAIMS_SELECT });
  });

  it("the update payload cannot even touch defaultLocationId", async () => {
    findUnique.mockResolvedValue(row({ defaultLocationId: 3 }));
    const token = await jwt({
      token: memberToken(),
      trigger: "update",
      session: { user: { defaultLocationId: 99, isAdmin: true } },
    });
    expect(token.defaultLocationId).toBe(3);
    expect(token.isAdmin).toBe(false);
  });

  it("a DB promotion is picked up on the next read", async () => {
    findUnique.mockResolvedValue(row({ isAdmin: true }));
    const token = await jwt({ token: memberToken({ isAdmin: false }) });
    expect(token.isAdmin).toBe(true);
  });

  it("a DB demotion (admin -> member, approved -> pending) is picked up on the next read", async () => {
    findUnique.mockResolvedValue(row({ isAdmin: false, isApproved: false, defaultLocationId: null }));
    const token = await jwt({ token: memberToken({ isAdmin: true, isApproved: true }) });
    expect(token.isAdmin).toBe(false);
    expect(token.isApproved).toBe(false);
    expect(token.defaultLocationId).toBeNull();
  });

  it("an approval made in the DB is picked up on update (the old 'when user is approved' flow)", async () => {
    findUnique.mockResolvedValue(row({ isApproved: true }));
    const token = await jwt({ token: memberToken({ isApproved: false }), trigger: "update", session: {} });
    expect(token.isApproved).toBe(true);
  });

  it("a soft-deleted user => isAdmin false, isApproved false", async () => {
    findUnique.mockResolvedValue(row({ isAdmin: true, isApproved: true, deletedAt: new Date() }));
    const token = await jwt({ token: memberToken({ isAdmin: true }) });
    expect(token.isAdmin).toBe(false);
    expect(token.isApproved).toBe(false);
  });

  it("a FAILED re-read => both false for that read, no throw (cookie kept); the next good read restores", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      findUnique.mockRejectedValueOnce(new Error("db down for member@advancedresearchpep.com"));
      const failed = await jwt({ token: memberToken({ isAdmin: true, isApproved: true }) });
      expect(failed.isAdmin).toBe(false);
      expect(failed.isApproved).toBe(false);
      // ONE address-free line, never the error (which may carry an address).
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("[auth] jwt claims re-read failed");

      findUnique.mockResolvedValueOnce(row({ isAdmin: true, isApproved: true, defaultLocationId: 4 }));
      const healed = await jwt({ token: failed });
      expect(healed.isAdmin).toBe(true);
      expect(healed.isApproved).toBe(true);
      expect(healed.defaultLocationId).toBe(4);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a missing row => isAdmin false, isApproved false", async () => {
    findUnique.mockResolvedValue(null);
    const token = await jwt({ token: memberToken({ isAdmin: true }) });
    expect(token.isAdmin).toBe(false);
    expect(token.isApproved).toBe(false);
  });

  it.each([
    ["a non-numeric id", "7"],
    ["a missing id", undefined],
    ["zero", 0],
    ["a negative id", -7],
    ["a fractional id", 7.5],
    ["NaN", Number.NaN],
    ["past the Int range", 2147483648],
    ["an object", { id: 7 }],
  ])("%s => both false, with NO Prisma read (so no Prisma throw)", async (_label, id) => {
    const token = await jwt({ token: memberToken({ id, isAdmin: true, isApproved: true }) });
    expect(token.isAdmin).toBe(false);
    expect(token.isApproved).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("D0: sign-in branches are unchanged", () => {
  it("credentials sign-in mints the token from the row found by EMAIL (no id re-read)", async () => {
    findUnique.mockResolvedValue({
      id: 7,
      email: "member@advancedresearchpep.com",
      username: "member",
      isAdmin: false,
      isApproved: true,
      defaultLocationId: 3,
    });
    const token = await jwt({
      token: {},
      user: { id: 7, email: "Member@AdvancedResearchPep.com" },
      account: { provider: "credentials" },
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "member@advancedresearchpep.com" } });
    expect(token).toEqual({
      id: 7,
      email: "member@advancedresearchpep.com",
      name: "member",
      isAdmin: false,
      isApproved: true,
      defaultLocationId: 3,
    });
  });

  it("Google sign-in mints the token from the row found by the profile email (no id re-read)", async () => {
    findUnique.mockResolvedValue({
      id: 8,
      email: "g@advancedresearchpep.com",
      username: "g.user",
      isAdmin: true,
      isApproved: true,
      defaultLocationId: null,
    });
    const token = await jwt({
      token: {},
      user: { id: 8, email: "g@advancedresearchpep.com" },
      account: { provider: "google" },
      profile: { email: "g@advancedresearchpep.com" },
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "g@advancedresearchpep.com" } });
    expect(token.isAdmin).toBe(true);
    expect(token.id).toBe(8);
  });

  it("a Google sign-in from a refused address leaves the token untouched (no reads)", async () => {
    const token = await jwt({
      token: { marker: 1 },
      user: { id: 9, email: "x@advancedresearchpep.com@evil.example" },
      account: { provider: "google" },
      profile: { email: "x@advancedresearchpep.com@evil.example" },
    });
    expect(token).toEqual({ marker: 1 });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
