/**
 * @jest-environment node
 *
 * N0 C6 (RC-4 note) — ONE email-domain rule, shared by signup and credentials
 * sign-in (and Google sign-in): after trimming, EXACTLY ONE "@", a non-empty local
 * part and domain, no whitespace or control characters, THEN the wildcard or an
 * allowed domain.
 *
 * Before N0, `email.split('@')[1]` read "a@allowed.com@evil.com" as allowed.com,
 * and the wildcard skipped the shape check entirely.
 *
 * lib/auth.ts and the signup route read ALLOWED_EMAIL_DOMAINS at module load, so
 * each mode loads its own isolated module graph with the env set explicitly (the
 * repo's .env, which next/jest layers in, cannot steer a result).
 */

import { NextRequest } from "next/server";

type Loaded = {
  emailDomainAllowed: (email: string) => boolean;
  authorize: (creds: unknown, req: unknown) => Promise<unknown>;
  signupPOST: (req: NextRequest) => Promise<Response>;
  db: { user: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock }; $transaction: jest.Mock };
};

function load(allowedDomains: string): Loaded {
  const saved = process.env.ALLOWED_EMAIL_DOMAINS;
  process.env.ALLOWED_EMAIL_DOMAINS = allowedDomains;
  let loaded: Loaded | undefined;
  try {
    jest.isolateModules(() => {
      jest.doMock("@/lib/prisma", () => ({
        __esModule: true,
        default: {
          user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
          $transaction: jest.fn(),
        },
      }));
      jest.doMock("@/lib/auth-helpers", () => ({
        verifyPassword: jest.fn(async () => true),
        hashPassword: jest.fn(async () => "HASH"),
      }));
      jest.doMock("@/lib/rateLimit", () => {
        const actual = jest.requireActual("@/lib/rateLimit");
        return {
          __esModule: true,
          ...actual,
          enforceRateLimit: jest.fn(() => ({})),
          enforceRateLimitByKey: jest.fn(),
          applyRateLimitHeaders: jest.fn((r: unknown) => r),
        };
      });
      /* eslint-disable @typescript-eslint/no-require-imports -- isolateModules needs registry-bound requires */
      const auth = require("@/lib/auth");
      const provider = (auth.authOptions.providers as any[]).find(
        (p) => p.id === "credentials" || p.type === "credentials"
      );
      loaded = {
        emailDomainAllowed: auth.emailDomainAllowed,
        authorize: provider.options?.authorize ?? provider.authorize,
        signupPOST: require("@/app/api/auth/signup/route").POST,
        db: require("@/lib/prisma").default,
      };
      /* eslint-enable @typescript-eslint/no-require-imports */
    });
  } finally {
    if (saved === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = saved;
  }
  return loaded!;
}

const MODES: Array<[string, string]> = [
  ["a domain list", "advancedresearchpep.com,artech.tools"],
  ["the wildcard", "*"],
];

const DOUBLE_AT = "a@advancedresearchpep.com@evil.com";

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe.each(MODES)("emailDomainAllowed with %s", (_label, domains) => {
  const { emailDomainAllowed } = load(domains);

  it.each([
    [DOUBLE_AT],
    ["a@b@advancedresearchpep.com"],
    ["no-at-sign.advancedresearchpep.com"],
    ["@advancedresearchpep.com"],
    ["user@"],
    ["@"],
    [""],
    ["us er@advancedresearchpep.com"],
    ["user@advanced researchpep.com"],
    ["user\t@advancedresearchpep.com"],
    ["user@advancedresearchpep.com\nBcc: x@evil.com"],
    ["user\u0000@advancedresearchpep.com"],
    ["user\u0085@advancedresearchpep.com"],
    ["user @advancedresearchpep.com"],
    // N0 FR1 E5: the local part is printable ASCII only.
    ["us\u200ber@advancedresearchpep.com"], // zero-width space
    ["\u202euser@advancedresearchpep.com"], // right-to-left override
    ["us\uff20er@advancedresearchpep.com"], // fullwidth commercial at
    ["jos\u00e9@advancedresearchpep.com"], // a non-ASCII letter
    ["\u212aris@advancedresearchpep.com"], // Kelvin-sign lookalike
  ])("refuses %j", (email) => {
    expect(emailDomainAllowed(email)).toBe(false);
  });

  it("allows a normal address (surrounding whitespace trimmed, domain case-insensitive)", () => {
    expect(emailDomainAllowed("user@advancedresearchpep.com")).toBe(true);
    expect(emailDomainAllowed("  User@AdvancedResearchPep.COM  ")).toBe(true);
  });

  it("allows every printable-ASCII local part shape real addresses use", () => {
    for (const local of ["first.last", "first+tag", "o'brien", "a_b-c", "x!#$%&*/=?^`{|}~"]) {
      expect(emailDomainAllowed(`${local}@advancedresearchpep.com`)).toBe(true);
    }
  });
});

describe("the domain list vs the wildcard", () => {
  it("a list refuses an unlisted domain; the wildcard allows any single-@ address", () => {
    expect(load("advancedresearchpep.com").emailDomainAllowed("user@evil.com")).toBe(false);
    expect(load("*").emailDomainAllowed("user@evil.com")).toBe(true);
    expect(load("*").emailDomainAllowed("user@evil.com@advancedresearchpep.com")).toBe(false);
  });
});

describe.each(MODES)("signup (POST /api/auth/signup) with %s", (_label, domains) => {
  const loaded = load(domains);

  function signup(email: string) {
    return loaded.signupPOST(
      new NextRequest("http://x/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, username: "newuser", password: "SignupPass123" }),
        headers: { "Content-Type": "application/json" },
      })
    );
  }

  beforeEach(() => {
    loaded.db.user.findFirst.mockReset();
    loaded.db.$transaction.mockReset();
  });

  it(`${DOUBLE_AT} => 403, nothing created`, async () => {
    const res = await signup(DOUBLE_AT);
    expect(res.status).toBe(403);
    expect(loaded.db.user.findFirst).not.toHaveBeenCalled();
    expect(loaded.db.$transaction).not.toHaveBeenCalled();
  });

  it.each([["no-at.advancedresearchpep.com"], ["@advancedresearchpep.com"], ["us er@advancedresearchpep.com"]])(
    "%j => 403",
    async (email) => {
      const res = await signup(email);
      expect(res.status).toBe(403);
      expect(loaded.db.$transaction).not.toHaveBeenCalled();
    }
  );

  it("a normal address is allowed through to the uniqueness check", async () => {
    loaded.db.user.findFirst.mockResolvedValue({ email: "user@advancedresearchpep.com" });
    const res = await signup("user@advancedresearchpep.com");
    expect(res.status).toBe(409); // already in use — i.e. it got PAST the domain check
    expect(loaded.db.user.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe("credentials sign-in uses the same rule", () => {
  it.each(MODES)("with %s, a double-@ address is refused before any user read", async (_label, domains) => {
    const loaded = load(domains);
    const result = await loaded.authorize(
      { email: DOUBLE_AT, password: "pw" },
      { headers: { "x-forwarded-for": "10.9.8.7" } }
    );
    expect(result).toBeNull();
    expect(loaded.db.user.findUnique).not.toHaveBeenCalled();
  });

  it("a normal allowed address still reaches the user read", async () => {
    const loaded = load("advancedresearchpep.com");
    loaded.db.user.findUnique.mockResolvedValue(null);
    await loaded.authorize(
      { email: "user@advancedresearchpep.com", password: "pw" },
      { headers: { "x-forwarded-for": "10.9.8.6" } }
    );
    expect(loaded.db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "user@advancedresearchpep.com" },
    });
  });

  it("signup and sign-in share ONE function (signup imports it from lib/auth)", () => {
    const fs = jest.requireActual("node:fs") as typeof import("node:fs");
    const path = jest.requireActual("node:path") as typeof import("node:path");
    const root = path.resolve(__dirname, "../../..");
    const signupSrc = fs.readFileSync(path.join(root, "app/api/auth/signup/route.ts"), "utf8");
    const authSrc = fs.readFileSync(path.join(root, "lib/auth.ts"), "utf8");
    expect(signupSrc).toMatch(/import\s*\{\s*emailDomainAllowed\s*\}\s*from\s*["']@\/lib\/auth["']/);
    expect(signupSrc).not.toMatch(/function\s+isAllowedDomain/);
    expect(authSrc).not.toMatch(/function\s+isAllowedDomain/);
    // The credentials authorize() calls it.
    expect(authSrc).toMatch(/if \(!emailDomainAllowed\(email\)\)/);
  });
});
