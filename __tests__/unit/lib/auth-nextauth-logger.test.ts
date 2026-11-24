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
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { authOptions } from "@/lib/auth";

const findUnique = (prisma as unknown as { user: { findUnique: jest.Mock } }).user.findUnique;
const TEST_SECRET = "n0-fr2-logger-test-secret-not-a-real-one";
const DB_HOST = "db.internal.example:3306";
const DB_USER = "inventory_app_user";

// N0 FR3 G3: the REAL Prisma class — an initialization error carries its code in
// `errorCode`, with NO `code` (the FR2 fixture had invented a `code`).
function prismaShapedError() {
  return new Prisma.PrismaClientInitializationError(
    `Can't reach database server at \`${DB_HOST}\` as user \`${DB_USER}\``,
    "6.0.0",
    "P1001"
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

  it("G3: a REAL PrismaClientInitializationError logs its errorCode (it has no code)", () => {
    const real = prismaShapedError();
    expect((real as unknown as { code?: unknown }).code).toBeUndefined();
    error("JWT_SESSION_ERROR", real);
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] JWT_SESSION_ERROR (P1001)");
  });

  it("G3: a known request error's string code wins over its errorCode and name", () => {
    error(
      "JWT_SESSION_ERROR",
      new Prisma.PrismaClientKnownRequestError(`Unique constraint for ${DB_USER}`, {
        code: "P2002",
        clientVersion: "6.0.0",
      })
    );
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] JWT_SESSION_ERROR (P2002)");
    expect(printed()).not.toContain(DB_USER);
  });

  // FR3 G4 CHANGED this pin: a valid providerId is now printed as provider=<id>.
  it("a { error } metadata (OAuth-style): the nested error's code and the provider, never the sibling fields", () => {
    error("OAUTH_CALLBACK_ERROR", {
      error: Object.assign(new Error(`bad state for ${DB_USER}`), { code: "E_STATE" }),
      providerId: "google",
      message: `secret detail ${DB_HOST}`,
    });
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] OAUTH_CALLBACK_ERROR (E_STATE) provider=google");
    expect(printed()).not.toContain(DB_HOST);
  });

  // N0 FR3 G4: an OAuth OPError's `.error` is a STRING — the OAuth token, never "a
  // nested error"; error_description, messages and URLs never print.
  it("G4: an OPError-shaped metadata => (OPError) provider=google oauth=invalid_client, no description", () => {
    error("OAUTH_CALLBACK_ERROR", {
      name: "OPError",
      error: "invalid_client",
      error_description: "secret text",
      error_uri: "https://accounts.example/secret",
      message: "invalid_client (secret text)",
      providerId: "google",
    } as never);
    expect(errorSpy).toHaveBeenCalledWith(
      "[next-auth] OAUTH_CALLBACK_ERROR (OPError) provider=google oauth=invalid_client"
    );
    const out = printed();
    expect(out).not.toContain("secret text");
    expect(out).not.toContain("https://");
  });

  it("G4: a nested OPError also yields its OAuth token", () => {
    error("OAUTH_CALLBACK_ERROR", {
      error: Object.assign(new Error("invalid_grant (secret text)"), {
        name: "OPError",
        error: "invalid_grant",
        error_description: "secret text",
      }),
      providerId: "google",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[next-auth] OAUTH_CALLBACK_ERROR (OPError) provider=google oauth=invalid_grant"
    );
    expect(printed()).not.toContain("secret text");
  });

  it("G4: a providerId or OAuth token that is not a plain token is left out", () => {
    error("OAUTH_CALLBACK_ERROR", {
      name: "OPError",
      error: "Invalid Client: see https://x",
      providerId: "goo gle\nFAKE",
    } as never);
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] OAUTH_CALLBACK_ERROR (OPError)");
  });

  // N0 FR3 G1 (defence in depth): a forged code or detail is printed as `invalid`.
  it("G1: a newline-bearing code or detail prints `invalid`, never a newline", () => {
    error("JWT_SESSION_ERROR\n[next-auth] FORGED ADMIN LOGIN", Object.assign(new Error("x"), { code: "P1\nFORGED" }));
    expect(errorSpy).toHaveBeenCalledWith("[next-auth] invalid (invalid)");
    error("x".repeat(65), {} as never);
    expect(errorSpy).toHaveBeenLastCalledWith("[next-auth] invalid");
    expect(printed()).not.toContain("FORGED");
    for (const call of errorSpy.mock.calls) expect(String(call[0])).not.toMatch(/[\r\n]/);
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
