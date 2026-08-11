/**
 * launch-gate/matrix-lifecycle.test.ts — ASSERTION MATRIX ROW 4: thread lifecycle
 * (plan Task 1.8; spec C7 row 4).
 *
 * THE CLAIM: a thread is a durable, single-writer, per-user object, and every
 * transition it can make is observable over real HTTP against a real database.
 *
 * WHAT LIVES ELSEWHERE, deliberately (this file does NOT re-prove them):
 *   · create-on-first-message + threadId metadata — infra.test.ts (the 1.5 exit).
 *   · stop mid-stream -> partial + `aborted` row — spike-b.test.ts B(a).
 *   · the FENCE (backdated stale claim, zombie writes nothing) — spike-b B(b).
 *   · the crash path (SIGKILL -> young-row THREAD_BUSY -> lease -> SUPERSEDED) —
 *     spike-b B(c).
 *   · THE TWO PROVIDER_TIMEOUT CASES (content-then-stall and indefinitely-open
 *     silent, both finalizing via T2 at ~75s before the 90s lease) — spike-b B(d)(i)
 *     and (ii), which are the spec REV-8 standing rows themselves. Duplicating them
 *     here would add 150 seconds of wall clock and zero information.
 *
 * THE GENERATION BOUNDARY. This file opens with `restartApp()` (plan Task 1.8: "the
 * POST budget ... restartApp between rows 3 and 4"). Jest's file order VARIES (pack
 * REV-8), so "between rows 3 and 4" is implemented as "row 4 always begins a fresh
 * app generation" — which is the property the budget actually needs, and the only
 * one a file cannot get by assuming where it sits in the order.
 *
 * THE SETTLE BARRIER (pack REV-8) precedes every DB assertion and every same-thread
 * follow-up POST. The route finalizes 59-87ms AFTER the stream closes.
 *
 * MODULE-LEVEL WORK, declared: the history byte-bound case asserts `loadBoundedHistory`
 * directly (spike-b B(b)'s precedent — DATABASE_URL through the refusal belt, then a
 * dynamic import). The model input is NOT observable over HTTP: the route hands it to
 * the provider, and the shim is deliberately blind to everything but the last user
 * message. The HTTP-observable half (the turn still succeeds; storage is never
 * truncated) is asserted beside it.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  asJson,
  canonicalJson,
  compareRoundTrip,
  coverageOf,
  callWithInput,
  eventsOfType,
  okData,
  settleTurn,
  sleep,
  toolCalls,
  type FloatDrift,
} from "./assertions";
import { gatePrompt } from "./choreography";
import {
  apiDelete,
  apiGet,
  loginOnce,
  postTurn,
  type SseEvent,
  type TurnResult,
} from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_SEED } from "./seed";
import { restartApp } from "./spawn";
import { assertGateDatabaseUrl, gateDatabaseUrl, readState } from "./state";

type ThreadsModule = typeof import("../lib/assistant/threads");

const MEMBER_A = GATE_SEED.actors.memberA;
const ADMIN = GATE_SEED.actors.admin;
const NO_FACTS = GATE_SEED.actors.noFactsUser;

// --- The byte-exact oracles (pack REV-5; spec C5 / the AppError strings of pack REV-3).
const NOT_FOUND_BODY = '{"error":"Thread not found","code":"NOT_FOUND"}';
const CLAIM_BUSY_BODY =
  '{"error":"A response is already streaming in this thread","code":"THREAD_BUSY"}';
const DELETE_BUSY_BODY = '{"error":"Stop the response first","code":"THREAD_BUSY"}';
const CONFLICT_BODY = '{"error":"Thread advanced — reload","code":"CONFLICT"}';
const DELETED_BODY = '{"deleted":true}';

type MessageRow = {
  id: string;
  role: string;
  parts: string;
  metadata: string | null;
  sequence: number;
};

type RequestRow = {
  id: number;
  threadId: string | null;
  status: string;
  errorCode: string | null;
};

type DetailBody = {
  id: string;
  title: string | null;
  messages: Array<{ id: string; role: string; parts: unknown[]; metadata: unknown }>;
  activeRequest: { status: "running" } | null;
};

async function messagesOf(threadId: string): Promise<MessageRow[]> {
  return oracleQuery<MessageRow>(
    "SELECT id, role, parts, metadata, sequence FROM assistant_messages WHERE threadId = ? ORDER BY sequence",
    [threadId],
  );
}

async function requestsOf(threadId: string): Promise<RequestRow[]> {
  return oracleQuery<RequestRow>(
    "SELECT id, threadId, status, errorCode FROM assistant_requests WHERE threadId = ? ORDER BY id",
    [threadId],
  );
}

/** The text an assistant ROW carries, joined from its persisted text parts. */
function textOf(row: MessageRow): string {
  const parts = asJson(row.parts) as Array<{ type: string; text?: string }>;
  return parts
    .filter((part) => part.type === "text")
    .map((part) => String(part.text))
    .join("");
}

/** Drive one scripted turn and settle it. Throws with the body on any non-200. */
async function drive(
  user: Parameters<typeof loginOnce>[0],
  scenario: string,
  messageId: string,
  options: { threadId?: string; trigger?: "submit-message" | "regenerate-message" } = {},
): Promise<TurnResult> {
  const session = await loginOnce(user);
  const turn = await postTurn(session, {
    threadId: options.threadId ?? null,
    message: {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: gatePrompt(scenario) }],
    },
    trigger: options.trigger ?? "submit-message",
  });
  if (turn.status !== 200 || turn.threadId === null) {
    throw new Error(`${scenario} turn (${messageId}) failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
  }
  await settleTurn(turn.threadId, { requireAssistantRow: false });
  return turn;
}

async function maxRequestIdFor(userId: number): Promise<number> {
  const rows = await oracleQuery<{ maxId: number }>(
    "SELECT COALESCE(MAX(id), 0) AS maxId FROM assistant_requests WHERE userId = ?",
    [userId],
  );
  return Number(rows[0].maxId);
}

/** BOUNDED poll for the request row a turn created — how a turn whose CLIENT half
 *  died is still located (spike-b's `pollForNewRequest` pattern). */
async function pollForNewRequest(
  afterId: number,
  userId: number,
  label: string,
): Promise<{ id: number; threadId: string }> {
  const until = Date.now() + 20_000;
  for (;;) {
    const rows = await oracleQuery<{ id: number; threadId: string }>(
      "SELECT id, threadId FROM assistant_requests WHERE id > ? AND userId = ? ORDER BY id LIMIT 1",
      [afterId, userId],
    );
    if (rows.length === 1) return { id: Number(rows[0].id), threadId: String(rows[0].threadId) };
    if (Date.now() > until) throw new Error(`${label}: no new request row appeared within 20000ms`);
    await sleep(200);
  }
}

type FailedTurn = {
  events: SseEvent[];
  outcome: string;
  threadId: string;
  requestId: number;
};

/**
 * Drive a turn whose PROVIDER dies mid-stream, tolerating whatever the client half
 * does about it.
 *
 * A truncated provider stream is not a case `postTurn`'s return value can express:
 * the turn's server-side truth outlives the client's connection, so the events are
 * collected through `onEvent` as they arrive (1.6's affordance), the promise's
 * settlement is recorded as data rather than asserted on the way past, and the row is
 * found by POLLING for the claim — never by reading a `TurnResult` that may never
 * exist.
 */
async function driveFailing(
  user: Parameters<typeof loginOnce>[0],
  scenario: string,
  messageId: string,
  options: { threadId?: string; trigger?: "submit-message" | "regenerate-message" } = {},
): Promise<FailedTurn> {
  const session = await loginOnce(user);
  const userId = GATE_SEED.actors[user].userId;
  const before = await maxRequestIdFor(userId);
  const events: SseEvent[] = [];

  const outcome = await postTurn(
    session,
    {
      threadId: options.threadId ?? null,
      message: {
        id: messageId,
        role: "user",
        parts: [{ type: "text", text: gatePrompt(scenario) }],
      },
      trigger: options.trigger ?? "submit-message",
    },
    { onEvent: (event) => events.push(event) },
  ).then(
    (result) => `resolved status=${result.status}`,
    (err: unknown) => `rejected ${err instanceof Error ? err.name : String(err)}`,
  );

  const created = await pollForNewRequest(before, userId, `${scenario} claim`);
  await settleTurn(created.threadId, { label: `the ${scenario} turn` });
  console.log(
    `[launch-gate] row 4 ${scenario}: client half ${outcome}; events seen: ` +
      `${events.map((event) => event.type).join(", ") || "(none)"}`,
  );
  return { events, outcome, threadId: created.threadId, requestId: created.id };
}

/**
 * A deferred that resolves with the thread id the moment ANY metadata-bearing event
 * carries it — which is how a turn that is still streaming can be addressed. The
 * returned `TurnResult` only exists once the stream is over, and the THREAD_BUSY /
 * delete-while-held cases are entirely about the window before that.
 */
function threadIdSignal(): { wait: Promise<string>; onEvent: (event: SseEvent) => void } {
  let resolve!: (value: string) => void;
  let reject!: (err: Error) => void;
  const inner = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(
    () => reject(new Error("no metadata carrier delivered a threadId within 30000ms")),
    30_000,
  );
  return {
    wait: inner.finally(() => clearTimeout(timer)),
    onEvent: (event) => {
      const carrier =
        event.type === "start" || event.type === "finish" || event.type === "message-metadata"
          ? event.messageMetadata
          : undefined;
      if (carrier?.threadId !== undefined) resolve(carrier.threadId);
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Evidence collected by the two provider-failure cases and asserted by the FINDING
 * describe at the END of this file (jest runs describes in declaration order, so the
 * evidence is populated by the time that block's tests run).
 */
const providerFailure: {
  before?: FailedTurn;
  beforeRequest?: RequestRow;
  after?: FailedTurn;
  afterRequest?: RequestRow;
  afterMetadata?: unknown;
} = {};

let generationBefore = 0;
let generationAfter = 0;

beforeAll(async () => {
  generationBefore = readState().appGeneration;
  const startedAt = Date.now();
  await restartApp();
  generationAfter = readState().appGeneration;
  console.log(
    `[launch-gate] row 4: restartApp() in ${Date.now() - startedAt}ms — app generation ` +
      `${generationBefore} -> ${generationAfter} (a fresh POST budget for this row)`,
  );
});

describe("row 4 opens on a fresh app generation", () => {
  it("bumped the generation (the POST budget for this row starts empty)", () => {
    expect(generationAfter).toBe(generationBefore + 1);
    expect(readState().postCounts[String(generationAfter)] ?? {}).toEqual({});
  });
});

// =========================================================================
describe("RESUME — the persisted transcript is canonical-equal to what streamed", () => {
  let turn: TurnResult;
  let threadId: string;
  let detail: DetailBody;
  let persisted: MessageRow[];
  const drifts: FloatDrift[] = [];

  beforeAll(async () => {
    // A MULTI-PART turn on purpose: two parallel tool calls in step 1, closing text in
    // step 2. One assistant message therefore carries structured tool parts AND text —
    // which is the shape a resume has to reproduce, and the shape a text-only turn
    // would let a broken serializer pass.
    turn = await drive("memberA", "life-resume-multipart", "gate-life-resume-user");
    threadId = turn.threadId as string;
    await settleTurn(threadId, { requireAssistantRow: true, label: "the resume turn" });
    persisted = await messagesOf(threadId);
    const response = await apiGet(await loginOnce("memberA"), `/api/assistant/threads/${threadId}`);
    expect(response.status).toBe(200);
    detail = JSON.parse(response.raw) as DetailBody;
  });

  it("streamed two parallel tool calls and closing text", () => {
    expect(toolCalls(turn)).toHaveLength(2);
    expect(toolCalls(turn).map((call) => call.toolName).sort()).toEqual([
      "get_inventory_summary",
      "get_stock",
    ]);
    expect(turn.text).toBe("Resume fixture complete.");
    expect(eventsOfType(turn, "error")).toHaveLength(0);
  });

  it("persists ONE user row and ONE assistant row, in sequence order", () => {
    expect(persisted.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(persisted.map((row) => row.sequence)).toEqual([1, 2]);
    expect(persisted[0].id).toBe("gate-life-resume-user");
  });

  it("serves every streamed tool input/output back CANONICAL-EQUAL (compareRoundTrip)", () => {
    const served = detail.messages.find((message) => message.role === "assistant");
    expect(served).toBeDefined();
    const servedParts = (served?.parts ?? []) as Array<Record<string, unknown>>;
    for (const call of toolCalls(turn)) {
      const part = servedParts.find((candidate) => candidate.toolCallId === call.toolCallId);
      if (part === undefined) {
        throw new Error(`resume lost tool part ${call.toolName} (${call.toolCallId})`);
      }
      // compareRoundTrip THROWS on a missing key, an extra key, a reordered array, a
      // changed string or a moved integer; it tolerates ONLY MySQL's double
      // re-formatting, and it reports every one of those it tolerated.
      drifts.push(...compareRoundTrip(call.input, part.input, `${call.toolName}.input`));
      drifts.push(...compareRoundTrip(call.output, part.output, `${call.toolName}.output`));
      expect(part.state).toBe("output-available");
    }
    if (drifts.length > 0) {
      console.log(
        `[launch-gate] row 4 resume: ${drifts.length} MySQL double-format drift(s) tolerated: ` +
          drifts.map((drift) => `${drift.path} ${drift.streamed} -> ${drift.persisted}`).join(", "),
      );
    }
  });

  it("serves the closing text and the terminal metadata the stream carried", () => {
    const served = detail.messages.find((message) => message.role === "assistant");
    const servedParts = (served?.parts ?? []) as Array<{ type: string; text?: string }>;
    const servedText = servedParts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join("");
    expect(servedText).toBe(turn.text);

    const streamedFinish = eventsOfType(turn, "finish")[0]?.messageMetadata?.finishReason;
    expect(typeof streamedFinish).toBe("string");
    // C4: the finalizer re-derives finishReason from the message's OWN metadata, so a
    // route that stopped emitting messageMetadata on "finish" would lose it here.
    expect(served?.metadata).toEqual({ finishReason: streamedFinish });
    // `threadId` rides the WIRE only — it is stripped before persistence.
    expect(canonicalJson(served?.metadata)).not.toContain(threadId);
  });

  it("SANITIZED: no incomplete tool part survived into storage", () => {
    const parts = asJson(persisted[1].parts) as Array<Record<string, unknown>>;
    const states = parts
      .filter((part) => typeof part.type === "string" && String(part.type).startsWith("tool-"))
      .map((part) => part.state);
    expect(states).toEqual(["output-available", "output-available"]);
    for (const part of parts) {
      expect(part.state).not.toBe("input-streaming");
      expect(part.state).not.toBe("input-available");
    }
  });

  it("DB -> HTTP is byte-identical (the client's resume path)", () => {
    const served = detail.messages.find((message) => message.role === "assistant");
    expect(JSON.stringify(served?.parts)).toBe(JSON.stringify(asJson(persisted[1].parts)));
    expect(detail.id).toBe(threadId);
    // Settled: nothing is streaming into this thread any more.
    expect(detail.activeRequest).toBeNull();
    // W1 stubs titles (pack T6) — the title charter in matrix-telemetry covers the
    // W2 behaviour; here the honest observation is that nothing wrote one.
    expect(detail.title).toBeNull();
  });

  // The ownership matrix rides on this thread: it is a real thread with real content,
  // which is the only kind whose absence is worth asserting.
  describe("OWNERSHIP 404 matrix over real HTTP", () => {
    it("admin fetching memberA's thread gets the byte-exact NOT_FOUND body", async () => {
      const response = await apiGet(await loginOnce("admin"), `/api/assistant/threads/${threadId}`);
      expect(response.status).toBe(404);
      expect(response.raw).toBe(NOT_FOUND_BODY);
    });

    it("a NONEXISTENT id gets the SAME status and the SAME bytes (no existence oracle)", async () => {
      const response = await apiGet(
        await loginOnce("memberA"),
        "/api/assistant/threads/gatethreaddoesnotexist01",
      );
      expect(response.status).toBe(404);
      expect(response.raw).toBe(NOT_FOUND_BODY);
    });

    it("admin DELETING memberA's thread 404s and deletes NOTHING", async () => {
      const response = await apiDelete(
        await loginOnce("admin"),
        `/api/assistant/threads/${threadId}`,
      );
      expect(response.status).toBe(404);
      expect(response.raw).toBe(NOT_FOUND_BODY);
      expect((await messagesOf(threadId)).map((row) => row.role)).toEqual(["user", "assistant"]);
    });

    it("the OWNER still reads it (the 404s above are about ownership, not breakage)", async () => {
      const response = await apiGet(await loginOnce("memberA"), `/api/assistant/threads/${threadId}`);
      expect(response.status).toBe(200);
      expect((JSON.parse(response.raw) as DetailBody).messages).toHaveLength(2);
    });
  });
});

// =========================================================================
describe("THREAD_BUSY — one writer per thread, and the DELETE that respects it", () => {
  let heldTurn: TurnResult;
  let threadId: string;
  let busySend: TurnResult;
  let busyDelete: { status: number; raw: string };
  let afterSettleSend: TurnResult;
  let requestsBeforeDelete: RequestRow[];
  let deleteResponse: { status: number; raw: string };

  beforeAll(async () => {
    const session = await loginOnce("memberA");
    const signal = threadIdSignal();

    // The scenario writes its content immediately and holds the connection open for
    // six seconds. The thread is therefore genuinely BUSY — a real live claim, not a
    // backdated row — for a window wide enough to drive two calls into it.
    const inFlight = postTurn(
      session,
      {
        threadId: null,
        message: {
          id: "gate-life-held-user",
          role: "user",
          parts: [{ type: "text", text: gatePrompt("life-hold-brief") }],
        },
        trigger: "submit-message",
      },
      { onEvent: signal.onEvent },
    );

    threadId = await signal.wait;

    busySend = await postTurn(session, {
      threadId,
      message: {
        id: "gate-life-busy-user",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("life-simple") }],
      },
      trigger: "submit-message",
    });
    busyDelete = await apiDelete(session, `/api/assistant/threads/${threadId}`);

    heldTurn = await inFlight;
    await settleTurn(threadId, { requireAssistantRow: true, label: "the held turn" });

    // The other half of the claim contract: once the turn is finalized the thread
    // accepts the next send.
    afterSettleSend = await drive("memberA", "life-simple", "gate-life-after-settle-user", {
      threadId,
    });
    await settleTurn(threadId, { requireAssistantRow: true });

    requestsBeforeDelete = await requestsOf(threadId);
    deleteResponse = await apiDelete(session, `/api/assistant/threads/${threadId}`);
  }, 120_000);

  it("the held turn completed normally once its hold expired", () => {
    expect(heldTurn.status).toBe(200);
    expect(heldTurn.text).toBe("Held turn complete.");
    expect(eventsOfType(heldTurn, "error")).toHaveLength(0);
  });

  it("a concurrent send into the busy thread is 409 THREAD_BUSY, byte-exact", () => {
    expect(busySend.status).toBe(409);
    expect(busySend.raw).toBe(CLAIM_BUSY_BODY);
    // Rejected BEFORE the claim: no stream opened, so no request row was created.
    expect(busySend.events).toHaveLength(0);
  });

  it("a DELETE into the busy thread is 409 with its OWN message (not the claim's)", () => {
    expect(busyDelete.status).toBe(409);
    expect(busyDelete.raw).toBe(DELETE_BUSY_BODY);
    expect(busyDelete.raw).not.toBe(CLAIM_BUSY_BODY);
  });

  it("the rejected send left NO trace: two request rows, not three", () => {
    expect(requestsBeforeDelete).toHaveLength(2);
    expect(requestsBeforeDelete.map((row) => row.status)).toEqual(["ok", "ok"]);
  });

  it("after the turn finalizes the SAME thread accepts the next send", () => {
    expect(afterSettleSend.status).toBe(200);
    expect(afterSettleSend.threadId).toBe(threadId);
    expect(afterSettleSend.text).toBe("Life simple turn complete.");
  });

  it("DELETE after settle returns {deleted:true} and the messages are gone", async () => {
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.raw).toBe(DELETED_BODY);
    expect(await messagesOf(threadId)).toHaveLength(0);
    const threads = await oracleQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM assistant_threads WHERE id = ?",
      [threadId],
    );
    expect(Number(threads[0].n)).toBe(0);
  });

  it("the REQUEST rows survive the delete with threadId NULL (usage attribution is kept)", async () => {
    const survivors = await oracleQuery<RequestRow>(
      `SELECT id, threadId, status, errorCode FROM assistant_requests WHERE id IN (${requestsBeforeDelete
        .map(() => "?")
        .join(", ")}) ORDER BY id`,
      requestsBeforeDelete.map((row) => row.id),
    );
    expect(survivors).toHaveLength(requestsBeforeDelete.length);
    for (const row of survivors) {
      expect(row.threadId).toBeNull();
      expect(row.status).toBe("ok");
    }
    // Nothing can still be addressed by the dead thread id.
    expect(await requestsOf(threadId)).toHaveLength(0);
  });
});

// =========================================================================
describe("TWO TABS on DIFFERENT threads stream concurrently", () => {
  let first: TurnResult;
  let second: TurnResult;

  beforeAll(async () => {
    const session = await loginOnce("admin");
    const body = (id: string) =>
      ({
        threadId: null,
        message: {
          id,
          role: "user" as const,
          parts: [{ type: "text" as const, text: gatePrompt("life-simple") }],
        },
        trigger: "submit-message" as const,
      });
    // GENUINELY parallel: both POSTs are in flight at the same time. The claim lock is
    // per THREAD, so two threads must not serialize against each other.
    [first, second] = await Promise.all([
      postTurn(session, body("gate-life-tab-one-user")),
      postTurn(session, body("gate-life-tab-two-user")),
    ]);
    for (const turn of [first, second]) {
      if (turn.threadId !== null) await settleTurn(turn.threadId, { requireAssistantRow: true });
    }
  });

  it("both streamed clean, into DIFFERENT threads", () => {
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.text).toBe("Life simple turn complete.");
    expect(second.text).toBe("Life simple turn complete.");
    expect(eventsOfType(first, "error")).toHaveLength(0);
    expect(eventsOfType(second, "error")).toHaveLength(0);
  });

  it("both finalized ok — neither turn fenced or busied the other", async () => {
    for (const turn of [first, second]) {
      const rows = await requestsOf(turn.threadId as string);
      expect(rows).toHaveLength(1);
      expect({ status: rows[0].status, errorCode: rows[0].errorCode }).toEqual({
        status: "ok",
        errorCode: null,
      });
    }
  });

  it("both threads belong to the caller who opened them", async () => {
    const owners = await oracleQuery<{ id: string; userId: number }>(
      "SELECT id, userId FROM assistant_threads WHERE id IN (?, ?)",
      [first.threadId, second.threadId],
    );
    expect(owners).toHaveLength(2);
    for (const row of owners) expect(Number(row.userId)).toBe(ADMIN.userId);
  });
});

// =========================================================================
describe("REGENERATE — the four cases (spec C4's ONE anchor rule)", () => {
  // -- (1) + (4) ride one admin thread: a normal re-ask, then a newer user row.
  describe("(1) a normal re-ask supersedes the trailing assistant row", () => {
    let threadId: string;
    let firstAssistantId: string;
    let afterRegenerate: MessageRow[];
    let requestsAfter: RequestRow[];
    let conflict: TurnResult;
    let messagesBeforeConflict: MessageRow[];
    let messagesAfterConflict: MessageRow[];

    beforeAll(async () => {
      const setup = await drive("admin", "life-simple", "gate-life-regen-user");
      threadId = setup.threadId as string;
      await settleTurn(threadId, { requireAssistantRow: true });
      const before = await messagesOf(threadId);
      firstAssistantId = before[1].id;

      await drive("admin", "life-simple", "gate-life-regen-user", {
        threadId,
        trigger: "regenerate-message",
      });
      await settleTurn(threadId, { requireAssistantRow: true, label: "the regenerate turn" });
      afterRegenerate = await messagesOf(threadId);
      requestsAfter = await requestsOf(threadId);

      // -- (4) the two-tab conflict: another send advances the thread, and a
      //    regenerate anchored on the OLDER user row must refuse rather than fork.
      await drive("admin", "life-simple", "gate-life-regen-user-2", { threadId });
      await settleTurn(threadId, { requireAssistantRow: true });
      messagesBeforeConflict = await messagesOf(threadId);
      const session = await loginOnce("admin");
      conflict = await postTurn(session, {
        threadId,
        message: {
          id: "gate-life-regen-user",
          role: "user",
          parts: [{ type: "text", text: gatePrompt("life-simple") }],
        },
        trigger: "regenerate-message",
      });
      messagesAfterConflict = await messagesOf(threadId);
    }, 120_000);

    it("the OLD assistant row is gone and a NEW one took its place", () => {
      expect(afterRegenerate.map((row) => row.role)).toEqual(["user", "assistant"]);
      expect(afterRegenerate.map((row) => row.id)).not.toContain(firstAssistantId);
      expect(afterRegenerate[1].id).not.toBe(firstAssistantId);
      expect(textOf(afterRegenerate[1])).toBe("Life simple turn complete.");
    });

    it("the anchor user row was REUSED, never duplicated", () => {
      expect(afterRegenerate.filter((row) => row.id === "gate-life-regen-user")).toHaveLength(1);
      expect(afterRegenerate[0].sequence).toBe(1);
    });

    it("the PRIOR request row survives (regenerate deletes messages, not the audit)", () => {
      expect(requestsAfter).toHaveLength(2);
      expect(requestsAfter.map((row) => row.status)).toEqual(["ok", "ok"]);
    });

    it("(4) a regenerate under a NEWER user row is 409 CONFLICT, byte-exact", () => {
      expect(conflict.status).toBe(409);
      expect(conflict.raw).toBe(CONFLICT_BODY);
    });

    it("(4) the refused regenerate changed NOTHING — no fork, no deletion", () => {
      // Compared against the snapshot taken immediately BEFORE the refused POST, so
      // the assertion cannot be satisfied by the transcript it is reading.
      expect(messagesBeforeConflict.map((row) => row.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(messagesAfterConflict.map((row) => [row.id, row.role, row.sequence])).toEqual(
        messagesBeforeConflict.map((row) => [row.id, row.role, row.sequence]),
      );
      expect(messagesBeforeConflict[0].id).toBe("gate-life-regen-user");
      expect(messagesBeforeConflict[2].id).toBe("gate-life-regen-user-2");
    });
  });

  // -- (2) failed BEFORE content. `hold: {then: "eof", silent: true}` is a provider
  //    that accepts the request, writes nothing, and dies: ai-sdk-ollama raises its
  //    "did not receive done" error, the route masks it PROVIDER_ERROR, and the
  //    meaningful-content predicate persists NO assistant row.
  describe("(2) a retry after a failure BEFORE content is accepted, not 409'd", () => {
    let failed: FailedTurn;
    let retry: FailedTurn;
    let threadId: string;
    let messagesAfterFailure: MessageRow[];
    let messagesAfterRetry: MessageRow[];
    let requestsAfterRetry: RequestRow[];

    beforeAll(async () => {
      failed = await driveFailing("zeroUser", "life-fail-before", "gate-life-failbefore-user");
      threadId = failed.threadId;
      messagesAfterFailure = await messagesOf(threadId);

      retry = await driveFailing("zeroUser", "life-fail-before", "gate-life-failbefore-user", {
        threadId,
        trigger: "regenerate-message",
      });
      messagesAfterRetry = await messagesOf(threadId);
      requestsAfterRetry = await requestsOf(threadId);

      providerFailure.before = failed;
      [providerFailure.beforeRequest] = await requestsOf(threadId);
    }, 120_000);

    it("the first attempt reached the provider and streamed NO content", () => {
      expect(failed.events.filter((event) => event.type === "text-delta")).toHaveLength(0);
      expect(failed.events.filter((event) => event.type === "tool-output-available")).toHaveLength(0);
    });

    it("persists NO assistant row — the shape whose retry REV-2's anchor rule 409'd", () => {
      // The meaningful-content predicate runs on the SANITIZED parts, and there were
      // none: a turn that died before content leaves the user row standing alone.
      // (The REQUEST row classifies this error/PROVIDER_ERROR — the F-5 block at the
      // end of this file — it is not what the anchor rule is about.)
      expect(messagesAfterFailure.map((row) => row.role)).toEqual(["user"]);
    });

    it("the RETRY is ACCEPTED — a second claim, a second request row, no CONFLICT", () => {
      // THE CONTRACT UNDER TEST (G2C-1) is the CLAIM: REV-2's anchor rule 409'd this
      // exact shape (a persisted user row with no assistant row after it). A 409 would
      // have written NO second request row at all, so the second row IS the proof the
      // claim succeeded. The provider outcome is NOT the contract — the shim
      // dispatches on the persisted user message, which regenerate reuses verbatim, so
      // attempt 2 necessarily replays attempt 1's script; asserting "the retry
      // produced content" would be asserting something this harness cannot arrange.
      expect(requestsAfterRetry).toHaveLength(2);
      expect(retry.requestId).toBeGreaterThan(failed.requestId);
      expect(retry.threadId).toBe(threadId);
    });

    it("the thread did not fork: still ONE user row, still no assistant row", () => {
      expect(messagesAfterRetry.map((row) => row.id)).toEqual(["gate-life-failbefore-user"]);
      expect(messagesAfterRetry).toHaveLength(1);
    });
  });

  // -- (3) failed AFTER content: the same dead-provider wire, but the content frame is
  //    written first, so the ACCUMULATOR has a real partial to persist.
  describe("(3) a retry after a failure AFTER content replaces the partial", () => {
    let failed: FailedTurn;
    let threadId: string;
    let streamedText: string;
    let partialAssistantId: string;
    let partialMetadata: unknown;
    let afterRetry: MessageRow[];
    let requestsAfterRetry: RequestRow[];

    beforeAll(async () => {
      failed = await driveFailing("zeroUser", "life-fail-after", "gate-life-failafter-user");
      threadId = failed.threadId;
      streamedText = failed.events
        .filter((event): event is Extract<SseEvent, { type: "text-delta" }> => event.type === "text-delta")
        .map((event) => event.delta)
        .join("");
      await settleTurn(threadId, {
        requireAssistantRow: true,
        label: "the failed-after-content turn",
      });
      const persisted = await messagesOf(threadId);
      partialAssistantId = persisted[1].id;
      partialMetadata = asJson(persisted[1].metadata);

      await driveFailing("zeroUser", "life-fail-after", "gate-life-failafter-user", {
        threadId,
        trigger: "regenerate-message",
      });
      await settleTurn(threadId, {
        requireAssistantRow: true,
        label: "the failed-after-content retry",
      });
      afterRetry = await messagesOf(threadId);
      requestsAfterRetry = await requestsOf(threadId);

      providerFailure.after = failed;
      providerFailure.afterMetadata = partialMetadata;
      [providerFailure.afterRequest] = await requestsOf(threadId);
    }, 120_000);

    it("persisted the partial the user actually saw", () => {
      // The USER SAW this text — it arrived over the wire before the provider died —
      // and the ACCUMULATOR is what carries it into storage: `onEnd`'s responseMessage
      // never materializes on a stream that dies, so without the accumulator this row
      // would not exist at all.
      expect(streamedText).toBe("Partial before the truncated stream.");
      const persistedText = textOf(afterRetry[1]);
      expect(persistedText).toBe(streamedText);
      // (That row's METADATA carries errorCode PROVIDER_ERROR — the F-5 block below.)
      expect(partialAssistantId).toMatch(/^am/);
    });

    it("the retry SUPERSEDED the failed partial with a new assistant row", () => {
      expect(afterRetry.map((row) => row.role)).toEqual(["user", "assistant"]);
      expect(afterRetry[1].id).not.toBe(partialAssistantId);
      expect(afterRetry.map((row) => row.id)).not.toContain(partialAssistantId);
      expect(textOf(afterRetry[1])).toBe("Partial before the truncated stream.");
    });

    it("both request rows survive the regenerate (the audit is never deleted)", () => {
      expect(requestsAfterRetry).toHaveLength(2);
      for (const row of requestsAfterRetry) {
        expect(row.threadId).toBe(threadId);
        expect(row.status).not.toBe("running");
      }
    });
  });
});

// =========================================================================
/**
 * F-5, FIXED (found by Task 1.8; orchestrator fix round) — A TRUNCATED PROVIDER
 * STREAM IS RECORDED error/PROVIDER_ERROR.
 *
 * HISTORY: as first landed, a provider NDJSON stream that ended WITHOUT its terminal
 * frame finalized `ok` with NULL errorCode and a metadata-less partial — a truncated
 * answer was indistinguishable from a complete one. The fix is evidence-based in the
 * route: a CONSUMED accumulator stream that never observed its terminal `data: [DONE]`
 * frame downgrades an otherwise-ok classification to error/PROVIDER_ERROR (spike B(d)'s
 * held-past-T2 wire is untouched — the latch supplies provider-timeout there first).
 *
 * THE WIRE ITSELF IS UNCHANGED PHYSICS: a dead upstream terminates the client's
 * response mid-body; no masked `error` frame can reach a connection that no longer
 * exists. What changed is THE RECORD.
 */
describe("F-5 fixed — a truncated provider stream is recorded error/PROVIDER_ERROR", () => {
  it("still delivers NO masked `error` SSE frame — the connection is terminated (physics)", () => {
    const before = providerFailure.before as FailedTurn;
    const after = providerFailure.after as FailedTurn;
    expect(before.outcome).toMatch(/^rejected/);
    expect(after.outcome).toMatch(/^rejected/);
    expect(before.events.map((event) => event.type)).toEqual(["start"]);
    expect(after.events.map((event) => event.type)).toEqual(["start", "text-delta"]);
    expect(before.events.some((event) => event.type === "error")).toBe(false);
    expect(after.events.some((event) => event.type === "error")).toBe(false);
  });

  it("records BOTH request rows error/PROVIDER_ERROR (the truthful classification)", () => {
    const before = providerFailure.beforeRequest as RequestRow;
    const after = providerFailure.afterRequest as RequestRow;
    expect({ status: before.status, errorCode: before.errorCode }).toEqual({
      status: "error",
      errorCode: "PROVIDER_ERROR",
    });
    expect({ status: after.status, errorCode: after.errorCode }).toEqual({
      status: "error",
      errorCode: "PROVIDER_ERROR",
    });
  });

  it("marks the persisted partial: metadata.errorCode = PROVIDER_ERROR", () => {
    // On resume, a truncated answer is now DISTINGUISHABLE from a complete one —
    // deriveTurnStatus reads exactly this field (pack T4 precedence).
    expect(providerFailure.afterMetadata).toEqual({ errorCode: "PROVIDER_ERROR" });
  });

  // The CONTRAST — the same dead wire held past T2 records error/PROVIDER_TIMEOUT —
  // remains spike-b B(d)'s own assertion (no cross-file order dependency).
});

// =========================================================================
// F-3 (pack REV-9's open coverage item, CLOSED HERE): 2j's fourth branch.
describe("F-3 — a caller WITH companies and ZERO facts: the null-salesDataStart branch", () => {
  const IN_SALES = { groupBy: "product", relativeDays: 30, includeZeroRows: true } as const;
  let turn: TurnResult;

  beforeAll(async () => {
    turn = await drive("noFactsUser", "life-nofacts-sales", "gate-life-nofacts-user");
  });

  it("the seed really does give this caller companies and no facts (the premise)", async () => {
    expect(NO_FACTS.companyIds.length).toBeGreaterThan(0);
    const placeholders = NO_FACTS.companyIds.map(() => "?").join(", ");
    const [row] = await oracleQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM product_sales_facts WHERE companyId IN (${placeholders})`,
      [...NO_FACTS.companyIds],
    );
    expect(Number(row.n)).toBe(0);
  });

  it("windowCoverage is `none` with a null salesDataStart — not the empty-membership shape", () => {
    const call = callWithInput(turn, "get_sales", IN_SALES);
    const coverage = coverageOf(call);
    expect(coverage.windowCoverage).toBe("none");
    expect(coverage.salesDataStart).toBeNull();
    // The DISCRIMINATOR from the `partial` case (row 2j's third branch): one company,
    // so nothing is staggered and no per-company block is emitted at all.
    expect(coverage.companyCoverage).toBeUndefined();
    // And NOT the zeroUser short-circuit: this caller has a real scope, so rows exist.
    expect(okData(call).note).toBeUndefined();
  });

  it("every zero row is null-with-the-FOURTH-reason, over the real approved population", async () => {
    const call = callWithInput(turn, "get_sales", IN_SALES);
    const rows = okData(call).rows as Array<{
      productId: number;
      _sum: { orderedQty: number | null; revenue: string | null; orderCount: number | null };
      reason?: string;
    }>;
    const population = await oracleQuery<{ id: number }>(
      "SELECT id FROM products WHERE approvalStatus = 'APPROVED' ORDER BY id",
    );
    expect(rows.map((row) => row.productId)).toEqual(population.map((row) => Number(row.id)));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row._sum).toEqual({ orderedQty: null, revenue: null, orderCount: null });
      // No truthful substitution exists for the "starts <date>" template when there is
      // no date — so the sentence says exactly that, and neither of the other two.
      expect(row.reason).toBe("no attributed sales data recorded");
      expect(row.reason).not.toContain("predates/straddles");
      expect(row.reason).not.toContain("not recorded in every company");
    }
  });

  it("nothing was manufactured as a MEASURED zero", () => {
    const rows = okData(callWithInput(turn, "get_sales", IN_SALES)).rows as Array<{
      _sum: { orderedQty: number | null };
    }>;
    expect(rows.filter((row) => row._sum.orderedQty === 0)).toHaveLength(0);
  });
});


// =========================================================================
/**
 * HISTORY BYTE BOUND (spec C7 row 4's last item; pack T2's `loadBoundedHistory`).
 *
 * TWO THREADS, and the difference between them is the whole point:
 *   A — big enough that WHOLE OLDEST TURNS drop, so the bounded input carries the
 *       system OMISSION NOTE.
 *   B — big enough that tool outputs SHED, but small enough after shedding that
 *       nothing drops, so there is NO omission note.
 * Same actor, same tool parts, same size class. The only structural difference is the
 * note — which is what makes the FINDING block below a controlled experiment rather
 * than an anecdote.
 *
 * WHY MODULE-LEVEL (declared): the bounded input is what the ROUTE hands the provider.
 * It is not observable over HTTP (the shim sees only the last user message and the
 * client sees only the answer), so the bound itself is asserted by calling
 * `loadBoundedHistory` against the real gate database — spike-b B(b)'s precedent. What
 * IS observable over HTTP is asserted beside it: the turn completes, and storage is
 * never truncated.
 *
 * The fixtures are SIZED, not guessed: `sized()` pads a message's last text part until
 * the serialized message hits an exact byte target, so the drop arithmetic is a
 * property of the numbers below rather than a hope.
 */

type Part = Record<string, unknown>;
type Fixture = { id: string; role: string; parts: Part[] };
type TurnSpec = { userBytes: number; assistantBytes: number; outputChars: number };

/** Raw byte target for a turn whose huge tool output will be SHED to a one-line marker. */
const SHEDDABLE: TurnSpec = { userBytes: 11_000, assistantBytes: 31_200, outputChars: 30_000 };
/** Thread A's recent turns — kept whole, and heavy enough to force whole-turn drops. */
const HEAVY_RECENT: TurnSpec = { userBytes: 1_000, assistantBytes: 19_480, outputChars: 15_000 };
/** Thread B's recent turns — light enough that shedding alone brings it under budget. */
const LIGHT_RECENT: TurnSpec = { userBytes: 1_000, assistantBytes: 14_000, outputChars: 10_000 };

/** Pad a message's LAST text part until the serialized message hits `targetBytes`
 *  exactly (ASCII filler adds one byte per character to the JSON). */
function sized(id: string, role: string, parts: Part[], targetBytes: number): Fixture {
  const message: Fixture = { id, role, parts };
  const base = Buffer.byteLength(JSON.stringify(message), "utf8");
  const fill = targetBytes - base;
  if (fill < 0) {
    throw new Error(`history fixture ${id} is already ${base} bytes, over its ${targetBytes} target`);
  }
  const last = parts[parts.length - 1];
  last.text = `${String(last.text ?? "")}${"x".repeat(fill)}`;
  return message;
}

/** UIMessage parts as a plain record array — the fixtures and the module's output are
 *  the same JSON, and this file reads them field by field. */
function partsOf(message: { parts: unknown }): Part[] {
  return message.parts as unknown as Part[];
}

function toolPart(tag: string, outputChars: number): Part {
  return {
    type: "tool-get_stock",
    toolCallId: `gate-hist-${tag}`,
    state: "output-available",
    input: { productId: GATE_SEED.fixtures.approvedActiveProductId },
    output: "y".repeat(outputChars),
  };
}

async function insertMessage(threadId: string, message: Fixture, sequence: number): Promise<void> {
  await oracleQuery(
    "INSERT INTO assistant_messages (threadId, id, role, parts, metadata, sequence) VALUES (?, ?, ?, ?, NULL, ?)",
    [threadId, message.id, message.role, JSON.stringify(message.parts), sequence],
  );
}

async function partsBytes(threadId: string): Promise<Array<{ id: string; bytes: number }>> {
  const rows = await oracleQuery<{ id: string; bytes: number }>(
    "SELECT id, OCTET_LENGTH(CAST(parts AS BINARY)) AS bytes FROM assistant_messages WHERE threadId = ? ORDER BY sequence",
    [threadId],
  );
  return rows.map((row) => ({ id: row.id, bytes: Number(row.bytes) }));
}

/** Seed one synthetic thread: `prefix` names its message ids, `turns` their sizes. */
async function buildHistoryThread(
  threadId: string,
  prefix: string,
  turns: TurnSpec[],
): Promise<void> {
  await oracleQuery(
    "INSERT INTO assistant_threads (id, userId, title, createdAt, updatedAt) VALUES (?, ?, NULL, NOW(3), NOW(3))",
    [threadId, MEMBER_A.userId],
  );
  let sequence = 0;
  for (let index = 0; index < turns.length; index += 1) {
    const spec = turns[index];
    sequence += 1;
    await insertMessage(
      threadId,
      sized(`${prefix}-u${index}`, "user", [{ type: "text", text: `turn ${index} ask ` }], spec.userBytes),
      sequence,
    );
    sequence += 1;
    await insertMessage(
      threadId,
      sized(
        `${prefix}-a${index}`,
        "assistant",
        [
          toolPart(`${prefix}-${index}`, spec.outputChars),
          { type: "text", text: `turn ${index} answer ` },
        ],
        spec.assistantBytes,
      ),
      sequence,
    );
  }
}

/** Bind the prisma singleton to the gate container, then load the module (spike-b
 *  B(b)'s binding: the client reads DATABASE_URL at module load). */
async function loadThreadsModule(): Promise<ThreadsModule> {
  const databaseUrl = gateDatabaseUrl();
  assertGateDatabaseUrl(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  return import("../lib/assistant/threads");
}

let threads: ThreadsModule;

// --- Thread A: drops whole turns, so the bounded input carries the omission note ---
const THREAD_A = "clifehistory000000000001";
const A_SHED_TURNS = 4;
const A_KEPT_TURNS = 4;

// --- Thread B: sheds only, so the bounded input has NO omission note ---
const THREAD_B = "clifehistory000000000002";
const B_SHED_TURNS = 2;
const B_KEPT_TURNS = 4;

describe("HISTORY BYTE BOUND — shedding, whole-turn drops and the omission note", () => {
  let bounded: Awaited<ReturnType<ThreadsModule["loadBoundedHistory"]>>;
  let boundedBytes = 0;
  let storage: Array<{ id: string; bytes: number }> = [];

  beforeAll(async () => {
    threads = await loadThreadsModule();
    await buildHistoryThread(THREAD_A, "gate-hista", [
      ...Array.from({ length: A_SHED_TURNS }, () => SHEDDABLE),
      ...Array.from({ length: A_KEPT_TURNS }, () => HEAVY_RECENT),
    ]);
    storage = await partsBytes(THREAD_A);
    bounded = await threads.loadBoundedHistory(MEMBER_A.userId, THREAD_A);
    boundedBytes = threads.serializedBytes(bounded);
    console.log(
      `[launch-gate] row 4 history A: ${storage.length} seeded rows ` +
        `(${storage.reduce((sum, row) => sum + row.bytes, 0)} raw bytes) -> ${bounded.length} messages, ` +
        `${boundedBytes} bytes of a ${threads.HISTORY_BUDGET_BYTES} budget`,
    );
  }, 180_000);

  it("fits the byte budget (the whole point of the bound)", () => {
    expect(boundedBytes).toBeLessThanOrEqual(threads.HISTORY_BUDGET_BYTES);
    // …and the RAW thread is far larger, or the bound was never exercised.
    expect(storage.reduce((sum, row) => sum + row.bytes, 0)).toBeGreaterThan(
      threads.HISTORY_BUDGET_BYTES,
    );
  });

  it("drops WHOLE oldest turns and says so with the system note", () => {
    expect(bounded[0].role).toBe("system");
    expect(bounded[0].parts).toEqual([{ type: "text", text: threads.HISTORY_OMISSION_NOTE }]);
    const ids = bounded.map((message) => message.id);
    expect(ids).not.toContain("gate-hista-u0");
    expect(ids).not.toContain("gate-hista-a0");
    // Never HALF a turn: a dangling assistant row is a broken conversation.
    for (const id of ids) {
      const match = /^gate-hista-[ua](\d)$/.exec(id);
      if (match === null) continue;
      expect(ids).toContain(`gate-hista-u${match[1]}`);
      expect(ids).toContain(`gate-hista-a${match[1]}`);
    }
  });

  it("SHEDS tool outputs on surviving OLD turns", () => {
    const shed = bounded.filter((message) =>
      partsOf(message).some((part) => part.output === threads.TOOL_OUTPUT_OMITTED),
    );
    expect(shed.length).toBeGreaterThan(0);
    // Shedding replaces the OUTPUT and nothing else: the call is still there, so the
    // model still knows the tool ran and with what input.
    for (const message of shed) {
      const part = partsOf(message).find(
        (candidate) => candidate.output === threads.TOOL_OUTPUT_OMITTED,
      );
      expect(part?.state).toBe("output-available");
      expect(part?.input).toEqual({ productId: GATE_SEED.fixtures.approvedActiveProductId });
    }
  });

  it("retains the NEWEST turn in full — output intact", () => {
    const newest = bounded.find(
      (message) => message.id === `gate-hista-a${A_SHED_TURNS + A_KEPT_TURNS - 1}`,
    );
    expect(newest).toBeDefined();
    const output = newest === undefined ? undefined : partsOf(newest).find((part) => "output" in part)?.output;
    expect(typeof output).toBe("string");
    expect(String(output)).toHaveLength(HEAVY_RECENT.outputChars);
    expect(String(output)).not.toBe(threads.TOOL_OUTPUT_OMITTED);
  });

  it("STORAGE is never truncated — the bound shapes the model input only", async () => {
    // Nothing the bound did touched a row: `loadBoundedHistory` is a READ.
    expect(await partsBytes(THREAD_A)).toEqual(storage);
    expect(storage.some((row) => row.bytes > 30_000)).toBe(true);
  });
});

// =========================================================================
describe("HISTORY BYTE BOUND — a big SHED-ONLY thread still answers over HTTP", () => {
  let bounded: Awaited<ReturnType<ThreadsModule["loadBoundedHistory"]>>;
  let storageBefore: Array<{ id: string; bytes: number }> = [];
  let storageAfter: Array<{ id: string; bytes: number }> = [];
  let liveTurn: TurnResult;

  beforeAll(async () => {
    threads = await loadThreadsModule();
    await buildHistoryThread(THREAD_B, "gate-histb", [
      ...Array.from({ length: B_SHED_TURNS }, () => SHEDDABLE),
      ...Array.from({ length: B_KEPT_TURNS }, () => LIGHT_RECENT),
    ]);
    storageBefore = await partsBytes(THREAD_B);
    bounded = await threads.loadBoundedHistory(MEMBER_A.userId, THREAD_B);

    liveTurn = await drive("memberA", "life-simple", "gate-histb-live-user", { threadId: THREAD_B });
    await settleTurn(THREAD_B, { requireAssistantRow: true, label: "the shed-only history turn" });
    storageAfter = await partsBytes(THREAD_B);
    console.log(
      `[launch-gate] row 4 history B: ${storageBefore.length} seeded rows ` +
        `(${storageBefore.reduce((sum, row) => sum + row.bytes, 0)} raw bytes) -> ` +
        `${threads.serializedBytes(bounded)} bytes, ${bounded.length} messages, no omission note`,
    );
  }, 180_000);

  it("SHED its old tool outputs but dropped NO turn (so there is no omission note)", () => {
    expect(storageBefore.reduce((sum, row) => sum + row.bytes, 0)).toBeGreaterThan(
      threads.HISTORY_BUDGET_BYTES,
    );
    expect(threads.serializedBytes(bounded)).toBeLessThanOrEqual(threads.HISTORY_BUDGET_BYTES);
    expect(bounded.map((message) => message.role)).not.toContain("system");
    expect(bounded).toHaveLength((B_SHED_TURNS + B_KEPT_TURNS) * 2);
    expect(
      bounded.filter((message) =>
        partsOf(message).some((part) => part.output === threads.TOOL_OUTPUT_OMITTED),
      ),
    ).toHaveLength(B_SHED_TURNS);
  });

  it("the CURRENT turn is never dropped: the live POST completed normally", () => {
    expect(liveTurn.status).toBe(200);
    expect(liveTurn.text).toBe("Life simple turn complete.");
    expect(eventsOfType(liveTurn, "error")).toHaveLength(0);
  });

  it("STORAGE is never truncated — every seeded row is byte-for-byte intact", () => {
    const after = new Map(storageAfter.map((row) => [row.id, row.bytes]));
    for (const row of storageBefore) {
      expect({ id: row.id, bytes: after.get(row.id) }).toEqual({ id: row.id, bytes: row.bytes });
    }
    // Plus the live turn's own two rows.
    expect(storageAfter).toHaveLength(storageBefore.length + 2);
  });
});

// =========================================================================
/**
 * F-4, FIXED (found by Task 1.8; orchestrator fix round) — THE OMISSION NOTE RIDES
 * THE SYSTEM OPTION.
 *
 * HISTORY: `loadBoundedHistory` prepends a `role:"system"` note message when whole
 * turns drop, and ai@7.0.29's standardizePrompt REJECTS system-role messages in
 * `messages` ("Use the instructions option instead") — as first landed, every turn in
 * a dropped-turn thread failed PROVIDER_ERROR forever (the brick case spec C7 row 4
 * forbids). The fix keeps the module contract intact (the note is STILL the bounded
 * history's first message — the 1.1 unit pins hold) and moves the ROUTE: it strips
 * the note (known id) before conversion/persistence-mode and appends its text to the
 * streamText `system` option, exactly where the SDK says instructions belong.
 *
 * The controlled pair above (thread A drops turns, thread B only sheds) is what
 * proved the note was the one structural difference; it now proves the fix.
 */
describe("F-4 fixed — a dropped-turn history answers normally", () => {
  let turn: TurnResult;
  let requestRow: RequestRow;
  let messagesAfter: MessageRow[];

  beforeAll(async () => {
    turn = await drive("memberA", "life-simple", "gate-hista-live-user", { threadId: THREAD_A });
    await settleTurn(THREAD_A, {
      requireAssistantRow: true,
      label: "the dropped-turn over-budget turn",
    });
    const rows = await requestsOf(THREAD_A);
    requestRow = rows[rows.length - 1];
    messagesAfter = await messagesOf(THREAD_A);
  }, 120_000);

  it("completes the turn: 200, scripted text, no error frames", () => {
    expect(turn.status).toBe(200);
    expect(turn.text).toBe("Life simple turn complete.");
    expect(eventsOfType(turn, "error")).toHaveLength(0);
  });

  it("finalizes ok and persists the assistant row", () => {
    expect({ status: requestRow.status, errorCode: requestRow.errorCode }).toEqual({
      status: "ok",
      errorCode: null,
    });
    const last = messagesAfter[messagesAfter.length - 1];
    expect(last.role).toBe("assistant");
  });

  it("CONTROL: the shed-only thread of the same size class also answered normally", async () => {
    const [row] = await oracleQuery<{ status: string; errorCode: string | null }>(
      "SELECT status, errorCode FROM assistant_requests WHERE threadId = ? ORDER BY id DESC LIMIT 1",
      [THREAD_B],
    );
    expect({ status: row.status, errorCode: row.errorCode }).toEqual({
      status: "ok",
      errorCode: null,
    });
  });

  it("the MODULE contract is intact: the note is still the bounded history's first message", async () => {
    const reloaded = await threads.loadBoundedHistory(MEMBER_A.userId, THREAD_A);
    expect(reloaded[0].role).toBe("system");
    expect(reloaded[0].parts).toEqual([{ type: "text", text: threads.HISTORY_OMISSION_NOTE }]);
    // The route strips it by its KNOWN id — pin that id here so a rename breaks loudly.
    expect(reloaded[0].id).toBe("system-history-omission");
  });
});

afterAll(async () => {
  // The suite's own PrismaClient must not outlive the file, or the worker hangs.
  const { default: prisma } = await import("../lib/prisma");
  await prisma.$disconnect();
});
