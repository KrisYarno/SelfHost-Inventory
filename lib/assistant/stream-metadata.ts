/**
 * lib/assistant/stream-metadata.ts — the chat route's `messageMetadata` rule (assistant
 * A1, contract pack C4b; plan D7; seam S2's producer half).
 *
 * The SDK calls `messageMetadata({ part })` for EVERY stream part
 * (`toUIMessageStream`); what this returns rides to the client — on `start` / `finish`
 * inside that chunk, on any other part as a separate `message-metadata` chunk — and
 * the client MERGES it into the message's metadata. So:
 *  - `start`  → `{ threadId }` (C3: the client reads its thread id off the FIRST
 *    metadata it sees);
 *  - `finish` → `{ finishReason, threadId }` (D-B4: a step-cap stays distinguishable
 *    from a natural completion; the finalizer re-reads finishReason from the persisted
 *    message's metadata, so `finish` must keep carrying it — passed through UNCHANGED,
 *    S3b);
 *  - `abort`  → `{ errorCode: "PROVIDER_TIMEOUT", threadId }` unless the abort was the
 *    user's own Stop. A `null` cause is the SDK's own timeout firing first (it merges
 *    `AbortSignal.timeout` into the signal), which is never the user's doing either —
 *    the same belt `classifyTurn` applies when it persists the turn (threads.ts). This
 *    is how a timeout reaches the LIVE client: it arrives as an `abort` part, never as
 *    a client error.
 *  - anything else → `undefined` (no chunk).
 *
 * The part type name is the SDK's: `TextStreamAbortPart = { type: 'abort'; reason?:
 * string }`, a member of `TextStreamPart` — the type of the `part` the
 * `messageMetadata` callback receives (`node_modules/ai/dist/index.d.ts`, ai 7.0.29).
 *
 * A leaf: its one import is a TYPE (erased) — no `ai`, no prisma — so the A1 wire probe
 * bundles it and drives it through the REAL SDK stream.
 *
 * MUST stay Next-free.
 */

import type { AbortCause } from "@/lib/assistant/threads";

export function turnMessageMetadata(
  part: { type: string; finishReason?: string },
  cause: AbortCause | null,
  threadId: string,
): { threadId: string; finishReason?: string; errorCode?: "PROVIDER_TIMEOUT" } | undefined {
  switch (part.type) {
    case "start":
      return { threadId };
    case "finish":
      return { finishReason: part.finishReason, threadId };
    case "abort":
      return cause === "client" ? undefined : { errorCode: "PROVIDER_TIMEOUT", threadId };
    default:
      return undefined;
  }
}
