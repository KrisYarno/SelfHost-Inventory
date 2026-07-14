/**
 * lib/platforms/egress/posture.ts — the OUTERMOST gate (Lane 6 T1).
 *
 * Pure, dependency-free, fail-closed env parsing. Everything downstream of this
 * module trusts its output, so it is exhaustively tested.
 *
 * THE RULE (spec REV-2 #1/#2, BINDING): any configuration we do not understand
 * EXACTLY means OFF. There is no "did they mean 'on'?" — a store owner's live
 * order statuses are on the other side of this parse. A typo must fail closed
 * and turn health red, never fail open and guess.
 *
 * Byte-exactness scope, stated precisely:
 *   - PLATFORM_WRITES: the whole value is compared byte-for-byte against the
 *     three literals. No trim, no lowercase. " on " is a DIFFERENT value and is
 *     therefore invalid.
 *   - PLATFORM_WRITE_CAPABILITIES: a comma-separated LIST. Whitespace around a
 *     comma is a separator artifact and is stripped; each resulting TOKEN is
 *     then matched byte-exactly. "Stock_Status" is not a known token and poisons
 *     the set.
 */

// ---------------------------------------------------------------------------
// Capability registry (codex #12 — a runtime registry, not just a type)
// ---------------------------------------------------------------------------

export const WRITE_CAPABILITIES = ["stock_status", "order_status"] as const;

export type WriteCapability = (typeof WRITE_CAPABILITIES)[number];

const WRITE_CAPABILITY_SET: ReadonlySet<string> = new Set(WRITE_CAPABILITIES);

export function isWriteCapability(value: string): value is WriteCapability {
  return WRITE_CAPABILITY_SET.has(value);
}

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

export type Posture = "off" | "dry-run" | "on";

/**
 * The exhaustive reason set for a refused write. Every member is asserted in the
 * gate matrix (`egress-gates.test.ts`) for BOTH capabilities.
 */
export type BlockReason =
  /** PLATFORM_WRITES is not "on". */
  | "master_off"
  /** The capability is not in PLATFORM_WRITE_CAPABILITIES. */
  | "capability_not_allowed"
  /** The integration's own stockSyncEnabled / fulfillmentPushEnabled is false. */
  | "integration_flag_off"
  /** No write-capable credential is provisioned (R-E8). */
  | "no_write_credential"
  /** The SystemSetting emergency stop is engaged (R-E9). */
  | "kill_switch"
  /** An env value we could not parse. Fail-closed + red health (REV-2 #1). */
  | "invalid_env"
  /** Integration missing or isActive=false (REV-2 #7). */
  | "integration_inactive"
  /** The integration is not on a platform we can write to (REV-2 #7). */
  | "wrong_platform"
  /** Path-template / external-id / body validation failed (REV-2 #3). */
  | "invalid_target"
  /** The store URL is not https:. Never upgraded, always blocked (REV-2 #8). */
  | "insecure_store_url"
  /** Config changed between authorization and send — TOCTOU fence (REV-2 #4). */
  | "config_changed";

const VALID_POSTURES: ReadonlySet<string> = new Set<Posture>([
  "off",
  "dry-run",
  "on",
]);

/**
 * Parses PLATFORM_WRITES.
 *
 * ANY value other than the exact literals "off" | "dry-run" | "on" resolves to
 * "off" and sets invalid=true. An UNSET variable is the intended production
 * default: "off", invalid=false (it must not turn health red).
 */
export function parsePosture(raw: string | undefined | null): {
  posture: Posture;
  invalid: boolean;
} {
  // Unset (never configured) is the safe default, not a misconfiguration.
  if (raw === undefined || raw === null) {
    return { posture: "off", invalid: false };
  }

  // Byte-exact. Deliberately NO trim and NO case folding (REV-2 #1).
  if (VALID_POSTURES.has(raw)) {
    return { posture: raw as Posture, invalid: false };
  }

  return { posture: "off", invalid: true };
}

/**
 * Parses PLATFORM_WRITE_CAPABILITIES (a comma-separated list).
 *
 * REV-2 #2: unknown, duplicate, or malformed (empty) tokens poison the ENTIRE
 * allowlist — the effective set becomes empty and invalid is set. We never
 * "keep the good ones": a typo in one token must not silently leave the other
 * capability enabled.
 */
export function parseCapabilities(raw: string | undefined | null): {
  allowed: Set<WriteCapability>;
  invalid: boolean;
} {
  if (raw === undefined || raw === null) {
    return { allowed: new Set(), invalid: false };
  }

  // A configured-but-empty list is a legitimate "no capabilities".
  if (raw === "") {
    return { allowed: new Set(), invalid: false };
  }

  const tokens = raw.split(",").map((t) => t.trim());
  const allowed = new Set<WriteCapability>();

  for (const token of tokens) {
    // Empty token (stray/trailing comma) is malformed.
    if (token === "") {
      return { allowed: new Set(), invalid: true };
    }
    // Unknown token (incl. any case variant of a known one).
    if (!isWriteCapability(token)) {
      return { allowed: new Set(), invalid: true };
    }
    // Duplicate token.
    if (allowed.has(token)) {
      return { allowed: new Set(), invalid: true };
    }
    allowed.add(token);
  }

  return { allowed, invalid: false };
}

// ---------------------------------------------------------------------------
// Composed env view
// ---------------------------------------------------------------------------

export interface EnvPosture {
  posture: Posture;
  capabilities: Set<WriteCapability>;
  /** True when ANY env value was not understood. Drives the red health signal. */
  invalid: boolean;
  /** Which variables were not understood — so healthz can say WHY. */
  invalidReasons: string[];
}

export const PLATFORM_WRITES_ENV = "PLATFORM_WRITES";
export const PLATFORM_WRITE_CAPABILITIES_ENV = "PLATFORM_WRITE_CAPABILITIES";

/**
 * The composed, fail-closed env view.
 *
 * Composition rule: if EITHER variable is invalid, the effective posture is
 * "off" and the effective allowlist is EMPTY. A configuration we only partially
 * understand is not a configuration we may write under.
 */
export function readEnvPosture(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): EnvPosture {
  const posture = parsePosture(env[PLATFORM_WRITES_ENV]);
  const capabilities = parseCapabilities(env[PLATFORM_WRITE_CAPABILITIES_ENV]);

  const invalidReasons: string[] = [];
  if (posture.invalid) invalidReasons.push(PLATFORM_WRITES_ENV);
  if (capabilities.invalid) invalidReasons.push(PLATFORM_WRITE_CAPABILITIES_ENV);

  const invalid = invalidReasons.length > 0;

  if (invalid) {
    return {
      posture: "off",
      capabilities: new Set(),
      invalid: true,
      invalidReasons,
    };
  }

  return {
    posture: posture.posture,
    capabilities: capabilities.allowed,
    invalid: false,
    invalidReasons,
  };
}

// ---------------------------------------------------------------------------
// Emergency stop (R-E9) — the runtime lever, no redeploy
// ---------------------------------------------------------------------------

/**
 * SystemSetting key for the emergency stop. `"true"` (exactly) blocks every
 * platform write. Anything else — including a missing row — is "not engaged".
 *
 * Note the asymmetry, and that it is deliberate: the kill switch can only ever
 * make the posture MORE restrictive. A DB read failure must therefore be treated
 * as ENGAGED (see isKillSwitchEngaged) — if we cannot prove the emergency stop
 * is off, we do not write.
 */
export const KILL_SWITCH_KEY = "platformWritesKillSwitch";

/** Interpret a raw SystemSetting value. Only the exact string "true" engages. */
export function parseKillSwitch(value: string | null | undefined): boolean {
  return value === "true";
}
