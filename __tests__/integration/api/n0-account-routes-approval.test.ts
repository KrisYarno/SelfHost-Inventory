/**
 * @jest-environment node
 *
 * N0 FR1 E3 (GR-2 = XR-3 = OCR-3) — the four self-service account routes require
 * an APPROVED session, not just a signed-in one.
 *
 * D0 re-reads the claims on every session read, so a deleted or unapproved user's
 * session carries isApproved:false. requireAuth() alone still accepted it, so a
 * deleted user could keep editing their own profile until the cookie expired. The
 * sessions here are built by the REAL jwt + session callbacks from a re-read row,
 * exactly as getServerSession would build them.
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    location: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  },
}));

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import prisma from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { requireAuth, requireApproved } from "@/lib/api-utils";
import { GET as preferencesGET, PATCH as preferencesPATCH } from "@/app/api/user/preferences/route";
import { GET as usernameGET, PATCH as usernamePATCH } from "@/app/api/account/username/route";
import { PATCH as defaultLocationPATCH } from "@/app/api/account/default-location/route";
import { POST as passwordPOST, PATCH as passwordPATCH } from "@/app/api/account/password/route";

const db = prisma as unknown as {
  user: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  location: { findUnique: jest.Mock };
  $transaction: jest.Mock;
};
const jwt = authOptions.callbacks!.jwt! as unknown as (args: Record<string, unknown>) => Promise<any>;
const sessionCallback = authOptions.callbacks!.session! as unknown as (
  args: Record<string, unknown>
) => Promise<any>;

/** The session getServerSession would hand a route after D0 re-read `row`. */
async function sessionAfterReRead(row: Record<string, unknown> | null) {
  db.user.findUnique.mockResolvedValueOnce(row);
  const token = await jwt({
    token: {
      id: 42,
      email: "member@advancedresearchpep.com",
      name: "member",
      isAdmin: false,
      isApproved: true, // what the cookie still claims
      defaultLocationId: 1,
    },
  });
  return sessionCallback({
    session: { user: { name: token.name, email: token.email }, expires: "2099-01-01T00:00:00.000Z" },
    token,
  });
}

function req(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

const HANDLERS: Array<[string, () => Promise<Response>]> = [
  ["GET /api/user/preferences", () => preferencesGET(req("http://x/api/user/preferences", "GET"), {} as never)],
  [
    "PATCH /api/user/preferences",
    () => preferencesPATCH(req("http://x/api/user/preferences", "PATCH", { emailAlerts: false }), {} as never),
  ],
  ["GET /api/account/username", () => usernameGET(req("http://x/api/account/username", "GET"), {} as never)],
  [
    "PATCH /api/account/username",
    () => usernamePATCH(req("http://x/api/account/username", "PATCH", { username: "new.name" }), {} as never),
  ],
  [
    "PATCH /api/account/default-location",
    () =>
      defaultLocationPATCH(req("http://x/api/account/default-location", "PATCH", { locationId: 2 }), {} as never),
  ],
  [
    "POST /api/account/password",
    () =>
      passwordPOST(
        req("http://x/api/account/password", "POST", { newPassword: "NewPass12345", confirmPassword: "NewPass12345" }),
        {} as never
      ),
  ],
  [
    "PATCH /api/account/password",
    () =>
      passwordPATCH(
        req("http://x/api/account/password", "PATCH", {
          currentPassword: "OldPass12345",
          newPassword: "NewPass12345",
          confirmPassword: "NewPass12345",
        }),
        {} as never
      ),
  ],
];

const ROWS: Array<[string, Record<string, unknown> | null]> = [
  ["a soft-deleted user", { isAdmin: false, isApproved: true, deletedAt: new Date(), defaultLocationId: 1 }],
  ["an unapproved user", { isAdmin: false, isApproved: false, deletedAt: null, defaultLocationId: 1 }],
  ["a user whose row is gone", null],
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each(ROWS)("E3: %s", (_label, row) => {
  it.each(HANDLERS)("%s => 403, and the route reads nothing", async (_name, call) => {
    (getServerSession as jest.Mock).mockResolvedValue(await sessionAfterReRead(row));
    db.user.findUnique.mockClear();

    const res = await call();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "Account pending approval", code: "FORBIDDEN" });
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("the guard is what refuses it: requireAuth() alone accepts this session, requireApproved() does not", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(await sessionAfterReRead(row));
    await expect(requireAuth()).resolves.toMatchObject({ user: { isApproved: false } });
    await expect(requireApproved()).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe("E3: an approved user still gets through", () => {
  it("GET /api/account/username with an approved re-read row => 200", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(
      await sessionAfterReRead({ isAdmin: false, isApproved: true, deletedAt: null, defaultLocationId: 1 })
    );
    db.user.findUnique.mockResolvedValue({ id: 42, username: "member" });
    const res = await usernameGET(req("http://x/api/account/username", "GET"), {} as never);
    expect(res.status).toBe(200);
  });
});
