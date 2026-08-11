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
 * TITLE CASES ARE SKIPPED CHARTERS (plan G2-2 / cluster F). `lib/assistant/titles.ts`
 * is the W1 STUB — it resolves immediately and writes nothing — so a title row does
 * not exist to assert on yet. The charters below are EXECUTABLE and carry their exact
 * expected shapes; Task 2.4a unskips them RED-FIRST once 2.3 fills the module. They
 * are explicitly excluded from the W1 exit.
 */

import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import path from "node:path";
import { asJson, settleTurn, sleep } from "./assertions";
import { TITLE_SCRIPT, gatePrompt, loadChoreographies, type Choreography } from "./choreography";
import { loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_MODEL, GATE_SEED } from "./seed";
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
// TITLE CHARTERS — EXECUTABLE, SKIPPED, and EXCLUDED FROM THE W1 EXIT (plan G2-2).
//
// `lib/assistant/titles.ts` is 1.2's STUB: `generateThreadTitle` resolves immediately
// and writes NOTHING (pack T6), so there is no `kind: "title"` row in the database to
// assert against and no thread ever gets a title. These charters state the exact
// shapes Task 2.3 must produce; Task 2.4a unskips them RED-FIRST, watches them fail
// against the stub, then fills the module. Do NOT weaken them into something the stub
// satisfies — a charter that passes today proves nothing tomorrow.
describe.skip("CHARTER (2.4a) — title request rows (spec C6/C7 row 5)", () => {
  let threadId: string;
  let titleRow: RequestRow;

  beforeAll(async () => {
    // 2.4a: drive a `title-*` choreography whose FIRST turn creates the thread, then
    // poll `assistant_requests` for the detached kind="title" row (the title call is
    // fired-and-forgotten behind the finalize fence, so it is POLLED, never read once).
    const turn = await drive("memberA", "title-creating-model", "gate-title-user");
    threadId = turn.threadId as string;
    const until = Date.now() + 20_000;
    for (;;) {
      const rows = await oracleQuery<RequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE threadId = ? AND kind = 'title'`,
        [threadId],
      );
      if (rows.length === 1 && rows[0].status !== "running") {
        titleRow = rows[0];
        break;
      }
      if (Date.now() > until) throw new Error("no settled title request row appeared");
      await sleep(200);
    }
  }, 120_000);

  it("writes ONE kind=\"title\" row with the title call's OWN scripted usage", () => {
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

  it("carries the SAME membershipScope + dayKey discipline as a chat row", () => {
    expect(asJson(titleRow.membershipScope)).toEqual(MEMBER_A.companyIds);
    expect(Number(titleRow.userId)).toBe(MEMBER_A.userId);
    expect(titleRow.dayKey).toBe(utcDayKey());
    expect(titleRow.providerKind).toBe("OLLAMA");
  });

  it("sets the thread title from the model output, sanitized to <= 120 chars", async () => {
    const [thread] = await oracleQuery<{ title: string | null }>(
      "SELECT title FROM assistant_threads WHERE id = ?",
      [threadId],
    );
    expect(thread.title).toBe(TITLE_SCRIPT.text);
    expect(String(thread.title).length).toBeLessThanOrEqual(120);
  });

  it("spends AT MOST one model title per thread (the C6 bound)", async () => {
    const [row] = await oracleQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM assistant_requests WHERE threadId = ? AND kind = 'title'",
      [threadId],
    );
    expect(Number(row.n)).toBe(1);
  });
});

describe.skip("CHARTER (2.4a) — a FAILED title call is still attributed (spec C6)", () => {
  let threadId: string;
  let failedRow: RequestRow;

  beforeAll(async () => {
    // 2.4a: a `title-*` scenario whose title path fails (the shim's title response is
    // scripted per scenario in W2), then poll for the settled row.
    const turn = await drive("memberA", "title-failing", "gate-title-fail-user");
    threadId = turn.threadId as string;
    const until = Date.now() + 20_000;
    for (;;) {
      const rows = await oracleQuery<RequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM assistant_requests WHERE threadId = ? AND kind = 'title'`,
        [threadId],
      );
      if (rows.length === 1 && rows[0].status !== "running") {
        failedRow = rows[0];
        break;
      }
      if (Date.now() > until) throw new Error("no settled failed-title row appeared");
      await sleep(200);
    }
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
  });

  it("still falls back to a 60-char truncation of the first user text", async () => {
    const [thread] = await oracleQuery<{ title: string | null }>(
      "SELECT title FROM assistant_threads WHERE id = ?",
      [threadId],
    );
    expect(thread.title).not.toBeNull();
    expect(String(thread.title).length).toBeLessThanOrEqual(60);
  });
});

describe.skip("CHARTER (2.4a) — later-fallback makes NO model call (spec C6 / pack T6)", () => {
  it("writes NO title request row when the thread already existed", async () => {
    // 2.4a: a SECOND turn in an existing thread dispatches mode "later-fallback",
    // which loads the first persisted user text and conditionally writes a 60-char
    // fallback title — with no provider call, and therefore NO assistant_requests row.
    const first = await drive("memberA", "title-creating-model", "gate-title-later-1");
    const threadId = first.threadId as string;
    const before = await oracleQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM assistant_requests WHERE threadId = ? AND kind = 'title'",
      [threadId],
    );
    const session = await loginOnce("memberA");
    await postTurn(session, {
      threadId,
      message: {
        id: "gate-title-later-2",
        role: "user",
        parts: [{ type: "text", text: gatePrompt("title-creating-model") }],
      },
      trigger: "submit-message",
    });
    await settleTurn(threadId, { requireAssistantRow: true });
    const after = await oracleQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM assistant_requests WHERE threadId = ? AND kind = 'title'",
      [threadId],
    );
    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });
});
