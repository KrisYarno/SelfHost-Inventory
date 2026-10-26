/** @jest-environment node */
//
// Assistant A1 (M2a, pack C4; seams S1 + S2) — what the REAL `ai` + `@ai-sdk/anthropic`
// put on the wire for the A1 model-call options, and what a real mid-stream abort
// becomes on the client.
//
// `ai` is ESM-only and cannot load under the root jest transform (lane4-assistant.test.ts
// mocks it for that reason), so this suite spawns a plain node ESM probe
// (__tests__/support/anthropic-wire-probe.mjs). It imports the genuine SDK, bundles the
// two A1 leaves (model-options.ts, stream-metadata.ts) with esbuild, and talks only to a
// capture `fetch` (a `.invalid` host, the literal key "test-key"; global fetch is a
// tripwire). It prints one NDJSON line per case.
//
// The FIRST test is the harness self-check. Every other pin runs only after it is
// green: a probe load error or a watchdog is never evidence.

import { spawnSync } from "node:child_process";
import path from "node:path";

const PROBE = path.resolve(__dirname, "../../../support/anthropic-wire-probe.mjs");
const PROBE_TIMEOUT_MS = 90_000;
const CAPTURE_HOST = "anthropic-wire-probe.invalid";
const CASES = ["a0", "a", "b", "c", "d", "e"] as const;
type CaseName = (typeof CASES)[number];

/* eslint-disable @typescript-eslint/no-explicit-any */

type Captured = {
  url: string;
  host: string;
  path: string;
  method?: string;
  headers: Record<string, string>;
  body: Record<string, any>;
  signalPassed: boolean;
};
type ProbeRecord = { case: string; error?: string; requests?: Captured[]; [key: string]: any };

const records = {} as Record<string, ProbeRecord>;
let harnessOk = false;

/** True when ANY nested plain object/array of `value` owns `key`. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value as Record<string, unknown>).some((v) => hasKeyDeep(v, key));
}

/** The ONE request a case made (each case makes exactly one model call). */
function body(name: CaseName): Record<string, any> {
  const requests = records[name].requests ?? [];
  expect(requests).toHaveLength(1);
  return requests[0].body;
}

describe("anthropic wire probe (A1 C4)", () => {
  test("harness self-check: the probe loads, runs every case, and no case hits the watchdog", () => {
    const r = spawnSync(process.execPath, [PROBE], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    if (r.error) throw new Error(`wire probe failed to spawn: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`wire probe exited ${r.status} (signal ${r.signal}):\n${r.stderr}`);

    const lines = r.stdout.split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) {
      const record = JSON.parse(line) as ProbeRecord;
      expect(typeof record.case).toBe("string");
      expect(records[record.case]).toBeUndefined(); // one line per case
      records[record.case] = record;
    }
    expect(Object.keys(records).sort()).toEqual([...CASES, "bundles", "summary"].sort());
    for (const name of CASES) expect(records[name].error).not.toBe("watchdog");
    harnessOk = true;
  }, PROBE_TIMEOUT_MS + 30_000);

  describe("wire pins", () => {
    beforeAll(() => {
      if (!harnessOk) {
        throw new Error("harness self-check is not green — no wire pin result is evidence");
      }
    });

    test("no network: every request went to the capture host, through the capture, with the literal test key", () => {
      expect(records.summary.captureHost).toBe(CAPTURE_HOST);
      expect(records.summary.strayFetches).toEqual([]);
      for (const name of CASES) {
        const requests = records[name].requests ?? [];
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.host).toBe(CAPTURE_HOST);
          expect(new URL(request.url).host).toBe(CAPTURE_HOST);
          expect(request.path).toBe("/v1/messages");
          expect(request.method).toBe("POST");
          expect(request.headers["x-api-key"]).toBe("test-key");
        }
      }
    });

    test("every scripted reply parsed: no case reports an error, and nothing rejected unhandled", () => {
      for (const name of CASES) expect({ case: name, error: records[name].error }).toEqual({ case: name });
      for (const name of ["b", "c", "d"] as const) expect(records[name].streamErrors).toEqual([]);
      expect(records.e.readErrors).toEqual([]);
      expect(records.summary.unhandledRejections).toEqual([]);
    });

    test("the leaf bundles carry no prisma and no import at all (dependency-free, Next-free, ai-free)", () => {
      const bundles = records.bundles.bundles as Array<Record<string, any>>;
      expect(bundles.map((b) => b.entry)).toEqual([
        "lib/assistant/model-options.ts",
        "lib/assistant/stream-metadata.ts",
      ]);
      for (const b of bundles) {
        expect(b.sources).toEqual([b.entry]); // only the leaf itself was bundled
        expect(b.imports).toEqual([]);
        expect(b.mentionsPrisma).toBe(false);
      }
    });

    test("a0 (control): the PRE-A1 title parameters DO put thinking disabled and max_tokens 256 on the wire", () => {
      // Non-vacuity of (a): the capture sees the very fields (a) asserts are gone.
      const sent = body("a0");
      expect(sent.model).toBe("claude-opus-5-5");
      expect(sent.thinking).toEqual({ type: "disabled" });
      expect(sent.max_tokens).toBe(256);
    });

    test("a: the A1 title call for claude-opus-5-5 sends effort low, max_tokens 1024, and no thinking", () => {
      const sent = body("a");
      expect(sent.model).toBe("claude-opus-5-5");
      expect(hasKeyDeep(sent, "thinking")).toBe(false);
      expect(sent.output_config?.effort).toBe("low");
      expect(sent.max_tokens).toBe(1024);
      expect(sent.stream).toBeUndefined(); // generateText: non-streaming
    });

    test("b: the chat call for claude-opus-5-5 sends effort medium, max_tokens 16000, one tool, no thinking, no fallbacks", () => {
      const sent = body("b");
      expect(sent.model).toBe("claude-opus-5-5");
      expect(sent.stream).toBe(true);
      expect(sent.output_config?.effort).toBe("medium");
      expect(sent.max_tokens).toBe(16000);
      expect(sent.tools).toHaveLength(1);
      expect(sent.tools[0].name).toBe("probe_lookup");
      expect(hasKeyDeep(sent, "thinking")).toBe(false);
      expect(hasKeyDeep(sent, "fallbacks")).toBe(false);
    });

    test("c: the chat call for claude-opus-5 sends effort high (its API default)", () => {
      const sent = body("c");
      expect(sent.model).toBe("claude-opus-5");
      expect(sent.output_config?.effort).toBe("high");
      expect(sent.max_tokens).toBe(16000);
      expect(hasKeyDeep(sent, "thinking")).toBe(false);
    });

    test("d: the chat call for claude-sonnet-4-5 (outside the effort table) sends no effort", () => {
      const sent = body("d");
      expect(sent.model).toBe("claude-sonnet-4-5");
      expect(sent.output_config?.effort).toBeUndefined();
      expect(sent.max_tokens).toBe(16000);
      expect(hasKeyDeep(sent, "thinking")).toBe(false);
    });

    test("e: a real mid-stream abort reaches readUIMessageStream as an abort chunk + PROVIDER_TIMEOUT metadata", () => {
      const e = records.e;
      // The abort was real: the signal reached fetch, and it fired after the first delta.
      expect(e.requests?.[0].signalPassed).toBe(true);
      expect(e.abortedAfterFirstDelta).toBe(true);
      expect(e.abortChunkSeen).toBe(true);
      const types = e.chunkTypes as string[];
      expect(types.indexOf("abort")).toBeGreaterThan(types.indexOf("text-delta"));
      // The metadata rides a message-metadata chunk right behind the abort part.
      expect(types.slice(types.indexOf("abort"))).toEqual(["abort", "message-metadata"]);
      expect(e.finalMetadata).toEqual(expect.objectContaining({ errorCode: "PROVIDER_TIMEOUT", threadId: "t1" }));
      // Content above the timeout is kept.
      expect(e.finalText).toBe("ok");
    });
  });
});
