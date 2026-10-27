/**
 * lib/assistant/stream-errors.ts — which errors the chat route's UI-stream `onError`
 * must NOT treat as a failed turn (assistant A1, contract pack C12 REV 11; A1-FD3-1).
 *
 * The SDK calls that `onError` for a tool call it REJECTED as well as for real stream
 * failures, and for ONE rejected call it calls it TWICE (ai 7.0.29):
 *  - with the error INSTANCE, for the `tool-input-error` part
 *    (`node_modules/ai/dist/index.js:7335-7345`: `errorText: onError(part.error)`);
 *  - with its STRING form, for the paired `tool-output-error` part (`:7394-7399`).
 *    The producer (`:8232-8242`) sets that part's `error` to
 *    `getErrorMessage(toolCall.error)`, which for an Error is `error.toString()`
 *    (`@ai-sdk/provider/dist/index.js:91-102`) — `"<name>: <message>"`, e.g.
 *    `"AI_NoSuchToolError: Model tried to call unavailable tool 'x'. …"`.
 * The model reads the rejection and can recover in its next step, so both calls are a
 * recovered tool call, never a failed turn. Only the two rejection classes count
 * (unknown tool, input that fails the tool's schema); a provider failure never
 * reaches `onError` as a string carrying those names.
 *
 * Imports only from `ai` (the two classes' `isInstance`, the SDK's own marker check),
 * so the A1 wire probe bundles it with `ai` external and runs it against the REAL SDK.
 *
 * MUST stay Next-free.
 */

import { InvalidToolInputError, NoSuchToolError } from "ai";

/** The SDK's stringification of exactly the two rejection classes (`error.toString()`). */
const RECOVERED_TOOL_CALL_PREFIXES = ["AI_InvalidToolInputError: ", "AI_NoSuchToolError: "];

/**
 * True for a tool call the SDK rejected — an `InvalidToolInputError` /
 * `NoSuchToolError` instance, or the string the SDK makes of one — and false for
 * everything else.
 */
export function isRecoveredToolCallError(error: unknown): boolean {
  if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) return true;
  return typeof error === "string" && RECOVERED_TOOL_CALL_PREFIXES.some((prefix) => error.startsWith(prefix));
}
