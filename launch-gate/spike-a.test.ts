/**
 * launch-gate/spike-a.test.ts — SPIKE A: shim wire fidelity through ai-sdk-ollama
 * (plan Task 1.6; spec C7 "W1 SPIKES"; go/no-go, ORCHESTRATOR-adjudicated).
 *
 * Two claims, both of which the whole matrix rests on:
 *
 *  A1 — THE TURN-SCOPED STEP INDEX survives its two hard cases. The shim picks a
 *  choreography step by counting assistant `tool_calls` messages AFTER the last user
 *  message, and that count has exactly two ways to be wrong:
 *    · an EARLIER, COMPLETED tool turn in the same thread advances it (G2D-2) — then
 *      a fresh turn would start mid-choreography;
 *    · a PARALLEL-packed step double-counts, because the provider emits one
 *      `role: "tool"` message PER RESULT (G2C-6) — then a two-call step would look
 *      like two steps.
 *  The proof is one thread with a completed 1-call turn FOLLOWED BY a 2-parallel-call
 *  turn: turn 2 must fire BOTH calls in its first step (history did not advance the
 *  index) and then close on the scripted text (the two results did not double-count).
 *  A miscount is not a subtle failure here — the shim would be asked for a step that
 *  does not exist and would 500.
 *
 *  A2 — THE TITLE PATH through the REAL `ai` + `ai-sdk-ollama` module graph. That
 *  graph cannot load under this suite's CommonJS transform (G2-9), so the probe is a
 *  spawned node ESM script: `node --check` first (G2P-6), then execute and compare
 *  the returned text and usage against TITLE_SCRIPT.
 *
 * Everything else in this file is persistence fidelity along for the ride: the
 * scripted tool INPUTS and the resulting tool OUTPUTS must round-trip
 * stream -> assistant_messages.parts unchanged.
 */

import { describe, expect, it, beforeAll } from "@jest/globals";
import { spawnSync } from "node:child_process";
import path from "node:path";
// Extracted to launch-gate/assertions.ts by Task 1.7 (contract pack REV-8). Same
// helpers, same behaviour — one definition.
import { asJson, canonicalJson, eventsOfType, settleTurn } from "./assertions";
import { gatePrompt, loadChoreographies, TITLE_SCRIPT } from "./choreography";
import { loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { REPO_ROOT, SHIM_PORT } from "./spawn";
import { GATE_MODEL } from "./seed";

const CHOREOGRAPHY_DIR = path.join(__dirname, "choreography");
const HISTORY_SCENARIO = "spike-a-history";
const PARALLEL_SCENARIO = "spike-a-parallel";
const TITLE_PROBE = path.join(__dirname, "spike-a-title.mjs");

type MessageRow = { id: string; role: string; parts: string; sequence: number };

function toolPartsOf(parts: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(parts)) return [];
  return (parts as unknown[]).filter((part): part is Record<string, unknown> => {
    if (typeof part !== "object" || part === null) return false;
    const type = (part as { type?: unknown }).type;
    return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
  });
}

describe("SPIKE A — shim wire fidelity through ai-sdk-ollama", () => {
  describe("A1 — a completed tool turn, then a parallel-call turn in the SAME thread", () => {
    let historyTurn: TurnResult;
    let parallelTurn: TurnResult;
    let threadId: string;
    let rows: MessageRow[];

    beforeAll(async () => {
      const caseStartedAt = Date.now();
      const session = await loginOnce("memberA");

      historyTurn = await postTurn(session, {
        threadId: null,
        message: {
          id: "spike-a-hist-user",
          role: "user",
          parts: [{ type: "text", text: gatePrompt(HISTORY_SCENARIO) }],
        },
        trigger: "submit-message",
      });
      if (historyTurn.status !== 200 || historyTurn.threadId === null) {
        throw new Error(
          `spike A historical turn failed (${historyTurn.status}): ${historyTurn.raw.slice(0, 2_000)}`,
        );
      }
      threadId = historyTurn.threadId;
      // The historical turn must be COMPLETE — persisted and no longer holding the
      // claim — before the next one is posted; otherwise "history" is not history.
      await settleTurn(threadId, { label: "the historical turn", requireAssistantRow: true, deadlineMs: 20_000 });

      // SAME thread: the server-canonical history now carries a COMPLETED assistant
      // tool_calls message, which is the thing that must not advance the step index.
      parallelTurn = await postTurn(session, {
        threadId,
        message: {
          id: "spike-a-par-user",
          role: "user",
          parts: [{ type: "text", text: gatePrompt(PARALLEL_SCENARIO) }],
        },
        trigger: "submit-message",
      });
      if (parallelTurn.status !== 200) {
        throw new Error(
          `spike A parallel turn failed (${parallelTurn.status}): ${parallelTurn.raw.slice(0, 2_000)}`,
        );
      }

      await settleTurn(threadId, { label: "the parallel turn", requireAssistantRow: true, deadlineMs: 20_000 });
      rows = await oracleQuery<MessageRow>(
        "SELECT id, role, parts, sequence FROM assistant_messages WHERE threadId = ? ORDER BY sequence",
        [threadId],
      );
      console.log(`[launch-gate] A1 wall clock: ${Date.now() - caseStartedAt}ms (two turns + settle)`);
    });

    it("turn 1 ran the scripted single-tool step and then its closing text", () => {
      const inputs = eventsOfType(historyTurn, "tool-input-available");
      expect(inputs).toHaveLength(1);
      expect(inputs[0].toolName).toBe("get_inventory_summary");
      expect(eventsOfType(historyTurn, "tool-output-available")).toHaveLength(1);
      expect(eventsOfType(historyTurn, "error")).toHaveLength(0);
      expect(historyTurn.text).toBe("Spike A history turn complete.");
    });

    it("turn 2 opened at step 0: the historical tool turn did NOT advance the index", () => {
      // Had the earlier turn's assistant tool_calls message counted, the shim would
      // have served step 1 (the closing text) and NO tool call would have fired.
      const inputs = eventsOfType(parallelTurn, "tool-input-available");
      expect(inputs.map((event) => event.toolName).sort()).toEqual([
        "get_inventory_policy",
        "get_inventory_summary",
      ]);
      expect(eventsOfType(parallelTurn, "error")).toHaveLength(0);
    });

    it("the parallel step fired BOTH calls in ONE step with the scripted arguments", () => {
      const scripted = loadChoreographies(CHOREOGRAPHY_DIR).get(PARALLEL_SCENARIO);
      const scriptedCalls = scripted?.steps[0].toolCalls ?? [];
      expect(scriptedCalls).toHaveLength(2);

      const inputs = eventsOfType(parallelTurn, "tool-input-available");
      expect(inputs).toHaveLength(2);
      for (const call of scriptedCalls) {
        const event = inputs.find((candidate) => candidate.toolName === call.name);
        expect(event).toBeDefined();
        expect(event?.input).toEqual(call.input);
      }
      // Two calls, two distinct call ids, one step.
      expect(new Set(inputs.map((event) => event.toolCallId)).size).toBe(2);
      expect(eventsOfType(parallelTurn, "tool-output-available")).toHaveLength(2);
    });

    it("the two tool RESULTS did not double-count: the closing text arrived at step 1", () => {
      // A double count would have asked the shim for step 2 of a two-step
      // choreography — a 500 and an `error` event, never this text.
      expect(parallelTurn.text).toBe("Spike A parallel turn complete.");
      expect(eventsOfType(parallelTurn, "error")).toHaveLength(0);
    });

    it("persists exactly four rows: both turns, in order, both assistant rows present", () => {
      expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(rows[0].id).toBe("spike-a-hist-user");
      expect(rows[2].id).toBe("spike-a-par-user");
      expect(rows.map((row) => Number(row.sequence))).toEqual([1, 2, 3, 4]);
    });

    it("round-trips the scripted inputs and the tool outputs into assistant_messages", () => {
      const persisted = toolPartsOf(asJson(rows[3].parts));
      expect(persisted).toHaveLength(2);

      const streamedInputs = eventsOfType(parallelTurn, "tool-input-available");
      const streamedOutputs = eventsOfType(parallelTurn, "tool-output-available");
      for (const part of persisted) {
        expect(part.state).toBe("output-available");
        const streamedInput = streamedInputs.find((event) => event.toolCallId === part.toolCallId);
        const streamedOutput = streamedOutputs.find((event) => event.toolCallId === part.toolCallId);
        expect(streamedInput).toBeDefined();
        expect(streamedOutput).toBeDefined();
        expect(canonicalJson(part.input)).toBe(canonicalJson(streamedInput?.input));
        expect(canonicalJson(part.output)).toBe(canonicalJson(streamedOutput?.output));
      }

      // The historical turn's row is untouched by the second turn.
      const historical = toolPartsOf(asJson(rows[1].parts));
      expect(historical).toHaveLength(1);
      expect(historical[0].state).toBe("output-available");
    });

    it("recorded one request row per turn, both `ok`, with the scripted usage summed", async () => {
      // Usage AGGREGATES across steps (pack REV-7): the row carries the sum of every
      // step the turn actually ran, which is itself evidence of the step count.
      const scripted = loadChoreographies(CHOREOGRAPHY_DIR).get(PARALLEL_SCENARIO);
      const expectedInput = (scripted?.steps ?? []).reduce(
        (sum, step) => sum + step.usage.prompt_eval_count,
        0,
      );
      const expectedOutput = (scripted?.steps ?? []).reduce(
        (sum, step) => sum + step.usage.eval_count,
        0,
      );
      const requests = await oracleQuery<{
        status: string;
        model: string;
        inputTokens: number | null;
        outputTokens: number | null;
      }>(
        // Scoped to kind = 'chat' since 2.4a made titles real: the detached C6 title
        // call interleaves a kind:"title" row between the two chat turns' rows
        // (precedent: matrix-mcp:278).
        "SELECT status, model, inputTokens, outputTokens FROM assistant_requests WHERE threadId = ? AND kind = 'chat' ORDER BY id",
        [threadId],
      );
      expect(requests).toHaveLength(2);
      expect(requests.map((row) => row.status)).toEqual(["ok", "ok"]);
      expect(requests[1].model).toBe(GATE_MODEL);
      expect(Number(requests[1].inputTokens)).toBe(expectedInput);
      expect(Number(requests[1].outputTokens)).toBe(expectedOutput);
    });
  });

  describe("A2 — the title probe through the REAL ai-sdk-ollama path", () => {
    it("passes `node --check` (the spawned ESM probe is outside the TS graph)", () => {
      const checked = spawnSync(process.execPath, ["--check", TITLE_PROBE], { encoding: "utf8" });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    });

    it("returns the scripted TITLE_SCRIPT text and usage from one generateText call", () => {
      const run = spawnSync(process.execPath, [TITLE_PROBE], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 60_000,
        // A minimal env, like every other harness child: the probe must not inherit
        // the developer's shell (and has no business seeing a DATABASE_URL at all).
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NODE_ENV: "test",
          LAUNCH_GATE_SHIM_URL: `http://127.0.0.1:${SHIM_PORT}`,
          LAUNCH_GATE_MODEL: GATE_MODEL,
        },
      });
      if (run.status !== 0) {
        throw new Error(
          `the title probe exited ${run.status}:\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
        );
      }

      const printed = run.stdout.trim().split("\n").pop() ?? "";
      const result = JSON.parse(printed) as {
        text: string;
        usage: { inputTokens: number; outputTokens: number; totalTokens: number };
        finishReason: string;
      };
      expect(result.text).toBe(TITLE_SCRIPT.text);
      expect(result.usage.inputTokens).toBe(TITLE_SCRIPT.usage.prompt_eval_count);
      expect(result.usage.outputTokens).toBe(TITLE_SCRIPT.usage.eval_count);
      expect(result.usage.totalTokens).toBe(
        TITLE_SCRIPT.usage.prompt_eval_count + TITLE_SCRIPT.usage.eval_count,
      );
      expect(result.finishReason).toBe("stop");
    });
  });
});
