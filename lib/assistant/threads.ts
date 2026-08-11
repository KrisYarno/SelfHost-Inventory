/**
 * lib/assistant/threads.ts — server-canonical thread persistence (spec C2/C4;
 * contract pack T1/T2, seams S1/S2).
 *
 * The ONE place chat-turn database logic lives: the claim transaction (row lock +
 * ownership + busy assert + stale-claim fence + branch ops + request row), the
 * byte-bounded history load, the FENCED finalize-once writer, and the claim-aware
 * thread delete. The route stays orchestration-only (design D1).
 *
 * Two hard import rules:
 *  - Next-free, like every lib/assistant module.
 *  - `ai`-FREE AT RUNTIME. Spike B imports this module against the real gate
 *    database with no `ai` in its graph, so nothing here may reach providers.ts,
 *    tools.ts or tool-adapters.ts, and the only `ai` reference is a TYPE-ONLY import
 *    of `UIMessage` (erased at compile time). The three time constants therefore
 *    live in ./timing, not in providers.ts.
 */

import type { UIMessage } from "ai";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { AppError } from "@/lib/error-handling";
import {
  CLAIM_STALE_MS,
  FINALIZE_DEADLINE_MS,
  PROVIDER_TIMEOUT_MS,
} from "@/lib/assistant/timing";
import { utcDayKey } from "@/lib/assistant/requests";
import type {
  AssistantMessageMetadata,
  UsageTriple,
  ValidatedUserMessage,
} from "@/lib/assistant/thread-contracts";

/** Serialized byte cap for ONE incoming user message (C2 post-parse assert). */
export const MESSAGE_BUDGET_BYTES = 24_576;

/** Serialized byte cap for the whole model input (96 KiB ~ 24K tokens). */
export const HISTORY_BUDGET_BYTES = 98_304;

/** Turns newer than this keep their full tool outputs; older ones are shed. */
export const SHED_KEEP_TURNS = 4;

/** What a shed tool output is replaced by. Storage is NEVER truncated — only the
 *  model input is. */
export const TOOL_OUTPUT_OMITTED =
  "[tool result omitted from context — full result in thread history]";

/** The system note prepended when earlier turns did not survive the byte bound. */
export const HISTORY_OMISSION_NOTE = "earlier turns omitted (thread continues in history)";

/** Id of that synthetic note. It is never persisted; it exists only in the model
 *  input and in `originalMessages`. */
export const HISTORY_OMISSION_ID = "system-history-omission";

const HISTORY_PAGE_SIZE = 20;

const ASSISTANT_LIKE_ROLES = ["assistant", "system"];

export type AbortCause = "client" | "provider-timeout";

export interface AbortLatch {
  signal: AbortSignal;
  cause(): AbortCause | null;
  armTimers(onDeadline: () => void): void;
  clearTimers(): void;
}

export interface ClaimTurnInput {
  userId: number;
  threadId: string | null;
  message: ValidatedUserMessage;
  trigger: "submit-message" | "regenerate-message";
  membershipScope: string[];
  providerKind: string;
  model: string;
}

export interface ClaimTurnResult {
  threadId: string;
  requestId: number;
  threadWasCreated: boolean;
  supersededMessageIds: string[];
}

export type FinalizeTurnResult =
  | { finalized: false; status: null }
  | { finalized: true; status: "ok" | "aborted" | "error" };

export interface FinalizeTurnInput {
  requestId: number;
  threadId: string;
  message: UIMessage | null;
  cause: AbortCause | null;
  eventAborted: boolean;
  errorLatched: string | null;
  usage: UsageTriple | null;
  durationMs: number;
}

type MessageRow = {
  id: string;
  role: string;
  parts: unknown;
  metadata: unknown;
  sequence: number;
};

/** Existence is never leaked: a thread the caller does not own is simply absent. */
function notFound(): AppError {
  return new AppError("Thread not found", "NOT_FOUND", 404);
}

/**
 * The ONE canonical size measurement, shared by the incoming-message cap and the
 * history budget. A raw-text cap does not bound serialized size (JSON escaping
 * expands control characters ~6x), so both bounds measure the SAME representation.
 */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/**
 * The FIRST-SOURCE abort latch with the spec REV-8 two-timer design.
 *
 * The route passes THIS controller's signal to `streamText`, never `request.signal`
 * directly, so that a provider timeout and a client disconnect are distinguishable
 * after the fact: whichever lands first is latched immutably, and the finalizer reads
 * the latched cause instead of re-reading signals (a timeout followed by a client
 * disconnect must still record PROVIDER_TIMEOUT).
 *
 * T1 (PROVIDER_TIMEOUT_MS) latches "provider-timeout" AND aborts; T2
 * (FINALIZE_DEADLINE_MS) force-runs the caller's finalizer and abandons the blocked
 * read, whose late finalize no-ops on the database fence. An ALREADY-ABORTED
 * requestSignal latches "client" synchronously at construction.
 */
export function createAbortLatch(requestSignal: AbortSignal): AbortLatch {
  const controller = new AbortController();
  let latched: AbortCause | null = null;
  let providerTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const latch = (cause: AbortCause): void => {
    if (latched === null) latched = cause;
  };

  const abortOnce = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };

  const onRequestAbort = (): void => {
    latch("client");
    abortOnce();
  };

  if (requestSignal.aborted) onRequestAbort();
  else requestSignal.addEventListener("abort", onRequestAbort);

  const clearTimers = (): void => {
    requestSignal.removeEventListener("abort", onRequestAbort);
    if (providerTimer !== null) {
      clearTimeout(providerTimer);
      providerTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };

  return {
    signal: controller.signal,
    cause: () => latched,
    armTimers(onDeadline: () => void): void {
      if (providerTimer !== null) clearTimeout(providerTimer);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      providerTimer = setTimeout(() => {
        providerTimer = null;
        latch("provider-timeout");
        abortOnce();
      }, PROVIDER_TIMEOUT_MS);
      deadlineTimer = setTimeout(() => {
        deadlineTimer = null;
        onDeadline();
      }, FINALIZE_DEADLINE_MS);
    },
    clearTimers,
  };
}

/** Next sequence under the claim row lock. */
async function nextSequence(tx: Prisma.TransactionClient, threadId: string): Promise<number> {
  const top = await tx.assistantMessage.aggregate({
    where: { threadId },
    _max: { sequence: true },
  });
  return (top._max.sequence ?? 0) + 1;
}

/**
 * Claim the thread's single active turn (spec C2 step 2) in ONE transaction:
 *
 *   a. UPDATE the thread row — the lock serializes every concurrent writer,
 *      re-checks ownership (0 rows -> 404) and keeps sidebar ordering live.
 *   b. Assert no LIVE turn (a running chat request younger than the lease) -> 409.
 *   c. FENCE every older running row as SUPERSEDED so its zombie stream can never
 *      finalize (C4's database fence).
 *   d. Branch ops (submit inserts; regenerate anchors on the incoming message).
 *   e. INSERT the `running` request row whose id threads into per-tool telemetry.
 *
 * History is loaded AFTER this commits — the claim tx stays tiny on purpose
 * (Prisma's interactive-tx default timeout is 5s and a large thread's JSON inside it
 * is a P2028/memory hazard).
 */
export async function claimTurn(input: ClaimTurnInput): Promise<ClaimTurnResult> {
  const { userId, message, trigger, membershipScope, providerKind, model } = input;
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - CLAIM_STALE_MS);

  return prisma.$transaction(async (tx) => {
    let threadId: string;
    let threadWasCreated = false;

    if (input.threadId === null) {
      const created = await tx.assistantThread.create({
        data: { userId },
        select: { id: true },
      });
      threadId = created.id;
      threadWasCreated = true;
      // A thread created inside THIS transaction cannot have a competing claim or a
      // dead one, so steps (a)-(c) are structurally satisfied.
    } else {
      threadId = input.threadId;

      const locked = await tx.assistantThread.updateMany({
        where: { id: threadId, userId },
        data: { updatedAt: now },
      });
      if (locked.count === 0) throw notFound();

      const live = await tx.assistantRequest.findFirst({
        where: {
          threadId,
          kind: "chat",
          status: "running",
          createdAt: { gt: staleCutoff },
        },
        select: { id: true },
      });
      if (live) {
        throw new AppError(
          "A response is already streaming in this thread",
          "THREAD_BUSY",
          409,
        );
      }

      await tx.assistantRequest.updateMany({
        where: { threadId, kind: "chat", status: "running" },
        data: { status: "error", errorCode: "SUPERSEDED" },
      });
    }

    const supersededMessageIds =
      trigger === "regenerate-message"
        ? await anchorRegenerate(tx, threadId, message)
        : await insertSubmittedMessage(tx, threadId, message);

    const request = await tx.assistantRequest.create({
      data: {
        threadId,
        userId,
        kind: "chat",
        providerKind,
        model,
        status: "running",
        membershipScope: membershipScope as Prisma.InputJsonValue,
        dayKey: utcDayKey(now),
      },
      select: { id: true },
    });

    return { threadId, requestId: request.id, threadWasCreated, supersededMessageIds };
  });
}

/** submit-message: append the client-supplied user row; a duplicate id in THIS
 *  thread is a real conflict (ids are per-thread — no cross-thread oracle). */
async function insertSubmittedMessage(
  tx: Prisma.TransactionClient,
  threadId: string,
  message: ValidatedUserMessage,
): Promise<string[]> {
  const existing = await tx.assistantMessage.findUnique({
    where: { threadId_id: { threadId, id: message.id } },
    select: { sequence: true },
  });
  if (existing) {
    throw new AppError("Message id already used in this thread", "CONFLICT", 409);
  }

  await tx.assistantMessage.create({
    data: {
      threadId,
      id: message.id,
      role: "user",
      parts: message.parts as unknown as Prisma.InputJsonValue,
      sequence: await nextSequence(tx, threadId),
    },
  });
  return [];
}

/**
 * regenerate-message (spec C4's ONE anchor rule): the anchor is ALWAYS the incoming
 * user message's row — idempotent when already persisted, inserted when genuinely
 * new (the failed-submit retry). A newer USER row means another tab advanced the
 * thread: 409 rather than a silent fork. The conflict check runs BEFORE the delete so
 * the outcome does not depend on transaction rollback.
 */
async function anchorRegenerate(
  tx: Prisma.TransactionClient,
  threadId: string,
  message: ValidatedUserMessage,
): Promise<string[]> {
  const anchor = await tx.assistantMessage.findUnique({
    where: { threadId_id: { threadId, id: message.id } },
    select: { sequence: true },
  });

  if (!anchor) {
    await tx.assistantMessage.create({
      data: {
        threadId,
        id: message.id,
        role: "user",
        parts: message.parts as unknown as Prisma.InputJsonValue,
        sequence: await nextSequence(tx, threadId),
      },
    });
    return [];
  }

  const newer = await tx.assistantMessage.findFirst({
    where: { threadId, role: "user", sequence: { gt: anchor.sequence } },
    select: { id: true },
  });
  if (newer) throw new AppError("Thread advanced — reload", "CONFLICT", 409);

  const superseded = await tx.assistantMessage.findMany({
    where: {
      threadId,
      role: { in: ASSISTANT_LIKE_ROLES },
      sequence: { gt: anchor.sequence },
    },
    select: { id: true },
  });
  if (superseded.length === 0) return [];

  await tx.assistantMessage.deleteMany({
    where: {
      threadId,
      role: { in: ASSISTANT_LIKE_ROLES },
      sequence: { gt: anchor.sequence },
    },
  });
  return superseded.map((row) => row.id);
}

/**
 * The bounded model input (spec C2 step 3), loaded AFTER the claim tx commits and
 * ownership-checked like everything else.
 *
 * Tail-paged by sequence DESC so the whole thread is never in memory; tool OUTPUTS
 * are shed outside the last SHED_KEEP_TURNS turns; then whole OLDEST turns drop until
 * the SERIALIZED history fits HISTORY_BUDGET_BYTES. The current turn is never
 * dropped (MESSAGE_BUDGET_BYTES plus headroom guarantees it fits), and when earlier
 * turns are missing a system note says so. Storage is never truncated.
 */
export async function loadBoundedHistory(userId: number, threadId: string): Promise<UIMessage[]> {
  const owned = await prisma.assistantThread.findFirst({
    where: { id: threadId, userId },
    select: { id: true },
  });
  if (!owned) throw notFound();

  const rows: MessageRow[] = [];
  let cursor: number | null = null;
  let reachedStart = false;

  for (;;) {
    const page: MessageRow[] = await prisma.assistantMessage.findMany({
      where: { threadId, ...(cursor === null ? {} : { sequence: { lt: cursor } }) },
      orderBy: { sequence: "desc" },
      take: HISTORY_PAGE_SIZE,
      select: { id: true, role: true, parts: true, metadata: true, sequence: true },
    });
    rows.push(...page);

    if (page.length < HISTORY_PAGE_SIZE) {
      reachedStart = true;
      break;
    }
    cursor = page[page.length - 1].sequence;

    if (serializedBytes(rows) > HISTORY_BUDGET_BYTES) {
      // Stop paging once the RAW load already exceeds the budget; shedding and turn
      // dropping only shrink it from here. One cheap probe keeps the omission note
      // truthful rather than assumed.
      const earlier = await prisma.assistantMessage.findFirst({
        where: { threadId, sequence: { lt: cursor } },
        select: { sequence: true },
      });
      reachedStart = earlier === null;
      break;
    }
  }

  rows.reverse();

  const turns = groupIntoTurns(rows);
  const shedBefore = Math.max(0, turns.length - SHED_KEEP_TURNS);
  let kept = turns.map((turn, index) => (index < shedBefore ? turn.map(shedToolOutputs) : turn));

  let droppedTurns = 0;
  while (kept.length > 1 && serializedBytes(toMessages(kept)) > HISTORY_BUDGET_BYTES) {
    kept = kept.slice(1);
    droppedTurns += 1;
  }

  const messages = toMessages(kept);
  if (droppedTurns > 0 || !reachedStart) {
    messages.unshift({
      id: HISTORY_OMISSION_ID,
      role: "system",
      parts: [{ type: "text", text: HISTORY_OMISSION_NOTE }],
    });
  }
  return messages;
}

/** A turn starts at each user message; anything before the first one is its own
 *  leading turn. */
function groupIntoTurns(rows: MessageRow[]): MessageRow[][] {
  const turns: MessageRow[][] = [];
  let current: MessageRow[] | null = null;
  for (const row of rows) {
    if (current === null || row.role === "user") {
      current = [];
      turns.push(current);
    }
    current.push(row);
  }
  return turns;
}

function isToolPart(part: unknown): part is Record<string, unknown> {
  if (typeof part !== "object" || part === null) return false;
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
}

/** Replace resolved tool OUTPUTS with the one-line marker; one turn can carry 128 KiB
 *  of them, which is what makes a message-count bound meaningless. */
function shedToolOutputs(row: MessageRow): MessageRow {
  if (!Array.isArray(row.parts)) return row;
  let changed = false;
  const parts = (row.parts as unknown[]).map((part) => {
    if (isToolPart(part) && part.state === "output-available") {
      changed = true;
      return { ...part, output: TOOL_OUTPUT_OMITTED };
    }
    return part;
  });
  return changed ? { ...row, parts } : row;
}

function toMessages(turns: MessageRow[][]): UIMessage[] {
  return turns.flat().map((row) => {
    const message: UIMessage = {
      id: row.id,
      role: row.role as UIMessage["role"],
      parts: (Array.isArray(row.parts) ? row.parts : []) as UIMessage["parts"],
    };
    if (row.metadata !== null && row.metadata !== undefined) message.metadata = row.metadata;
    return message;
  });
}

/** An incomplete tool call re-sent as history becomes a dangling `tool_use` and the
 *  provider 400s forever — the thread would be permanently bricked. */
function sanitizeParts(parts: unknown[]): unknown[] {
  return parts.filter((part) => {
    if (!isToolPart(part)) return true;
    return part.state !== "input-streaming" && part.state !== "input-available";
  });
}

/** Run on the SANITIZED parts, never the raw ones: the SDK pushes a `step-start`
 *  part before any content, and a step-only message is visually empty. */
function hasMeaningfulContent(parts: unknown[]): boolean {
  return parts.some((part) => {
    if (typeof part !== "object" || part === null) return false;
    const typed = part as { type?: unknown; text?: unknown; state?: unknown };
    if (typed.type === "text") return typeof typed.text === "string" && typed.text.trim() !== "";
    if (!isToolPart(part)) return false;
    return (
      typed.state === "output-available" ||
      typed.state === "output-error" ||
      typed.state === "output-denied"
    );
  });
}

function classifyTurn(input: FinalizeTurnInput): {
  status: "ok" | "aborted" | "error";
  errorCode: string | null;
} {
  if (input.cause === "client") return { status: "aborted", errorCode: null };
  // Belt: an SDK-internal abort with no client signal is never the user's doing.
  if (input.cause === "provider-timeout" || input.eventAborted) {
    return { status: "error", errorCode: "PROVIDER_TIMEOUT" };
  }
  if (input.errorLatched) return { status: "error", errorCode: input.errorLatched };
  return { status: "ok", errorCode: null };
}

function buildMessageMetadata(
  message: UIMessage,
  status: "ok" | "aborted" | "error",
  errorCode: string | null,
): AssistantMessageMetadata | undefined {
  const metadata: AssistantMessageMetadata = {};
  const incoming = message.metadata as { finishReason?: unknown } | null | undefined;
  if (incoming && typeof incoming.finishReason === "string") {
    metadata.finishReason = incoming.finishReason;
  }
  if (status === "aborted") metadata.aborted = true;
  if (errorCode !== null) metadata.errorCode = errorCode as AssistantMessageMetadata["errorCode"];
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * The idempotent, FENCED finalizer (spec C4). The transaction's FIRST statement is
 * the request-row update `WHERE id = <mine> AND status = "running"`: 0 rows means a
 * later claim SUPERSEDED this request and the ENTIRE finalize aborts — no assistant
 * insert, no thread touch — so a zombie stream can never append stale output.
 *
 * Then: sanitize -> meaningful-content predicate on the SANITIZED parts -> persist or
 * skip -> touch the thread. If the transaction fails (the narrow crash-window case
 * where the thread was deleted between C5's lock release and this tx, FK-breaking the
 * assistant insert), the request row is finalized ALONE — a phantom `running` row is
 * worse than a missing message.
 */
export async function finalizeTurn(input: FinalizeTurnInput): Promise<FinalizeTurnResult> {
  const { status, errorCode } = classifyTurn(input);
  const requestData = {
    status,
    errorCode,
    inputTokens: input.usage?.inputTokens ?? null,
    outputTokens: input.usage?.outputTokens ?? null,
    totalTokens: input.usage?.totalTokens ?? null,
    durationMs: input.durationMs,
  };

  try {
    return await prisma.$transaction(async (tx): Promise<FinalizeTurnResult> => {
      const fenced = await tx.assistantRequest.updateMany({
        where: { id: input.requestId, status: "running" },
        data: requestData,
      });
      if (fenced.count === 0) return { finalized: false, status: null };

      if (input.message) {
        const parts = sanitizeParts(
          Array.isArray(input.message.parts) ? (input.message.parts as unknown[]) : [],
        );
        if (hasMeaningfulContent(parts)) {
          await tx.assistantMessage.create({
            data: {
              threadId: input.threadId,
              id: input.message.id,
              role: "assistant",
              parts: parts as Prisma.InputJsonValue,
              metadata: buildMessageMetadata(input.message, status, errorCode) as
                | Prisma.InputJsonValue
                | undefined,
              sequence: await nextSequence(tx, input.threadId),
            },
          });
        }
      }

      await tx.assistantThread.updateMany({
        where: { id: input.threadId },
        data: { updatedAt: new Date() },
      });

      return { finalized: true, status };
    });
  } catch (err) {
    console.error(
      "[assistant-threads] finalize transaction failed; finalizing the request row alone",
      err,
    );
    const alone = await prisma.assistantRequest.updateMany({
      where: { id: input.requestId, status: "running" },
      data: requestData,
    });
    if (alone.count === 0) return { finalized: false, status: null };
    return { finalized: true, status };
  }
}

/**
 * DELETE takes the SAME claim lock (spec C5): an unguarded delete during a live
 * stream FK-breaks the finalizer's assistant insert and strands the request
 * `running`. Messages then Cascade; requests SetNull, so usage attribution survives.
 */
export async function deleteThreadGuarded(userId: number, threadId: string): Promise<void> {
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - CLAIM_STALE_MS);

  await prisma.$transaction(async (tx) => {
    const locked = await tx.assistantThread.updateMany({
      where: { id: threadId, userId },
      data: { updatedAt: now },
    });
    if (locked.count === 0) throw notFound();

    const live = await tx.assistantRequest.findFirst({
      where: { threadId, kind: "chat", status: "running", createdAt: { gt: staleCutoff } },
      select: { id: true },
    });
    if (live) throw new AppError("Stop the response first", "THREAD_BUSY", 409);

    await tx.assistantThread.delete({ where: { id: threadId } });
  });
}
