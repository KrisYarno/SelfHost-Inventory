/**
 * @jest-environment node
 *
 * N0 FR3 G2 (FD2-2) + G3 — a database failure during sign-in never reaches the
 * sign-in form (or a log) as raw Prisma text.
 *
 * next-auth's credentials callback (core/routes/callback.js) puts a thrown
 * error's MESSAGE into the result's `error`, and the form used to render any
 * non-CredentialsSignin error verbatim — so an outage could show a visitor the
 * database host or user. authorize() and the credentials branch of the signIn
 * callback now wrap their DB calls: ONE address-free line,
 * `[auth] sign-in lookup failed (<code>)`, then `new Error("ServiceUnavailable")`.
 *
 * Fixtures use the REAL Prisma error classes (an initialization error carries its
 * code in `errorCode`, with no `code`).
 */

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn(), update: jest.fn() } },
}));
jest.mock("@/lib/auth-helpers", () => ({ verifyPassword: jest.fn() }));

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth-helpers";
import { authOptions } from "@/lib/auth";

const db = prisma as unknown as { user: { findUnique: jest.Mock; update: jest.Mock } };
const provider: any = (authOptions.providers as any[]).find(
  (p) => p.id === "credentials" || p.type === "credentials"
);
const authorize: (creds: any, req: any) => Promise<any> = provider.options?.authorize ?? provider.authorize;
const signIn = authOptions.callbacks!.signIn! as unknown as (args: Record<string, unknown>) => Promise<unknown>;
const jwt = authOptions.callbacks!.jwt! as unknown as (args: Record<string, unknown>) => Promise<unknown>;

const DB_HOST = "db.internal.example:3306";
const DB_USER = "inventory_app_user";
const EMAIL = "member@advancedresearchpep.com";

function initError() {
  return new Prisma.PrismaClientInitializationError(
    `Can't reach database server at \`${DB_HOST}\` as user \`${DB_USER}\``,
    "6.0.0",
    "P1001"
  );
}

let ip = 0;
const req = () => ({ headers: { "x-forwarded-for": `192.0.2.${++ip}` } });

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

function logged(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join("\n");
}

async function thrownBy(run: () => Promise<unknown>): Promise<Error> {
  const outcome = await run().then(
    () => null,
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

function expectServiceUnavailable(error: Error) {
  expect(error.message).toBe("ServiceUnavailable");
  const everything = `${error.message}\n${error.stack ?? ""}\n${logged()}`;
  expect(everything).not.toContain(DB_HOST);
  expect(everything).not.toContain(DB_USER);
  expect(everything).not.toContain("Can't reach database server");
  expect(errorSpy).toHaveBeenCalledWith("[auth] sign-in lookup failed (P1001)");
  expect(logged()).not.toContain(EMAIL);
}

describe("G2: authorize() never throws Prisma text", () => {
  it("a rejecting findUnique => the thrown error's message is exactly ServiceUnavailable", async () => {
    db.user.findUnique.mockRejectedValue(initError());
    expectServiceUnavailable(await thrownBy(() => authorize({ email: EMAIL, password: "pw" }, req())));
  });

  it("a rejecting failed-attempt update => ServiceUnavailable", async () => {
    db.user.findUnique.mockResolvedValue({
      id: 1, email: EMAIL, passwordHash: "h", deletedAt: null, lockedUntil: null, failedLoginAttempts: 0,
    });
    (verifyPassword as jest.Mock).mockResolvedValue(false);
    db.user.update.mockRejectedValue(initError());
    expectServiceUnavailable(await thrownBy(() => authorize({ email: EMAIL, password: "pw" }, req())));
  });

  it("a rejecting attempt-reset update => ServiceUnavailable", async () => {
    db.user.findUnique.mockResolvedValue({
      id: 1, email: EMAIL, username: "m", passwordHash: "h", deletedAt: null, lockedUntil: null,
      failedLoginAttempts: 2, isAdmin: false, isApproved: true, defaultLocationId: null,
    });
    (verifyPassword as jest.Mock).mockResolvedValue(true);
    db.user.update.mockRejectedValue(initError());
    expectServiceUnavailable(await thrownBy(() => authorize({ email: EMAIL, password: "pw" }, req())));
  });

  it("G3: a known request error logs its string code", async () => {
    db.user.findUnique.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(`timeout talking to ${DB_HOST}`, { code: "P1008", clientVersion: "6.0.0" })
    );
    const error = await thrownBy(() => authorize({ email: EMAIL, password: "pw" }, req()));
    expect(error.message).toBe("ServiceUnavailable");
    expect(errorSpy).toHaveBeenCalledWith("[auth] sign-in lookup failed (P1008)");
    expect(logged()).not.toContain(DB_HOST);
  });

  it("an error with no code logs (unknown)", async () => {
    db.user.findUnique.mockRejectedValue(new Error(`socket closed by ${DB_HOST}`));
    const error = await thrownBy(() => authorize({ email: EMAIL, password: "pw" }, req()));
    expect(error.message).toBe("ServiceUnavailable");
    expect(errorSpy).toHaveBeenCalledWith("[auth] sign-in lookup failed (unknown)");
  });

  it("every ordinary refusal is still null (never a thrown error)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    expect(await authorize({ email: EMAIL, password: "pw" }, req())).toBeNull();
  });
});

describe("G2: the credentials signIn callback never throws Prisma text", () => {
  it("a rejecting findUnique => ServiceUnavailable", async () => {
    db.user.findUnique.mockRejectedValue(initError());
    expectServiceUnavailable(
      await thrownBy(() => signIn({ user: { email: EMAIL }, account: { provider: "credentials" } }))
    );
  });

  it("the healthy paths are unchanged (approved => true, pending => the pending page)", async () => {
    db.user.findUnique.mockResolvedValueOnce({ isApproved: true });
    expect(await signIn({ user: { email: EMAIL }, account: { provider: "credentials" } })).toBe(true);
    db.user.findUnique.mockResolvedValueOnce({ isApproved: false });
    expect(await signIn({ user: { email: EMAIL }, account: { provider: "credentials" } })).toBe(
      "/auth/pending-approval"
    );
  });
});

// N0 FR4 H2: the jwt callback's SIGN-IN reads (credentials, Google) go through the
// same lookup — the fixed ServiceUnavailable, a code-only log, no Prisma text.
describe("H2: the jwt callback's sign-in reads never throw Prisma text", () => {
  it("credentials sign-in: a real-shaped init error => exactly ServiceUnavailable", async () => {
    db.user.findUnique.mockRejectedValue(initError());
    expectServiceUnavailable(
      await thrownBy(() => jwt({ token: {}, user: { id: 1, email: EMAIL }, account: { provider: "credentials" } }))
    );
  });

  it("Google sign-in: a real-shaped init error => exactly ServiceUnavailable", async () => {
    db.user.findUnique.mockRejectedValue(initError());
    expectServiceUnavailable(
      await thrownBy(() =>
        jwt({
          token: {},
          user: { id: 1, email: EMAIL },
          account: { provider: "google" },
          profile: { email: EMAIL },
        })
      )
    );
  });

  it("the healthy sign-in reads are unchanged (same query, the token minted from the row)", async () => {
    db.user.findUnique.mockResolvedValue({
      id: 7, email: EMAIL, username: "m", isAdmin: false, isApproved: true, defaultLocationId: null,
    });
    const token = (await jwt({
      token: {},
      user: { id: 7, email: "Member@AdvancedResearchPep.com" },
      account: { provider: "credentials" },
    })) as Record<string, unknown>;
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: EMAIL } });
    expect(token).toMatchObject({ id: 7, email: EMAIL, isApproved: true });
  });
});

// N0 FR3 G6: the Google signIn catch logs its context and the code or name only.
describe("G6: the Google signIn catch never logs the error object", () => {
  it("a DB failure while provisioning a Google user => false, ONE line with the errorCode", async () => {
    db.user.findUnique.mockRejectedValue(initError());
    const result = await signIn({
      user: { email: EMAIL },
      account: { provider: "google" },
      profile: { email: EMAIL },
    });
    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("Error in signIn callback (P1001)");
    for (const arg of errorSpy.mock.calls.flat()) expect(arg).not.toBeInstanceOf(Error);
    expect(logged()).not.toContain(DB_HOST);
  });

  it("an error with no code logs its name", async () => {
    db.user.findUnique.mockRejectedValue(Object.assign(new TypeError(`bad ${DB_HOST}`)));
    await signIn({ user: { email: EMAIL }, account: { provider: "google" }, profile: { email: EMAIL } });
    expect(errorSpy).toHaveBeenCalledWith("Error in signIn callback (TypeError)");
    expect(logged()).not.toContain(DB_HOST);
  });
});
