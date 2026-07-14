/**
 * @jest-environment node
 *
 * Lane 5 S3 — per-IP credentials-login rate limit inside NextAuth's authorize().
 *   - the 21st attempt from one IP returns null (same shape as a wrong password),
 *     NEVER a thrown/distinct error that would confirm the account exists;
 *   - a second IP is unaffected (independent buckets);
 *   - multi-hop x-forwarded-for keys on the FIRST hop;
 *   - the IP limit and the per-account lockout coexist and fire independently.
 *
 * Uses the REAL enforceRateLimitByKey (in-process store); each test uses a unique
 * IP so buckets don't bleed across tests.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock("@/lib/auth-helpers", () => ({ verifyPassword: jest.fn() }));

import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth-helpers";
import { authOptions } from "@/lib/auth";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; update: jest.Mock };
};

const provider: any = (authOptions.providers as any[]).find(
  (p) => p.id === "credentials" || p.type === "credentials"
);
// next-auth v4 keeps the user's authorize on provider.options; the top-level
// provider.authorize is a default `() => null` stub.
const authorize: (creds: any, req: any) => Promise<any> =
  provider.options?.authorize ?? provider.authorize;

const EMAIL = "user@advancedresearchpep.com";
const creds = { email: EMAIL, password: "pw" };

function approvedUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: EMAIL,
    username: "user",
    isAdmin: false,
    isApproved: true,
    defaultLocationId: null,
    passwordHash: "hash",
    deletedAt: null,
    lockedUntil: null,
    failedLoginAttempts: 0,
    ...overrides,
  };
}

function reqWith(headers: Record<string, string>) {
  // NextAuth v4 hands authorize a partial request: plain object, LOWERCASE header keys.
  return { headers };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.user.update.mockResolvedValue({});
});

describe("S3 per-IP login rate limit", () => {
  it("21st attempt from one IP returns null (indistinguishable from a bad password)", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(true); // correct password every time
    db.user.findUnique.mockResolvedValue(approvedUser());
    const req = reqWith({ "x-forwarded-for": "1.1.1.1" });

    // 20 correct-credential attempts succeed (return the user).
    for (let i = 0; i < 20; i++) {
      const r = await authorize(creds, req);
      expect(r).toMatchObject({ id: 1, email: EMAIL });
    }
    // The 21st is throttled — returns null (NOT the user, NOT a thrown error).
    const throttled = await authorize(creds, req);
    expect(throttled).toBeNull();
  });

  it("a second IP is unaffected by the first IP's exhausted bucket", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(true);
    db.user.findUnique.mockResolvedValue(approvedUser());

    const hot = reqWith({ "x-forwarded-for": "8.8.8.8" });
    for (let i = 0; i < 21; i++) await authorize(creds, hot);
    expect(await authorize(creds, hot)).toBeNull(); // 8.8.8.8 exhausted

    const fresh = reqWith({ "x-forwarded-for": "8.8.4.4" });
    expect(await authorize(creds, fresh)).toMatchObject({ id: 1 });
  });

  it("multi-hop x-forwarded-for keys on the FIRST hop", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(true);
    db.user.findUnique.mockResolvedValue(approvedUser());

    // Exhaust first-hop 5.5.5.5 (second hop 6.6.6.6 rides along but is not the key).
    const a = reqWith({ "x-forwarded-for": "5.5.5.5, 6.6.6.6" });
    for (let i = 0; i < 21; i++) await authorize(creds, a);
    expect(await authorize(creds, a)).toBeNull();

    // First hop 6.6.6.6 is a fresh bucket — proves the first hop (not the whole
    // string or the last hop) is the key.
    const b = reqWith({ "x-forwarded-for": "6.6.6.6, 5.5.5.5" });
    expect(await authorize(creds, b)).toMatchObject({ id: 1 });
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(true);
    db.user.findUnique.mockResolvedValue(approvedUser());
    const req = reqWith({ "x-real-ip": "7.7.7.7" });
    expect(await authorize(creds, req)).toMatchObject({ id: 1 });
  });

  it("per-account lockout still fires independently of the IP limit (interplay)", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(false); // wrong password
    // 4 prior fails -> this 5th fail must set lockedUntil (well under the 20/IP limit).
    db.user.findUnique.mockResolvedValue(approvedUser({ failedLoginAttempts: 4 }));
    const req = reqWith({ "x-forwarded-for": "3.3.3.3" });

    const r = await authorize(creds, req);
    expect(r).toBeNull();
    expect(db.user.update).toHaveBeenCalledTimes(1);
    const data = db.user.update.mock.calls[0][0].data;
    expect(data.failedLoginAttempts).toBe(5);
    expect(data.lockedUntil).toBeInstanceOf(Date);
  });

  it("an already-locked account returns null before the password check", async () => {
    (verifyPassword as jest.Mock).mockResolvedValue(true);
    db.user.findUnique.mockResolvedValue(
      approvedUser({ lockedUntil: new Date(Date.now() + 60_000) })
    );
    const req = reqWith({ "x-forwarded-for": "4.4.4.4" });

    expect(await authorize(creds, req)).toBeNull();
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});
