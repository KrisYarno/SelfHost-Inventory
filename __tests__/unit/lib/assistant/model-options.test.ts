/**
 * @jest-environment node
 *
 * Assistant A1 (M2a, contract pack C3) — the truth table of the ONE owner of
 * model-call parameters, `lib/assistant/model-options.ts`.
 *
 * No mocks: the module is a dependency-free leaf (its one import is a type). The ids,
 * caps and efforts below are written out literally — a pin, not a mirror of the
 * module's own table.
 */

import {
  ANTHROPIC_DEFAULT_EFFORT,
  CHAT_MAX_OUTPUT_TOKENS,
  TITLE_MAX_OUTPUT_TOKENS,
  anthropicEffortFor,
  modelCallOptions,
  type ModelSurface,
} from "@/lib/assistant/model-options";
import type { ProviderKind } from "@/lib/assistant/providers";

/** The cited table (claude-api skill, cached 2026-10-06), each id -> its API default. */
const TABLE: Record<string, "medium" | "high"> = {
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
};
const TABLE_IDS = Object.keys(TABLE);

/** Not in the table -> no effort. Effort 400s on Sonnet 4.5 / Haiku 4.5; the rest
 *  are near-miss spellings an exact-key lookup must not match (a dated snapshot, a
 *  missing minor, a wrong minor, the empty string) and inherited property names. */
const NOT_IN_TABLE = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-1",
  "claude-haiku-5",
  "claude-opus-5-0",
  "claude-opus-5-5-20260401",
  "",
  "Claude-Opus-5-5",
  " claude-opus-5-5",
  "constructor",
  "toString",
  "__proto__",
  "hasOwnProperty",
];

const SURFACES: ModelSurface[] = ["assistant", "title"];
const NON_ANTHROPIC: ProviderKind[] = ["OPENAI", "GOOGLE", "OLLAMA"];
const CAP: Record<ModelSurface, number> = { assistant: 16000, title: 1024 };

/** True when ANY nested plain object/array of `value` owns `key`. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value as Record<string, unknown>).some((v) => hasKeyDeep(v, key));
}

describe("model-options constants (C3)", () => {
  test("the per-surface caps are 16000 (chat, per step) and 1024 (title)", () => {
    expect(CHAT_MAX_OUTPUT_TOKENS).toBe(16000);
    expect(TITLE_MAX_OUTPUT_TOKENS).toBe(1024);
  });

  test("the effort table is EXACTLY the cited eleven ids with their API defaults", () => {
    expect({ ...ANTHROPIC_DEFAULT_EFFORT }).toEqual(TABLE);
  });

  test("the table cannot be mutated at runtime (a test or caller cannot widen it)", () => {
    expect(Object.isFrozen(ANTHROPIC_DEFAULT_EFFORT)).toBe(true);
  });
});

describe("anthropicEffortFor (C3): exact-key lookup only", () => {
  test.each(TABLE_IDS)("%s: title -> low, assistant -> its API default", (id) => {
    expect(anthropicEffortFor(id, "title")).toBe("low");
    expect(anthropicEffortFor(id, "assistant")).toBe(TABLE[id]);
  });

  test("Opus 5.5 and Haiku 5.5 chat at medium (their default); Opus 5 at high", () => {
    expect(anthropicEffortFor("claude-opus-5-5", "assistant")).toBe("medium");
    expect(anthropicEffortFor("claude-haiku-5-5", "assistant")).toBe("medium");
    expect(anthropicEffortFor("claude-opus-5", "assistant")).toBe("high");
  });

  test.each(NOT_IN_TABLE)("%j is not in the table -> null on both surfaces", (id) => {
    for (const surface of SURFACES) expect(anthropicEffortFor(id, surface)).toBeNull();
  });
});

describe("modelCallOptions (C3)", () => {
  test.each(TABLE_IDS)("ANTHROPIC %s -> the surface cap + exactly { anthropic: { effort } }", (id) => {
    for (const surface of SURFACES) {
      const options = modelCallOptions({ kind: "ANTHROPIC", model: id, surface });
      expect(options).toEqual({
        maxOutputTokens: CAP[surface],
        providerOptions: { anthropic: { effort: surface === "title" ? "low" : TABLE[id] } },
      });
    }
  });

  test.each(NOT_IN_TABLE)("ANTHROPIC %j (not in the table) -> the cap and NO providerOptions key", (id) => {
    for (const surface of SURFACES) {
      const options = modelCallOptions({ kind: "ANTHROPIC", model: id, surface });
      expect(options).toEqual({ maxOutputTokens: CAP[surface] });
      expect(options).not.toHaveProperty("providerOptions");
    }
  });

  test.each(NON_ANTHROPIC)("%s -> the cap and NO providerOptions key, even for a table id", (kind) => {
    for (const surface of SURFACES) {
      for (const model of ["claude-opus-5-5", "gpt-x", "gate-scripted"]) {
        const options = modelCallOptions({ kind, model, surface });
        expect(options).toEqual({ maxOutputTokens: CAP[surface] });
        expect(options).not.toHaveProperty("providerOptions");
      }
    }
  });

  test("no `thinking` and no `fallbacks` key anywhere, for any kind, id or surface", () => {
    const kinds: ProviderKind[] = ["ANTHROPIC", ...NON_ANTHROPIC];
    for (const kind of kinds) {
      for (const model of [...TABLE_IDS, ...NOT_IN_TABLE]) {
        for (const surface of SURFACES) {
          const options = modelCallOptions({ kind, model, surface });
          expect(hasKeyDeep(options, "thinking")).toBe(false);
          expect(hasKeyDeep(options, "fallbacks")).toBe(false);
        }
      }
    }
  });

  test("each call returns a fresh object (a caller mutating one cannot leak into the next)", () => {
    const a = modelCallOptions({ kind: "ANTHROPIC", model: "claude-opus-5-5", surface: "assistant" });
    a.maxOutputTokens = 1;
    a.providerOptions!.anthropic.effort = "low";
    expect(modelCallOptions({ kind: "ANTHROPIC", model: "claude-opus-5-5", surface: "assistant" })).toEqual({
      maxOutputTokens: 16000,
      providerOptions: { anthropic: { effort: "medium" } },
    });
  });
});
