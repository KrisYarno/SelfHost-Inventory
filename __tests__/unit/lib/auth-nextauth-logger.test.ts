/**
 * @jest-environment node
 *
 * N0 FR2 F3 (FD1-3 = QA-5) — next-auth's own error log never prints an error's
 * message, stack or metadata object.
 *
 * FR1 E1 makes a failed claims re-read RETHROW, so next-auth's session route logs
 * JWT_SESSION_ERROR with the thrown error. Its DEFAULT logger prints the message,
 * the stack and the whole metadata object, and a Prisma message can name the
 * database host or user. authOptions.logger.error now prints
 * `[next-auth] <code>` plus the error's own code (or name) — nothing else.
 *
 * Driven through next-auth's REAL session route (its exported getServerSession
 * from "next-auth/next", which runs the core AuthHandler's `session` action) with
 * a REAL encoded session cookie; only Prisma is mocked (it rejects like Prisma).
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));

import { getServerSession } from "next-auth/next";
import { encode } from "next-auth/jwt";
import prisma from "@/lib/prisma";
import { authOptions } from "@/lib/auth";

const findUnique = (prisma as unknown as { user: { findUnique: jest.Mock } }).user.findUnique;
const TEST_SECRET = "n0-fr2-logger-test-secret-not-a-real-one";
const DB_HOST = "db.internal.example:3306";
const DB_USER = "inventory_app_user";

function prismaShapedError() {
  return Object.assign(
    new Error(`Can't reach database server at \`${DB_HOST}\` as user \`${DB_USER}\``),
    { name: "PrismaClientInitializationError", code: "P1001", clientVersion: "6.0.0" }
  );
}

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

function printed(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls, ...logSpy.mock.calls]
    .flat()
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg)))
    .join("\n");
}

const ORIGINAL_URL = process.env.NEXTAUTH_URL;
beforeAll(() => {
  process.env.NEXTAUTH_URL = "http://localhost"; // => the non-__Secure cookie name
});
afterAll(() => {
  if (ORIGINAL_URL === undefined) delete process.env.NEXTAUTH_URL;
  else process.env.NEXTAUTH_URL = ORIGINAL_URL;
});

async function sessionRouteWithFailingDb() {
  const jwt = await encode({
    secret: TEST_SECRET,
    token: { id: 42, email: "member@example.com", name: "member", isAdmin: false, isApproved: true, defaultLocationId: null },
  });
  findUnique.mockRejectedValueOnce(prismaShapedError());
  const setHeader = jest.fn();
  const session = await getServerSession(
    { headers: { host: "localhost" }, cookies: { "next-auth.session-token": jwt } } as never,
    { getHeader: () => undefined, setHeader } as never,
    { ...authOptions, secret: TEST_SECRET, debug: false }
  );
  const setCookies = setHeader.mock.calls
    .filter(([name]) => String(name).toLowerCase() === "set-cookie")
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
    .map(String);
  return { session, setCookies };
}

describe("F3: JWT_SESSION_ERROR through the real session route", () => {
  it("logs the code (and the Prisma code) only — no message, no stack, no metadata object", async () => {
    const { session, setCookies } = await sessionRouteWithFailingDb();

    // The session route still answers no session and clears the cookie (FR1 E1).
    expect(session).toBeNull();
    expect(setCookies.some((c) => /^next-auth\.session-token=;/.test(c))).toBe(true);

    expect(errorSpy).toHaveBeenCalledWith("[next-auth] JWT_SESSION_ERROR (P1001)");
    const out = printed();
    expect(out).not.toContain(DB_HOST);
    expect(out).not.toContain(DB_USER);
    expect(out).not.toContain("Can't reach database server");
    expect(out).not.toMatch(/\n\s+at /); // no stack frame
    expect(out).not.toContain("clientVersion");
    // Every next-auth error line is ONE string argument.
    for (const call of errorSpy.mock.calls) {
      expect(call).toHaveLength(1);
      expect(typeof call[0]).toBe("string");
    }
  });
});

describe("F3: the logger itself", () => {
  const error = authOptions.logger!.error!;

  it("an Error metadata: its code wins over its name", () => {
    error("JWT_SESSION_ERROR", prismaShapedError());
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] JWT_SESSION_ERROR (P1001)");
  });

  it("a { error } metadata (OAuth-style): the nested error's code, never the sibling fields", () => {
    error("OAUTH_CALLBACK_ERROR", {
      error: Object.assign(new Error(`bad state for ${DB_USER}`), { code: "E_STATE" }),
      providerId: "google",
      message: `secret detail ${DB_HOST}`,
    });
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] OAUTH_CALLBACK_ERROR (E_STATE)");
    expect(printed()).not.toContain(DB_HOST);
  });

  it("no code: the name; neither: the code alone", () => {
    error("SIGNIN_EMAIL_ERROR", Object.assign(new Error(`x ${DB_HOST}`), { name: "TypeError" }));
    expect(errorSpy).toHaveBeenLastCalledWith("[next-auth] SIGNIN_EMAIL_ERROR (TypeError)");
    error("CLIENT_FETCH_ERROR", { error: { message: `y ${DB_HOST}` } as unknown as Error });
    expect(errorSpy).toHaveBeenLastCalledWith("[next-auth] CLIENT_FETCH_ERROR");
    expect(printed()).not.toContain(DB_HOST);
  });

  it("warn and debug keep next-auth's defaults (not overridden here)", () => {
    expect(authOptions.logger).not.toHaveProperty("warn");
    expect(authOptions.logger).not.toHaveProperty("debug");
  });
});
