/**
 * launch-gate/infra.test.ts — THE INFRA EXIT for plan Task 1.5.
 *
 * Not a matrix. This file proves the harness itself: the container is up and
 * migrated, the three processes are alive, the loader accepts every committed
 * scenario, and ONE trivial scripted turn goes through the REAL route, the REAL
 * tool layer and the REAL database — persisting a thread, its two messages and a
 * request row whose content round-trips byte-for-byte against what the client saw.
 *
 * The residue assertions are the observable half of "teardown leaves no orphans": a
 * test run can only see what a PREVIOUS run left behind, so this file asserts that
 * exactly one launch-gate container exists (ours) and that nothing foreign holds the
 * gate ports. Run the suite twice back-to-back and a leaked run-1 container or
 * process fails run 2 here. The other half — that THIS run leaves nothing — is
 * asserted inside global-teardown, which fails the run when it finds residue.
 */

import { describe, expect, it, beforeAll } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";
// The five helpers this file used to define locally now live in ONE place (contract
// pack REV-8's 1.7 first-creator task). Behaviour is unchanged.
import { asJson, canonicalJson, eventsOfType, settleTurn } from "./assertions";
import { gatePrompt, loadChoreographies, parseChoreography } from "./choreography";
import { apiGet, loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery, tableDigest } from "./oracle";
import { GATE_ACTOR_KEYS, GATE_MODEL, GATE_SEED } from "./seed";
import { GATE_CONTAINER_PREFIX, GATE_PORTS, findOrphans } from "./spawn";
import { readState } from "./state";

const CHOREOGRAPHY_DIR = path.join(__dirname, "choreography");
const SCENARIO = "infra-trivial-turn";

type MessageRow = { id: string; role: string; parts: string; metadata: string | null; sequence: number };

describe("choreography loader (seam S8)", () => {
  it("validates every committed scenario JSON", () => {
    const loaded = loadChoreographies(CHOREOGRAPHY_DIR);
    const files = fs.readdirSync(CHOREOGRAPHY_DIR).filter((name) => name.endsWith(".json"));
    expect(loaded.size).toBe(files.length);
    expect(loaded.size).toBeGreaterThan(0);
  });

  it("carries the trivial turn: one tool step then one text step", () => {
    const scenario = loadChoreographies(CHOREOGRAPHY_DIR).get(SCENARIO);
    expect(scenario).toBeDefined();
    expect(scenario?.steps).toHaveLength(2);
    expect(scenario?.steps[0].toolCalls?.[0].name).toBe("get_inventory_summary");
    expect(typeof scenario?.steps[1].text).toBe("string");
  });

  // Red-capability controls: the schema is executable, not decorative.
  it("rejects a step carrying BOTH branches", () => {
    expect(() =>
      parseChoreography("synthetic.json", {
        id: "infra-synthetic",
        steps: [
          {
            toolCalls: [{ name: "get_inventory_summary", input: {} }],
            text: "both",
            usage: { prompt_eval_count: 1, eval_count: 1 },
          },
        ],
      }),
    ).toThrow(/EXACTLY one/);
  });

  it("rejects a text step that is not last, an unowned namespace and non-integer usage", () => {
    expect(() =>
      parseChoreography("synthetic.json", {
        id: "infra-synthetic",
        steps: [
          { text: "early", usage: { prompt_eval_count: 1, eval_count: 1 } },
          { toolCalls: [{ name: "x", input: {} }], usage: { prompt_eval_count: 1, eval_count: 1 } },
        ],
      }),
    ).toThrow(/only the LAST step may be text/);
    expect(() =>
      parseChoreography("synthetic.json", {
        id: "nope-synthetic",
        steps: [{ text: "t", usage: { prompt_eval_count: 1, eval_count: 1 } }],
      }),
    ).toThrow(/owned namespace/);
    expect(() =>
      parseChoreography("synthetic.json", {
        id: "infra-synthetic",
        steps: [{ text: "t", usage: { prompt_eval_count: 0, eval_count: 1 } }],
      }),
    ).toThrow(/positive integer/);
  });
});

describe("harness infrastructure", () => {
  it("recorded a live container and three live processes", () => {
    const state = readState();
    expect(state.version).toBe(1);
    expect(state.containerName.startsWith(GATE_CONTAINER_PREFIX)).toBe(true);
    for (const name of ["app", "mcp", "shim"] as const) {
      const entry = state.processes[name];
      expect(entry.pid).toBeGreaterThan(0);
      // Signal 0 = liveness probe; it throws ESRCH when the process is gone.
      expect(() => process.kill(entry.pid, 0)).not.toThrow();
    }
  });

  it("migrated and seeded the throwaway database", async () => {
    const users = await oracleQuery<{ n: number }>("SELECT COUNT(*) AS n FROM users");
    // Pinned against the MANIFEST, not a literal (Task 1.8, declared — the F-3 fourth
    // actor moved this from 3 to 4 and a hand-kept literal would move again). The
    // assertion still bites: it is the DB row count versus the manifest's actor list,
    // so a seed that silently skipped an actor fails here.
    expect(Number(users[0].n)).toBe(GATE_ACTOR_KEYS.length);
    const setting = await oracleQuery<{ value: string }>(
      "SELECT value FROM system_settings WHERE `key` = ?",
      ["aiSurfaceConfig"],
    );
    expect(setting[0].value).toBe('{"default":{"providerKind":"OLLAMA","model":"gate-scripted"}}');
    // The digest primitive answers on a real table (empty tables digest as MD5('')).
    await expect(tableDigest("companies")).resolves.toMatch(/^[0-9a-f]{32}$/);
  });

  it("recorded warm-up ids so the matrices can exclude them", () => {
    const { warmupIds } = readState();
    expect(warmupIds.threadIds).toHaveLength(1);
    expect(warmupIds.requestIds.length).toBeGreaterThan(0);
  });

  it("leaves no residue from an earlier run (the twice-back-to-back proof)", async () => {
    const orphans = await findOrphans();
    expect(orphans.containers).toEqual([readState().containerName]);
    // Every gate port is bound — by OUR three processes, which the liveness probe
    // above already identified.
    expect(orphans.boundPorts.sort()).toEqual([...GATE_PORTS].sort());
  });
});

describe("one trivial scripted turn through the REAL route", () => {
  let turn: TurnResult;
  let threadId: string;

  beforeAll(async () => {
    const session = await loginOnce("memberA");
    turn = await postTurn(session, {
      threadId: null,
      message: {
        id: "gate-infra-user-message",
        role: "user",
        parts: [{ type: "text", text: gatePrompt(SCENARIO) }],
      },
      trigger: "submit-message",
    });
    if (turn.status !== 200 || turn.threadId === null) {
      throw new Error(`infra turn failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
    }
    threadId = turn.threadId;
  });

  it("streams the scripted tool call, its output and the closing text", () => {
    expect(turn.status).toBe(200);
    const inputs = eventsOfType(turn, "tool-input-available");
    expect(inputs).toHaveLength(1);
    expect(inputs[0].toolName).toBe("get_inventory_summary");
    expect(inputs[0].input).toEqual({});
    expect(eventsOfType(turn, "tool-output-available")).toHaveLength(1);
    expect(eventsOfType(turn, "error")).toHaveLength(0);
    expect(turn.text).toBe("Gate infra turn complete.");
  });

  it("returns the thread id on a metadata carrier", () => {
    expect(threadId).toMatch(/^[a-z0-9]+$/);
    const starts = eventsOfType(turn, "start");
    expect(starts[0]?.messageMetadata?.threadId).toBe(threadId);
  });

  it("persists the thread, both messages and the request row", async () => {
    // SETTLE BARRIER (1.6 finding, orchestrator seam-fix; now the shared helper): the
    // route finalizes 59-87ms AFTER the response stream closes (usage race + finalize
    // tx). A read taken the instant postTurn resolves races the assistant row — this
    // exact race was the lane's one unidentified flake. Bounded poll, no fixed sleeps.
    await settleTurn(threadId, { requireAssistantRow: true });

    const threads = await oracleQuery<{ id: string; userId: number; title: string | null }>(
      "SELECT id, userId, title FROM assistant_threads WHERE id = ?",
      [threadId],
    );
    expect(threads).toHaveLength(1);
    expect(Number(threads[0].userId)).toBe(GATE_SEED.actors.memberA.userId);

    const messages = await oracleQuery<MessageRow>(
      "SELECT id, role, parts, metadata, sequence FROM assistant_messages WHERE threadId = ? ORDER BY sequence",
      [threadId],
    );
    expect(messages.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(messages[0].id).toBe("gate-infra-user-message");

    const requests = await oracleQuery<{
      status: string;
      kind: string;
      model: string;
      providerKind: string;
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      membershipScope: unknown;
      dayKey: string;
    }>(
      // Scoped to kind = 'chat' since 2.4a made titles real: the detached C6 title
      // call adds a kind:"title" row to this same thread (precedent: matrix-mcp:278).
      "SELECT status, kind, model, providerKind, inputTokens, outputTokens, totalTokens, membershipScope, dayKey FROM assistant_requests WHERE threadId = ? AND kind = 'chat'",
      [threadId],
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("ok");
    expect(requests[0].kind).toBe("chat");
    expect(requests[0].model).toBe(GATE_MODEL);
    expect(requests[0].providerKind).toBe("OLLAMA");
    expect(requests[0].dayKey).toBe(new Date().toISOString().slice(0, 10));
    expect(asJson(requests[0].membershipScope)).toEqual(GATE_SEED.actors.memberA.companyIds);
    // Recorded for 1.8 row 5, which owns the exact-usage assertions.
    console.log(
      `[launch-gate] infra turn usage: input=${requests[0].inputTokens} output=${requests[0].outputTokens} total=${requests[0].totalTokens}`,
    );
  });

  it("round-trips byte-comparable content: stream -> database -> thread detail", async () => {
    const [assistantRow] = await oracleQuery<MessageRow>(
      "SELECT id, role, parts, metadata, sequence FROM assistant_messages WHERE threadId = ? AND role = 'assistant'",
      [threadId],
    );
    const persistedParts = asJson(assistantRow.parts) as Array<Record<string, unknown>>;

    const persistedText = persistedParts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join("");
    expect(persistedText).toBe(turn.text);

    // The structured tool result: identical values, identical array order, and a
    // key order normalised by the MySQL JSON column (see canonicalJson).
    const streamedOutput = eventsOfType(turn, "tool-output-available")[0].output;
    const persistedOutput = persistedParts.find((part) => "output" in part)?.output;
    expect(persistedOutput).toEqual(streamedOutput);
    expect(canonicalJson(persistedOutput)).toBe(canonicalJson(streamedOutput));

    // Database -> HTTP is the round trip the client's resume path actually depends
    // on, and THAT one is byte-identical: both sides read the same normalised JSON.
    const detail = await apiGet(await loginOnce("memberA"), `/api/assistant/threads/${threadId}`);
    expect(detail.status).toBe(200);
    const body = JSON.parse(detail.raw) as {
      id: string;
      messages: Array<{ id: string; role: string; parts: unknown[] }>;
    };
    expect(body.id).toBe(threadId);
    const served = body.messages.find((message) => message.role === "assistant");
    expect(JSON.stringify(served?.parts)).toBe(JSON.stringify(persistedParts));
  });

  it("records the raw chunk-type inventory the bound SseEvent union filters", () => {
    const observed = Array.from(turn.raw.matchAll(/"type":"([a-z-]+)"/g), (match) => match[1]);
    const distinct = Array.from(new Set(observed)).sort();
    // Not an assertion about the union — a standing record for 1.6/1.8, which need to
    // know which chunk names the REAL ai@7.0.29 stream emits versus which eight the
    // driver surfaces as typed events.
    console.log(`[launch-gate] observed stream chunk types: ${distinct.join(", ")}`);
    expect(distinct).toContain("text-delta");
    expect(distinct).toContain("tool-output-available");
  });

  it("never sent a company-B sentinel to a company-A caller", () => {
    expect(turn.raw.length).toBeGreaterThan(0);
    for (const sentinel of GATE_SEED.sentinels.companyB) {
      expect(turn.raw).not.toContain(sentinel);
    }
  });
});
