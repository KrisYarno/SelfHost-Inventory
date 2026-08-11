/**
 * launch-gate/matrix-reports.test.ts — the C9 launch-gate ride-along: user reports,
 * the eval surface, the export round trip, and the C8 usage rollup (plan Task 3.3;
 * spec C9 "Launch-gate ride-along (W3)" + C8; contract pack T10/T11, rows 17/18).
 *
 * THE CLAIM: everything task 3.2 and 3.1 proved against mocked prisma is re-proved
 * here against REAL MySQL, over HTTP, through the REAL routes — because three of
 * those contracts are things a mock structurally cannot answer:
 *
 *   1. FULL-TURN FIDELITY. "The report holds the full persisted transcript including
 *      tool outputs" is a claim about what the DATABASE holds after a real streamed
 *      turn. Here the report is compared against the oracle's raw-SQL read of
 *      `assistant_messages` — two independent paths to the same rows.
 *   2. EXPORT BYTE FIDELITY (G2-12). The exported bytes are compared against
 *      `serializeEvalExport(toEvalExportDto(row))` recomputed from a row this file
 *      read with mysql2, never with prisma. A JSON column round-trips through MySQL's
 *      own normalization on the way out; that is exactly what a mock cannot model.
 *   3. THE C8 groupBy (pack REV-17's registered gap). `nullUsageRequests =
 *      _count._all - _count.inputTokens` is a COUNT(*)-vs-COUNT(column) distinction
 *      that only MySQL can adjudicate. It is asserted against a raw-SQL recompute of
 *      the same fold, with a NULL-usage row deliberately created first.
 *
 * PROFILE AWARE (plan Task 3.3 part C). The report route derives its stored
 * `environment` from `NODE_ENV`, and the two profiles run the app under different
 * ones (`next dev` -> development -> "dev"; `next build && next start` -> production
 * -> "production"). The expectation is DERIVED from `appNodeEnv()`, never hard-coded,
 * so both profiles assert the real contract instead of one of them asserting a lie.
 *
 * DECLARED FIXTURES (the matrix-lifecycle precedent, :1396-1430): the two 2 MB cases
 * hand-build their threads with raw SQL. A 2 MB transcript through the real route
 * would cost ~85 POSTs against a 24 KB per-message cap — the cap behaviour under test
 * is a property of the REPORT route, not of how the rows got there, and the fixture is
 * the only affordable way to reach it.
 *
 * POST ARITHMETIC (pack T8, budget "3.3 <= 10"): THREE chat POSTs — two
 * `report-toolturn` (the fidelity thread and the ownership thread) and one
 * `title-failing` (the NULL-usage row). Everything else is a report/eval/export/usage
 * call, which the chat budget does not model and which the middleware's per-PATHNAME
 * 30-per-60s bucket cannot exhaust (`driver.apiPost` states that arithmetic in full).
 * The limiter that really binds the report path is the route's own 5/hr per USER, and
 * the four seeded actors are spent deliberately: memberA 3 (fidelity, truncation, the
 * 413 attempt), zeroUser 2 + admin 1 (the ownership 404s — refused attempts DO count),
 * noFactsUser 6 (the limiter case itself, five allowed then the refusal).
 */

import { beforeAll, describe, expect, it } from "@jest/globals";
import { canonicalJson, settleTurn, sleep } from "./assertions";
import { gatePrompt } from "./choreography";
import { apiGet, apiPost, loginOnce, postTurn, type ApiResponse, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_MODEL, GATE_SEED } from "./seed";
import { TITLE_FAILING_SCENARIO } from "./shim";
import { appNodeEnv, assertGateDatabaseUrl, gateDatabaseUrl, gateProfile } from "./state";

type EvalContractsModule = typeof import("../lib/assistant/eval-contracts");

const MEMBER_A = GATE_SEED.actors.memberA;
const ADMIN = GATE_SEED.actors.admin;

const REPORT_SCENARIO = "report-toolturn";

/**
 * The product's OWN serializer is the comparand (pack row 18: "export round-trip byte
 * == `serializeEvalExport(toEvalExportDto(row))`"). Loading it needs the prisma
 * singleton bound to the gate container first — `eval-contracts` reaches prisma
 * through `serializedBytes`, and the client reads DATABASE_URL at module load
 * (spike-b B(b)'s binding, matrix-lifecycle:1434-1439).
 */
async function loadEvalContracts(): Promise<EvalContractsModule> {
  const databaseUrl = gateDatabaseUrl();
  assertGateDatabaseUrl(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;
  return import("../lib/assistant/eval-contracts");
}

// ---------------------------------------------------------------------------
// Oracle reads (raw SQL only — never prisma)
// ---------------------------------------------------------------------------

type MessageRow = { id: string; role: string; parts: unknown; metadata: unknown; sequence: number };

async function messagesOf(threadId: string): Promise<MessageRow[]> {
  return oracleQuery<MessageRow>(
    "SELECT id, role, parts, metadata, sequence FROM assistant_messages WHERE threadId = ? ORDER BY sequence",
    [threadId],
  );
}

type EvalRow = {
  id: number;
  runAt: string;
  environment: string;
  model: string | null;
  corpusRev: string | null;
  source: string;
  report: unknown;
  createdAt: string;
};

async function evalRowById(id: number): Promise<EvalRow> {
  const rows = await oracleQuery<EvalRow>(
    "SELECT id, runAt, environment, model, corpusRev, source, report, createdAt " +
      "FROM assistant_eval_reports WHERE id = ?",
    [id],
  );
  if (rows.length !== 1) throw new Error(`assistant_eval_reports row ${id} not found`);
  return rows[0];
}

async function evalRowCount(): Promise<number> {
  const [row] = await oracleQuery<{ n: number }>("SELECT COUNT(*) AS n FROM assistant_eval_reports");
  return Number(row.n);
}

/**
 * `mysql2` is configured `dateStrings: true` (the digest reads raw bytes), so a
 * DATETIME(3) arrives as "YYYY-MM-DD HH:MM:SS.mmm" — UTC, because that is what prisma
 * stored. This is the ONE place the export comparand converts it back to the `Date`
 * `toEvalExportDto` expects.
 */
function toDate(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}

/** `report` arrives parsed from a MySQL JSON column; a driver that handed back text
 *  would be normalised here rather than silently compared as a string. */
function asJsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

// ---------------------------------------------------------------------------
// Shapes the routes answer with (transcribed from the 3.2 as-built, pack row 18)
// ---------------------------------------------------------------------------

type ReportEnvelope = {
  reported: boolean;
  id: number;
  truncation: { applied: boolean; omittedToolOutputCount: number };
};

type ReportedMessage = { id: string; role: string; parts: unknown[]; metadata: unknown };
type ReportedTurn = { messages: ReportedMessage[] };
type StoredUserReport = {
  threadId: string;
  userId: number;
  reporterNote?: string;
  turns: ReportedTurn[];
  truncation: { applied: boolean; omittedToolOutputCount: number };
};

function reportPath(threadId: string): string {
  return `/api/assistant/threads/${threadId}/report`;
}

function asEnvelope(response: ApiResponse): ReportEnvelope {
  return JSON.parse(response.raw) as ReportEnvelope;
}

/**
 * Byte equality with a COMPACT failure. A plain `expect(a).toBe(b)` on an export body
 * would dump both megabyte-scale strings into the run log and bury the finding; this
 * reports the first divergence and its neighbourhood, which is what a byte-fidelity
 * failure actually needs.
 */
function assertSameBytes(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  let at = 0;
  while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
  throw new Error(
    `${label}: exported bytes differ from the canonical serialization at index ${at} ` +
      `(lengths ${actual.length} vs ${expected.length})\n` +
      `  actual   ...${JSON.stringify(actual.slice(Math.max(0, at - 60), at + 60))}\n` +
      `  expected ...${JSON.stringify(expected.slice(Math.max(0, at - 60), at + 60))}`,
  );
}

/**
 * The `environment` the app records under THIS profile. Mirrors the route's own
 * derivation (`app/api/assistant/threads/[id]/report/route.ts:70` — NODE_ENV
 * "production" -> "production", anything else -> "dev") against the NODE_ENV the
 * harness pins per profile. Hard-coding "dev" here would make the start profile
 * assert a falsehood; hard-coding nothing would assert nothing at all.
 */
function expectedEnvironment(): string {
  return appNodeEnv() === "production" ? "production" : "dev";
}

/** Drive one scripted turn to a settled, persisted state. */
async function driveTurn(
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
    throw new Error(`report-matrix turn ${messageId} failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
  }
  await settleTurn(turn.threadId, { requireAssistantRow: true, label: `the ${scenario} turn` });
  return turn;
}

// ---------------------------------------------------------------------------
// Declared 2 MB fixtures (raw SQL; matrix-lifecycle:1396 precedent)
// ---------------------------------------------------------------------------

/** ~800 KB per output/text part: three of them clear the 2 MB cap, and dropping ONE
 *  brings the payload back under it — so the truncation case's arithmetic is a
 *  property of these numbers rather than a hope. */
const BIG_PART_CHARS = 800_000;

async function insertThread(threadId: string, userId: number): Promise<void> {
  await oracleQuery(
    "INSERT INTO assistant_threads (id, userId, title, createdAt, updatedAt) VALUES (?, ?, NULL, NOW(3), NOW(3))",
    [threadId, userId],
  );
}

async function insertMessage(
  threadId: string,
  id: string,
  role: string,
  parts: unknown[],
  sequence: number,
): Promise<void> {
  await oracleQuery(
    "INSERT INTO assistant_messages (threadId, id, role, parts, metadata, sequence) VALUES (?, ?, ?, ?, NULL, ?)",
    [threadId, id, role, JSON.stringify(parts), sequence],
  );
}

function bigToolPart(tag: string, filler: string): Record<string, unknown> {
  return {
    type: "tool-get_stock",
    toolCallId: `gate-report-${tag}`,
    state: "output-available",
    input: { productId: GATE_SEED.fixtures.approvedActiveProductId },
    output: { status: "ok", data: { note: filler }, meta: { scope: "gate", bytes: filler.length } },
  };
}

/** THREE turns whose tool OUTPUTS carry the weight: the truthful-degradation walk has
 *  something to shed, oldest first. */
async function buildToolHeavyThread(threadId: string): Promise<void> {
  await insertThread(threadId, MEMBER_A.userId);
  let sequence = 0;
  for (let index = 0; index < 3; index += 1) {
    sequence += 1;
    await insertMessage(
      threadId,
      `gate-report-big-u${index}`,
      "user",
      [{ type: "text", text: `report fixture ask ${index}` }],
      sequence,
    );
    sequence += 1;
    await insertMessage(
      threadId,
      `gate-report-big-a${index}`,
      "assistant",
      [
        bigToolPart(`big-${index}`, "o".repeat(BIG_PART_CHARS)),
        { type: "text", text: `report fixture answer ${index}` },
      ],
      sequence,
    );
  }
}

/** THREE turns whose weight is TEXT — nothing the degradation walk is allowed to
 *  touch, which is the whole point of the REV-9 overflow rule. */
async function buildTextHeavyThread(threadId: string): Promise<void> {
  await insertThread(threadId, MEMBER_A.userId);
  let sequence = 0;
  for (let index = 0; index < 3; index += 1) {
    sequence += 1;
    await insertMessage(
      threadId,
      `gate-report-text-u${index}`,
      "user",
      [{ type: "text", text: `overflow fixture ask ${index}` }],
      sequence,
    );
    sequence += 1;
    await insertMessage(
      threadId,
      `gate-report-text-a${index}`,
      "assistant",
      [{ type: "text", text: "t".repeat(BIG_PART_CHARS) }],
      sequence,
    );
  }
}

// ===========================================================================
// C9 — the consent-only report path
// ===========================================================================

describe("C9 REPORT — the full persisted transcript crosses, through the REAL route", () => {
  let threadId: string;
  let turn: TurnResult;
  let envelope: ReportEnvelope;
  let stored: StoredUserReport;
  let row: EvalRow;
  let persisted: MessageRow[];

  const REPORTER_NOTE = "gate report: the stock number looks wrong";

  beforeAll(async () => {
    turn = await driveTurn("memberA", REPORT_SCENARIO, "gate-report-fidelity-user");
    threadId = turn.threadId as string;
    persisted = await messagesOf(threadId);

    const response = await apiPost(await loginOnce("memberA"), reportPath(threadId), {
      reporterNote: REPORTER_NOTE,
    });
    if (response.status !== 201) {
      throw new Error(`report POST failed (${response.status}): ${response.raw.slice(0, 1_000)}`);
    }
    envelope = asEnvelope(response);
    row = await evalRowById(envelope.id);
    stored = asJsonValue(row.report) as StoredUserReport;
  }, 120_000);

  it("answers 201 with the {reported, id, truncation} envelope (pack row 18)", () => {
    expect(envelope).toEqual({
      reported: true,
      id: expect.any(Number),
      truncation: { applied: false, omittedToolOutputCount: 0 },
    });
    expect(envelope.id).toBeGreaterThan(0);
  });

  it("stores EVERY persisted message, in order, byte-for-byte against the oracle's rows", () => {
    // The oracle read `assistant_messages` with mysql2; the route read it with prisma
    // and shipped it through JSON. Two independent paths, compared as canonical JSON
    // (MySQL's JSON columns normalise object key order — spec REV-10).
    const reported = stored.turns.flatMap((entry) => entry.messages);
    expect(reported.map((message) => message.id)).toEqual(persisted.map((message) => message.id));
    expect(reported.map((message) => message.role)).toEqual(persisted.map((message) => message.role));
    for (let index = 0; index < reported.length; index += 1) {
      expect(canonicalJson(reported[index].parts)).toBe(
        canonicalJson(asJsonValue(persisted[index].parts)),
      );
      expect(canonicalJson(reported[index].metadata)).toBe(
        canonicalJson(asJsonValue(persisted[index].metadata) ?? null),
      );
    }
    // A transcript that lost its turn boundaries is not the conversation: the grouping
    // rule is "a new turn at each user message".
    expect(stored.turns).toHaveLength(persisted.filter((message) => message.role === "user").length);
  });

  it("carries the TOOL OUTPUTS verbatim — the ground truth AT REPORT TIME (Kris's call)", () => {
    const outputs = stored.turns
      .flatMap((entry) => entry.messages)
      .flatMap((message) => message.parts as Array<Record<string, unknown>>)
      .filter((part) => String(part.type).startsWith("tool-") && part.state === "output-available");
    // The scenario packs TWO parallel tool calls, so "tool outputs ride the report" is
    // asserted on a number this file scripted, not on whatever happened to be there.
    expect(outputs).toHaveLength(2);
    for (const part of outputs) {
      const envelopeOut = part.output as { status?: string; data?: unknown };
      expect(envelopeOut.status).toBe("ok");
      expect(envelopeOut.data).not.toBeUndefined();
      // Not a marker: the untruncated path must leave real structured output behind.
      expect(typeof part.output).toBe("object");
    }
    // And the report's copy is the PERSISTED copy — same bytes, same order.
    const persistedOutputs = persisted
      .flatMap((message) => asJsonValue(message.parts) as Array<Record<string, unknown>>)
      .filter((part) => String(part.type).startsWith("tool-") && part.state === "output-available");
    expect(canonicalJson(outputs)).toBe(canonicalJson(persistedOutputs));
  });

  it("discriminates the row: source user-report, NULL model/corpusRev, profile-derived environment", () => {
    expect(row.source).toBe("user-report");
    // C1: a user report has no corpus revision and may span models. NULL is the truth.
    expect(row.model).toBeNull();
    expect(row.corpusRev).toBeNull();
    // PROFILE-AWARE (Task 3.3 C): "dev" under `next dev`, "production" under
    // `next start` — the same route, the same derivation, two honest answers.
    expect(row.environment).toBe(expectedEnvironment());
    expect(["dev", "production"]).toContain(row.environment);
  });

  it("records the reporter's own words and the thread they reported", () => {
    expect(stored.reporterNote).toBe(REPORTER_NOTE);
    expect(stored.threadId).toBe(threadId);
    expect(Number(stored.userId)).toBe(MEMBER_A.userId);
    expect(stored.truncation).toEqual({ applied: false, omittedToolOutputCount: 0 });
  });
});

describe("C9 REPORT — ownership is absolute and the 404 is not an existence oracle", () => {
  let ownedThreadId: string;
  let foreignAttempt: ApiResponse;
  let missingAttempt: ApiResponse;
  let adminAttempt: ApiResponse;
  let rowsBefore: number;
  let rowsAfter: number;

  const MISSING_THREAD_ID = "gatemissingthread00000000x";

  beforeAll(async () => {
    // memberA owns it; nobody else may report it — including an admin.
    const turn = await driveTurn("memberA", REPORT_SCENARIO, "gate-report-ownership-user");
    ownedThreadId = turn.threadId as string;
    rowsBefore = await evalRowCount();

    foreignAttempt = await apiPost(await loginOnce("zeroUser"), reportPath(ownedThreadId), {});
    missingAttempt = await apiPost(await loginOnce("zeroUser"), reportPath(MISSING_THREAD_ID), {});
    adminAttempt = await apiPost(await loginOnce("admin"), reportPath(ownedThreadId), {});

    rowsAfter = await evalRowCount();
  }, 120_000);

  it("answers a FOREIGN thread and a MISSING thread with byte-identical 404s", () => {
    expect(foreignAttempt.status).toBe(404);
    expect(missingAttempt.status).toBe(404);
    // Byte-identical, not merely both-404: a difference of one character is an
    // existence oracle (G1).
    expect(foreignAttempt.raw).toBe(missingAttempt.raw);
    expect(JSON.parse(foreignAttempt.raw)).toEqual({ error: "Thread not found", code: "NOT_FOUND" });
  });

  it("gives an ADMIN no bypass — consent-only means the owner, not the role", () => {
    expect(adminAttempt.status).toBe(404);
    expect(adminAttempt.raw).toBe(foreignAttempt.raw);
  });

  it("wrote NO row for any refused attempt", () => {
    expect(rowsAfter).toBe(rowsBefore);
  });
});

describe("C9 REPORT — CSRF, then the house 5/hr limiter (spec C9)", () => {
  let csrfless: ApiResponse;
  const attempts: ApiResponse[] = [];
  const FOREIGN_THREAD_ID = "gatereportlimiterthread01";

  beforeAll(async () => {
    // A memberA-owned thread nobody else may report (declared fixture: the limiter is
    // what is under test, and the reporter 404s before a single message is read).
    await insertThread(FOREIGN_THREAD_ID, MEMBER_A.userId);
    // THE FOURTH ACTOR drives this case: `assistant:report` is keyed per USER, and
    // memberA/zeroUser/admin have each already spent slots above. Using a spent actor
    // would move the refusal earlier and the arithmetic below would prove nothing.
    const reporter = await loginOnce("noFactsUser");

    // FIRST, without the CSRF header. `requireCSRF` runs BEFORE `enforceRateLimit`, so
    // this attempt must cost the caller NOTHING — which the six attempts below prove by
    // arithmetic: the SIXTH is the one that is refused, not the fifth.
    csrfless = await apiPost(reporter, reportPath(FOREIGN_THREAD_ID), {}, { omitCsrf: true });

    // This actor owns no such thread, so every attempt is a 404 — and the limiter counts
    // them anyway, because it runs before ownership is even looked up. That is the real
    // contract: a scripted reporter cannot probe 100 threads for the price of zero.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      attempts.push(await apiPost(reporter, reportPath(FOREIGN_THREAD_ID), {}));
    }
  }, 120_000);

  it("refuses a report with no CSRF token (403 CSRF_INVALID)", () => {
    expect(csrfless.status).toBe(403);
    expect(JSON.parse(csrfless.raw)).toEqual({ error: "Invalid CSRF token", code: "CSRF_INVALID" });
  });

  it("allows exactly FIVE attempts in the window, then refuses the sixth with 429", () => {
    expect(attempts.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 429]);
  });

  it("the 429 comes from the ROUTE's own per-user limiter, not from the middleware", () => {
    const refused = attempts[5];
    // The discriminator is the envelope: `apiHandler` maps a RateLimitError to
    // { error, code: "RATE_LIMITED" }, while middleware.ts:46 answers { error,
    // retryAfter } with NO code. Same status, different limiter, and this file's whole
    // 5/hr claim depends on which one bound.
    expect(JSON.parse(refused.raw)).toEqual({ error: "Too many requests", code: "RATE_LIMITED" });
    expect(refused.headers["retry-after"]).toMatch(/^\d+$/);
    expect(refused.headers["x-ratelimit-limit"]).toBe("5");
    expect(refused.headers["x-ratelimit-remaining"]).toBe("0");
  });

  it("the thread it was pointed at is untouched — a refused report writes nothing", async () => {
    const rows = await oracleQuery<{ n: number }>(
      "SELECT COUNT(*) AS n FROM assistant_eval_reports " +
        "WHERE JSON_UNQUOTE(JSON_EXTRACT(report, '$.threadId')) = ?",
      [FOREIGN_THREAD_ID],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe("C9 REPORT — truthful degradation at the 2 MB cap (declared fixture)", () => {
  const THREAD_ID = "gatereportbigthread000001";
  let envelope: ReportEnvelope;
  let stored: StoredUserReport;
  let marker: string;
  let capBytes: number;

  beforeAll(async () => {
    const contracts = await loadEvalContracts();
    marker = contracts.TOOL_OUTPUT_REPORT_MARKER;
    capBytes = contracts.REPORT_CAP_BYTES;

    await buildToolHeavyThread(THREAD_ID);
    const response = await apiPost(await loginOnce("memberA"), reportPath(THREAD_ID), {});
    if (response.status !== 201) {
      throw new Error(`oversized report POST failed (${response.status}): ${response.raw.slice(0, 500)}`);
    }
    envelope = asEnvelope(response);
    stored = asJsonValue((await evalRowById(envelope.id)).report) as StoredUserReport;
  }, 120_000);

  it("discloses the truncation to the reporter AND inside the stored payload", () => {
    expect(envelope.truncation.applied).toBe(true);
    expect(envelope.truncation.omittedToolOutputCount).toBeGreaterThan(0);
    expect(stored.truncation).toEqual(envelope.truncation);
  });

  it("sheds the OLDEST tool output first and leaves the newest turn complete", () => {
    const outputs = stored.turns.map((turn) => {
      const part = (turn.messages[1].parts as Array<Record<string, unknown>>)[0];
      return part.output;
    });
    expect(outputs[0]).toBe(marker);
    // Three ~800 KB outputs over a 2 MB cap: dropping exactly one fits. The newest turn
    // — the one a reviewer actually needs — is untouched.
    expect(envelope.truncation.omittedToolOutputCount).toBe(1);
    expect(typeof outputs[1]).toBe("object");
    expect(typeof outputs[2]).toBe("object");
  });

  it("never drops a prompt, an answer or a whole turn", () => {
    expect(stored.turns).toHaveLength(3);
    const texts = stored.turns.flatMap((turn) =>
      turn.messages.flatMap((message) =>
        (message.parts as Array<Record<string, unknown>>)
          .filter((part) => part.type === "text")
          .map((part) => String(part.text)),
      ),
    );
    expect(texts).toEqual([
      "report fixture ask 0",
      "report fixture answer 0",
      "report fixture ask 1",
      "report fixture answer 1",
      "report fixture ask 2",
      "report fixture answer 2",
    ]);
  });

  it("lands under the cap (the degradation is what made it fit)", () => {
    expect(Buffer.byteLength(JSON.stringify(stored), "utf8")).toBeLessThanOrEqual(capBytes);
  });
});

describe("C9 REPORT — overflow answers 413 and writes NO ROW (spec REV-9)", () => {
  const THREAD_ID = "gatereporttextthread00001";
  let response: ApiResponse;
  let rowsBefore: number;
  let rowsAfter: number;

  beforeAll(async () => {
    await buildTextHeavyThread(THREAD_ID);
    rowsBefore = await evalRowCount();
    response = await apiPost(await loginOnce("memberA"), reportPath(THREAD_ID), {});
    rowsAfter = await evalRowCount();
  }, 120_000);

  it("answers 413 in the VALIDATION_ERROR vocabulary", () => {
    expect(response.status).toBe(413);
    const body = JSON.parse(response.raw) as { error: string; code: string };
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.error).toContain("too large to report");
  });

  it("writes NO row — a report that dropped the user's words would be a false record", () => {
    expect(rowsAfter).toBe(rowsBefore);
  });
});

// ===========================================================================
// C9 — the eval surface + the export round trip (G2-12)
// ===========================================================================

describe("C9 EVAL — upload, read-back, and the export ROUND TRIP at the HTTP layer", () => {
  let contracts: EvalContractsModule;
  let evalRunId: number;
  let userReportId: number;
  let getBody: {
    latest: { id: number; source: string; report: unknown } | null;
    history: Array<Record<string, unknown>>;
    historyNote: string;
  };
  let evalExport: ApiResponse;
  let reportExport: ApiResponse;
  let memberExport: ApiResponse;

  /** Deliberately BACKDATED: the user reports this file already filed are newer, so
   *  "latest is the newest EVAL RUN" can only pass on a source-discriminating query. */
  const RUN_AT = "2026-08-01T09:30:00.000Z";

  const uploadBody = {
    runAt: RUN_AT,
    environment: "dev",
    model: GATE_MODEL,
    corpusRev: "gate-corpus-3.3",
    turns: [
      {
        conversation: "gate conversation 1",
        turn: 1,
        prompt: "What is on hand for the gate fixture product?",
        verdict: "pass",
        notes: "answered from get_stock, numbers matched the ledger",
        toolCalls: ["get_stock", "get_inventory_summary"],
        answerExcerpt: "On hand is exactly what the ledger says.",
      },
      {
        conversation: "gate conversation 1",
        turn: 2,
        prompt: "And the reorder position?",
        verdict: "mixed",
        notes: "coverage block present; velocity trichotomy not stated",
        toolCalls: ["get_reorder_report"],
        answerExcerpt: "Reorder now for one product.",
      },
    ],
  };

  beforeAll(async () => {
    contracts = await loadEvalContracts();
    const admin = await loginOnce("admin");

    const upload = await apiPost(admin, "/api/admin/assistant-eval", uploadBody);
    if (upload.status !== 201) {
      throw new Error(`eval upload failed (${upload.status}): ${upload.raw.slice(0, 500)}`);
    }
    evalRunId = (JSON.parse(upload.raw) as { id: number }).id;

    const read = await apiGet(admin, "/api/admin/assistant-eval");
    expect(read.status).toBe(200);
    getBody = JSON.parse(read.raw) as typeof getBody;

    // The FIRST user report this file wrote — the fidelity one, whose transcript
    // carries real STRUCTURED tool outputs (nested objects and arrays are exactly
    // where MySQL's JSON key-order normalisation bites a byte-fidelity claim). The
    // 2 MB truncated report is a worse comparand for that question and a worse log.
    const [first] = await oracleQuery<{ id: number }>(
      "SELECT id FROM assistant_eval_reports WHERE source = 'user-report' ORDER BY id ASC LIMIT 1",
    );
    userReportId = Number(first.id);

    evalExport = await apiGet(admin, `/api/admin/assistant-eval/${evalRunId}/export`);
    reportExport = await apiGet(admin, `/api/admin/assistant-eval/${userReportId}/export`);
    memberExport = await apiGet(await loginOnce("memberA"), `/api/admin/assistant-eval/${evalRunId}/export`);
  }, 120_000);

  it("writes an eval-run row with model + corpusRev, and the uploaded document verbatim", async () => {
    const row = await evalRowById(evalRunId);
    expect({ source: row.source, environment: row.environment, model: row.model, corpusRev: row.corpusRev }).toEqual({
      source: "eval-run",
      environment: "dev",
      model: GATE_MODEL,
      corpusRev: "gate-corpus-3.3",
    });
    expect(canonicalJson(asJsonValue(row.report))).toBe(canonicalJson(uploadBody));
  });

  it("GET's `latest` is the newest EVAL RUN even though newer user reports exist", () => {
    expect(getBody.latest).not.toBeNull();
    expect(getBody.latest?.id).toBe(evalRunId);
    expect(getBody.latest?.source).toBe("eval-run");
    expect(canonicalJson(getBody.latest?.report)).toBe(canonicalJson(uploadBody));
  });

  it("GET's history is SUMMARIES ONLY — transcripts leave only by export", () => {
    const sources = getBody.history.map((entry) => entry.source);
    expect(sources).toContain("user-report");
    expect(sources).toContain("eval-run");
    for (const entry of getBody.history) {
      expect(Object.keys(entry).sort()).toEqual(
        ["corpusRev", "createdAt", "environment", "id", "model", "runAt", "source"].sort(),
      );
      expect(entry).not.toHaveProperty("report");
    }
    expect(getBody.historyNote).toContain("most recent reports");
  });

  it("EXPORT BYTES == serializeEvalExport(toEvalExportDto(row)) for a user report (G2-12)", async () => {
    const row = await evalRowById(userReportId);
    const expected = contracts.serializeEvalExport(
      contracts.toEvalExportDto({
        id: Number(row.id),
        runAt: toDate(row.runAt),
        environment: row.environment,
        model: row.model,
        corpusRev: row.corpusRev,
        source: row.source,
        report: asJsonValue(row.report),
        createdAt: toDate(row.createdAt),
      }),
    );
    // BYTE equality, recomputed from a row read with mysql2 — the export path and the
    // comparand share no code below `serializeEvalExport` itself.
    expect(reportExport.status).toBe(200);
    assertSameBytes(reportExport.raw, expected, "user-report export");
    expect(reportExport.headers["content-disposition"]).toBe(
      `attachment; filename="assistant-eval-${userReportId}.json"`,
    );
  });

  it("EXPORT BYTES == the canonical serialization for an eval run too (same route)", async () => {
    const row = await evalRowById(evalRunId);
    const expected = contracts.serializeEvalExport(
      contracts.toEvalExportDto({
        id: Number(row.id),
        runAt: toDate(row.runAt),
        environment: row.environment,
        model: row.model,
        corpusRev: row.corpusRev,
        source: row.source,
        report: asJsonValue(row.report),
        createdAt: toDate(row.createdAt),
      }),
    );
    expect(evalExport.status).toBe(200);
    assertSameBytes(evalExport.raw, expected, "eval-run export");
    // The FULL row travels, never `report` alone: that is what makes an exported file
    // self-describing once it is sitting in the docs corpus.
    const parsed = JSON.parse(evalExport.raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "id",
      "runAt",
      "environment",
      "model",
      "corpusRev",
      "source",
      "report",
      "createdAt",
    ]);
  });

  it("is admin-gated: a member reporting user gets 403 and no bytes", () => {
    expect(memberExport.status).toBe(403);
    expect(memberExport.raw).not.toContain("corpusRev");
  });
});

// ===========================================================================
// C8 — the usage rollup against REAL MySQL (pack REV-17's registered gap)
// ===========================================================================

type UsageRollup = {
  userId: number;
  displayName: string;
  dayKey: string;
  model: string;
  kind: string;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  aborted: number;
  errored: number;
  running: number;
  nullUsageRequests: number;
};

type UsageResponse = {
  range: { from: string; to: string };
  tokenRollups: UsageRollup[];
  toolMix: Array<{ toolName: string; calls: number }>;
  horizonNote: string;
};

/** mysql2 hands COUNT/SUM back as numbers or decimal strings depending on the
 *  aggregate; NULL stays NULL, which is the whole point of the G2 columns. */
function num(value: unknown): number {
  return Number(value ?? 0);
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The oracle's own C8 fold: the same dimensions, in raw SQL, with `COUNT(*) -
 * COUNT(inputTokens)` written out where the route writes `_count._all -
 * _count.inputTokens`. Prisma's groupBy is the thing under test, so it appears
 * nowhere here.
 */
async function recomputeRollups(from: string, to: string): Promise<UsageRollup[]> {
  const rows = await oracleQuery<Record<string, unknown>>(
    "SELECT userId, dayKey, model, kind, COUNT(*) AS requests, " +
      "COUNT(*) - COUNT(inputTokens) AS nullUsageRequests, " +
      "SUM(status = 'aborted') AS aborted, SUM(status = 'error') AS errored, " +
      "SUM(status = 'running') AS running, SUM(inputTokens) AS inputTokens, " +
      "SUM(outputTokens) AS outputTokens, SUM(totalTokens) AS totalTokens " +
      "FROM assistant_requests WHERE dayKey >= ? AND dayKey <= ? " +
      "GROUP BY userId, dayKey, model, kind",
    [from, to],
  );
  const users = await oracleQuery<{ id: number; username: string; email: string }>(
    "SELECT id, username, email FROM users",
  );
  const nameById = new Map(users.map((user) => [Number(user.id), (user.username ?? "").trim() || user.email]));

  return rows
    .map((row) => ({
      userId: num(row.userId),
      displayName: nameById.get(num(row.userId)) ?? `User ${num(row.userId)}`,
      dayKey: String(row.dayKey),
      model: String(row.model),
      kind: String(row.kind),
      requests: num(row.requests),
      inputTokens: nullableNum(row.inputTokens),
      outputTokens: nullableNum(row.outputTokens),
      totalTokens: nullableNum(row.totalTokens),
      aborted: num(row.aborted),
      errored: num(row.errored),
      running: num(row.running),
      nullUsageRequests: num(row.nullUsageRequests),
    }))
    .sort(
      (a, b) =>
        compareText(b.dayKey, a.dayKey) ||
        a.userId - b.userId ||
        compareText(a.model, b.model) ||
        compareText(a.kind, b.kind),
    );
}

async function recomputeToolMix(from: string, to: string): Promise<Array<{ toolName: string; calls: number }>> {
  // `assistant_runs` has no dayKey column; the window is the same half-open UTC instant
  // range the route uses, expressed as DATETIME literals (never a JS Date through
  // mysql2, which would format in the LOCAL zone).
  const nextDay = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
  const rows = await oracleQuery<{ toolName: string; calls: number }>(
    "SELECT toolName, COUNT(*) AS calls FROM assistant_runs " +
      "WHERE createdAt >= ? AND createdAt < ? GROUP BY toolName",
    [`${from} 00:00:00.000`, `${nextDay} 00:00:00.000`],
  );
  return rows
    .map((row) => ({ toolName: String(row.toolName), calls: num(row.calls) }))
    .sort((a, b) => b.calls - a.calls || compareText(a.toolName, b.toolName));
}

/**
 * A DECLARED FIXTURE for the null-preserving SUM (spec C8 / G2), and the reason it is
 * a fixture: the sums are null only when EVERY contributing row is null, and the
 * failed-title row this file drives shares its (userId, dayKey, model, kind) group with
 * the warm-up thread's SUCCESSFUL title row — a real group that is legitimately not
 * all-null. Isolating one takes a dimension nothing else uses, so this inserts a single
 * request row under its own MODEL. The row is the READ path's input; the write path's
 * null discipline is proven separately, through the product, by the failing-title turn
 * below (and by matrix-telemetry row 5).
 */
const NULL_USAGE_MODEL = "gate-nullusage-probe";

async function insertNullUsageRequest(dayKey: string): Promise<void> {
  await oracleQuery(
    "INSERT INTO assistant_requests " +
      "(threadId, userId, kind, providerKind, model, inputTokens, outputTokens, totalTokens, " +
      "durationMs, status, errorCode, membershipScope, dayKey, createdAt) VALUES " +
      "(NULL, ?, 'chat', 'OLLAMA', ?, NULL, NULL, NULL, 41, 'error', 'PROVIDER_ERROR', ?, ?, NOW(3))",
    [MEMBER_A.userId, NULL_USAGE_MODEL, JSON.stringify(MEMBER_A.companyIds), dayKey],
  );
}

/** Bounded wait for the DETACHED title job's request row (the C6 race). */
async function waitForTitleRow(threadId: string, deadlineMs = 20_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const [row] = await oracleQuery<{ n: number; running: number }>(
      "SELECT COUNT(*) AS n, SUM(status = 'running') AS running FROM assistant_requests " +
        "WHERE threadId = ? AND kind = 'title'",
      [threadId],
    );
    if (num(row.n) > 0 && num(row.running) === 0) return;
    if (Date.now() > until) {
      throw new Error(`no settled title row for thread ${threadId} within ${deadlineMs}ms`);
    }
    await sleep(200);
  }
}

describe("C8 USAGE — the ONE groupBy, adjudicated by REAL MySQL (pack REV-17)", () => {
  let response: UsageResponse;
  let expectedRollups: UsageRollup[];
  let expectedToolMix: Array<{ toolName: string; calls: number }>;
  let memberAttempt: ApiResponse;
  let failedTitleThreadId: string;
  let dayKeyBefore: string;
  let dayKeyAfter: string;

  beforeAll(async () => {
    // A NULL-usage request row, made the way the product really makes one: the shim
    // refuses the C6 title call (pack REV-14's failing-title affordance), the title row
    // finalizes error/PROVIDER_ERROR, and its token columns stay NULL — never 0. Without
    // it, `nullUsageRequests` could only be asserted as "0 == 0".
    const turn = await driveTurn("memberA", TITLE_FAILING_SCENARIO, "gate-report-usage-user");
    failedTitleThreadId = turn.threadId as string;
    await waitForTitleRow(failedTitleThreadId);
    await insertNullUsageRequest(new Date().toISOString().slice(0, 10));

    const admin = await loginOnce("admin");
    dayKeyBefore = new Date().toISOString().slice(0, 10);
    const read = await apiGet(admin, "/api/admin/assistant-usage");
    dayKeyAfter = new Date().toISOString().slice(0, 10);
    expect(read.status).toBe(200);
    response = JSON.parse(read.raw) as UsageResponse;

    // A QUIESCENCE CHECK, stated for what it is: the range is only known FROM the
    // response, so both recomputes happen after it — and they must agree with each
    // other. Two agreeing reads say the database stopped moving; if a detached title
    // job were still landing, this is the assertion that would say so instead of the
    // deep-equal below failing with a mysterious one-row difference.
    const first = await recomputeRollups(response.range.from, response.range.to);
    expectedRollups = await recomputeRollups(response.range.from, response.range.to);
    expect(canonicalJson(first)).toBe(canonicalJson(expectedRollups));
    expectedToolMix = await recomputeToolMix(response.range.from, response.range.to);

    memberAttempt = await apiGet(await loginOnce("memberA"), "/api/admin/assistant-usage");
  }, 180_000);

  it("returns the DEFAULT 14-day inclusive UTC range", () => {
    const days =
      (Date.parse(`${response.range.to}T00:00:00.000Z`) - Date.parse(`${response.range.from}T00:00:00.000Z`)) /
      86_400_000;
    expect(days).toBe(13);
    // Bracketed, not compared to one instant (the telemetry file's dayKey idiom): a run
    // straddling UTC midnight must not fail, and both ends are still assertions.
    expect([dayKeyBefore, dayKeyAfter]).toContain(response.range.to);
  });

  it("tokenRollups deep-equal the oracle's raw-SQL recompute, row for row", () => {
    expect(response.tokenRollups).toHaveLength(expectedRollups.length);
    expect(canonicalJson(response.tokenRollups)).toBe(canonicalJson(expectedRollups));
    // Non-vacuous: this run really did produce rollup rows for the seeded actors.
    expect(response.tokenRollups.length).toBeGreaterThan(0);
    expect(response.tokenRollups.map((row) => row.userId)).toContain(MEMBER_A.userId);
  });

  it("nullUsageRequests is the COUNT(*)-vs-COUNT(column) difference, and it is NOT zero", async () => {
    const [failedTitle] = await oracleQuery<{ id: number; kind: string; dayKey: string; model: string }>(
      "SELECT id, kind, dayKey, model FROM assistant_requests " +
        "WHERE threadId = ? AND kind = 'title' AND status = 'error' AND inputTokens IS NULL",
      [failedTitleThreadId],
    );
    expect(failedTitle).toBeDefined();

    const rollup = response.tokenRollups.find(
      (row) =>
        row.userId === MEMBER_A.userId &&
        row.dayKey === failedTitle.dayKey &&
        row.model === failedTitle.model &&
        row.kind === "title",
    );
    expect(rollup).toBeDefined();
    expect(rollup?.nullUsageRequests).toBeGreaterThan(0);

    // The independent count of exactly that distinction, over the whole window.
    const [counted] = await oracleQuery<{ nulls: number }>(
      "SELECT COUNT(*) - COUNT(inputTokens) AS nulls FROM assistant_requests WHERE dayKey >= ? AND dayKey <= ?",
      [response.range.from, response.range.to],
    );
    const reported = response.tokenRollups.reduce((sum, row) => sum + row.nullUsageRequests, 0);
    expect(reported).toBe(num(counted.nulls));
    expect(reported).toBeGreaterThan(0);
  });

  it("token sums stay NULL where every contributor was NULL (G2, never 0)", () => {
    // The isolated group (declared fixture above). FOUND, not assumed: its absence
    // fails here rather than making the loop below iterate zero times.
    const isolated = response.tokenRollups.find((row) => row.model === NULL_USAGE_MODEL);
    expect(isolated).toBeDefined();
    expect(isolated).toMatchObject({
      requests: 1,
      nullUsageRequests: 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      errored: 1,
    });

    // And the rule as a PROPERTY over every such group in the run: a null sum happens
    // exactly when every contributing request reported nothing.
    const nullRows = response.tokenRollups.filter((row) => row.inputTokens === null);
    expect(nullRows.length).toBeGreaterThan(0);
    for (const row of nullRows) {
      expect(row.requests).toBe(row.nullUsageRequests);
      expect(row.outputTokens).toBeNull();
      expect(row.totalTokens).toBeNull();
    }
    // The converse, so "null" cannot be the answer to everything: the groups that DID
    // report usage carry real numbers, not zeros.
    const reported = response.tokenRollups.filter((row) => row.inputTokens !== null);
    expect(reported.length).toBeGreaterThan(0);
    for (const row of reported) {
      expect(row.inputTokens).toBeGreaterThan(0);
    }
  });

  it("toolMix deep-equals the oracle recompute over assistant_runs, with its horizon note", () => {
    expect(canonicalJson(response.toolMix)).toBe(canonicalJson(expectedToolMix));
    expect(response.toolMix.length).toBeGreaterThan(0);
    expect(response.horizonNote).toBe("newest 10,000 runs retained — window may be clipped");
  });

  it("is admin-gated", () => {
    expect(memberAttempt.status).toBe(403);
    expect(memberAttempt.raw).not.toContain("tokenRollups");
  });

  it("names the profile it proved this under", () => {
    // Not decoration: the C8 groupBy runs through the same prisma client on both
    // profiles, and this line is what makes the run of record say WHICH artifact
    // answered (`next dev` or the built one).
    expect(["dev", "start"]).toContain(gateProfile());
    console.log(
      `[launch-gate] C8/C9 ride-along proved under the ${gateProfile()} profile ` +
        `(app NODE_ENV=${appNodeEnv()}, reports stored as environment="${expectedEnvironment()}"); ` +
        `admin actor ${ADMIN.email}`,
    );
  });
});
