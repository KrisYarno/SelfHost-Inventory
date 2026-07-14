/**
 * Lane 6 T1 — posture parsing is the OUTERMOST gate. It is exhaustively tested
 * because every other control is downstream of it.
 *
 * REV-2 #1 (BINDING): byte-exact literals ONLY. "ON", " on ", "Dry-Run", "onn",
 * "true", "" are ALL invalid -> off + red health. The plan's original test table
 * (which accepted case/whitespace variants) is SUPERSEDED — it contradicted
 * fail-closed.
 *
 * REV-2 #2 (BINDING): one unknown/duplicate/malformed capability token poisons
 * the WHOLE allowlist (empty effective set) + invalid flag. Never "keep the good
 * ones".
 */

import {
  parsePosture,
  parseCapabilities,
  readEnvPosture,
  WRITE_CAPABILITIES,
} from "@/lib/platforms/egress/posture";

describe("parsePosture — byte-exact, fail-closed (REV-2 #1)", () => {
  it.each([
    // The three valid literals, byte-exact.
    ["off", "off", false],
    ["on", "on", false],
    ["dry-run", "dry-run", false],
  ])("accepts the exact literal %p -> %p", (raw, expected, invalid) => {
    const r = parsePosture(raw as string);
    expect(r.posture).toBe(expected);
    expect(r.invalid).toBe(invalid);
  });

  it("treats an UNSET var as the safe default (off) WITHOUT flagging invalid", () => {
    // Unset is the intended production posture — it must not turn health red.
    const r = parsePosture(undefined);
    expect(r.posture).toBe("off");
    expect(r.invalid).toBe(false);
  });

  it.each([
    // Case variants — REV-2 #1: NOT accepted.
    ["ON"],
    ["On"],
    ["OFF"],
    ["Dry-Run"],
    ["DRY-RUN"],
    // Whitespace variants — REV-2 #1: NOT accepted.
    [" on "],
    ["on "],
    [" on"],
    ["\ton"],
    ["on\n"],
    ["   "],
    // Empty string — configured but meaningless.
    [""],
    // Typos and truthy-looking values.
    ["onn"],
    ["no"],
    ["true"],
    ["1"],
    ["yes"],
    ["enabled"],
    ["dry run"],
    ["dry_run"],
    ["dryrun"],
    ["on;order_status"],
  ])(
    "REJECTS %p -> off + invalid (any value we do not understand means OFF)",
    (raw) => {
      const r = parsePosture(raw as string);
      expect(r.posture).toBe("off");
      expect(r.invalid).toBe(true);
    }
  );

  it("flags invalid values so health can go red", () => {
    expect(parsePosture("onn").invalid).toBe(true);
    expect(parsePosture("on").invalid).toBe(false);
  });
});

describe("parseCapabilities — one bad token poisons the set (REV-2 #2)", () => {
  it("defaults to an empty set when unset", () => {
    const r = parseCapabilities(undefined);
    expect(r.allowed.size).toBe(0);
    expect(r.invalid).toBe(false);
  });

  it("treats an empty string as an empty (valid) allowlist", () => {
    const r = parseCapabilities("");
    expect(r.allowed.size).toBe(0);
    expect(r.invalid).toBe(false);
  });

  it("accepts the known tokens", () => {
    const r = parseCapabilities("stock_status,order_status");
    expect(Array.from(r.allowed).sort()).toEqual(["order_status", "stock_status"]);
    expect(r.invalid).toBe(false);
  });

  it("tolerates whitespace AROUND list separators (a separator artifact)", () => {
    const r = parseCapabilities("stock_status, order_status");
    expect(Array.from(r.allowed).sort()).toEqual(["order_status", "stock_status"]);
    expect(r.invalid).toBe(false);
  });

  it.each([
    // Unknown token — poisons.
    ["stock_status,bogus"],
    ["bogus"],
    ["stock_status, bogus ,order_status"],
    // Case variant of a known token is NOT a known token — poisons.
    ["Stock_Status"],
    ["STOCK_STATUS,order_status"],
    // Duplicate — poisons (REV-2 #2 names duplicates explicitly).
    ["stock_status,stock_status"],
    // Malformed: empty token from a stray/trailing comma.
    ["stock_status,"],
    [",stock_status"],
    ["stock_status,,order_status"],
    // Wrong separator entirely.
    ["stock_status order_status"],
    ["stock_status;order_status"],
  ])(
    "POISONS the whole allowlist for %p -> empty set + invalid",
    (raw) => {
      const r = parseCapabilities(raw as string);
      expect(r.allowed.size).toBe(0);
      expect(r.invalid).toBe(true);
    }
  );

  it("never keeps 'the good ones' when a sibling token is bad", () => {
    // The exact hazard REV-2 #2 names: a typo'd token must not silently leave
    // order_status enabled.
    const r = parseCapabilities("stock_status,order_statuss");
    expect(r.allowed.has("stock_status")).toBe(false);
    expect(r.allowed.size).toBe(0);
    expect(r.invalid).toBe(true);
  });
});

describe("WRITE_CAPABILITIES registry", () => {
  it("is the runtime source of truth for the capability union", () => {
    expect(Array.from(WRITE_CAPABILITIES).sort()).toEqual([
      "order_status",
      "stock_status",
    ]);
  });
});

describe("readEnvPosture — the composed env view", () => {
  it("is off with an empty allowlist when nothing is set (production default)", () => {
    const r = readEnvPosture({});
    expect(r.posture).toBe("off");
    expect(r.capabilities.size).toBe(0);
    expect(r.invalid).toBe(false);
  });

  it("reports invalid when EITHER var is malformed", () => {
    expect(
      readEnvPosture({ PLATFORM_WRITES: "onn" }).invalid
    ).toBe(true);
    expect(
      readEnvPosture({
        PLATFORM_WRITES: "on",
        PLATFORM_WRITE_CAPABILITIES: "bogus",
      }).invalid
    ).toBe(true);
  });

  it("forces posture off when the capability list is invalid, even if PLATFORM_WRITES=on", () => {
    // Fail-closed composition: a config we do not fully understand is OFF.
    const r = readEnvPosture({
      PLATFORM_WRITES: "on",
      PLATFORM_WRITE_CAPABILITIES: "stock_status,bogus",
    });
    expect(r.posture).toBe("off");
    expect(r.capabilities.size).toBe(0);
    expect(r.invalid).toBe(true);
  });

  it("carries named reasons so healthz can say WHY it is red", () => {
    const r = readEnvPosture({
      PLATFORM_WRITES: "ON",
      PLATFORM_WRITE_CAPABILITIES: "nope",
    });
    expect(r.invalidReasons).toEqual(
      expect.arrayContaining(["PLATFORM_WRITES", "PLATFORM_WRITE_CAPABILITIES"])
    );
  });

  it("resolves the happy path", () => {
    const r = readEnvPosture({
      PLATFORM_WRITES: "on",
      PLATFORM_WRITE_CAPABILITIES: "stock_status",
    });
    expect(r.posture).toBe("on");
    expect(Array.from(r.capabilities)).toEqual(["stock_status"]);
    expect(r.invalid).toBe(false);
  });
});
