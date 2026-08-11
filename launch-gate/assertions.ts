/**
 * launch-gate/assertions.ts — the shared assertion vocabulary for every launch-gate
 * suite (contract pack REV-8: "helper extraction ... = a 1.7 first-creator task").
 *
 * Before this module `asJson` / `canonicalJson` / `eventsOfType` / `settleTurn` /
 * `sleep` lived in three copies across infra.test.ts, spike-a.test.ts and
 * spike-b.test.ts. Three copies of a settle barrier is three chances to get the
 * barrier wrong, and the barrier is the lane's one identified flake — so it lives
 * here once and every suite imports it.
 *
 * RELATIVE IMPORTS ONLY (pack REV-7): nothing here may assume jest's
 * `moduleNameMapper`, because a future globalSetup-reachable module may want these
 * helpers. Test FILES may still use the `@/` alias; this file may not.
 *
 * No `expect` import: helpers either return a value or throw an Error carrying the
 * evidence. That keeps them usable from a non-jest context (a debugging script) and
 * keeps the failure message the thing that explains the failure.
 */

import { GATE_SEED } from "./seed";
import { oracleQuery } from "./oracle";
import type { SseEvent, TurnResult } from "./driver";

// ---------------------------------------------------------------------------
// Primitives (extracted verbatim from the three 1.5/1.6 suites)
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** mysql2 hands back MySQL JSON columns already parsed; normalise either shape. */
export function asJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

/**
 * Key-order-canonical serialization.
 *
 * MySQL's native JSON type stores objects in a normalised binary form and re-emits
 * keys sorted by (length, lexicographic) — so a structured tool output that goes
 * `stream -> assistant_messages.parts -> read back` is byte-IDENTICAL in its values
 * and its ARRAY order, but NOT in its object key order. Comparing canonical forms is
 * the strongest byte-level claim available on that round trip; strings (the assistant
 * text) are compared raw, where byte-identity really does hold.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function eventsOfType<T extends SseEvent["type"]>(
  turn: TurnResult,
  type: T,
): Array<Extract<SseEvent, { type: T }>> {
  return turn.events.filter((event): event is Extract<SseEvent, { type: T }> => event.type === type);
}

// ---------------------------------------------------------------------------
// THE SETTLE BARRIER (contract pack REV-8 — binding on 1.7/1.8/2.4a/3.3)
// ---------------------------------------------------------------------------

/** Pack REV-8 states the barrier as "5s deadline; 50ms steps; never fixed sleeps". */
export const SETTLE_DEADLINE_MS = 5_000;
export const SETTLE_INTERVAL_MS = 50;

export type SettleOptions = {
  /** Named in the log line + the failure message ("… after the historical turn"). */
  label?: string;
  deadlineMs?: number;
  intervalMs?: number;
  /**
   * Also wait for the assistant ROW. "No running request" is enough before a
   * follow-up POST (the claim is free); a PERSISTENCE assertion additionally needs
   * the finalizer's insert to have landed.
   */
  requireAssistantRow?: boolean;
};

/**
 * A turn is over for the CLIENT when the stream closes and over for the DATABASE
 * when the finalizer commits — and those are NOT the same instant. The route
 * finalizes 59-87ms AFTER the response ends (the usage race, then the finalize
 * transaction), so a DB read taken the moment `postTurn` resolves can legitimately
 * see the user row and not yet the assistant row, and a follow-up POST to the same
 * thread can legitimately 409 THREAD_BUSY on a turn the client considers finished.
 *
 * BOUNDED, and never a fixed sleep.
 */
export async function settleTurn(threadId: string, options: SettleOptions = {}): Promise<void> {
  const {
    label,
    deadlineMs = SETTLE_DEADLINE_MS,
    intervalMs = SETTLE_INTERVAL_MS,
    requireAssistantRow = false,
  } = options;
  const startedAt = Date.now();
  const until = startedAt + deadlineMs;
  const suffix = label === undefined ? "" : ` after ${label}`;
  for (;;) {
    const rows = await oracleQuery<{ running: number; assistants: number }>(
      "SELECT (SELECT COUNT(*) FROM assistant_requests WHERE threadId = ? AND status = 'running') AS running, " +
        "(SELECT COUNT(*) FROM assistant_messages WHERE threadId = ? AND role = 'assistant') AS assistants",
      [threadId, threadId],
    );
    const running = Number(rows[0].running);
    const assistants = Number(rows[0].assistants);
    if (running === 0 && (!requireAssistantRow || assistants > 0)) {
      if (label !== undefined) {
        // Standing record: how far the finalizer trails the closed stream on this
        // machine, this run.
        console.log(
          `[launch-gate] settle lag${suffix}: ${Date.now() - startedAt}ms from stream close to settled turn`,
        );
      }
      return;
    }
    if (Date.now() > until) {
      throw new Error(
        `thread ${threadId} did not settle within ${deadlineMs}ms${suffix} ` +
          `(running=${running} assistantRows=${assistants})`,
      );
    }
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Row-1 leak scan (spec C7 row 1; contract pack T9 / seam S12)
// ---------------------------------------------------------------------------

const scannedScopedTurns: string[] = [];

/**
 * The row-1 leak scan, as a helper every suite can reuse: grep the company-B
 * sentinel LITERALS over a turn's raw transcript.
 *
 * `TurnResult.raw` is every byte the server sent, which is why the driver keeps it
 * lossless: a structured compare only looks where the test thought to look, and the
 * whole point of a banded sentinel is that it is findable ANYWHERE in the payload —
 * a prose field, a coverage note, an error message.
 *
 * Call this on EVERY A-scoped turn. The registry is per test file (jest gives each
 * file its own module registry), so a file can assert how many turns it scanned and
 * a reviewer can see the count instead of trusting that the calls were made.
 */
export function assertNoCompanyBLeak(turn: TurnResult, label: string): void {
  for (const sentinel of GATE_SEED.sentinels.companyB) {
    const at = turn.raw.indexOf(sentinel);
    if (at !== -1) {
      throw new Error(
        `COMPANY-B SENTINEL LEAK: "${sentinel}" appears in the ${label} transcript at byte ${at} — ` +
          `context: ${JSON.stringify(turn.raw.slice(Math.max(0, at - 160), at + 160))}`,
      );
    }
  }
  scannedScopedTurns.push(label);
}

/** Labels of every turn `assertNoCompanyBLeak` has scanned in THIS test file. */
export function scannedScopedTurnLabels(): readonly string[] {
  return scannedScopedTurns;
}

/**
 * The transcript with every MACHINE-GENERATED IDENTIFIER blanked, for value scans.
 *
 * `toolCallId`/`messageId`/`threadId` are random hex, and hex contains decimal digits:
 * a numeric literal scan over the raw bytes really did hit `"4747"` inside the UUID
 * `1d99d7bd-9e56-4a9e-b0a8-6376104747bb` (observed, run 3). Values live in payloads,
 * never in ids, so a value scan reads the transcript with the ids removed — and it stays
 * a WHOLE-TRANSCRIPT scan (prose, coverage notes, error messages all included), which a
 * structured field-by-field compare would not be.
 */
export function payloadTranscript(turn: TurnResult): string {
  return turn.raw
    .replace(/"toolCallId":"[^"]*"/g, '"toolCallId":""')
    .replace(/"messageId":"[^"]*"/g, '"messageId":""')
    .replace(/"threadId":"[^"]*"/g, '"threadId":""')
    .replace(/"id":"[^"]*"/g, '"id":""');
}

/** The POSITIVE control for the scan above: a caller who really can see company B
 *  MUST see it, or the negative assertion is vacuous. */
export function assertCompanyBSentinelPresent(turn: TurnResult, sentinel: string, label: string): void {
  if (!turn.raw.includes(sentinel)) {
    throw new Error(
      `leak-scan POSITIVE CONTROL failed: company-B sentinel "${sentinel}" is absent from the ` +
        `${label} transcript, so the row-1 negative scan proves nothing`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tool-call/result access over a streamed turn
// ---------------------------------------------------------------------------

/** One scripted tool call as the STREAM reported it: the input the shim scripted and
 *  the structured result the REAL tool returned. */
export type ToolCallResult = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: unknown;
};

/** The ToolResult contract (lib/assistant/tools.ts) as the matrices read it. */
export type ToolResultEnvelope =
  | { status: "ok"; data: unknown; meta: { dataStart?: string; scope: string; bytes: number } }
  | { status: "truncated"; notice: string; meta: { scope: string; bytes: number } }
  | { status: "error"; code: "TOOL_ERROR"; hint?: string; meta: { scope: string } }
  | { status: "error"; error: { code: "NOT_FOUND"; message: string } };

/**
 * Pair `tool-input-available` with `tool-output-available` by toolCallId, in stream
 * order. A parallel-packed step emits both event families interleaved, so pairing by
 * id is the only correct join (position would silently mis-pair).
 */
export function toolCalls(turn: TurnResult): ToolCallResult[] {
  const outputs = new Map<string, unknown>();
  for (const event of eventsOfType(turn, "tool-output-available")) {
    outputs.set(event.toolCallId, event.output);
  }
  return eventsOfType(turn, "tool-input-available").map((event) => {
    if (!outputs.has(event.toolCallId)) {
      throw new Error(
        `tool call ${event.toolName} (${event.toolCallId}) streamed an input with no matching output`,
      );
    }
    return {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      output: outputs.get(event.toolCallId),
    };
  });
}

/** Every call of `toolName` in this turn, in stream order. */
export function callsNamed(turn: TurnResult, toolName: string): ToolCallResult[] {
  return toolCalls(turn).filter((call) => call.toolName === toolName);
}

/**
 * The ONE call of `toolName` whose scripted input is EXACTLY `input`.
 *
 * Deliberately an exact compare (key-order-insensitive), not a subset one: a scenario
 * packs several calls of the same tool that differ by a single flag, and a subset
 * match silently selects the wrong one the moment a scenario grows a superset call
 * (`{includeOkay:false}` matching both itself and `{includeOkay:false,
 * includeHealthy:true}`). An ambiguous selector in an assertion harness is a test that
 * asserts something other than what it says.
 */
export function callWithInput(
  turn: TurnResult,
  toolName: string,
  input: Record<string, unknown>,
): ToolCallResult {
  const wanted = canonicalJson(input);
  const candidates = callsNamed(turn, toolName).filter(
    (call) => canonicalJson(call.input ?? {}) === wanted,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly ONE ${toolName} call with input ${JSON.stringify(input)}, found ` +
        `${candidates.length} (inputs seen: ${JSON.stringify(
          callsNamed(turn, toolName).map((call) => call.input),
        )})`,
    );
  }
  return candidates[0];
}

/**
 * A stream -> `assistant_messages.parts` -> read-back difference that is NOT a value
 * change: MySQL's JSON type stores a number as a DOUBLE and re-emits it with its own
 * shortest-round-trip formatting, which can drop the 17th significant digit of a
 * non-terminating quotient (observed: `daysOfSupply` 15.145631067961164 persisting as
 * 15.14563106796116).
 */
export type FloatDrift = { path: string; streamed: number; persisted: number };

/** Relative tolerance for the drift class above — 1e-15 is one ULP-ish at double
 *  precision, so a real value change (even a tiny one) still THROWS. */
const DOUBLE_FORMAT_TOLERANCE = 1e-15;

/**
 * Compare a streamed tool output against its persisted copy and return the float-format
 * drifts. ANY other difference — a missing key, an extra key, a reordered array, a
 * changed string, an integer that moved, or a float that moved by more than the
 * formatting tolerance — THROWS with the path.
 *
 * This is the same shape of carve-out spec REV-10 already made for MySQL's JSON key-order
 * normalisation, applied to the one other thing that column normalises. It is scoped, it
 * names its cause, and it cannot absorb a real change.
 */
export function compareRoundTrip(streamed: unknown, persisted: unknown, path = "$"): FloatDrift[] {
  if (typeof streamed === "number" && typeof persisted === "number") {
    if (Object.is(streamed, persisted)) return [];
    const scale = Math.max(Math.abs(streamed), Math.abs(persisted));
    const withinFormatting =
      Number.isFinite(streamed) &&
      Number.isFinite(persisted) &&
      !Number.isInteger(streamed) &&
      Math.abs(streamed - persisted) <= scale * DOUBLE_FORMAT_TOLERANCE;
    if (!withinFormatting) {
      throw new Error(
        `round-trip VALUE change at ${path}: streamed ${streamed}, persisted ${persisted}`,
      );
    }
    return [{ path, streamed, persisted }];
  }
  if (Array.isArray(streamed) || Array.isArray(persisted)) {
    if (!Array.isArray(streamed) || !Array.isArray(persisted) || streamed.length !== persisted.length) {
      throw new Error(`round-trip ARRAY shape change at ${path}`);
    }
    return streamed.flatMap((entry, index) =>
      compareRoundTrip(entry, persisted[index], `${path}[${index}]`),
    );
  }
  if (streamed !== null && persisted !== null && typeof streamed === "object" && typeof persisted === "object") {
    const a = streamed as Record<string, unknown>;
    const b = persisted as Record<string, unknown>;
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (canonicalJson(keysA) !== canonicalJson(keysB)) {
      throw new Error(`round-trip KEY SET change at ${path}: ${keysA.join(",")} vs ${keysB.join(",")}`);
    }
    return keysA.flatMap((key) => compareRoundTrip(a[key], b[key], `${path}.${key}`));
  }
  if (canonicalJson(streamed) !== canonicalJson(persisted)) {
    throw new Error(
      `round-trip VALUE change at ${path}: streamed ${canonicalJson(streamed)}, persisted ${canonicalJson(persisted)}`,
    );
  }
  return [];
}

/** Unwrap an `ok` ToolResult's `data`, failing loudly (with the envelope) otherwise. */
export function okData(call: ToolCallResult): Record<string, unknown> {
  const envelope = call.output as ToolResultEnvelope;
  if (envelope === null || typeof envelope !== "object" || envelope.status !== "ok") {
    throw new Error(
      `${call.toolName} did not return an ok result: ${JSON.stringify(envelope).slice(0, 1_200)}`,
    );
  }
  return envelope.data as Record<string, unknown>;
}

/** The `meta.bytes` an ok result declared (used to prove the turn budget never bound). */
export function okBytes(call: ToolCallResult): number {
  const envelope = call.output as Extract<ToolResultEnvelope, { status: "ok" }>;
  if (envelope?.status !== "ok") throw new Error(`${call.toolName} is not an ok result`);
  return envelope.meta.bytes;
}

/** The `hint` a G1 misuse rejection surfaced through the real adapter (spec C7 2l). */
export function errorHint(call: ToolCallResult): string {
  const envelope = call.output as ToolResultEnvelope;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.status !== "error" ||
    !("code" in envelope)
  ) {
    throw new Error(
      `${call.toolName} did not return a TOOL_ERROR result: ${JSON.stringify(envelope).slice(0, 1_200)}`,
    );
  }
  if (typeof envelope.hint !== "string") {
    throw new Error(
      `${call.toolName} returned TOOL_ERROR with NO hint — a G1 misuse rejection must be ` +
        `self-correcting: ${JSON.stringify(envelope)}`,
    );
  }
  return envelope.hint;
}

/** The NOT_FOUND error a current-state tool returns for an archived/unapproved id. */
export function notFoundMessage(call: ToolCallResult): string {
  const envelope = call.output as ToolResultEnvelope;
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    envelope.status !== "error" ||
    !("error" in envelope)
  ) {
    throw new Error(
      `${call.toolName} did not return a NOT_FOUND result: ${JSON.stringify(envelope).slice(0, 1_200)}`,
    );
  }
  return envelope.error.message;
}

/** `data.coverage`, which every list/aggregate tool carries (spec §7 coverage gate). */
export function coverageOf(call: ToolCallResult): Record<string, unknown> {
  const coverage = okData(call).coverage;
  if (coverage === null || typeof coverage !== "object") {
    throw new Error(`${call.toolName} returned no coverage block: ${JSON.stringify(okData(call)).slice(0, 800)}`);
  }
  return coverage as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Window arithmetic (the oracle side of every relativeDays scenario)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** UTC day key `YYYY-MM-DD`, `back` days before now — the seed's own helper shape. */
export function dayKeyBack(back: number, now: Date = new Date()): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

/** `relativeDays: N` resolves to EXACTLY N day-keys ending today (lib/assistant/window). */
export function relativeWindow(relativeDays: number, now: Date = new Date()): { from: string; to: string } {
  return { from: dayKeyBack(relativeDays - 1, now), to: dayKeyBack(0, now) };
}

/** The shared days-covered denominator (metrics-contract): whole days from the first
 *  qualifying event to now, floored at 1 and clamped to the window. */
export function daysCovered(firstEventMs: number, nowMs: number, windowDays: number): number {
  return Math.min(windowDays, Math.max(1, Math.ceil((nowMs - firstEventMs) / DAY_MS)));
}
