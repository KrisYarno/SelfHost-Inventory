/**
 * lib/notifications/delivery-posture.ts — the ONE switch for real email (N0, RC-6).
 *
 * Next-free and dependency-free, like lib/platforms/egress/posture.ts, and
 * fail-closed the same way: any configuration we do not understand EXACTLY means
 * OFF. A prod-dump copy of the database (dev, StagingProduction) holds real
 * people's addresses, so a stack that is not deliberately switched on must never
 * mail anyone.
 *
 * Byte-exactness scope, stated precisely:
 *   - EMAIL_DELIVERY: the whole value is compared byte-for-byte against "on",
 *     "allowlist" and "off". No trim, no lowercase. " on " and "ON" are DIFFERENT
 *     values and are therefore invalid (mode "off", invalidEnv true). Unset is the
 *     intended default: "off", NOT invalid.
 *   - EMAIL_ALLOWLIST: a comma-separated list, read only in "allowlist" mode. Each
 *     entry is trimmed and ASCII-lowercased; empty entries are dropped. An allowlist that
 *     is empty after dropping is invalid (mode "off", invalidEnv true).
 *
 * The env is read on EVERY call (no caching), so a test or an operator always sees
 * the value the process holds now. An invalid value warns ONCE per process, naming
 * the variable and never its value; the posture never carries or logs an address.
 */

type EmailDeliveryMode = "on" | "allowlist" | "off";

interface EmailDeliveryPosture {
  mode: EmailDeliveryMode;
  /** Lowercased addresses; empty unless mode is "allowlist". */
  allowlist: string[];
  /** True when EMAIL_DELIVERY / EMAIL_ALLOWLIST held something we did not understand. */
  invalidEnv: boolean;
  /** WHY invalidEnv is set — variable names / reason codes, never values. */
  invalidReasons: string[];
}

const EMAIL_DELIVERY_ENV = "EMAIL_DELIVERY";
const EMAIL_ALLOWLIST_ENV = "EMAIL_ALLOWLIST";

const VALID_MODES: ReadonlySet<string> = new Set<EmailDeliveryMode>(["on", "allowlist", "off"]);

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

// One warning per process, however many times the posture is read.
let warnedInvalid = false;

// N0 FR1 E11: allowlist matching is ASCII-only. Only A-Z are lowercased (Unicode
// case folding maps lookalikes such as the Kelvin sign U+212A onto "k"), and an
// address carrying ANY non-ASCII character never matches.
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

const NON_ASCII = /[^\x00-\x7f]/;

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => asciiLower(entry.trim()))
    .filter((entry) => entry !== "");
}

/**
 * The effective delivery posture. Fail-closed: an unknown mode, or "allowlist"
 * with no addresses, resolves to "off" with invalidEnv set.
 */
export function emailDeliveryPosture(env: Env = process.env): EmailDeliveryPosture {
  const raw = env[EMAIL_DELIVERY_ENV];
  let posture: EmailDeliveryPosture;

  if (raw === undefined) {
    posture = { mode: "off", allowlist: [], invalidEnv: false, invalidReasons: [] };
  } else if (!VALID_MODES.has(raw)) {
    posture = { mode: "off", allowlist: [], invalidEnv: true, invalidReasons: [EMAIL_DELIVERY_ENV] };
  } else if (raw === "allowlist") {
    const allowlist = parseAllowlist(env[EMAIL_ALLOWLIST_ENV]);
    posture =
      allowlist.length === 0
        ? { mode: "off", allowlist: [], invalidEnv: true, invalidReasons: ["empty_allowlist"] }
        : { mode: "allowlist", allowlist, invalidEnv: false, invalidReasons: [] };
  } else {
    posture = { mode: raw as EmailDeliveryMode, allowlist: [], invalidEnv: false, invalidReasons: [] };
  }

  if (posture.invalidEnv && !warnedInvalid) {
    warnedInvalid = true;
    console.warn(
      `[email] ${EMAIL_DELIVERY_ENV} / ${EMAIL_ALLOWLIST_ENV} not understood ` +
        `(${posture.invalidReasons.join(", ")}); email delivery is OFF`
    );
  }

  return posture;
}

/**
 * The addresses a message may actually go to under `posture`:
 *   - "on"        every non-empty address;
 *   - "allowlist" only ASCII addresses whose ASCII-lowercased form is on the allowlist;
 *   - "off"       none.
 */
export function filterRecipients(to: string | string[], posture: EmailDeliveryPosture): string[] {
  if (posture.mode === "off") return [];
  const addresses = (Array.isArray(to) ? to : [to]).filter((address) => address.trim() !== "");
  if (posture.mode === "on") return addresses;
  const allowed = new Set(posture.allowlist);
  return addresses.filter((address) => !NON_ASCII.test(address) && allowed.has(asciiLower(address)));
}

/**
 * Whether a provider key is configured — a BOOLEAN only; the key itself is never
 * returned, logged, or compared to anything here.
 */
export function emailProviderConfigured(env: Env = process.env): boolean {
  return typeof env.SENDGRID_API_KEY === "string" && env.SENDGRID_API_KEY !== "";
}

// Startup log (X1-10): the mode once at module load, never an address.
console.log(`email delivery: ${emailDeliveryPosture().mode}`);
