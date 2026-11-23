/**
 * @jest-environment node
 *
 * N0 (RC-6, C2b, FV-9) — the email delivery switch's env parse.
 *
 * Fail-closed and byte-exact, like lib/platforms/egress/posture.ts: anything not
 * understood EXACTLY is "off" with invalidEnv set; unset is "off" and NOT invalid.
 * An invalid value warns ONCE per process, naming the variable, never its value.
 */

type PostureModule = typeof import("@/lib/notifications/delivery-posture");

// A fresh module per test, so the once-per-process warning flag starts clean.
function freshModule(): PostureModule {
  let mod: PostureModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolateModules needs a registry-bound require
    mod = require("@/lib/notifications/delivery-posture");
  });
  return mod!;
}

let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe("emailDeliveryPosture — parsing", () => {
  it("unset => off, NOT invalid, no warning", () => {
    const { emailDeliveryPosture } = freshModule();
    warnSpy.mockClear();
    expect(emailDeliveryPosture({})).toEqual({
      mode: "off",
      allowlist: [],
      invalidEnv: false,
      invalidReasons: [],
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('"off" => off', () => {
    const { emailDeliveryPosture } = freshModule();
    expect(emailDeliveryPosture({ EMAIL_DELIVERY: "off" })).toEqual({
      mode: "off",
      allowlist: [],
      invalidEnv: false,
      invalidReasons: [],
    });
  });

  it('"on" => on, the allowlist is not read', () => {
    const { emailDeliveryPosture } = freshModule();
    expect(
      emailDeliveryPosture({ EMAIL_DELIVERY: "on", EMAIL_ALLOWLIST: "someone@example.com" })
    ).toEqual({ mode: "on", allowlist: [], invalidEnv: false, invalidReasons: [] });
  });

  it('"allowlist" => trimmed, lowercased entries; empty entries dropped', () => {
    const { emailDeliveryPosture } = freshModule();
    expect(
      emailDeliveryPosture({
        EMAIL_DELIVERY: "allowlist",
        EMAIL_ALLOWLIST: " Kris@Example.COM ,, b@example.com ,",
      })
    ).toEqual({
      mode: "allowlist",
      allowlist: ["kris@example.com", "b@example.com"],
      invalidEnv: false,
      invalidReasons: [],
    });
  });

  it('"allowlist" with an EMPTY list => off + invalidEnv ["empty_allowlist"]', () => {
    const { emailDeliveryPosture } = freshModule();
    for (const list of [undefined, "", " , ,"]) {
      expect(emailDeliveryPosture({ EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: list })).toEqual({
        mode: "off",
        allowlist: [],
        invalidEnv: true,
        invalidReasons: ["empty_allowlist"],
      });
    }
  });

  it.each([["ON"], [" on"], ["on "], ["On"], ["true"], ["1"], [""], ["allow-list"], ["Off"]])(
    "byte-exact: %p is NOT understood => off + invalidEnv",
    (raw) => {
      const { emailDeliveryPosture } = freshModule();
      expect(emailDeliveryPosture({ EMAIL_DELIVERY: raw, EMAIL_ALLOWLIST: "a@example.com" })).toEqual({
        mode: "off",
        allowlist: [],
        invalidEnv: true,
        invalidReasons: ["EMAIL_DELIVERY"],
      });
    }
  );

  it("an invalid value warns ONCE per process, naming the variable and never the value", () => {
    const { emailDeliveryPosture } = freshModule();
    warnSpy.mockClear();
    const SECRET_LOOKING_VALUE = "on-but-typo-SG.zzz-unique-marker";
    emailDeliveryPosture({ EMAIL_DELIVERY: SECRET_LOOKING_VALUE });
    emailDeliveryPosture({ EMAIL_DELIVERY: SECRET_LOOKING_VALUE });
    emailDeliveryPosture({ EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: "" });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const printed = warnSpy.mock.calls.flat().map(String).join(" ");
    expect(printed).toContain("EMAIL_DELIVERY");
    expect(printed).not.toContain(SECRET_LOOKING_VALUE);
  });

  it("is read on EVERY call (no caching)", () => {
    const { emailDeliveryPosture } = freshModule();
    const env: Record<string, string | undefined> = { EMAIL_DELIVERY: "off" };
    expect(emailDeliveryPosture(env).mode).toBe("off");
    env.EMAIL_DELIVERY = "on";
    expect(emailDeliveryPosture(env).mode).toBe("on");
  });

  it("defaults to process.env", () => {
    const { emailDeliveryPosture } = freshModule();
    const saved = process.env.EMAIL_DELIVERY;
    try {
      process.env.EMAIL_DELIVERY = "on";
      expect(emailDeliveryPosture().mode).toBe("on");
      delete process.env.EMAIL_DELIVERY;
      expect(emailDeliveryPosture().mode).toBe("off");
    } finally {
      if (saved === undefined) delete process.env.EMAIL_DELIVERY;
      else process.env.EMAIL_DELIVERY = saved;
    }
  });

  it("logs the mode once at module load (no addresses)", () => {
    const saved = { d: process.env.EMAIL_DELIVERY, l: process.env.EMAIL_ALLOWLIST };
    try {
      process.env.EMAIL_DELIVERY = "allowlist";
      process.env.EMAIL_ALLOWLIST = "private.person@example.com";
      logSpy.mockClear();
      freshModule();
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith("email delivery: allowlist");
    } finally {
      if (saved.d === undefined) delete process.env.EMAIL_DELIVERY;
      else process.env.EMAIL_DELIVERY = saved.d;
      if (saved.l === undefined) delete process.env.EMAIL_ALLOWLIST;
      else process.env.EMAIL_ALLOWLIST = saved.l;
    }
  });
});

describe("filterRecipients — per mode, case-insensitive", () => {
  const to = ["Kris@Example.com", "other@example.com", "", "third@example.com"];

  it("on => every non-empty address", () => {
    const { emailDeliveryPosture, filterRecipients } = freshModule();
    expect(filterRecipients(to, emailDeliveryPosture({ EMAIL_DELIVERY: "on" }))).toEqual([
      "Kris@Example.com",
      "other@example.com",
      "third@example.com",
    ]);
    expect(filterRecipients("solo@example.com", emailDeliveryPosture({ EMAIL_DELIVERY: "on" }))).toEqual([
      "solo@example.com",
    ]);
  });

  it("allowlist => only the addresses whose lowercased form is allowed", () => {
    const { emailDeliveryPosture, filterRecipients } = freshModule();
    const posture = emailDeliveryPosture({
      EMAIL_DELIVERY: "allowlist",
      EMAIL_ALLOWLIST: "kris@example.com,THIRD@example.com",
    });
    expect(filterRecipients(to, posture)).toEqual(["Kris@Example.com", "third@example.com"]);
    expect(filterRecipients("other@example.com", posture)).toEqual([]);
  });

  // N0 FR1 E11: matching is ASCII-only — Unicode case folding maps the Kelvin sign
  // (U+212A) onto "k", so toLowerCase() would let a lookalike through.
  it("a Kelvin-sign lookalike address does NOT match an ASCII allowlist entry", () => {
    const { emailDeliveryPosture, filterRecipients } = freshModule();
    const posture = emailDeliveryPosture({ EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: "kris@example.com" });
    expect(filterRecipients(["\u212Aris@example.com"], posture)).toEqual([]);
    expect(filterRecipients(["KRIS@example.com"], posture)).toEqual(["KRIS@example.com"]);
  });

  it("a lookalike in the ALLOWLIST does not admit the ASCII address either", () => {
    const { emailDeliveryPosture, filterRecipients } = freshModule();
    const posture = emailDeliveryPosture({
      EMAIL_DELIVERY: "allowlist",
      EMAIL_ALLOWLIST: "\u212Aris@example.com",
    });
    expect(filterRecipients(["kris@example.com"], posture)).toEqual([]);
  });

  it("an address with ANY non-ASCII character never matches, even an identical entry", () => {
    const { emailDeliveryPosture, filterRecipients } = freshModule();
    const posture = emailDeliveryPosture({
      EMAIL_DELIVERY: "allowlist",
      EMAIL_ALLOWLIST: "jos\u00e9@example.com,kris@example.com",
    });
    expect(filterRecipients(["jos\u00e9@example.com", "kris@example.com"], posture)).toEqual([
      "kris@example.com",
    ]);
  });

  it("off => none", () => {
    const { emailDeliveryPosture, filterRecipients } = freshModule();
    expect(filterRecipients(to, emailDeliveryPosture({ EMAIL_DELIVERY: "off" }))).toEqual([]);
    expect(filterRecipients(to, emailDeliveryPosture({}))).toEqual([]);
  });
});

describe("emailProviderConfigured — a boolean, never the key", () => {
  it("true only for a non-empty SENDGRID_API_KEY", () => {
    const { emailProviderConfigured } = freshModule();
    expect(emailProviderConfigured({ SENDGRID_API_KEY: "SG.not-a-real-key" })).toBe(true);
    expect(emailProviderConfigured({ SENDGRID_API_KEY: "" })).toBe(false);
    expect(emailProviderConfigured({})).toBe(false);
  });
});
