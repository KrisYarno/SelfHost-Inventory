/**
 * launch-gate/spike-b.test.ts — SPIKE B: abort truth, THE FENCE, and bounded
 * finalization (plan Task 1.6; spec REV-8 C7 Spike B (a)-(d); go/no-go,
 * ORCHESTRATOR-adjudicated; verdicts are THREE-WAY — pass / broken /
 * harness-unreachable).
 *
 * The four proofs, and what each one would mean if it failed:
 *
 *  (a) CLIENT DISCONNECT -> `aborted` request row, end to end. The client drops the
 *      stream mid-flight; `consumeSseStream` keeps driving the tee server-side, the
 *      first-source latch records cause "client", and the finalizer writes `aborted`
 *      plus whatever the user had actually seen. Failure downgrades C4 to
 *      timeout-reaping (pre-adjudicated) — it does not stop the lane.
 *
 *  (b) THE FENCE, module-level against the REAL gate database with NO `ai` in the
 *      graph (that ai-free boundary is why the time constants live in timing.ts).
 *      A `running` row older than the lease is a dead claim: the next claim fences it
 *      SUPERSEDED, and the zombie's late finalize must then write NOTHING — no
 *      request update, no assistant row, no thread touch. THIS is the proof whose
 *      failure STOPS THE LANE: without it a resurrected stream can append stale
 *      output to a thread someone else has moved on from.
 *
 *  (c) THE CRASH PATH. SIGKILL leaves the row `running` (nothing can fire), and the
 *      lease — not a signal — is what eventually releases the thread: a YOUNG crashed
 *      row still blocks with THREAD_BUSY, and only once it is older than
 *      CLAIM_STALE_MS does the next claim fence it and stream.
 *
 *  (d) BOUNDED FINALIZATION, the two REV-8 cases. A blocked provider read outlives
 *      any SDK timeout, so the ROUTE's T2 deadline is the only thing that bounds the
 *      turn: a content-then-stall stream must finalize error/PROVIDER_TIMEOUT with
 *      the ACCUMULATOR's partial persisted, and an indefinitely-open SILENT stream
 *      must finalize the same way with no message row — both BEFORE the 90s lease.
 *      Per pack REV-4 the T2 clock starts at CLAIM COMPLETION, not at first token.
 *
 * NO WALL-CLOCK SLEEPS ON THE LEASE (plan D7): staleness is manufactured by
 * BACKDATING `createdAt` through the oracle. The only real waiting in this file is
 * (d)'s two ~75s deadline cases, which are the contract itself.
 *
 * DATABASE BINDING (b): `lib/assistant/threads.ts` reaches the database through the
 * `@/lib/prisma` singleton, which constructs its `PrismaClient` at module load and
 * takes its URL from `process.env.DATABASE_URL` at that moment. So this file sets
 * DATABASE_URL to the gate container URL — after running it through the harness's
 * `launch_gate`-only refusal belt — and only THEN imports the module, dynamically.
 * The binding is not assumed: the first assertion writes through prisma and reads
 * the row back with the independent mysql2 oracle.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
// Extracted to launch-gate/assertions.ts by Task 1.7 (contract pack REV-8). Same
// helpers, same behaviour — one definition.
import { asJson, settleTurn, sleep } from "./assertions";
import { gatePrompt } from "./choreography";
import { apiGet, loginOnce, postTurn, type SseEvent } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_MODEL, GATE_SEED } from "./seed";
import { restartApp } from "./spawn";
import { assertGateDatabaseUrl, gateDatabaseUrl, readState } from "./state";
// RELATIVE (pack REV-7's rule for spawn-reachable modules, applied here for the same
// reason it exists: this suite loads product modules directly rather than over HTTP).
// threads.ts is `ai`-free at runtime, which is what makes this import legal at all.
import { CLAIM_STALE_MS, FINALIZE_DEADLINE_MS } from "../lib/assistant/timing";

type ThreadsModule = typeof import("../lib/assistant/threads");

const MEMBER_A = GATE_SEED.actors.memberA;

type RequestRow = {
  id: number;
  threadId: string | null;
  status: string;
  errorCode: string | null;
  durationMs: number | null;
  createdAt: string;
  ageMs: number;
};

type MessageRow = { id: string; role: string; parts: string; metadata: string | null };

const REQUEST_COLUMNS =
  "id, threadId, status, errorCode, durationMs, createdAt, " +
  "TIMESTAMPDIFF(MICROSECOND, createdAt, NOW(3)) DIV 1000 AS ageMs";

async function requestRow(id: number): Promise<RequestRow> {
  const rows = await oracleQuery<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE id = ?`,
    [id],
  );
  if (rows.length !== 1) throw new Error(`assistant_requests row ${id} not found`);
  return rows[0];
}

async function messagesOf(threadId: string): Promise<MessageRow[]> {
  return oracleQuery<MessageRow>(
    "SELECT id, role, parts, metadata FROM assistant_messages WHERE threadId = ? ORDER BY sequence",
    [threadId],
  );
}

async function threadUpdatedAt(threadId: string): Promise<string> {
  const rows = await oracleQuery<{ updatedAt: string }>(
    "SELECT updatedAt FROM assistant_threads WHERE id = ?",
    [threadId],
  );
  if (rows.length !== 1) throw new Error(`assistant_threads row ${threadId} not found`);
  return String(rows[0].updatedAt);
}

/** BOUNDED poll — never a fixed sleep. Returns the first row that satisfies
 *  `predicate`, or throws WITH the last row it saw (which is the evidence). */
async function pollRequest(
  id: number,
  predicate: (row: RequestRow) => boolean,
  deadlineMs: number,
  label: string,
  intervalMs = 500,
): Promise<RequestRow> {
  const until = Date.now() + deadlineMs;
  let last: RequestRow | null = null;
  for (;;) {
    last = await requestRow(id);
    if (predicate(last)) return last;
    if (Date.now() > until) {
      throw new Error(
        `${label}: request ${id} never satisfied the condition within ${deadlineMs}ms ` +
          `(last seen status=${last.status} errorCode=${last.errorCode} ageMs=${last.ageMs})`,
      );
    }
    await sleep(intervalMs);
  }
}

/** The newest request row for this caller above `afterId` — how a turn whose POST is
 *  still in flight is located without depending on stream buffering. */
async function pollForNewRequest(afterId: number, deadlineMs: number, label: string): Promise<RequestRow> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const rows = await oracleQuery<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE id > ? AND userId = ? ORDER BY id LIMIT 1`,
      [afterId, MEMBER_A.userId],
    );
    if (rows.length === 1) return rows[0];
    if (Date.now() > until) {
      throw new Error(`${label}: no new request row appeared within ${deadlineMs}ms`);
    }
    await sleep(250);
  }
}

async function maxRequestId(): Promise<number> {
  const rows = await oracleQuery<{ maxId: number }>(
    "SELECT COALESCE(MAX(id), 0) AS maxId FROM assistant_requests",
  );
  return Number(rows[0].maxId);
}

/** Manufacture staleness the ONLY sanctioned way (plan D7): move `createdAt` back
 *  past the lease instead of waiting out 90 seconds of wall clock. */
async function backdate(requestId: number, seconds: number): Promise<void> {
  await oracleQuery(
    "UPDATE assistant_requests SET createdAt = DATE_SUB(NOW(3), INTERVAL ? SECOND) WHERE id = ?",
    [seconds, requestId],
  );
}

const BACKDATE_SECONDS = Math.ceil(CLAIM_STALE_MS / 1_000) + 1;

/** The app is GONE when its port stops answering — a liveness signal that does not
 *  depend on whoever spawned it getting round to reaping the pid. */
async function waitForAppDown(deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      await fetch("http://127.0.0.1:3100/api/csrf", { redirect: "manual" });
    } catch {
      return;
    }
    if (Date.now() > until) {
      throw new Error(`the app under test still answered on 3100 ${deadlineMs}ms after SIGKILL`);
    }
    await sleep(250);
  }
}

describe("SPIKE B(a) — client disconnect mid-stream lands an `aborted` request row", () => {
  let row: RequestRow;
  let messages: MessageRow[];
  const seen: SseEvent[] = [];
  let postOutcome: string;

  beforeAll(async () => {
    const caseStartedAt = Date.now();
    const session = await loginOnce("memberA");
    const controller = new AbortController();
    const before = await maxRequestId();

    // The scenario streams its content immediately and then holds the connection for
    // four seconds before completing. The abort therefore lands while the provider
    // read is BLOCKED, and the SDK observes it when that read finally yields — the
    // real shape of a user pressing Stop, without a race against a 200ms turn.
    const inFlight = postTurn(
      session,
      {
        threadId: null,
        message: {
          id: "spike-b-abort-user",
          role: "user",
          parts: [{ type: "text", text: gatePrompt("spike-b-abort") }],
        },
        trigger: "submit-message",
      },
      {
        signal: controller.signal,
        onEvent: (event) => {
          seen.push(event);
          // Disconnect the moment the user has actually SEEN something.
          if (event.type === "text-delta") controller.abort();
        },
      },
    ).then(
      (result) => `resolved status=${result.status}`,
      (err: unknown) => `rejected ${err instanceof Error ? err.name : String(err)}`,
    );

    const created = await pollForNewRequest(before, 20_000, "B(a) claim");
    postOutcome = await inFlight;
    row = await pollRequest(
      created.id,
      (candidate) => candidate.status !== "running",
      30_000,
      "B(a) finalize",
    );
    messages = await messagesOf(String(created.threadId));
    console.log(`[launch-gate] B(a) wall clock: ${Date.now() - caseStartedAt}ms`);
  }, 90_000);

  it("saw streamed content before disconnecting (the abort was genuinely mid-stream)", () => {
    expect(seen.some((event) => event.type === "text-delta")).toBe(true);
    expect(postOutcome).toMatch(/^rejected/);
  });

  it("records the request row `aborted` — not ok, not PROVIDER_TIMEOUT", () => {
    expect(row.status).toBe("aborted");
    expect(row.errorCode).toBeNull();
  });

  it("finalized on the disconnect, nowhere near the T2 deadline", () => {
    expect(Number(row.durationMs)).toBeLessThan(FINALIZE_DEADLINE_MS);
  });

  it("persists the partial the user actually saw, marked aborted", () => {
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const parts = asJson(messages[1].parts) as Array<{ type: string; text?: string }>;
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => String(part.text))
      .join("");
    expect(text).toBe("Spike B abort payload.");
    expect(asJson(messages[1].metadata)).toMatchObject({ aborted: true });
  });
});

describe("SPIKE B(b) — THE FENCE, module-level against the real gate database", () => {
  let threads: ThreadsModule;
  let threadId: string;
  let staleRequestId: number;
  let liveRequestId: number;
  let oracleSawThread: number;
  let staleAfterFence: RequestRow;
  let zombieResult: Awaited<ReturnType<ThreadsModule["finalizeTurn"]>>;
  let liveResult: Awaited<ReturnType<ThreadsModule["finalizeTurn"]>>;
  let messagesAfterClaim: MessageRow[];
  let messagesAfterZombie: MessageRow[];
  let messagesAfterLive: MessageRow[];
  let updatedAtAfterClaim: string;
  let updatedAtAfterZombie: string;

  const zombieMessage = {
    id: "spike-b-zombie-assistant",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "zombie output that must never land" }],
  };
  const liveMessage = {
    id: "spike-b-live-assistant",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "the live claim's real output" }],
  };

  beforeAll(async () => {
    const caseStartedAt = Date.now();
    const databaseUrl = gateDatabaseUrl();
    // Belt BEFORE the binding: the harness only ever operates on `launch_gate`.
    assertGateDatabaseUrl(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    threads = await import("../lib/assistant/threads");

    const claim = await threads.claimTurn({
      userId: MEMBER_A.userId,
      threadId: null,
      message: {
        id: "spike-b-fence-user-1",
        role: "user",
        parts: [{ type: "text", text: "spike B fence — the claim that will go stale" }],
      },
      trigger: "submit-message",
      membershipScope: [...MEMBER_A.companyIds],
      providerKind: "OLLAMA",
      model: GATE_MODEL,
    });
    threadId = claim.threadId;
    staleRequestId = claim.requestId;

    // The independent mysql2 path decides whether prisma really wrote to the gate
    // container. If it did not, nothing below this line means anything.
    const threadRows = await oracleQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM assistant_threads WHERE id = ? AND userId = ?",
      [threadId, MEMBER_A.userId],
    );
    oracleSawThread = Number(threadRows[0].n);

    await backdate(staleRequestId, BACKDATE_SECONDS);

    // A REAL second claim on the same thread: it must NOT see a live turn (the row is
    // older than the lease) and must fence the dead one on its way through.
    const takeover = await threads.claimTurn({
      userId: MEMBER_A.userId,
      threadId,
      message: {
        id: "spike-b-fence-user-2",
        role: "user",
        parts: [{ type: "text", text: "spike B fence — the takeover claim" }],
      },
      trigger: "submit-message",
      membershipScope: [...MEMBER_A.companyIds],
      providerKind: "OLLAMA",
      model: GATE_MODEL,
    });
    liveRequestId = takeover.requestId;

    staleAfterFence = await requestRow(staleRequestId);
    messagesAfterClaim = await messagesOf(threadId);
    updatedAtAfterClaim = await threadUpdatedAt(threadId);

    // THE ZOMBIE: the superseded request's stream finally comes back with output.
    zombieResult = await threads.finalizeTurn({
      requestId: staleRequestId,
      threadId,
      message: zombieMessage,
      cause: null,
      eventAborted: false,
      errorLatched: null,
      usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
      durationMs: 4_242,
    });
    messagesAfterZombie = await messagesOf(threadId);
    updatedAtAfterZombie = await threadUpdatedAt(threadId);

    // The control: the SAME call, on the LIVE claim, does write.
    liveResult = await threads.finalizeTurn({
      requestId: liveRequestId,
      threadId,
      message: liveMessage,
      cause: null,
      eventAborted: false,
      errorLatched: null,
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      durationMs: 1_234,
    });
    messagesAfterLive = await messagesOf(threadId);
    console.log(`[launch-gate] B(b) wall clock: ${Date.now() - caseStartedAt}ms (module-level, no HTTP)`);
  }, 60_000);

  afterAll(async () => {
    // The suite's own PrismaClient must not outlive the file, or the worker hangs.
    const { default: prisma } = await import("../lib/prisma");
    await prisma.$disconnect();
  });

  it("bound the prisma singleton to the gate container (the oracle sees what it wrote)", () => {
    expect(oracleSawThread).toBe(1);
    expect(threadId).toMatch(/^[a-z0-9]+$/);
  });

  it("fenced the stale claim SUPERSEDED instead of refusing the takeover", () => {
    expect(staleAfterFence.status).toBe("error");
    expect(staleAfterFence.errorCode).toBe("SUPERSEDED");
    expect(liveRequestId).toBeGreaterThan(staleRequestId);
    expect(messagesAfterClaim.map((message) => message.id)).toEqual([
      "spike-b-fence-user-1",
      "spike-b-fence-user-2",
    ]);
  });

  it("the zombie's finalize writes NOTHING: { finalized: false, status: null }", () => {
    expect(zombieResult).toEqual({ finalized: false, status: null });
  });

  it("no assistant row appeared and the thread was not touched", () => {
    expect(messagesAfterZombie.map((message) => message.id)).toEqual(
      messagesAfterClaim.map((message) => message.id),
    );
    expect(messagesAfterZombie.some((message) => message.id === zombieMessage.id)).toBe(false);
    expect(updatedAtAfterZombie).toBe(updatedAtAfterClaim);
  });

  it("did not overwrite the fenced row's own terminal state", async () => {
    const stale = await requestRow(staleRequestId);
    expect(stale.status).toBe("error");
    expect(stale.errorCode).toBe("SUPERSEDED");
    expect(stale.durationMs).toBeNull();
  });

  it("CONTROL: the same finalize on the LIVE claim does write", () => {
    expect(liveResult).toEqual({ finalized: true, status: "ok" });
    expect(messagesAfterLive.map((message) => message.id)).toEqual([
      "spike-b-fence-user-1",
      "spike-b-fence-user-2",
      liveMessage.id,
    ]);
  });
});

describe("SPIKE B(c) — the crash path: SIGKILL, restart, lease, fence", () => {
  let threadId: string;
  let crashed: RequestRow;
  let rowAfterCrash: RequestRow;
  let generationBefore: number;
  let generationAfter: number;
  let busyStatus: number;
  let busyBody: { error?: string; code?: string };
  let busyAgeMs: number;
  let afterRestartDetail: number;
  let restartMs: number;
  let successStatus: number;
  let successText: string;
  let rowAfterTakeover: RequestRow;

  beforeAll(async () => {
    const caseStartedAt = Date.now();
    const session = await loginOnce("memberA");

    // 1. A completed turn, so the crash lands on a thread that already exists.
    const setup = await postTurn(session, {
      threadId: null,
      message: {
        id: "spike-b-crash-setup",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("spike-b-simple") }],
      },
      trigger: "submit-message",
    });
    if (setup.status !== 200 || setup.threadId === null) {
      throw new Error(`B(c) setup turn failed (${setup.status}): ${setup.raw.slice(0, 1_000)}`);
    }
    threadId = setup.threadId;
    // The setup turn's claim must be RELEASED before the next POST, or the crash turn
    // 409s on a turn whose stream the client already saw end.
    await settleTurn(threadId, { deadlineMs: 20_000 });

    // 2. A turn that holds its stream open, killed while genuinely in flight.
    const before = await maxRequestId();
    const inFlight = postTurn(session, {
      threadId,
      message: {
        id: "spike-b-crash-user",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("spike-b-crash") }],
      },
      trigger: "submit-message",
    }).then(
      () => undefined,
      () => undefined,
    );
    crashed = await pollForNewRequest(before, 20_000, "B(c) crash claim");
    expect(crashed.status).toBe("running");

    const { pgid } = readState().processes.app;
    if (pgid <= 0 || pgid === process.pid || pgid === process.ppid) {
      throw new Error(`refusing to signal process group ${pgid} — that is not the app under test`);
    }
    // The whole GROUP: `npx next dev` is two processes and killing only the outer one
    // would orphan the inner one onto port 3100.
    process.kill(-pgid, "SIGKILL");
    await inFlight;
    await waitForAppDown(15_000);
    rowAfterCrash = await requestRow(crashed.id);

    // 3. Restart. This suite is restartApp()'s first real caller (pack REV-7 recorded
    //    it as UNEXERCISED), so the generation bump and the cookie survival are
    //    themselves under assertion below.
    generationBefore = readState().appGeneration;
    const restartStartedAt = Date.now();
    await restartApp();
    restartMs = Date.now() - restartStartedAt;
    generationAfter = readState().appGeneration;

    const detail = await apiGet(session, `/api/assistant/threads/${threadId}`);
    afterRestartDetail = detail.status;

    // 4. The crashed row is YOUNG: the lease says the thread is still busy.
    const busy = await postTurn(session, {
      threadId,
      message: {
        id: "spike-b-busy-user",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("spike-b-simple") }],
      },
      trigger: "submit-message",
    });
    busyStatus = busy.status;
    busyBody = JSON.parse(busy.raw || "{}") as { error?: string; code?: string };
    busyAgeMs = Number((await requestRow(crashed.id)).ageMs);

    // 5. Age it past the lease (BACKDATE, never sleep) — now the next claim fences it.
    await backdate(crashed.id, BACKDATE_SECONDS);
    const success = await postTurn(session, {
      threadId,
      message: {
        id: "spike-b-fenced-user",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("spike-b-simple") }],
      },
      trigger: "submit-message",
    });
    successStatus = success.status;
    successText = success.text;
    rowAfterTakeover = await requestRow(crashed.id);
    console.log(
      `[launch-gate] B(c) wall clock: ${Date.now() - caseStartedAt}ms (incl. restartApp ${restartMs}ms)`,
    );
  }, 240_000);

  it("leaves the request row `running` after SIGKILL — nothing fired, nothing lied", () => {
    expect(rowAfterCrash.status).toBe("running");
    expect(rowAfterCrash.errorCode).toBeNull();
    expect(rowAfterCrash.durationMs).toBeNull();
  });

  it("restartApp() bumped the generation and the session cookie survived", () => {
    expect(generationAfter).toBe(generationBefore + 1);
    // A JWT session against the same NEXTAUTH_SECRET: no re-login, no credentials
    // limiter spend. A 401 here would be a harness defect, not a fence verdict.
    expect(afterRestartDetail).toBe(200);
  });

  it("a YOUNG crashed row still blocks the thread: THREAD_BUSY", () => {
    expect(busyAgeMs).toBeLessThan(CLAIM_STALE_MS);
    expect(busyStatus).toBe(409);
    expect(busyBody).toEqual({
      error: "A response is already streaming in this thread",
      code: "THREAD_BUSY",
    });
  });

  it("once older than the lease it is FENCED SUPERSEDED and the next turn streams", () => {
    expect(successStatus).toBe(200);
    expect(successText).toBe("Spike B simple turn complete.");
    expect(rowAfterTakeover.status).toBe("error");
    expect(rowAfterTakeover.errorCode).toBe("SUPERSEDED");
  });
});

describe("SPIKE B(d) — bounded finalization at the route-owned T2 deadline", () => {
  /**
   * Both cases: fire the turn, DO NOT wait for the stream (a blocked read never
   * returns), poll the request row out of `running`, and read the clock off the row
   * the route itself wrote. `durationMs` is measured from just after the claim, which
   * is exactly where pack REV-4 says the T2 clock starts.
   */
  async function driveStalledTurn(
    scenario: string,
    messageId: string,
  ): Promise<{ row: RequestRow; messages: MessageRow[]; observedMs: number }> {
    const session = await loginOnce("memberA");
    const controller = new AbortController();
    const before = await maxRequestId();
    const startedAt = Date.now();

    const inFlight = postTurn(
      session,
      {
        threadId: null,
        message: { id: messageId, role: "user", parts: [{ type: "text", text: gatePrompt(scenario) }] },
        trigger: "submit-message",
      },
      { signal: controller.signal },
    ).then(
      () => undefined,
      () => undefined,
    );

    const created = await pollForNewRequest(before, 20_000, `B(d) ${scenario} claim`);
    const row = await pollRequest(
      created.id,
      (candidate) => candidate.status !== "running",
      // Generous enough to SEE a late finalize (which would fail the lease assertion
      // with real evidence) rather than time out ambiguously.
      100_000,
      `B(d) ${scenario} finalize`,
      1_000,
    );
    const observedMs = Date.now() - startedAt;
    console.log(
      `[launch-gate] B(d) ${scenario}: request ${created.id} left \`running\` ${observedMs}ms after the POST ` +
        `(route-recorded durationMs=${row.durationMs}, lease ${CLAIM_STALE_MS}ms)`,
    );
    // The route has finalized; the client half is now pure cost. The shim's own hold
    // cap releases the server-side socket shortly after.
    controller.abort();
    await inFlight;
    return { row, messages: await messagesOf(String(created.threadId)), observedMs };
  }

  describe("(i) content, then an indefinite stall", () => {
    let outcome: Awaited<ReturnType<typeof driveStalledTurn>>;

    beforeAll(async () => {
      outcome = await driveStalledTurn("spike-b-stall", "spike-b-stall-user");
    }, 110_000);

    it("finalizes error/PROVIDER_TIMEOUT — never `aborted`, never `ok`", () => {
      expect(outcome.row.status).toBe("error");
      expect(outcome.row.errorCode).toBe("PROVIDER_TIMEOUT");
    });

    it("fires at the T2 deadline and BEFORE the lease", () => {
      const durationMs = Number(outcome.row.durationMs);
      expect(durationMs).toBeGreaterThanOrEqual(FINALIZE_DEADLINE_MS - 1_000);
      expect(durationMs).toBeLessThan(CLAIM_STALE_MS);
      expect(outcome.observedMs).toBeLessThan(CLAIM_STALE_MS);
    });

    it("persists the ACCUMULATOR's partial with the PROVIDER_TIMEOUT metadata", () => {
      expect(outcome.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      const parts = asJson(outcome.messages[1].parts) as Array<{ type: string; text?: string }>;
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => String(part.text))
        .join("");
      expect(text).toBe("Spike B stalled partial.");
      expect(asJson(outcome.messages[1].metadata)).toMatchObject({ errorCode: "PROVIDER_TIMEOUT" });
    });
  });

  describe("(ii) an indefinitely-open SILENT stream", () => {
    let outcome: Awaited<ReturnType<typeof driveStalledTurn>>;

    beforeAll(async () => {
      outcome = await driveStalledTurn("spike-b-silent", "spike-b-silent-user");
    }, 110_000);

    it("finalizes error/PROVIDER_TIMEOUT on the same bounded clock", () => {
      expect(outcome.row.status).toBe("error");
      expect(outcome.row.errorCode).toBe("PROVIDER_TIMEOUT");
      const durationMs = Number(outcome.row.durationMs);
      expect(durationMs).toBeGreaterThanOrEqual(FINALIZE_DEADLINE_MS - 1_000);
      expect(durationMs).toBeLessThan(CLAIM_STALE_MS);
    });

    it("writes NO assistant row: nothing was streamed, so nothing is claimed", () => {
      expect(outcome.messages.map((message) => message.role)).toEqual(["user"]);
    });
  });
});
