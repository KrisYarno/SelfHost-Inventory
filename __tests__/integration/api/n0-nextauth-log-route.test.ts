/**
 * @jest-environment node
 *
 * N0 FR3 G1 (FD2-1) — next-auth's `_log` action is answered 204 before NextAuth
 * runs.
 *
 * FR2 F3 set `authOptions.logger`, which SWITCHES ON next-auth's `_log` action
 * (core/index.js): an unauthenticated, CSRF-free POST whose body picks the level
 * and the code — forged, multi-line, unthrottled server-log lines (the middleware
 * skips api/auth). The route file now answers `_log` with 204 and delegates
 * everything else to NextAuth unchanged.
 *
 * The REAL route handler and the REAL NextAuth run (the global next-auth mock is
 * lifted here); only next/headers (no request scope in jest) and Prisma are stubbed.
 */

jest.unmock("next-auth");

let requestCookies: Array<{ name: string; value: string }> = [];
jest.mock("next/headers", () => ({
  __esModule: true,
  cookies: async () => ({ getAll: () => requestCookies }),
  headers: async () => new Headers({ host: "localhost" }),
}));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));

import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import prisma from "@/lib/prisma";

const findUnique = (prisma as unknown as { user: { findUnique: jest.Mock } }).user.findUnique;
const TEST_SECRET = "n0-fr3-log-route-test-secret-not-real";
const ORIGINAL = { secret: process.env.NEXTAUTH_SECRET, url: process.env.NEXTAUTH_URL };

type Route = typeof import("@/app/api/auth/[...nextauth]/route");
let route: Route;
let spies: jest.SpyInstance[] = [];

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = TEST_SECRET; // read when lib/auth builds authOptions
  process.env.NEXTAUTH_URL = "http://localhost";
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- authOptions must see the test secret
    route = require("@/app/api/auth/[...nextauth]/route");
  });
});

afterAll(() => {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of [
    ["NEXTAUTH_SECRET", ORIGINAL.secret],
    ["NEXTAUTH_URL", ORIGINAL.url],
  ] as const) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  requestCookies = [];
  spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});

afterEach(() => {
  spies.forEach((spy) => spy.mockRestore());
});

function consoleCalls(): number {
  return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

function post(action: string, body: Record<string, string>, contentType = "application/x-www-form-urlencoded") {
  return route.POST(
    new NextRequest(`http://localhost/api/auth/${action}`, {
      method: "POST",
      headers: { "content-type": contentType, host: "localhost" },
      body: contentType.includes("json") ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    }),
    { params: { nextauth: [action] } }
  );
}

describe("G1: the _log action never reaches a logger", () => {
  it.each([
    ["level=error", { code: "FORGED_ERROR", level: "error", message: "attacker text" }],
    ["level=warn", { code: "FORGED_WARN", level: "warn" }],
    ["a newline-bearing code", { code: "X\n[next-auth][error] ADMIN PASSWORD RESET for kris", level: "error" }],
    ["an unknown level", { code: "X", level: "constructor" }],
  ])("%s => 204, empty body, and NO console call at all", async (_label, body) => {
    const res = await post("_log", body);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(consoleCalls()).toBe(0);
  });

  it("a JSON-bodied _log is refused the same way", async () => {
    const res = await post("_log", { code: "FORGED", level: "error" }, "application/json");
    expect(res.status).toBe(204);
    expect(consoleCalls()).toBe(0);
  });
});

describe("G1: everything else is delegated to NextAuth unchanged", () => {
  it("GET csrf is still NextAuth's (a token and its cookie)", async () => {
    const res = await route.GET(new NextRequest("http://localhost/api/auth/csrf"), {
      params: { nextauth: ["csrf"] },
    });
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).csrfToken).toBe("string");
    expect(res.headers.get("set-cookie")).toMatch(/next-auth\.csrf-token=/);
  });

  it("a normal session POST (a CSRF-valid update) still works, and re-reads the claims", async () => {
    // 1. NextAuth's own CSRF round trip.
    const csrfRes = await route.GET(new NextRequest("http://localhost/api/auth/csrf"), {
      params: { nextauth: ["csrf"] },
    });
    const { csrfToken } = await csrfRes.json();
    const csrfCookie = /next-auth\.csrf-token=([^;]+)/.exec(csrfRes.headers.get("set-cookie") ?? "")![1];

    // 2. A signed-in member updates their session.
    const jwt = await encode({
      secret: TEST_SECRET,
      token: { id: 42, email: "member@example.com", name: "member", isAdmin: false, isApproved: true, defaultLocationId: 3 },
    });
    requestCookies = [
      { name: "next-auth.csrf-token", value: decodeURIComponent(csrfCookie) },
      { name: "next-auth.session-token", value: jwt },
    ];
    findUnique.mockResolvedValue({ isAdmin: false, isApproved: true, deletedAt: null, defaultLocationId: 3 });

    const res = await post("session", { csrfToken, data: JSON.stringify({ user: { isAdmin: true } }) }, "application/json");

    expect(res.status).toBe(200);
    const session = await res.json();
    expect(session.user).toMatchObject({ id: 42, email: "member@example.com", isAdmin: false, isApproved: true });
    expect(findUnique).toHaveBeenCalledTimes(1); // D0's re-read ran: NextAuth handled it
  });

  // N0 FR4 H3: a credentials sign-in POST is NextAuth's, end to end — a refused
  // sign-in still runs authorize() and answers NextAuth's CredentialsSignin, never
  // the _log 204.
  it("POST callback/credentials (a refused sign-in) reaches NextAuth and authorize(), not the 204", async () => {
    const csrfRes = await route.GET(new NextRequest("http://localhost/api/auth/csrf"), {
      params: { nextauth: ["csrf"] },
    });
    const { csrfToken } = await csrfRes.json();
    const csrfCookie = /next-auth\.csrf-token=([^;]+)/.exec(csrfRes.headers.get("set-cookie") ?? "")![1];
    requestCookies = [{ name: "next-auth.csrf-token", value: decodeURIComponent(csrfCookie) }];
    findUnique.mockResolvedValue(null); // no such account

    const res = await route.POST(
      new NextRequest("http://localhost/api/auth/callback/credentials", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost", "x-forwarded-for": "198.18.0.7" },
        body: new URLSearchParams({
          csrfToken,
          email: "nobody@advancedresearchpep.com",
          password: "wrong-password",
          json: "true",
        }).toString(),
      }),
      { params: { nextauth: ["callback", "credentials"] } }
    );

    expect(res.status).not.toBe(204);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(String(body.url)).toContain("error=CredentialsSignin");
    expect(findUnique).toHaveBeenCalledWith({ where: { email: "nobody@advancedresearchpep.com" } });
  });

  it("a session POST without CSRF is NextAuth's own 400 (not the 204)", async () => {
    const res = await post("session", {});
    expect(res.status).toBe(400);
  });
});
