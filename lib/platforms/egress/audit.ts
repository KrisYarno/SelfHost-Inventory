/**
 * lib/platforms/egress/audit.ts — the row that must exist before any byte leaves.
 *
 * PRIVATE to lib/platforms/egress/. Not exported from the package barrel.
 *
 * THE INVARIANT (codex #13): a platform write is authorized by a COMMITTED DB
 * row, written before the request is issued. If that row cannot be written, the
 * write does not happen. This is the difference between "we think we only sent
 * what we meant to" and "here is the list of everything we ever attempted".
 *
 * State machine (REV-2 #22) — a nullable outcome column cannot answer the first
 * question anyone asks after an incident ("did it actually go out?"):
 *
 *   blocked           terminal. The gate refused. No bytes.
 *   dry_run           terminal. Posture is dry-run. No bytes.
 *   authorized        the gate allowed it; the request has NOT been issued yet.
 *                     A row stuck here = we died before/at the send.
 *   sent              fetch() was invoked. Bytes may have left. Outcome unknown.
 *                     A row stuck here = we died after the send.
 *   response_received we have an HTTP status. The definitive outcome.
 *   outcome_unknown   the request left but the response was lost (timeout, reset).
 *                     NOT the same as a failure — the store may have applied it.
 */

import { createHash } from "node:crypto";

import { recordIngestion } from "@/lib/change-tracking";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";

import type { BlockReason, WriteCapability } from "./posture";

export const ATTEMPT_STATES = [
  "authorized",
  "sent",
  "response_received",
  "outcome_unknown",
  "blocked",
  "dry_run",
] as const;

export type AttemptState = (typeof ATTEMPT_STATES)[number];

export type AttemptDecision = "allow" | "block" | "dry_run";

/**
 * Terminal state implied by a decision. `allow` is the only decision that leaves
 * the row open (the request has yet to be issued).
 */
const INITIAL_STATE: Record<AttemptDecision, AttemptState> = {
  allow: "authorized",
  block: "blocked",
  dry_run: "dry_run",
};

export interface AuthorizationInput {
  integrationId: string;
  /** Denormalized so the record survives integration deletion (REV-2 #21). */
  integrationLabel: string;
  platform: string;
  companyId?: string | null;
  capability: WriteCapability;
  method: string;
  url: string;
  /** sha256 of the body. The body itself is NEVER persisted. */
  bodyDigest: string;
  decision: AttemptDecision;
  blockReason?: BlockReason;
  /** 1 = first attempt, 2 = the single permitted 429 retry (REV-2 #6). */
  attemptNo?: number;
  /** The exact config this attempt was granted under (REV-2 #4 fence). */
  configFingerprint: string;
}

/**
 * Stable sha256 of a request body. We record WHAT we would have sent without
 * ever writing credentials, PII, or payload contents into a long-lived table.
 */
export function digestBody(body: unknown): string {
  const serialized = body === undefined ? "" : JSON.stringify(body) ?? "";
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Writes and COMMITS the authorization row.
 *
 * THROWS if the row cannot be written. The caller MUST treat a throw as
 * "do not send" — that is the whole point (codex #13). Do not add a try/catch
 * at a call site that then proceeds to fetch.
 */
export async function recordAuthorization(
  input: AuthorizationInput
): Promise<{ attemptId: number }> {
  const state = INITIAL_STATE[input.decision];

  let attempt: { id: number };
  try {
    attempt = await prisma.platformWriteAttempt.create({
      data: {
        integrationId: input.integrationId,
        integrationLabel: input.integrationLabel,
        platform: input.platform,
        capability: input.capability,
        method: input.method,
        url: input.url,
        bodyDigest: input.bodyDigest,
        decision: input.decision,
        blockReason: input.blockReason ?? null,
        state,
        attemptNo: input.attemptNo ?? 1,
        configFingerprint: input.configFingerprint,
      },
      select: { id: true },
    });
  } catch (err) {
    // Fail closed. The caller blocks the send.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      "[egress] FAILED to commit the pre-send authorization row — the write will be REFUSED.",
      message
    );
    throw new AppError(
      "Could not record the platform-write authorization; the write was refused",
      "EGRESS_AUDIT_UNAVAILABLE",
      503
    );
  }

  // Human-facing surface of the same fact (D-E5). Best-effort BY DESIGN: the
  // hard record above is already committed, and an activity-feed outage must
  // neither block a legitimate write nor — more importantly — cause us to
  // believe nothing was recorded when the safety row exists.
  await recordIngestion({
    actor: { kind: "SYSTEM" },
    actionType: "PLATFORM_WRITE_ATTEMPT",
    entityType: "INTEGRATION",
    entityId: input.integrationId,
    companyId: input.companyId ?? undefined,
    action: describeAttempt(input),
    details: {
      attemptId: attempt.id,
      capability: input.capability,
      decision: input.decision,
      blockReason: input.blockReason ?? null,
      method: input.method,
      url: input.url,
      attemptNo: input.attemptNo ?? 1,
      state,
    },
  }).catch((err) => {
    // recordIngestion already swallows its own errors; this guards against a
    // mock/impl that rejects. Never let it surface as an authorization failure.
    console.error("[egress] attempt change-event failed (row is committed)", err);
    return false;
  });

  return { attemptId: attempt.id };
}

function describeAttempt(input: AuthorizationInput): string {
  const target = `${input.capability} on "${input.integrationLabel}"`;
  switch (input.decision) {
    case "allow":
      return `Authorized platform write: ${target}`;
    case "dry_run":
      return `Dry-run platform write (nothing sent): ${target}`;
    case "block":
      return `BLOCKED platform write (${input.blockReason ?? "unknown"}): ${target}`;
  }
}

/**
 * authorized -> sent. Called immediately BEFORE the wire call, so that a row
 * left at `authorized` provably means no bytes left, and a row left at `sent`
 * means they may have.
 *
 * NEVER throws: the hard guarantee (a committed authorization row) is already
 * satisfied by this point. Aborting a legitimate, fully-gated write because a
 * bookkeeping UPDATE blipped would trade a real business action for forensic
 * precision we still partially retain.
 */
export async function markSending(attemptId: number): Promise<void> {
  try {
    await prisma.platformWriteAttempt.update({
      where: { id: attemptId },
      data: { state: "sent" },
    });
  } catch (err) {
    console.error(
      `[egress] could not mark attempt ${attemptId} as sent (proceeding — the authorization row is committed)`,
      err
    );
  }
}

/**
 * Records the definitive outcome. NEVER throws — a post-flight bookkeeping
 * failure must not mask the actual result from the caller.
 */
export async function finalizeAttempt(
  attemptId: number,
  state: Extract<
    AttemptState,
    "response_received" | "outcome_unknown" | "blocked"
  >,
  httpStatus?: number
): Promise<void> {
  try {
    await prisma.platformWriteAttempt.update({
      where: { id: attemptId },
      data: { state, httpStatus },
    });
  } catch (err) {
    console.error(
      `[egress] could not finalize attempt ${attemptId} -> ${state}`,
      err
    );
  }
}
