/**
 * lib/platforms/egress — the ONLY way this application may talk to a merchant
 * platform.
 *
 * PUBLIC SURFACE (everything else in this directory is private):
 *   platformRead(integrationId, path, query?)  — GET, read credential, pinned.
 *   pushStockStatus(integrationId, updates)    — the ONLY stock write.
 *   pushOrderStatus(integrationId, id, status) — the ONLY order-status write.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WRITE FUNCTIONS ARE OPERATION-SPECIFIC (REV-2 #4)
 * ---------------------------------------------------------------------------
 * The original design had one `platformWrite(capability, url, method, body)`.
 * That is a confused deputy: a caller with a legitimate `stock_status` capability
 * could hand it an ORDERS url and a `{status:"cancelled"}` body, and the gate —
 * which only checks the capability token — would wave it through. Capability is
 * now IMPLICIT IN THE FUNCTION. There is no argument you can pass to
 * `pushStockStatus` that makes it touch an order.
 *
 * ---------------------------------------------------------------------------
 * THE GATE (spec R-1 "effective rule")
 * ---------------------------------------------------------------------------
 * A write is sent only if ALL of these are true, ANDed, and RE-EVALUATED with a
 * FRESH DB read immediately before EVERY wire attempt (including each retry):
 *
 *   env PLATFORM_WRITES == "on"                (and parses byte-exactly)
 *   capability ∈ env PLATFORM_WRITE_CAPABILITIES
 *   the integration exists AND isActive
 *   the integration is on a platform we can write to
 *   the integration's own flag (stockSyncEnabled / fulfillmentPushEnabled)
 *   a WRITE credential exists
 *   NOT the emergency kill switch
 *
 * Anything else returns a typed `blocked` with a named reason. It never throws,
 * and it never silently succeeds.
 *
 * The gate lives HERE, not in callers. `fulfill/route.ts` used to hold the only
 * `if (fulfillmentPushEnabled)` check in the codebase — deleting that one line
 * passed CI green and would have written to the live store. A call site cannot
 * forget a gate it does not own.
 */

import { createHash } from "node:crypto";

import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { wooCommerceAdapter } from "@/lib/platforms/woocommerce/adapter";

import {
  digestBody,
  finalizeAttempt,
  markSending,
  recordAuthorization,
} from "./audit";
import {
  credentialFingerprint,
  hasWriteCredential,
  resolveFromRow,
} from "./credentials";
import {
  authorizeWireRequest,
  send,
  sendRead,
  type ReadAuth,
  type WireRequestSpec,
} from "./http";
import {
  KILL_SWITCH_KEY,
  parseKillSwitch,
  readEnvPosture,
  type BlockReason,
  type Posture,
  type WriteCapability,
} from "./posture";

export type { BlockReason, WriteCapability } from "./posture";
export { WRITE_CAPABILITIES } from "./posture";

// ---------------------------------------------------------------------------
// Posture surface (D-E5, codex #16) — for healthz + the ops dashboard
// ---------------------------------------------------------------------------

export interface PostureView {
  /** The parsed env posture BEFORE the kill switch is applied. */
  envPosture: Posture;
  capabilities: WriteCapability[];
  /** True when an env value was not understood (fail-closed → off + red). */
  invalidEnv: boolean;
  invalidReasons: string[];
  /** The runtime emergency stop (R-E9). */
  killSwitchEngaged: boolean;
  /**
   * What actually happens right now: "off" | "dry-run" | "on". The kill switch
   * and invalid env can only ever pull this toward "off".
   */
  effective: Posture;
  /** Operator copy for the tile (DESIGN.md). */
  label: string;
  /** true when writes are provably NOT reaching any platform. */
  writesFullyBlocked: boolean;
}

/**
 * The effective posture, resolved the same way the gate resolves it. This is the
 * ONE place healthz and the ops dashboard read from, so "the tile says OFF" and
 * "a write is actually blocked" can never disagree.
 */
export async function getPostureView(): Promise<PostureView> {
  const env = readEnvPosture();
  const killSwitchEngaged = await isKillSwitchEngaged();

  // Fail-closed composition: invalid env OR the kill switch forces off.
  const effective: Posture =
    env.invalid || killSwitchEngaged ? "off" : env.posture;

  const caps = Array.from(env.capabilities);
  return {
    envPosture: env.posture,
    capabilities: caps,
    invalidEnv: env.invalid,
    invalidReasons: env.invalidReasons,
    killSwitchEngaged,
    effective,
    label: postureLabel(effective, env.invalid, killSwitchEngaged, caps),
    writesFullyBlocked: effective !== "on",
  };
}

function postureLabel(
  effective: Posture,
  invalidEnv: boolean,
  killSwitch: boolean,
  caps: WriteCapability[]
): string {
  if (invalidEnv) return "Platform writes: OFF (configuration not understood)";
  if (killSwitch) return "Platform writes: OFF (emergency stop engaged)";
  if (effective === "off") return "Platform writes: OFF";
  if (effective === "dry-run") return "Platform writes: DRY RUN";
  // on
  if (caps.length === 1 && caps[0] === "stock_status") {
    return "Platform writes: ON — stock status only";
  }
  return `Platform writes: ON — ${caps.join(", ") || "no capabilities"}`;
}

// ---------------------------------------------------------------------------
// Result types (REV-2 #23 — exhaustive, so no caller can mistake a failure or an
// unknown outcome for success)
// ---------------------------------------------------------------------------

export type EgressResult =
  | { status: "sent"; httpStatus: number; body: unknown }
  | { status: "blocked"; reason: BlockReason }
  | {
      status: "dry_run";
      wouldSend: { method: string; url: string; body: unknown };
    }
  | {
      status: "failed";
      reason:
        | "transport"
        | "redirect"
        | "outcome_unknown"
        | "http_error"
        | "audit_unavailable";
      httpStatus?: number;
    }
  /** A fan-out (REV-2 #5). Partial success is EXPLICIT, never collapsed to "sent". */
  | { status: "partial"; results: EgressResult[] };

/** The platforms this app is able to write to. Everything else -> wrong_platform. */
const WRITABLE_PLATFORMS = new Set(["WOOCOMMERCE"]);

/** The integration row the gate needs. Read fresh, every attempt. */
const GATE_SELECT = {
  id: true,
  companyId: true,
  name: true,
  platform: true,
  storeUrl: true,
  isActive: true,
  stockSyncEnabled: true,
  fulfillmentPushEnabled: true,
  updatedAt: true,
  encryptedWriteKey: true,
  encryptedWriteSecret: true,
  encryptedReadKey: true,
  encryptedReadSecret: true,
} as const;

type GateRow = {
  id: string;
  companyId: string;
  name: string;
  platform: string;
  storeUrl: string;
  isActive: boolean;
  stockSyncEnabled: boolean;
  fulfillmentPushEnabled: boolean;
  updatedAt: Date;
  encryptedWriteKey: string | null;
  encryptedWriteSecret: string | null;
  encryptedReadKey: string | null;
  encryptedReadSecret: string | null;
};

type GateAllow = {
  decision: "allow" | "dry_run";
  row: GateRow;
  fingerprint: string;
};
type GateBlock = { decision: "block"; reason: BlockReason; row: GateRow | null };
type GateOutcome = GateAllow | GateBlock;

/**
 * Is the emergency stop engaged? (R-E9)
 *
 * Fails CLOSED: if we cannot READ the switch, we treat it as ENGAGED. The switch
 * exists to stop writes in an emergency; "the database is unreachable" is not a
 * moment to start writing to a live store on the assumption that nobody has
 * pulled the cord.
 */
async function isKillSwitchEngaged(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({
      where: { key: KILL_SWITCH_KEY },
      select: { value: true },
    });
    return parseKillSwitch(row?.value ?? null);
  } catch (err) {
    console.error(
      "[egress] could not read the kill switch — treating it as ENGAGED (fail closed)",
      err
    );
    return true;
  }
}

/**
 * The exact configuration an attempt was authorized under (REV-2 #4).
 *
 * DEVIATION FROM THE PLAN, DELIBERATE: REV-2 specifies a monotonically-increasing
 * `configGeneration` counter "bumped by ANY integration/settings write". A content
 * fingerprint is used instead, because a bump-counter is only as good as the
 * discipline of every present and future writer — miss one `prisma.integration.update`
 * and the fence is silently dead, which is precisely the failure mode this lane
 * exists to eliminate. The fingerprint is derived from the gate inputs themselves
 * (including `updatedAt`, which Prisma maintains automatically), so it cannot be
 * forgotten. It is strictly stronger than the counter and needs no cooperation.
 */
function fingerprintConfig(input: {
  posture: string;
  capabilities: string[];
  killSwitch: boolean;
  row: GateRow;
  flag: boolean;
}): string {
  const material = JSON.stringify({
    posture: input.posture,
    capabilities: [...input.capabilities].sort(),
    killSwitch: input.killSwitch,
    isActive: input.row.isActive,
    platform: input.row.platform,
    storeUrl: input.row.storeUrl,
    flag: input.flag,
    updatedAt: input.row.updatedAt.toISOString(),
    credential: credentialFingerprint(input.row),
  });
  return createHash("sha256").update(material).digest("hex");
}

function integrationFlagFor(row: GateRow, capability: WriteCapability): boolean {
  return capability === "stock_status"
    ? row.stockSyncEnabled
    : row.fulfillmentPushEnabled;
}

/**
 * Evaluate every gate, from a FRESH read. Called once per wire attempt — never
 * cached, never hoisted out of a retry loop (REV-2 #10: a flag flipped off
 * mid-flight must stop the retry).
 */
async function evaluateGate(
  integrationId: string,
  capability: WriteCapability
): Promise<GateOutcome> {
  const env = readEnvPosture();

  // Load the row up front so a block can still be AUDITED against a real
  // integration (label/platform/company), even when we block before using it.
  let row: GateRow | null = null;
  try {
    row = (await prisma.integration.findUnique({
      where: { id: integrationId },
      select: GATE_SELECT,
    })) as GateRow | null;
  } catch (err) {
    console.error("[egress] integration read failed — blocking (fail closed)", err);
    return { decision: "block", reason: "integration_inactive", row: null };
  }

  // 1. Env we could not parse means OFF, loudly (REV-2 #1).
  if (env.invalid) return { decision: "block", reason: "invalid_env", row };

  // 2. Master switch.
  if (env.posture === "off") {
    return { decision: "block", reason: "master_off", row };
  }

  // 3. Capability allowlist.
  if (!env.capabilities.has(capability)) {
    return { decision: "block", reason: "capability_not_allowed", row };
  }

  // 4. Emergency stop (R-E9). Can only ever RESTRICT.
  const killSwitch = await isKillSwitchEngaged();
  if (killSwitch) return { decision: "block", reason: "kill_switch", row };

  // 5. Integration identity — BEFORE credentials or URL construction (REV-2 #7).
  if (!row || !row.isActive) {
    return { decision: "block", reason: "integration_inactive", row };
  }
  if (!WRITABLE_PLATFORMS.has(row.platform)) {
    return { decision: "block", reason: "wrong_platform", row };
  }

  // 6. The integration's own flag.
  const flag = integrationFlagFor(row, capability);
  if (!flag) return { decision: "block", reason: "integration_flag_off", row };

  // 7. A write-capable credential must exist (R-E8). Presence only — no decrypt.
  if (!hasWriteCredential(row)) {
    return { decision: "block", reason: "no_write_credential", row };
  }

  const fingerprint = fingerprintConfig({
    posture: env.posture,
    capabilities: Array.from(env.capabilities),
    killSwitch,
    row,
    flag,
  });

  // 8. Dry run: everything passed, we simply do not send (D-E4).
  if (env.posture === "dry-run") {
    return { decision: "dry_run", row, fingerprint };
  }

  return { decision: "allow", row, fingerprint };
}

// ---------------------------------------------------------------------------
// The per-wire-request executor
// ---------------------------------------------------------------------------

type WirePlan =
  | { op: "products_batch"; updates: Array<{ id: string; stock_status: "instock" | "outofstock" }> }
  | {
      op: "variations_batch";
      parentId: string;
      updates: Array<{ id: string; stock_status: "instock" | "outofstock" }>;
    }
  | { op: "order_status"; externalOrderId: string; status: "processing" | "completed" };

function specFor(
  plan: WirePlan,
  row: GateRow,
  credentials: { key: string; secret: string }
): WireRequestSpec {
  switch (plan.op) {
    case "products_batch":
      return {
        op: "products_batch",
        storeUrl: row.storeUrl,
        credentials,
        updates: plan.updates,
      };
    case "variations_batch":
      return {
        op: "variations_batch",
        storeUrl: row.storeUrl,
        credentials,
        parentId: plan.parentId,
        updates: plan.updates,
      };
    case "order_status":
      return {
        op: "order_status",
        storeUrl: row.storeUrl,
        credentials,
        externalOrderId: plan.externalOrderId,
        status: plan.status,
      };
  }
}

/** Describe a plan for the audit row WITHOUT credentials in scope. */
function describeForAudit(plan: WirePlan, storeUrl: string): {
  method: string;
  url: string;
  body: unknown;
} {
  switch (plan.op) {
    case "products_batch":
      return {
        method: "POST",
        url: `${storeUrl}/wp-json/wc/v3/products/batch`,
        body: { update: plan.updates },
      };
    case "variations_batch":
      return {
        method: "POST",
        url: `${storeUrl}/wp-json/wc/v3/products/${plan.parentId}/variations/batch`,
        body: { update: plan.updates },
      };
    case "order_status":
      return {
        method: "PUT",
        url: `${storeUrl}/wp-json/wc/v3/orders/${plan.externalOrderId}`,
        body: { status: plan.status },
      };
  }
}

/**
 * ONE wire request: gate -> audit row -> (fence) -> send -> outcome.
 *
 * Every wire request in a fan-out runs this independently (REV-2 #5): its own
 * gate evaluation, its own authorization row, its own outcome. A 4-batch stock
 * push that gets disabled halfway through stops halfway through.
 */
async function executeWireRequest(
  integrationId: string,
  capability: WriteCapability,
  plan: WirePlan,
  attemptNo: number
): Promise<EgressResult> {
  const gate = await evaluateGate(integrationId, capability);

  // --- Blocked ------------------------------------------------------------
  if (gate.decision === "block") {
    const label = gate.row?.name ?? "(unknown integration)";
    const platform = gate.row?.platform ?? "UNKNOWN";
    const described = describeForAudit(plan, gate.row?.storeUrl ?? "");
    try {
      await recordAuthorization({
        integrationId,
        integrationLabel: label,
        platform,
        companyId: gate.row?.companyId,
        capability,
        method: described.method,
        url: described.url,
        bodyDigest: digestBody(described.body),
        decision: "block",
        blockReason: gate.reason,
        attemptNo,
        // A block was granted under no config; record the reason, not a grant.
        configFingerprint: "0".repeat(64),
      });
    } catch {
      // Even the BLOCK record failed. The write is blocked either way — that is
      // the safe direction — but we must not pretend it was audited.
      console.error(
        "[egress] could not record a BLOCKED attempt; the write was still blocked"
      );
    }
    return { status: "blocked", reason: gate.reason };
  }

  const { row, fingerprint } = gate;
  const described = describeForAudit(plan, row.storeUrl);

  // --- Dry run: zero network I/O -----------------------------------------
  if (gate.decision === "dry_run") {
    try {
      await recordAuthorization({
        integrationId,
        integrationLabel: row.name,
        platform: row.platform,
        companyId: row.companyId,
        capability,
        method: described.method,
        url: described.url,
        bodyDigest: digestBody(described.body),
        decision: "dry_run",
        attemptNo,
        configFingerprint: fingerprint,
      });
    } catch {
      console.error("[egress] could not record a DRY-RUN attempt");
    }
    return {
      status: "dry_run",
      wouldSend: {
        method: described.method,
        url: described.url,
        body: described.body,
      },
    };
  }

  // --- Allowed ------------------------------------------------------------
  // Decrypt only now, and only for a genuinely authorized write.
  const credentials = resolveFromRow(row, "write");
  if (!credentials) {
    // Presence passed the gate but the material would not decrypt.
    return { status: "blocked", reason: "no_write_credential" };
  }

  const authorized = authorizeWireRequest(specFor(plan, row, credentials));
  if (!authorized.ok) {
    // Path-template / id / https rejection. Audit it as a block — this is a
    // refusal, and refusals are exactly what the safety record is for.
    console.error(
      `[egress] refusing ${capability}: ${authorized.reason} — ${authorized.detail}`
    );
    try {
      await recordAuthorization({
        integrationId,
        integrationLabel: row.name,
        platform: row.platform,
        companyId: row.companyId,
        capability,
        method: described.method,
        url: described.url,
        bodyDigest: digestBody(described.body),
        decision: "block",
        blockReason: authorized.reason,
        attemptNo,
        configFingerprint: fingerprint,
      });
    } catch {
      console.error("[egress] could not record an INVALID-TARGET block");
    }
    return { status: "blocked", reason: authorized.reason };
  }

  // THE PRE-SEND ROW. If this throws, NOTHING is sent (codex #13). There is no
  // catch-and-continue here on purpose: a write we cannot account for is a write
  // we do not make.
  let attemptId: number;
  try {
    const rec = await recordAuthorization({
      integrationId,
      integrationLabel: row.name,
      platform: row.platform,
      companyId: row.companyId,
      capability,
      method: described.method,
      url: described.url,
      bodyDigest: digestBody(described.body),
      decision: "allow",
      attemptNo,
      configFingerprint: fingerprint,
    });
    attemptId = rec.attemptId;
  } catch {
    return { status: "failed", reason: "audit_unavailable" };
  }

  // The TOCTOU fence (REV-2 #4). Re-derived from a fresh read as the LAST thing
  // before bytes leave: if the posture, the flag, the kill switch, the store URL,
  // or the credential changed since we were authorized, we abort.
  const fence = async (): Promise<boolean> => {
    const recheck = await evaluateGate(integrationId, capability);
    if (recheck.decision !== "allow") return false;
    return recheck.fingerprint === fingerprint;
  };

  await markSending(attemptId);

  const outcome = await send(authorized.request, fence);

  if (outcome.kind === "fence_failed") {
    await finalizeAttempt(attemptId, "blocked");
    return { status: "blocked", reason: "config_changed" };
  }

  if (outcome.kind === "redirect") {
    await finalizeAttempt(attemptId, "response_received", outcome.httpStatus);
    return { status: "failed", reason: "redirect", httpStatus: outcome.httpStatus };
  }

  if (outcome.kind === "outcome_unknown") {
    // The bytes left; we do not know what the store did. NEVER retried.
    await finalizeAttempt(attemptId, "outcome_unknown");
    return { status: "failed", reason: "outcome_unknown" };
  }

  if (outcome.kind === "transport") {
    await finalizeAttempt(attemptId, "outcome_unknown");
    return { status: "failed", reason: "transport" };
  }

  await finalizeAttempt(attemptId, "response_received", outcome.httpStatus);

  // --- The ONLY retry in the system (REV-2 #6) ---------------------------
  // A RECEIVED 429 is the one signal that unambiguously means "we did nothing,
  // try later". Timeouts and resets do NOT qualify — the store may have applied
  // the write, and retrying could double-apply it. order_status never retries at
  // all, because a repeated status write is a business-visible event.
  if (
    outcome.httpStatus === 429 &&
    capability === "stock_status" &&
    attemptNo === 1
  ) {
    // Honor the store's own backoff when it names one (bounded in http.ts).
    await sleep((outcome.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS) * 1000);
    // Fresh gate, fresh authorization row, fresh credential — a full re-run.
    return executeWireRequest(integrationId, capability, plan, 2);
  }

  if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) {
    return {
      status: "failed",
      reason: "http_error",
      httpStatus: outcome.httpStatus,
    };
  }

  return { status: "sent", httpStatus: outcome.httpStatus, body: outcome.body };
}

/** Used when a 429 carries no (usable) Retry-After header. */
const DEFAULT_RETRY_SECONDS = 5;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// PUBLIC: pushStockStatus
// ---------------------------------------------------------------------------

export interface StockStatusUpdate {
  externalProductId: string;
  externalVariationId?: string;
  inStock: boolean;
}

/**
 * The ONLY function that may change stock status on a platform.
 *
 * Fans out to several wire requests (a simple-product batch plus one batch per
 * variable parent). Each is gated, audited, and reported INDEPENDENTLY — the
 * result is always `partial`, so a caller cannot read "the push succeeded" off a
 * run in which three of four batches were blocked (REV-2 #5).
 */
export async function pushStockStatus(
  integrationId: string,
  updates: StockStatusUpdate[]
): Promise<EgressResult> {
  if (updates.length === 0) {
    return { status: "partial", results: [] };
  }

  // Request shaping is the ADAPTER's job (platform knowledge); deciding whether
  // to send is OURS. The adapter no longer performs any I/O.
  const plans = wooCommerceAdapter.buildStockStatusRequests(updates);

  const results: EgressResult[] = [];
  for (const plan of plans) {
    results.push(
      await executeWireRequest(integrationId, "stock_status", plan, 1)
    );
  }

  return { status: "partial", results };
}

// ---------------------------------------------------------------------------
// PUBLIC: pushOrderStatus
// ---------------------------------------------------------------------------

/**
 * The ONLY function that may change an order's status on a platform.
 *
 * This is the capability the owner is most afraid of, and it is deliberately the
 * most constrained thing in the module: one wire request, no fan-out, NO RETRY
 * under any circumstance, a status restricted to two literals, and an order id
 * that must be canonical decimal or the request is refused before it is built.
 */
export async function pushOrderStatus(
  integrationId: string,
  externalOrderId: string,
  status: "processing" | "completed"
): Promise<EgressResult> {
  return executeWireRequest(
    integrationId,
    "order_status",
    { op: "order_status", externalOrderId, status },
    // attemptNo is pinned at 1 and the retry branch excludes order_status, so
    // this can never re-enter.
    1
  );
}

// ---------------------------------------------------------------------------
// PUBLIC: platformRead
// ---------------------------------------------------------------------------

/**
 * GET against a platform, using the READ credential (R-E8).
 *
 * Every read path in the app goes through here. Because it resolves scope
 * "read", a bug anywhere in the read paths cannot mutate the store — the
 * credential it holds is (once Kris provisions read-only keys) physically
 * incapable of it.
 *
 * Throws AppError on a missing/inactive integration, an unresolvable credential,
 * a non-https store, or a redirect. Callers already handle read failures.
 */
export async function platformRead(
  integrationId: string,
  path: string,
  query?: Record<string, string>,
  options?: { timeoutMs?: number }
): Promise<Response> {
  const row = (await prisma.integration.findUnique({
    where: { id: integrationId },
    select: GATE_SELECT,
  })) as GateRow | null;

  if (!row || !row.isActive) {
    throw new AppError("Integration not found or inactive", "NOT_FOUND", 404);
  }

  const credentials = resolveFromRow(row, "read");
  if (!credentials) {
    throw new AppError(
      "Failed to resolve integration read credentials",
      "CREDENTIAL_ERROR",
      500
    );
  }

  if (credentials.usedWriteFallback) {
    // Migration grace. Health surfaces this; it is not fatal, but it means this
    // read is still holding a write-capable key.
    console.warn(
      `[egress] integration ${integrationId} has no read credential; reads are using the WRITE key. Provision a Woo Read key.`
    );
  }

  const auth: ReadAuth =
    row.platform === "SHOPIFY"
      ? { scheme: "shopify_token", token: credentials.key }
      : { scheme: "basic", key: credentials.key, secret: credentials.secret };

  return sendRead({
    storeUrl: credentials.storeUrl,
    path,
    query,
    auth,
    timeoutMs: options?.timeoutMs,
  });
}

/**
 * The store's host, for callers that need to display or compare it (the webhook
 * source check). Returns null when the integration is unknown.
 *
 * NOT a credential and NOT a way to build a request — `platformRead` is the only
 * way to reach the store.
 */
export async function platformHost(integrationId: string): Promise<string | null> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { storeUrl: true },
  });
  if (!row) return null;
  try {
    return new URL(row.storeUrl).host;
  } catch {
    return null;
  }
}
