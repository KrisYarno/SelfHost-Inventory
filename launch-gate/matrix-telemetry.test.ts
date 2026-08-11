/**
 * launch-gate/matrix-telemetry.test.ts — ASSERTION MATRIX ROW 5: telemetry
 * (plan Task 1.8; spec C7 row 5).
 *
 * THE CLAIM: `assistant_requests` is an AUDIT record, not a summary. Every number in
 * it is either what the provider actually reported or NULL — never a 0 standing in
 * for "we did not measure" (G2, the lane's truthful-data north star applied to its
 * own bookkeeping).
 *
 * USAGE IS RECOMPUTED, NEVER HARD-CODED. The expected token counts are summed from
 * the choreography JSON at assertion time (pack REV-9: "later tasks recompute, never
 * hardcode"), and `result.usage` in ai@7.0.29 is documented as the SUM over all steps
 * — so a three-step scenario with three different scripted usages is the only shape
 * that can tell a summing route from a last-step-only one.
 *
 * MODULE-LEVEL WORK, declared: the NULL-preservation case. The shim ALWAYS reports
 * usage on its terminal frame (a `done:true` frame without `prompt_eval_count` is not
 * a thing the ollama wire does, and inventing one would be testing a fiction), so
 * "the provider reported nothing" is arranged where it actually happens — by calling
 * `finalizeTurn` with `usage: null` against the real gate database, spike-b B(b)'s
 * precedent. Its POSITIVE CONTROL is a sibling claim finalized with real numbers, so
 * "the column is NULL" cannot pass on a writer that simply never writes.
 *
 * TITLE CASES WERE SKIPPED CHARTERS (plan G2-2 / cluster F) while
 * `lib/assistant/titles.ts` was the W1 STUB. Task 2.3 filled it and Task 2.4a UNSKIPPED
 * them here, red-first: every reconciliation between the charter text and the as-built
 * contract is declared inline, above the block, with the pack row that justifies it.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import path from "node:path";
import { asJson, settleTurn, sleep } from "./assertions";
import { TITLE_SCRIPT, gatePrompt, loadChoreographies, type Choreography } from "./choreography";
import { loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_MODEL, GATE_SEED } from "./seed";
// ONE source of truth for the scenario the shim answers with a scripted title FAILURE
// (pack REV-13 S6-A keys it off the C6 system prompt AND this id).
import { TITLE_FAILING_SCENARIO } from "./shim";
import { assertGateDatabaseUrl, gateDatabaseUrl } from "./state";

type ThreadsModule = typeof import("../lib/assistant/threads");

const CHOREOGRAPHY_DIR = path.join(__dirname, "choreography");
const MEMBER_A = GATE_SEED.actors.memberA;
const ADMIN = GATE_SEED.actors.admin;
const ZERO_USER = GATE_SEED.actors.zeroUser;

type RequestRow = {
  id: number;
  threadId: string | null;
  userId: number;
  kind: string;
  providerKind: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
  status: string;
  errorCode: string | null;
  membershipScope: unknown;
  dayKey: string;
};

const REQUEST_COLUMNS =
  "id, threadId, userId, kind, providerKind, model, inputTokens, outputTokens, totalTokens, " +
  "durationMs, status, errorCode, membershipScope, dayKey";

async function requestRowsOf(threadId: string): Promise<RequestRow[]> {
  return oracleQuery<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE threadId = ? ORDER BY id`,
    [threadId],
  );
}

async function requestRowById(id: number): Promise<RequestRow> {
  const rows = await oracleQuery<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE id = ?`,
    [id],
  );
  if (rows.length !== 1) throw new Error(`assistant_requests row ${id} not found`);
  return rows[0];
}

/** The scripted usage SUM for a scenario, read off the committed JSON. */
function scriptedUsage(scenario: Choreography): { input: number; output: number; total: number } {
  const input = scenario.steps.reduce((sum, step) => sum + step.usage.prompt_eval_count, 0);
  const output = scenario.steps.reduce((sum, step) => sum + step.usage.eval_count, 0);
  return { input, output, total: input + output };
}

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Drive one scripted turn to a settled request row. */
async function drive(
  user: Parameters<typeof loginOnce>[0],
  scenario: string,
  messageId: string,
): Promise<TurnResult> {
  const session = await loginOnce(user);
  const turn = await postTurn(session, {
    threadId: null,
    message: {
      id: messageId,
      role: "user",
      parts: [{ type: "text", text: gatePrompt(scenario) }],
    },
    trigger: "submit-message",
  });
  if (turn.status !== 200 || turn.threadId === null) {
    throw new Error(`row-5 turn ${messageId} failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
  }
  await settleTurn(turn.threadId, { requireAssistantRow: true, label: `the ${scenario} turn` });
  return turn;
}

describe("MATRIX ROW 5 — request + run telemetry", () => {
  let usageTurn: TurnResult;
  let usageRow: RequestRow;
  let adminRow: RequestRow;
  let zeroRow: RequestRow;
  let dayKeyBeforePost: string;
  let dayKeyAfterPost: string;

  beforeAll(async () => {
    const startedAt = Date.now();

    dayKeyBeforePost = utcDayKey();
    usageTurn = await drive("memberA", "tel-usage-sums", "gate-tel-usage-user");
    dayKeyAfterPost = utcDayKey();
    [usageRow] = await requestRowsOf(usageTurn.threadId as string);

    const adminTurn = await drive("admin", "tel-scope-echo", "gate-tel-admin-user");
    [adminRow] = await requestRowsOf(adminTurn.threadId as string);

    const zeroTurn = await drive("zeroUser", "tel-scope-echo", "gate-tel-zero-user");
    [zeroRow] = await requestRowsOf(zeroTurn.threadId as string);

    console.log(`[launch-gate] row 5: three telemetry turns in ${Date.now() - startedAt}ms`);
  }, 120_000);

  describe("chat request rows carry the EXACT scripted usage, summed across steps", () => {
    it("matches the choreography file's totals", () => {
      const scenario = loadChoreographies(CHOREOGRAPHY_DIR).get("tel-usage-sums");
      if (scenario === undefined) throw new Error("tel-usage-sums is not a loaded scenario");
      const expected = scriptedUsage(scenario);
      expect(scenario.steps).toHaveLength(3);
      expect({
        inputTokens: Number(usageRow.inputTokens),
        outputTokens: Number(usageRow.outputTokens),
        totalTokens: Number(usageRow.totalTokens),
      }).toEqual({
        inputTokens: expected.input,
        outputTokens: expected.output,
        totalTokens: expected.total,
      });
    });

    it("is a SUM, not the last step's numbers (the three steps differ on purpose)", () => {
      const scenario = loadChoreographies(CHOREOGRAPHY_DIR).get("tel-usage-sums");
      if (scenario === undefined) throw new Error("tel-usage-sums is not a loaded scenario");
      const lastStep = scenario.steps[scenario.steps.length - 1].usage;
      expect(Number(usageRow.inputTokens)).not.toBe(lastStep.prompt_eval_count);
      expect(Number(usageRow.outputTokens)).not.toBe(lastStep.eval_count);
      // …and totalTokens is genuinely input+output, not a third independent report.
      expect(Number(usageRow.totalTokens)).toBe(
        Number(usageRow.inputTokens) + Number(usageRow.outputTokens),
      );
    });

    it("records the resolved provider, model, kind and a real duration", () => {
      expect({
        kind: usageRow.kind,
        providerKind: usageRow.providerKind,
        model: usageRow.model,
        status: usageRow.status,
        errorCode: usageRow.errorCode,
      }).toEqual({
        kind: "chat",
        providerKind: "OLLAMA",
        model: GATE_MODEL,
        status: "ok",
        errorCode: null,
      });
      expect(Number(usageRow.durationMs)).toBeGreaterThan(0);
    });
  });

  describe("membershipScope is the caller's snapshot at request time", () => {
    it("memberA's row carries memberA's companies", () => {
      expect(asJson(usageRow.membershipScope)).toEqual(MEMBER_A.companyIds);
      expect(Number(usageRow.userId)).toBe(MEMBER_A.userId);
    });

    it("admin's row carries A + B — memberships only, even for an admin", () => {
      expect(asJson(adminRow.membershipScope)).toEqual(ADMIN.companyIds);
      expect(Number(adminRow.userId)).toBe(ADMIN.userId);
      expect(asJson(adminRow.membershipScope)).not.toEqual(asJson(usageRow.membershipScope));
    });

    it("zeroUser's row carries an EMPTY array — a measured scope, never NULL", () => {
      expect(asJson(zeroRow.membershipScope)).toEqual([]);
      expect(ZERO_USER.companyIds).toEqual([]);
      expect(zeroRow.membershipScope).not.toBeNull();
    });
  });

  describe("dayKey is the UTC date of INSERTION", () => {
    it("equals the UTC day the POST was made", () => {
      // Bracketed rather than compared to one instant: a run that straddles UTC
      // midnight must not fail, and BOTH ends of the bracket are still assertions.
      expect([dayKeyBeforePost, dayKeyAfterPost]).toContain(usageRow.dayKey);
      expect(usageRow.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("is a STORED column, not a computed date (the reason C8 can group on it)", async () => {
      // Prisma cannot group a computed date and MySQL's DATE(createdAt) would silently
      // use the session timezone — which is exactly why dayKey exists as a real column
      // written by ONE function (requests.ts `utcDayKey`). If it ever became generated
      // or virtual, the C8 rollups would quietly change meaning.
      const [column] = await oracleQuery<{ COLUMN_TYPE: string; EXTRA: string; GENERATION: string | null }>(
        `SELECT COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION AS GENERATION
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'assistant_requests' AND COLUMN_NAME = 'dayKey'`,
      );
      expect(column.COLUMN_TYPE).toBe("char(10)");
      expect(column.EXTRA).not.toContain("GENERATED");
      expect(column.GENERATION === null || column.GENERATION === "").toBe(true);
    });
  });

  describe("per-tool assistant_runs rows carry the parent requestId", () => {
    it("joins every tool call of the turn back to its chat request", async () => {
      const until = Date.now() + 10_000;
      let rows: Array<{ toolName: string; surface: string; tokenId: string | null; userId: number }> = [];
      for (;;) {
        rows = await oracleQuery(
          `SELECT r.toolName, r.surface, r.tokenId, r.userId
             FROM assistant_runs r JOIN assistant_requests q ON q.id = r.requestId
            WHERE q.id = ? ORDER BY r.id`,
          [usageRow.id],
        );
        if (rows.length >= 2 || Date.now() > until) break;
        // recordAssistantRun is dispatched with `void` — best-effort by design, so the
        // row lands shortly AFTER the tool answered.
        await sleep(100);
      }
      expect(rows.map((row) => row.toolName)).toEqual(["get_inventory_summary", "get_stock"]);
      for (const row of rows) {
        expect(row.surface).toBe("assistant");
        // The chat surface has no token: attribution is the session's userId.
        expect(row.tokenId).toBeNull();
        expect(Number(row.userId)).toBe(MEMBER_A.userId);
      }
    });

    it("leaves no orphan: every run row of this turn points at a real request row", async () => {
      const [row] = await oracleQuery<{ orphans: number }>(
        `SELECT COUNT(*) AS orphans FROM assistant_runs r
          WHERE r.requestId IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM assistant_requests q WHERE q.id = r.requestId)`,
      );
      expect(Number(row.orphans)).toBe(0);
    });
  });
});

// =========================================================================
describe("NULL usage is PRESERVED as NULL, never written as 0 (G2)", () => {
  let threads: ThreadsModule;
  let measured: RequestRow;
  let unreported: RequestRow;
  let undefinedFields: RequestRow;

  beforeAll(async () => {
    const databaseUrl = gateDatabaseUrl();
    assertGateDatabaseUrl(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    threads = await import("../lib/assistant/threads");

    const claim = async (id: string) =>
      threads.claimTurn({
        userId: MEMBER_A.userId,
        threadId: null,
        message: { id, role: "user", parts: [{ type: "text", text: `row 5 ${id}` }] },
        trigger: "submit-message",
        membershipScope: [...MEMBER_A.companyIds],
        providerKind: "OLLAMA",
        model: GATE_MODEL,
      });

    const finalize = async (
      requestId: number,
      threadId: string,
      usage: Parameters<ThreadsModule["finalizeTurn"]>[0]["usage"],
    ) =>
      threads.finalizeTurn({
        requestId,
        threadId,
        message: null,
        cause: null,
        eventAborted: false,
        errorLatched: null,
        usage,
        durationMs: 4_242,
      });

    // POSITIVE CONTROL first: the same writer, with real numbers, DOES write them.
    const control = await claim("gate-tel-null-control-user");
    await finalize(control.requestId, control.threadId, {
      inputTokens: 7,
      outputTokens: 9,
      totalTokens: 16,
    });
    measured = await requestRowById(control.requestId);

    // The provider reported NOTHING (the route's 2s usage race timed out or rejected).
    const missing = await claim("gate-tel-null-missing-user");
    await finalize(missing.requestId, missing.threadId, null);
    unreported = await requestRowById(missing.requestId);

    // The provider answered but omitted the fields — `undefined`, not 0.
    const partial = await claim("gate-tel-null-partial-user");
    await finalize(partial.requestId, partial.threadId, {
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    undefinedFields = await requestRowById(partial.requestId);
  }, 60_000);

  afterAll(async () => {
    const { default: prisma } = await import("../lib/prisma");
    await prisma.$disconnect();
  });

  it("CONTROL: reported numbers are written exactly", () => {
    expect({
      inputTokens: Number(measured.inputTokens),
      outputTokens: Number(measured.outputTokens),
      totalTokens: Number(measured.totalTokens),
      status: measured.status,
      durationMs: Number(measured.durationMs),
    }).toEqual({
      inputTokens: 7,
      outputTokens: 9,
      totalTokens: 16,
      status: "ok",
      durationMs: 4_242,
    });
  });

  it("a turn with NO reported usage persists NULLs — and still finalizes `ok`", () => {
    expect(unreported.inputTokens).toBeNull();
    expect(unreported.outputTokens).toBeNull();
    expect(unreported.totalTokens).toBeNull();
    expect(unreported.status).toBe("ok");
    // The row is otherwise complete: unmeasured usage is not an unmeasured TURN.
    expect(Number(unreported.durationMs)).toBe(4_242);
  });

  it("undefined token FIELDS persist as NULLs too (never 0-as-measurement)", () => {
    expect(undefinedFields.inputTokens).toBeNull();
    expect(undefinedFields.outputTokens).toBeNull();
    expect(undefinedFields.totalTokens).toBeNull();
    // The distinction that matters on the usage page: NULL is not 0.
    expect(undefinedFields.inputTokens).not.toBe(0);
  });
});

// =========================================================================
// TITLE CHARTERS — WRITTEN SKIPPED BY 1.8, UNSKIPPED HERE (plan Task 2.4a; pack REV-3).
//
// They were charters because `lib/assistant/titles.ts` was 1.2's STUB. Task 2.3 filled
// it, so they now run against the REAL module. Every EXPECTED SHAPE below that moved
// from the charter text is a RECONCILIATION against the as-built contract, and each one
// names the pack row that justifies it:
//
//   REV-13 (2.3 as-built) — the resolve chain is `surfaces.title ?? surfaces.assistant
//     ?? default` and the gate seeds NO title surface, so the row's providerKind/model
//     are the DEFAULT surface's (S6-B). Pinned, because "gate-scripted" arriving on a
//     title row is the observable end of that chain.
//   REV-13 (S6-A) — the shim's title discriminant is the C6 SYSTEM PROMPT. Before that
//     fix EVERY title call fell into the scenario path and failed, which made the
//     FAILING charter pass for the wrong reason; the success charter is the control
//     that separates them, so both are asserted POSITIVELY (a title that succeeds AND a
//     title that fails, in the same run, against the same shim).
//   REV-8 (THE SETTLE BARRIER) + spec C6 (detached) — `settleTurn` watches the CHAT
//     request row and says NOTHING about a title, which is fired after the finalize
//     commits and never awaited. Every title assertion below polls to a deadline that
//     covers the worst legal path (the 10s race, then the fallback write and the fenced
//     finalize). The charter's one-shot `before` count in the later-fallback case would
//     have been read while the FIRST turn's title was still in flight — reconciled to a
//     settled read plus a bounded watch.
//   REV-9 (recompute, never hardcode) — the chat row's own usage is read from the
//     database and asserted DIFFERENT from the title row's, so "the title row carries
//     the title call's own usage" cannot pass on a row that copied the turn's.
//
// Nothing was weakened: every charter assertion survives, and each reconciliation adds
// a constraint rather than removing one.

/** The `title-*` scenarios (2.4a's namespace). Their chat turns are deliberately
 *  trivial one-step text turns — the interesting behaviour is on the TITLE path, which
 *  reuses the chat turn's first user text as its prompt. */
const TITLE_CREATING_SCENARIO = "title-creating-model";

/**
 * THE TITLE BARRIER. A title call is DETACHED (spec C6): the route fires it AFTER the
 * finalize transaction commits and never awaits it, so a turn that has settled by the
 * REV-8 barrier may still have no title row at all. Bounded, never a fixed sleep.
 *
 * 20s covers the worst legal path: `titles.ts`'s 10s `Promise.race`, the provider's own
 * retries inside it, then the conditional title write and the fenced row finalize.
 */
const TITLE_DEADLINE_MS = 20_000;

/** Poll until the thread's ONE title row exists and has left `running`. Returns the
 *  row and how long it took — the wait itself is evidence (the later-fallback case
 *  sizes its negative window from it). */
async function settledTitleRow(threadId: string): Promise<{ row: RequestRow; waitedMs: number }> {
  const startedAt = Date.now();
  for (;;) {
    const rows = await oracleQuery<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE threadId = ? AND kind = 'title' ORDER BY id`,
      [threadId],
    );
    if (rows.length > 1) {
      throw new Error(
        `thread ${threadId} carries ${rows.length} title rows — the C6 bound is at most one`,
      );
    }
    if (rows.length === 1 && rows[0].status !== "running") {
      return { row: rows[0], waitedMs: Date.now() - startedAt };
    }
    if (Date.now() - startedAt > TITLE_DEADLINE_MS) {
      throw new Error(
        `no settled title row for thread ${threadId} within ${TITLE_DEADLINE_MS}ms ` +
          `(rows=${rows.length}, status=${rows[0]?.status ?? "none"})`,
      );
    }
    await sleep(200);
  }
}

async function titleRowCount(threadId: string): Promise<number> {
  const [row] = await oracleQuery<{ n: number }>(
    "SELECT COUNT(*) AS n FROM assistant_requests WHERE threadId = ? AND kind = 'title'",
    [threadId],
  );
  return Number(row.n);
}

async function titleOf(threadId: string): Promise<string | null> {
  const [thread] = await oracleQuery<{ title: string | null }>(
    "SELECT title FROM assistant_threads WHERE id = ?",
    [threadId],
  );
  return thread.title;
}

describe("title request rows (spec C6/C7 row 5)", () => {
  let threadId: string;
  let titleRow: RequestRow;
  let chatRow: RequestRow;
  let dayKeyBefore: string;
  let dayKeyAfter: string;

  beforeAll(async () => {
    // The FIRST turn of a brand-new thread: the only turn that dispatches mode
    // "creating-model" and therefore the only one that ever spends a model title.
    dayKeyBefore = utcDayKey();
    const turn = await drive("memberA", TITLE_CREATING_SCENARIO, "gate-title-user");
    threadId = turn.threadId as string;
    const settled = await settledTitleRow(threadId);
    titleRow = settled.row;
    dayKeyAfter = utcDayKey();
    [chatRow] = await requestRowsOf(threadId);
    console.log(
      `[launch-gate] row 5 title: the detached title row settled ${settled.waitedMs}ms after the ` +
        "chat turn was already settled by the REV-8 barrier",
    );
  }, 120_000);

  it('writes ONE kind="title" row with the title call\'s OWN scripted usage', () => {
    expect(titleRow.kind).toBe("title");
    expect(titleRow.status).toBe("ok");
    expect(titleRow.errorCode).toBeNull();
    // The shim's TITLE_SCRIPT usage — NOT the chat turn's, which is the whole point of
    // a separate row: title spend is real spend and is attributed separately.
    expect({
      inputTokens: Number(titleRow.inputTokens),
      outputTokens: Number(titleRow.outputTokens),
      totalTokens: Number(titleRow.totalTokens),
    }).toEqual({
      inputTokens: TITLE_SCRIPT.usage.prompt_eval_count,
      outputTokens: TITLE_SCRIPT.usage.eval_count,
      totalTokens: TITLE_SCRIPT.usage.prompt_eval_count + TITLE_SCRIPT.usage.eval_count,
    });
    expect(Number(titleRow.durationMs)).toBeGreaterThan(0);
  });

  it("RECONCILED (pack REV-9): the chat row of the SAME turn carries DIFFERENT usage", () => {
    // Recomputed from the committed JSON, never hardcoded — and asserted UNEQUAL, so
    // "the title row carries the title call's usage" cannot pass on a row that simply
    // copied the turn's numbers.
    const scenario = loadChoreographies(CHOREOGRAPHY_DIR).get(TITLE_CREATING_SCENARIO);
    if (scenario === undefined) throw new Error(`${TITLE_CREATING_SCENARIO} is not a loaded scenario`);
    const expected = scriptedUsage(scenario);
    expect({
      kind: chatRow.kind,
      inputTokens: Number(chatRow.inputTokens),
      outputTokens: Number(chatRow.outputTokens),
    }).toEqual({ kind: "chat", inputTokens: expected.input, outputTokens: expected.output });
    expect(Number(chatRow.inputTokens)).not.toBe(Number(titleRow.inputTokens));
    expect(Number(chatRow.outputTokens)).not.toBe(Number(titleRow.outputTokens));
  });

  it("carries the SAME membershipScope + dayKey discipline as a chat row", () => {
    expect(asJson(titleRow.membershipScope)).toEqual(MEMBER_A.companyIds);
    expect(Number(titleRow.userId)).toBe(MEMBER_A.userId);
    // RECONCILED: bracketed like the chat-row case above rather than compared to one
    // instant — a run straddling UTC midnight must not fail, and both ends are still
    // assertions.
    expect([dayKeyBefore, dayKeyAfter]).toContain(titleRow.dayKey);
    expect(titleRow.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(titleRow.providerKind).toBe("OLLAMA");
    // RECONCILED (pack REV-13 S6-B): no `surfaces.title` is seeded, so the row's model
    // is what the fallback chain resolved — `surfaces.title ?? surfaces.assistant ??
    // default`. This value IS the chain's observable outcome.
    expect(titleRow.model).toBe(GATE_MODEL);
  });

  it("sets the thread title from the model output, sanitized to <= 120 chars", async () => {
    const title = await titleOf(threadId);
    expect(title).toBe(TITLE_SCRIPT.text);
    expect(String(title).length).toBeLessThanOrEqual(120);
    // RECONCILED (pack REV-13 S6-A): the exact regression the shim discriminant fix is
    // about. With the OLD non-GATE-prompt rule the title call landed on the scenario
    // path, came back empty, and this thread ended up wearing the 60-char truncation of
    // its own user text instead of a model title.
    expect(title).not.toBe(gatePrompt(TITLE_CREATING_SCENARIO));
  });

  it("spends AT MOST one model title per thread (the C6 bound)", async () => {
    expect(await titleRowCount(threadId)).toBe(1);
  });
});

describe("a FAILED title call is still attributed (spec C6)", () => {
  let threadId: string;
  let failedRow: RequestRow;

  beforeAll(async () => {
    // The shim answers this scenario's TITLE call with a 500 (the failing-title
    // affordance owed by pack REV-10 and keyed per REV-13 S6-A: the C6 system prompt
    // AND this scenario id). The CHAT turn itself is a trivially green text turn — the
    // failure under test is on the title path alone.
    const turn = await drive("memberA", TITLE_FAILING_SCENARIO, "gate-title-fail-user");
    threadId = turn.threadId as string;
    const settled = await settledTitleRow(threadId);
    failedRow = settled.row;
    console.log(
      `[launch-gate] row 5 failing title: settled ${settled.waitedMs}ms after the chat turn ` +
        `(status ${failedRow.status}/${failedRow.errorCode}, durationMs ${failedRow.durationMs})`,
    );
  }, 120_000);

  it("records status error / PROVIDER_ERROR with NULL usage and a real duration", () => {
    expect({ status: failedRow.status, errorCode: failedRow.errorCode }).toEqual({
      status: "error",
      errorCode: "PROVIDER_ERROR",
    });
    expect(failedRow.inputTokens).toBeNull();
    expect(failedRow.outputTokens).toBeNull();
    expect(failedRow.totalTokens).toBeNull();
    expect(Number(failedRow.durationMs)).toBeGreaterThan(0);
    // The row is still fully attributed: a failed call is spend that happened.
    expect(asJson(failedRow.membershipScope)).toEqual(MEMBER_A.companyIds);
    expect(Number(failedRow.userId)).toBe(MEMBER_A.userId);
    expect(failedRow.model).toBe(GATE_MODEL);
  });

  it("still falls back to a 60-char truncation of the first user text", async () => {
    const title = await titleOf(threadId);
    expect(title).not.toBeNull();
    expect(String(title).length).toBeLessThanOrEqual(60);
    // RECONCILED (pack REV-13, the as-built fallback = collapse -> cut 60 -> trim): the
    // first user text is this scenario's gate prompt, so the fallback is EXACTLY that
    // string. Asserting the value — not just its length — is what makes this different
    // from the success case rather than merely shorter.
    expect(title).toBe(gatePrompt(TITLE_FAILING_SCENARIO));
    expect(title).not.toBe(TITLE_SCRIPT.text);
  });
});

describe("later-fallback makes NO model call (spec C6 / pack T6)", () => {
  let threadId: string;
  let createdWaitMs: number;
  let secondTurnRequests: RequestRow[];
  let titleAfter: string | null;
  let watchedMs = 0;

  beforeAll(async () => {
    // A SECOND turn in an EXISTING thread dispatches mode "later-fallback": no model
    // call, no request row, and (because the creating turn already titled the thread)
    // no write at all.
    const first = await drive("memberA", TITLE_CREATING_SCENARIO, "gate-title-later-1");
    threadId = first.threadId as string;

    // POSITIVE CONTROL, in this same case: the creating turn's title row DID appear,
    // and how long it took is measured here. Without it, "no row appeared" would be
    // satisfied by a harness that simply never looked long enough.
    ({ waitedMs: createdWaitMs } = await settledTitleRow(threadId));
    expect(await titleRowCount(threadId)).toBe(1);

    const session = await loginOnce("memberA");
    const second = await postTurn(session, {
      threadId,
      message: {
        id: "gate-title-later-2",
        role: "user",
        parts: [{ type: "text", text: gatePrompt(TITLE_CREATING_SCENARIO) }],
      },
      trigger: "submit-message",
    });
    if (second.status !== 200) {
      throw new Error(`the later-fallback turn failed (${second.status}): ${second.raw.slice(0, 2_000)}`);
    }
    await settleTurn(threadId, { requireAssistantRow: true, label: "the later-fallback turn" });

    // RECONCILED (spec C6 detached + pack REV-8): the negative is WATCHED, not sampled
    // once. The window is sized from the latency just measured on this very thread, so
    // it cannot be shorter than the time a title actually takes on this machine.
    const windowMs = Math.max(3_000, createdWaitMs * 3);
    const until = Date.now() + windowMs;
    for (;;) {
      const count = await titleRowCount(threadId);
      if (count !== 1) {
        throw new Error(
          `a SECOND title row appeared ${Date.now() - (until - windowMs)}ms after the ` +
            `later-fallback turn (count ${count}) — later turns must never spend a model title`,
        );
      }
      if (Date.now() > until) break;
      await sleep(200);
    }
    watchedMs = windowMs;
    secondTurnRequests = await requestRowsOf(threadId);
    titleAfter = await titleOf(threadId);
    console.log(
      `[launch-gate] row 5 later-fallback: creating title landed in ${createdWaitMs}ms; ` +
        `watched ${watchedMs}ms for a second title row and saw none`,
    );
  }, 180_000);

  it("writes NO title request row when the thread already existed", () => {
    expect(secondTurnRequests.filter((row) => row.kind === "title")).toHaveLength(1);
    expect(watchedMs).toBeGreaterThanOrEqual(3_000);
    expect(watchedMs).toBeGreaterThanOrEqual(createdWaitMs);
  });

  it("the second turn really ran (the negative above is not a turn that never happened)", () => {
    const chatRows = secondTurnRequests.filter((row) => row.kind === "chat");
    expect(chatRows).toHaveLength(2);
    expect(chatRows.map((row) => row.status)).toEqual(["ok", "ok"]);
  });

  it("leaves the creating turn's model title untouched", () => {
    // later-fallback's first read is "is this thread still untitled?" — it is not, so
    // the whole path is a no-op. A backfill that overwrote a model title with a
    // truncation would show up right here.
    expect(titleAfter).toBe(TITLE_SCRIPT.text);
  });
});
