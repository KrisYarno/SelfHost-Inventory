/**
 * lib/assistant/model-options.ts — the ONE owner of model-call parameters (assistant
 * A1, contract pack C3; plan D3, D4, D5).
 *
 * Both model surfaces call this and neither spells a provider option itself: the
 * chat route (`streamText`) and the detached title call (`generateText`). What it
 * returns is the whole story:
 *  - `maxOutputTokens` — the per-surface cap, for EVERY provider (on the chat surface
 *    it applies PER STEP; thinking counts toward it);
 *  - `providerOptions.anthropic.effort` — ONLY for an ANTHROPIC row whose model id is
 *    an exact key of the effort table below; anything else gets no provider options
 *    at all (API defaults).
 *
 * Never sent, by design: `thinking` (review #4 R4-3 — `thinking: { type: "disabled" }`
 * 400s on Opus 5.5 at every effort, which is how every title failed after the Oct 12
 * switch) and `fallbacks` (the refusal fallback is A3's, plan D8).
 *
 * A dependency-free leaf: its one import is a TYPE (erased), so it pulls no `ai`, no
 * prisma and no encryption — the A1 wire probe bundles it as-is.
 *
 * MUST stay Next-free.
 */

import type { ProviderKind } from "@/lib/assistant/providers";

export type ModelSurface = "assistant" | "title";
export type AnthropicEffort = "low" | "medium" | "high";

/** Per step (was 3_072 in the route). Plan D5: 3,072 cut one Opus 5.5 answer in five,
 *  because thinking counts toward it. Cost is dominated by INPUT, not this cap — it
 *  moves only the output tail. */
export const CHAT_MAX_OUTPUT_TOKENS = 16_000;

/** A title is a handful of words; the cap is a COST bound, not a target length (was
 *  256 in titles.ts). With thinking on by default and no `thinking` option allowed,
 *  the title runs adaptive at effort "low" and needs the room. */
export const TITLE_MAX_OUTPUT_TOKENS = 1_024;

/** The application's supported lookup set (not a claim about every API model).
 *  Source: the Claude API reference (claude-api skill, cached 2026-10-06): effort is
 *  supported on these ids; each value is the model's API DEFAULT effort ("high" on
 *  every current model except Opus 5.5 and Haiku 5.5, "medium" there). Effort 400s on
 *  Sonnet 4.5 / Haiku 4.5; ids outside this table get NO effort. */
export const ANTHROPIC_DEFAULT_EFFORT: Readonly<Record<string, "medium" | "high">> = Object.freeze({
  "claude-fable-5-1": "high",
  "claude-fable-5": "high",
  "claude-opus-5-5": "medium",
  "claude-opus-5": "high",
  "claude-opus-4-8": "high",
  "claude-opus-4-7": "high",
  "claude-opus-4-6": "high",
  "claude-sonnet-5-5": "high",
  "claude-sonnet-5": "high",
  "claude-sonnet-4-6": "high",
  "claude-haiku-5-5": "medium",
});

export interface CallOptions {
  maxOutputTokens: number;
  providerOptions?: { anthropic: { effort: AnthropicEffort } };
}

/**
 * The effort to send, or `null` for "send none". EXACT-key lookup only: a dated
 * snapshot id, a typo or an inherited property name ("constructor") is not in the
 * table. The chat surface sends the model's own API default explicitly (so a default
 * change upstream cannot silently move it, R4-5); a title needs no depth and sends
 * "low".
 */
export function anthropicEffortFor(model: string, surface: ModelSurface): AnthropicEffort | null {
  if (!Object.prototype.hasOwnProperty.call(ANTHROPIC_DEFAULT_EFFORT, model)) return null;
  return surface === "title" ? "low" : ANTHROPIC_DEFAULT_EFFORT[model];
}

/** The call parameters for one model call on one surface. */
export function modelCallOptions(input: {
  kind: ProviderKind;
  model: string;
  surface: ModelSurface;
}): CallOptions {
  const maxOutputTokens =
    input.surface === "title" ? TITLE_MAX_OUTPUT_TOKENS : CHAT_MAX_OUTPUT_TOKENS;
  if (input.kind !== "ANTHROPIC") return { maxOutputTokens };
  const effort = anthropicEffortFor(input.model, input.surface);
  if (effort === null) return { maxOutputTokens };
  return { maxOutputTokens, providerOptions: { anthropic: { effort } } };
}
