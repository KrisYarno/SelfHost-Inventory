/**
 * launch-gate/choreography.ts — the executable scenario schema (contract pack T8,
 * spec C7 topology item 3; seam S8).
 *
 * A choreography is what the shim replays for one scripted turn: an ordered list of
 * STEPS, each of which is EITHER a set of tool calls (>1 = a parallel-packed step)
 * OR the closing text — never both. The shim picks the step by counting the
 * assistant tool-call messages that appear AFTER the last user message, so the same
 * file drives a multi-step turn without the shim holding any state.
 *
 * The loader is the ONLY validator. Every committed JSON file passes through it at
 * the infra exit (1.5) and again on every harness boot, so a malformed scenario
 * fails loudly at setup rather than as a confusing assertion three matrices later.
 *
 * MUST stay dependency-free apart from node builtins: the shim is bundled from this
 * module into a standalone process.
 */

import fs from "node:fs";
import path from "node:path";

export type UsageScript = { prompt_eval_count: number; eval_count: number };

export type ChoreographyStep =
  | {
      toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
      text?: never;
      usage: UsageScript;
    }
  | { text: string; toolCalls?: never; usage: UsageScript };

export type Choreography = { id: string; steps: ChoreographyStep[] };

/** The scripted title response. Any prompt WITHOUT the `GATE:` prefix is a title
 *  call by definition (spec C7 item 3), so the C6 flow needs no special casing. */
export const TITLE_SCRIPT: { text: string; usage: UsageScript } = {
  text: "Gate scripted thread title",
  usage: { prompt_eval_count: 64, eval_count: 7 },
};

/** Scenario-id namespaces, owned per task (plan Task 1.5). `infra-` is 1.5's own —
 *  the trivial turn that proves the harness before any matrix exists. */
const NAMESPACES = [
  "infra", // 1.5 (harness infra exit)
  "spike", // 1.6
  "scope", // 1.7
  "contract", // 1.7
  "life", // 1.8
  "tel", // 1.8
  "mcp", // 1.8
  "title", // 2.4a
  "report", // 3.3
] as const;

const ID_PATTERN = new RegExp(`^(?:${NAMESPACES.join("|")})-[a-z0-9]+(?:-[a-z0-9]+)*$`);

/** STEP_LIMIT is 10 at the route; a scenario packs at most 9 calls so a turn always
 *  has a step left for its closing text (pack T8). */
const MAX_TOOL_CALLS_PER_SCENARIO = 9;

/** The scenario-dispatch prefix on the last user message. */
export const GATE_PREFIX = "GATE:";

export function gatePrompt(id: string): string {
  return `${GATE_PREFIX}${id}`;
}

/** The committed scenario directory (absolute). The shim runs as a bundled child
 *  process and receives this through `LAUNCH_GATE_CHOREOGRAPHY_DIR` instead. */
export const CHOREOGRAPHY_DIR = path.join(__dirname, "choreography");

class ChoreographyError extends Error {
  constructor(file: string, message: string) {
    super(`choreography ${file}: ${message}`);
    this.name = "ChoreographyError";
  }
}

function assertUsage(file: string, usage: unknown): UsageScript {
  if (typeof usage !== "object" || usage === null) {
    throw new ChoreographyError(file, "step is missing its `usage` block");
  }
  const record = usage as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "prompt_eval_count" && key !== "eval_count") {
      throw new ChoreographyError(file, `unknown usage key "${key}"`);
    }
  }
  for (const key of ["prompt_eval_count", "eval_count"] as const) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new ChoreographyError(file, `usage.${key} must be a positive integer`);
    }
  }
  return { prompt_eval_count: record.prompt_eval_count as number, eval_count: record.eval_count as number };
}

function assertToolCalls(file: string, raw: unknown): Array<{ name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ChoreographyError(file, "`toolCalls` must be a non-empty array");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ChoreographyError(file, `toolCalls[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "name" && key !== "input") {
        throw new ChoreographyError(file, `toolCalls[${index}] has unknown key "${key}"`);
      }
    }
    if (typeof record.name !== "string" || record.name === "") {
      throw new ChoreographyError(file, `toolCalls[${index}].name must be a non-empty string`);
    }
    const input = record.input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ChoreographyError(file, `toolCalls[${index}].input must be an object`);
    }
    return { name: record.name, input: input as Record<string, unknown> };
  });
}

function parseStep(file: string, raw: unknown, index: number, lastIndex: number): ChoreographyStep {
  if (typeof raw !== "object" || raw === null) {
    throw new ChoreographyError(file, `steps[${index}] must be an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "toolCalls" && key !== "text" && key !== "usage") {
      throw new ChoreographyError(file, `steps[${index}] has unknown key "${key}"`);
    }
  }
  const hasTools = record.toolCalls !== undefined;
  const hasText = record.text !== undefined;
  if (hasTools === hasText) {
    throw new ChoreographyError(file, `steps[${index}] must carry EXACTLY one of \`toolCalls\` or \`text\``);
  }
  const usage = assertUsage(file, record.usage);
  if (hasText) {
    if (index !== lastIndex) {
      throw new ChoreographyError(file, `steps[${index}] is a text step but only the LAST step may be text`);
    }
    if (typeof record.text !== "string" || record.text === "") {
      throw new ChoreographyError(file, `steps[${index}].text must be a non-empty string`);
    }
    return { text: record.text, usage };
  }
  return { toolCalls: assertToolCalls(file, record.toolCalls), usage };
}

export function parseChoreography(file: string, raw: unknown): Choreography {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ChoreographyError(file, "must be a JSON object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "id" && key !== "steps") {
      throw new ChoreographyError(file, `unknown key "${key}"`);
    }
  }
  const id = record.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    throw new ChoreographyError(
      file,
      `id "${String(id)}" is not in an owned namespace (${NAMESPACES.join("-* / ")}-*)`,
    );
  }
  const steps = record.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new ChoreographyError(file, "`steps` must be a non-empty array");
  }
  const parsed = steps.map((step, index) => parseStep(file, step, index, steps.length - 1));
  const totalCalls = parsed.reduce((sum, step) => sum + (step.toolCalls?.length ?? 0), 0);
  if (totalCalls > MAX_TOOL_CALLS_PER_SCENARIO) {
    throw new ChoreographyError(
      file,
      `packs ${totalCalls} tool calls; the per-turn budget is ${MAX_TOOL_CALLS_PER_SCENARIO}`,
    );
  }
  return { id, steps: parsed };
}

/**
 * Load and validate every `*.json` under `dir`. Throws on the first violation —
 * a mis-seeded harness must fail at boot, never mid-matrix.
 */
export function loadChoreographies(dir: string): Map<string, Choreography> {
  const entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  const byId = new Map<string, Choreography>();
  for (const entry of entries) {
    const fileKey = entry.slice(0, -".json".length);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8"));
    } catch (err) {
      throw new ChoreographyError(entry, `is not valid JSON (${err instanceof Error ? err.message : "unknown"})`);
    }
    const choreography = parseChoreography(entry, raw);
    if (choreography.id !== fileKey) {
      throw new ChoreographyError(entry, `id "${choreography.id}" does not match its file key "${fileKey}"`);
    }
    if (byId.has(choreography.id)) {
      throw new ChoreographyError(entry, `duplicate id "${choreography.id}"`);
    }
    byId.set(choreography.id, choreography);
  }
  if (byId.size === 0) {
    throw new Error(`no choreography files found under ${dir}`);
  }
  return byId;
}
