/**
 * lib/assistant/thread-contracts.ts — the shared assistant-thread DTO module
 * (contract pack T0, seam S0).
 *
 * The ONE place the thread wire shapes live: the C2 request envelope, the persisted
 * turn metadata, and the thread list/detail responses. The route, the thread routes,
 * the client hook and the launch-gate driver all read them from here, so this module
 * carries TYPES AND ZOD ONLY — no prisma, no `ai`, no Next.
 *
 * The runtime zod limits below are authoritative for envelope SHAPE; they never
 * replace the post-parse asserts that C2 mandates (the serialized MESSAGE_BUDGET_BYTES
 * cap and the control-character rejection live at the route, measured on the same
 * canonical representation as the history budget).
 *
 * MUST stay Next-free.
 */

import { z } from "zod";

/** ai@7.0.29 reports every token field as `number | undefined` — persisted EXACTLY as
 *  reported (undefined -> NULL, never 0-as-measurement; global mechanic G2). */
export type UsageTriple = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
};

/** The single new/last UIMessage the client uploads — validated, never `unknown`
 *  (durable storage demands schema truth). */
export type ValidatedUserMessage = {
  id: string;
  role: "user";
  parts: Array<{ type: "text"; text: string }>;
};

/** The C2 request envelope. `messageId` is SDK-supplied, accepted and UNUSED: the
 *  incoming `message` IS the regenerate anchor (deriving from two sources would let
 *  them disagree). */
export type EnvelopeC2 = {
  threadId: string | null;
  message: ValidatedUserMessage;
  trigger: "submit-message" | "regenerate-message";
  messageId?: string;
};

/** Persisted terminal-turn metadata (`assistant_messages.metadata`) — without it,
 *  every stopped/failed/capped historical turn renders "completed" after a reload. */
export type AssistantMessageMetadata = {
  finishReason?: string;
  aborted?: true;
  errorCode?: "PROVIDER_ERROR" | "TOOL_ERROR" | "STEP_LIMIT" | "PROVIDER_TIMEOUT";
};

export type ThreadMessageDto = {
  id: string;
  role: "user" | "assistant" | "system";
  parts: unknown[];
  metadata: AssistantMessageMetadata | null;
};

export type ThreadDetailResponse = {
  id: string;
  title: string | null;
  messages: ThreadMessageDto[];
  activeRequest: { status: "running" } | null;
};

export type ThreadListResponse = {
  items: Array<{
    id: string;
    title: string | null;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
  }>;
  limit: number;
  offset: number;
  nextOffset: number | null;
};

/** The composer produces text parts only; unknown part types are 400
 *  VALIDATION_ERROR, never stored. The 24_576 character bound is the raw-length
 *  belt — the byte cap is the post-parse assert. */
export const textPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(24_576),
});

export const userMessageSchema = z.object({
  id: z.string().min(1).max(40),
  role: z.literal("user"),
  parts: z.array(textPartSchema).min(1).max(4),
});

/** Plain `z.object` (house rule: the MCP adapter reads `.shape`; cross-field rules
 *  are post-parse `assert*` helpers, never `.refine`). */
export const requestSchema = z.object({
  threadId: z.string().cuid().nullable(),
  message: userMessageSchema,
  trigger: z.enum(["submit-message", "regenerate-message"]).default("submit-message"),
  messageId: z.string().max(40).optional(),
});
