// @jest-environment node
//
// Task 3.2 — eval upload / report-to-admin / export (spec C9 + REV-9; contract
// pack T10, seams S13/S15/S16).
//
// What is under test is the ROUTE contract of three surfaces that share one table:
//
//   1. POST /api/admin/assistant-eval — the admin-curated scored run. Admin + CSRF,
//      the 1 MB cap, the ≤500-char answerExcerpt rule, and SOURCE DISCRIMINATION:
//      this route writes `eval-run` rows carrying model + corpusRev, and a `source`
//      key in the uploaded body can never forge anything else.
//   2. POST /api/assistant/threads/[id]/report — the CONSENT-ONLY path by which
//      conversation text reaches an admin. Ownership is absolute (a foreign thread
//      404s exactly like a missing one), the transcript crosses in FULL including
//      tool outputs verbatim, the 2 MB cap degrades TRUTHFULLY (oldest tool OUTPUTS
//      become markers first, the disclosure rides inside the payload), and the
//      REV-9 overflow rule refuses rather than lies: over cap with every output
//      already a marker is 413 + NO ROW, because dropping a user's words would make
//      the stored report a false record.
//   3. GET /api/admin/assistant-eval/[id]/export — the per-row download, for BOTH
//      sources, BYTE-IDENTICAL to the stored row under the T10 canonical
//      serialization (G2-12).
//
// Prisma is the GLOBAL jest.setup mock (design D2) driven by a small fake store:
// ownership is decided by the WHERE clause, so a `findFirst` that ignored
// `where.userId` is exactly the bug a fixed return value could not catch.
//
// FIXTURE DATA ONLY: every thread, message and tool output here is authored in this
// file. Reports hold real business data in production — none is read here.

// --- guards ----------------------------------------------------------------
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(),
  requireApproved: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(() => Promise.resolve(true)) }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin, requireApproved } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { AppError } from "@/lib/error-handling";
import {
  EVAL_CAP_BYTES,
  REPORT_CAP_BYTES,
  TOOL_OUTPUT_REPORT_MARKER,
  serializeEvalExport,
  toEvalExportDto,
  type EvalReportRow,
} from "@/lib/assistant/eval-contracts";
import { POST as evalPOST, GET as evalGET } from "@/app/api/admin/assistant-eval/route";
import { GET as exportGET } from "@/app/api/admin/assistant-eval/[id]/export/route";
import { POST as reportPOST } from "@/app/api/assistant/threads/[id]/report/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

const db = prisma as unknown as Record<string, any>;
const adminMock = requireAdmin as jest.Mock;
const approvedMock = requireApproved as jest.Mock;
const csrfMock = validateCSRFToken as jest.Mock;

const NOW = new Date("2026-08-11T10:00:00.000Z");

const ADMIN = {
  id: 1,
  email: "admin@example.com",
  name: null,
  isAdmin: true,
  isApproved: true,
  defaultLocationId: 1,
};

/** The rate limiter is the REAL in-process store (that is the point of the 5/hr
 *  case), and fake timers freeze its window — so every describe that posts a report
 *  uses its OWN caller id and can never inherit another test's budget. */
const CALLER = 7101;
const OTHER_USER = 7999;
const OWN_THREAD = "cthread0000000000000001";
const FOREIGN_THREAD = "cthread0000000000000002";
const MISSING_THREAD = "cthread0000000000000404";

// ---------------------------------------------------------------------------
// Fake store
// ---------------------------------------------------------------------------

type ThreadRow = { id: string; userId: number; title: string | null };
type MessageRow = {
  threadId: string;
  id: string;
  role: string;
  parts: unknown[];
  metadata: unknown;
  sequence: number;
};

let threads: ThreadRow[] = [];
let messages: MessageRow[] = [];
let evalRows: EvalReportRow[] = [];
let nextEvalId = 1;

function armStore(): void {
  db.assistantThread.findFirst.mockImplementation(async ({ where }: any) => {
    const row = threads.find(
      (t) =>
        (where.id === undefined || t.id === where.id) &&
        (where.userId === undefined || t.userId === where.userId),
    );
    return row ? { id: row.id, title: row.title } : null;
  });

  db.assistantMessage.findMany.mockImplementation(async ({ where, orderBy }: any) => {
    const rows = messages.filter((m) => m.threadId === where.threadId);
    rows.sort((a, b) =>
      orderBy?.sequence === "desc" ? b.sequence - a.sequence : a.sequence - b.sequence,
    );
    return rows.map((m) => ({
      id: m.id,
      role: m.role,
      parts: m.parts,
      metadata: m.metadata,
      sequence: m.sequence,
    }));
  });

  db.assistantEvalReport.create.mockImplementation(async ({ data }: any) => {
    const row: EvalReportRow = {
      id: nextEvalId++,
      runAt: data.runAt,
      environment: data.environment,
      model: data.model ?? null,
      corpusRev: data.corpusRev ?? null,
      source: data.source,
      report: data.report,
      createdAt: new Date(NOW),
    };
    evalRows.push(row);
    return row;
  });

  db.assistantEvalReport.findFirst.mockImplementation(async ({ where }: any) => {
    const rows = evalRows
      .filter((r) => where?.source === undefined || r.source === where.source)
      .sort((a, b) => b.runAt.getTime() - a.runAt.getTime());
    return rows[0] ?? null;
  });

  db.assistantEvalReport.findMany.mockImplementation(async ({ take }: any) => {
    const rows = [...evalRows].sort((a, b) => b.runAt.getTime() - a.runAt.getTime());
    return typeof take === "number" ? rows.slice(0, take) : rows;
  });

  db.assistantEvalReport.findUnique.mockImplementation(
    async ({ where }: any) => evalRows.find((r) => r.id === where.id) ?? null,
  );
}

// ---------------------------------------------------------------------------
// Fixtures + callers
// ---------------------------------------------------------------------------

function textPart(text: string) {
  return { type: "text", text };
}

function toolPart(toolCallId: string, output: unknown) {
  return {
    type: "tool-get_stock_levels",
    toolCallId,
    state: "output-available",
    input: { productId: 42 },
    output,
  };
}

/** One user turn + one assistant turn carrying a tool call and its OUTPUT. */
function seedTurn(index: number, output: unknown, assistantText = `answer ${index}`): void {
  messages.push({
    threadId: OWN_THREAD,
    id: `u${index}`,
    role: "user",
    parts: [textPart(`question ${index}`)],
    metadata: null,
    sequence: index * 2,
  });
  messages.push({
    threadId: OWN_THREAD,
    id: `a${index}`,
    role: "assistant",
    parts: [toolPart(`call-${index}`, output), textPart(assistantText)],
    metadata: { finishReason: "stop" },
    sequence: index * 2 + 1,
  });
}

function evalUpload(over: Record<string, unknown> = {}) {
  return {
    runAt: "2026-08-11T09:00:00.000Z",
    environment: "dev",
    model: "claude-opus-5",
    corpusRev: "corpus-2026-08-11",
    turns: [
      {
        conversation: "inv-prompts-1",
        turn: 1,
        prompt: "what is low on stock?",
        verdict: "pass",
        notes: "cited the real thresholds",
        toolCalls: ["get_low_stock"],
        answerExcerpt: "Three products are below their reorder point…",
      },
    ],
    ...over,
  };
}

function jsonReq(url: string, body: unknown, method = "POST"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-csrf-token": "t" },
    body: JSON.stringify(body),
  });
}

async function callEvalPost(body: unknown): Promise<{ status: number; body: any }> {
  const res = await (evalPOST as any)(jsonReq("http://x/api/admin/assistant-eval", body));
  return { status: res.status, body: await res.json() };
}

async function callEvalGet(): Promise<{ status: number; body: any }> {
  const res = await (evalGET as any)(new NextRequest("http://x/api/admin/assistant-eval"));
  return { status: res.status, body: await res.json() };
}

async function callExport(id: string): Promise<{ status: number; text: string; res: Response }> {
  const res = await (exportGET as any)(
    new NextRequest(`http://x/api/admin/assistant-eval/${id}/export`),
    { params: { id } },
  );
  return { status: res.status, text: await res.text(), res };
}

async function callReport(
  threadId: string,
  body: unknown = {},
): Promise<{ status: number; body: any }> {
  const res = await (reportPOST as any)(
    jsonReq(`http://x/api/assistant/threads/${threadId}/report`, body),
    { params: { id: threadId } },
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks(); // NEVER resetAllMocks: it drops $transaction's default (pack T12)
  threads = [{ id: OWN_THREAD, userId: CALLER, title: "Stock questions" }];
  threads.push({ id: FOREIGN_THREAD, userId: OTHER_USER, title: "Someone else's" });
  messages = [];
  evalRows = [];
  nextEvalId = 1;
  armStore();
  adminMock.mockResolvedValue({ user: ADMIN });
  approvedMock.mockResolvedValue({ user: { id: CALLER, isAdmin: false } });
  csrfMock.mockResolvedValue(true);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// POST /api/admin/assistant-eval — gates
// ---------------------------------------------------------------------------

describe("POST /api/admin/assistant-eval — admin + CSRF gates", () => {
  test("401s an unauthenticated caller and writes NOTHING", async () => {
    adminMock.mockRejectedValue(new AppError("Authentication required", "UNAUTHORIZED", 401));

    const { status, body } = await callEvalPost(evalUpload());

    expect(status).toBe(401);
    expect(body).toEqual({ error: "Authentication required", code: "UNAUTHORIZED" });
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });

  test("403s a non-admin caller and writes NOTHING", async () => {
    adminMock.mockRejectedValue(new AppError("Admin access required", "FORBIDDEN", 403));

    const { status, body } = await callEvalPost(evalUpload());

    expect(status).toBe(403);
    expect(body.code).toBe("FORBIDDEN");
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });

  test("missing/invalid CSRF => 403 CSRF_INVALID BEFORE any write", async () => {
    csrfMock.mockResolvedValue(false);

    const { status, body } = await callEvalPost(evalUpload());

    expect(status).toBe(403);
    expect(body).toEqual({ error: "Invalid CSRF token", code: "CSRF_INVALID" });
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/assistant-eval — source discrimination + schema
// ---------------------------------------------------------------------------

describe("POST /api/admin/assistant-eval — source discrimination (spec C1/C9)", () => {
  test("stores an eval-run row WITH model + corpusRev and echoes its identity", async () => {
    const { status, body } = await callEvalPost(evalUpload());

    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: 1,
      source: "eval-run",
      model: "claude-opus-5",
      corpusRev: "corpus-2026-08-11",
      environment: "dev",
    });
    expect(evalRows).toHaveLength(1);
    expect(evalRows[0].source).toBe("eval-run");
    expect(evalRows[0].model).toBe("claude-opus-5");
    expect(evalRows[0].corpusRev).toBe("corpus-2026-08-11");
    expect(evalRows[0].runAt.toISOString()).toBe("2026-08-11T09:00:00.000Z");
    // The stored document is the uploaded report, verbatim.
    expect(evalRows[0].report).toEqual(evalUpload());
  });

  test("a `source` key in the BODY cannot forge a user-report row", async () => {
    const { status } = await callEvalPost(evalUpload({ source: "user-report" }));

    expect(status).toBe(201);
    expect(evalRows[0].source).toBe("eval-run");
    // The forged key never reaches storage either (zod strips unknown keys).
    expect(evalRows[0].report).not.toHaveProperty("source");
  });

  test("an eval-run WITHOUT model or corpusRev is refused (C1: eval-run REQUIRES both)", async () => {
    const noModel = evalUpload();
    delete (noModel as any).model;
    expect((await callEvalPost(noModel)).status).toBe(400);

    const noCorpus = evalUpload();
    delete (noCorpus as any).corpusRev;
    expect((await callEvalPost(noCorpus)).status).toBe(400);

    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });

  test("rejects an unknown verdict and an unknown environment (400 VALIDATION_ERROR)", async () => {
    const badVerdict = evalUpload();
    (badVerdict.turns as any[])[0].verdict = "excellent";
    const one = await callEvalPost(badVerdict);
    expect(one.status).toBe(400);
    expect(one.body.code).toBe("VALIDATION_ERROR");

    const two = await callEvalPost(evalUpload({ environment: "prod" }));
    expect(two.status).toBe(400);

    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });

  test("the ≤500-char answerExcerpt rule is SCHEMA-enforced at upload", async () => {
    const long = evalUpload();
    (long.turns as any[])[0].answerExcerpt = "x".repeat(501);

    const { status, body } = await callEvalPost(long);

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();

    // ...and exactly 500 is accepted (the bound is inclusive, not off-by-one).
    const atBound = evalUpload();
    (atBound.turns as any[])[0].answerExcerpt = "y".repeat(500);
    expect((await callEvalPost(atBound)).status).toBe(201);
  });
});

describe("POST /api/admin/assistant-eval — the 1 MB cap", () => {
  test("a payload over EVAL_CAP_BYTES is refused 413 and writes NO row", async () => {
    const big = evalUpload();
    (big.turns as any[])[0].notes = "n".repeat(EVAL_CAP_BYTES);

    const { status, body } = await callEvalPost(big);

    expect(status).toBe(413);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });

  test("a large but UNDER-cap payload is accepted (the cap is a real boundary)", async () => {
    // A real scored run is many turns, not one enormous field — 230 fully-populated
    // turns is ~1 MB shy of nothing and still legal.
    const nearly = evalUpload({
      turns: Array.from({ length: 230 }, (_, i) => ({
        ...(evalUpload().turns as any[])[0],
        turn: i + 1,
        notes: "n".repeat(4_000),
      })),
    });
    // Self-check: the fixture really is under the cap, so a 413 here would be the
    // ROUTE's arithmetic and not the test's.
    expect(Buffer.byteLength(JSON.stringify(nearly), "utf8")).toBeLessThan(EVAL_CAP_BYTES);

    expect((await callEvalPost(nearly)).status).toBe(201);
    expect(evalRows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/assistant-eval
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-eval — latest + run history", () => {
  test("403s a non-admin caller and reads NOTHING", async () => {
    adminMock.mockRejectedValue(new AppError("Admin access required", "FORBIDDEN", 403));

    const { status } = await callEvalGet();

    expect(status).toBe(403);
    expect(db.assistantEvalReport.findMany).not.toHaveBeenCalled();
  });

  test("empty table => latest null, empty history (a named absence, never a fake row)", async () => {
    const { status, body } = await callEvalGet();

    expect(status).toBe(200);
    expect(body.latest).toBeNull();
    expect(body.history).toEqual([]);
    expect(typeof body.historyNote).toBe("string");
    expect(body.historyNote.length).toBeGreaterThan(0);
  });

  test("`latest` is the newest EVAL-RUN with its payload; history spans BOTH sources", async () => {
    evalRows = [
      {
        id: 1,
        runAt: new Date("2026-08-09T00:00:00.000Z"),
        environment: "dev",
        model: "m1",
        corpusRev: "c1",
        source: "eval-run",
        report: { turns: [{ verdict: "pass" }] },
        createdAt: new Date("2026-08-09T00:00:00.000Z"),
      },
      {
        id: 2,
        runAt: new Date("2026-08-10T00:00:00.000Z"),
        environment: "dev",
        model: "m2",
        corpusRev: "c2",
        source: "eval-run",
        report: { turns: [{ verdict: "fail" }] },
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
      },
      {
        id: 3,
        runAt: new Date("2026-08-11T00:00:00.000Z"),
        environment: "production",
        model: null,
        corpusRev: null,
        source: "user-report",
        report: { threadId: OWN_THREAD, turns: [] },
        createdAt: new Date("2026-08-11T00:00:00.000Z"),
      },
    ];

    const { body } = await callEvalGet();

    // The newest row overall is a USER REPORT — `latest` must still be the newest
    // scored RUN, or the page would show "the latest eval" that never ran.
    expect(body.latest.id).toBe(2);
    expect(body.latest.source).toBe("eval-run");
    expect(body.latest.report).toEqual({ turns: [{ verdict: "fail" }] });

    expect(body.history.map((h: any) => h.id)).toEqual([3, 2, 1]);
    expect(body.history[0]).toMatchObject({ source: "user-report", model: null, corpusRev: null });
    // History rows carry NO report payload: a user report is real business data and
    // crosses only by the deliberate export download.
    expect(body.history[0]).not.toHaveProperty("report");
  });

  test("history is bounded and the bound is DISCLOSED, never silently applied", async () => {
    await callEvalGet();

    const args = db.assistantEvalReport.findMany.mock.calls[0][0];
    expect(typeof args.take).toBe("number");
    const { body } = await callEvalGet();
    expect(body.historyNote).toContain(String(args.take));
  });
});

// ---------------------------------------------------------------------------
// POST /api/assistant/threads/[id]/report — ownership
// ---------------------------------------------------------------------------

describe("report-to-admin — ownership is absolute (404, never 403)", () => {
  test("a FOREIGN thread and a MISSING thread produce the SAME 404 body, and no row", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7201, isAdmin: false } });
    threads = [{ id: FOREIGN_THREAD, userId: OTHER_USER, title: "Someone else's" }];

    const foreign = await callReport(FOREIGN_THREAD);
    const missing = await callReport(MISSING_THREAD);

    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: "Thread not found", code: "NOT_FOUND" });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(foreign.body);
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
    // Never read: a foreign transcript is not loaded even to be discarded.
    expect(db.assistantMessage.findMany).not.toHaveBeenCalled();
  });

  test("an ADMIN reporter gets no bypass — ownership is the WHERE clause", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7202, isAdmin: true } });
    threads = [{ id: FOREIGN_THREAD, userId: OTHER_USER, title: "Someone else's" }];

    const { status } = await callReport(FOREIGN_THREAD);

    expect(status).toBe(404);
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });

  test("missing/invalid CSRF => 403 CSRF_INVALID before any read or write", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7203, isAdmin: false } });
    csrfMock.mockResolvedValue(false);
    seedTurn(1, { rows: [{ sku: "A-1", qty: 3 }] });

    const { status, body } = await callReport(OWN_THREAD);

    expect(status).toBe(403);
    expect(body).toEqual({ error: "Invalid CSRF token", code: "CSRF_INVALID" });
    expect(db.assistantMessage.findMany).not.toHaveBeenCalled();
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/assistant/threads/[id]/report — the FULL transcript
// ---------------------------------------------------------------------------

describe("report-to-admin — the FULL transcript crosses (Kris's call)", () => {
  test("prompts, answers, tool calls AND tool OUTPUTS are stored verbatim", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7301, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7301, title: "Stock questions" }];
    const output = { rows: [{ sku: "A-1", qty: 3, location: "Main" }], coverage: { note: "x" } };
    seedTurn(1, output);
    seedTurn(2, { rows: [] });

    const { status, body } = await callReport(OWN_THREAD, { reporterNote: "the numbers look off" });

    expect(status).toBe(201);
    expect(body).toMatchObject({
      reported: true,
      id: 1,
      truncation: { applied: false, omittedToolOutputCount: 0 },
    });

    const row = evalRows[0];
    expect(row.source).toBe("user-report");
    // C1: a user report has no corpus revision and may span models — NULL, never invented.
    expect(row.model).toBeNull();
    expect(row.corpusRev).toBeNull();
    expect(row.runAt.toISOString()).toBe(NOW.toISOString());

    const report = row.report as any;
    expect(report.threadId).toBe(OWN_THREAD);
    expect(report.userId).toBe(7301);
    expect(report.reporterNote).toBe("the numbers look off");
    expect(report.truncation).toEqual({ applied: false, omittedToolOutputCount: 0 });

    // Turns start at each user message, in transcript order.
    expect(report.turns).toHaveLength(2);
    expect(report.turns[0].messages.map((m: any) => m.id)).toEqual(["u1", "a1"]);
    expect(report.turns[1].messages.map((m: any) => m.id)).toEqual(["u2", "a2"]);
    // The tool OUTPUT is the ground truth at report time — byte-for-byte.
    expect(report.turns[0].messages[1].parts[0].output).toEqual(output);
    expect(report.turns[0].messages[1].metadata).toEqual({ finishReason: "stop" });
    expect(report.turns[0].messages[0].parts).toEqual([{ type: "text", text: "question 1" }]);
  });

  test("no reporter note => the key is absent, never an empty-string placeholder", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7302, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7302, title: null }];
    seedTurn(1, { rows: [] });

    await callReport(OWN_THREAD);

    expect(evalRows[0].report).not.toHaveProperty("reporterNote");
  });

  test("an over-long reporter note is refused (400) and writes nothing", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7303, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7303, title: null }];
    seedTurn(1, { rows: [] });

    const { status, body } = await callReport(OWN_THREAD, { reporterNote: "z".repeat(2_000) });

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/assistant/threads/[id]/report — the 2 MB cap + truncation ORDER
// ---------------------------------------------------------------------------

describe("report-to-admin — truthful degradation at REPORT_CAP_BYTES", () => {
  test("OLDEST tool outputs become markers FIRST; recent turns stay complete", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7401, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7401, title: null }];
    // 3 × ~900 KB of tool output = ~2.7 MB. Replacing ONE brings it under 2 MB, so
    // the ORDER is observable: replace the wrong end and turn 3 loses its output.
    const blob = (marker: string) => ({ marker, rows: `${marker}-${"x".repeat(900_000)}` });
    seedTurn(1, blob("oldest"));
    seedTurn(2, blob("middle"));
    seedTurn(3, blob("newest"));

    const { status, body } = await callReport(OWN_THREAD);

    expect(status).toBe(201);
    expect(body.truncation).toEqual({ applied: true, omittedToolOutputCount: 1 });

    const report = evalRows[0].report as any;
    expect(report.truncation).toEqual({ applied: true, omittedToolOutputCount: 1 });
    // The ORDER pin: turn 1's output is the marker; 2 and 3 are untouched.
    expect(report.turns[0].messages[1].parts[0].output).toBe(TOOL_OUTPUT_REPORT_MARKER);
    expect(report.turns[1].messages[1].parts[0].output.marker).toBe("middle");
    expect(report.turns[2].messages[1].parts[0].output.marker).toBe("newest");

    // Truncation removes OUTPUTS only: every prompt, every answer, every turn survives.
    expect(report.turns).toHaveLength(3);
    expect(report.turns[0].messages[0].parts[0].text).toBe("question 1");
    expect(report.turns[0].messages[1].parts[1].text).toBe("answer 1");
    // The tool CALL itself (id, input) is still there — only its output was dropped.
    expect(report.turns[0].messages[1].parts[0].toolCallId).toBe("call-1");
    expect(report.turns[0].messages[1].parts[0].input).toEqual({ productId: 42 });

    // And the stored payload really is inside the cap.
    expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeLessThanOrEqual(
      REPORT_CAP_BYTES,
    );
  });

  test("REV-9 overflow: still over cap with EVERY output a marker => 413 and NO row", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7402, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7402, title: null }];
    // The prose alone exceeds the cap: 3 × 900 KB of ANSWER text, which the rule
    // forbids touching. Shedding every tool output cannot save this report.
    seedTurn(1, { rows: [1] }, "a".repeat(900_000));
    seedTurn(2, { rows: [2] }, "b".repeat(900_000));
    seedTurn(3, { rows: [3] }, "c".repeat(900_000));

    const { status, body } = await callReport(OWN_THREAD);

    expect(status).toBe(413);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(db.assistantEvalReport.create).not.toHaveBeenCalled();
    expect(evalRows).toHaveLength(0);
  });

  test("an untruncated report discloses truncation:false — the disclosure is always present", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7403, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7403, title: null }];
    seedTurn(1, { rows: [{ sku: "A-1" }] });

    await callReport(OWN_THREAD);

    expect((evalRows[0].report as any).truncation).toEqual({
      applied: false,
      omittedToolOutputCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/assistant/threads/[id]/report — the 5/hr limit
// ---------------------------------------------------------------------------

describe("report-to-admin — rate limited 5/hr (the REAL limiter)", () => {
  test("the 6th report in the window is 429 RATE_LIMITED and writes no row", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7501, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7501, title: null }];
    seedTurn(1, { rows: [] });

    for (let i = 0; i < 5; i++) {
      expect((await callReport(OWN_THREAD)).status).toBe(201);
    }
    expect(evalRows).toHaveLength(5);

    const sixth = await callReport(OWN_THREAD);

    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("RATE_LIMITED");
    expect(evalRows).toHaveLength(5);
  });

  test("the budget is PER USER — another reporter is unaffected", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7502, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7502, title: null }];
    seedTurn(1, { rows: [] });
    for (let i = 0; i < 5; i++) await callReport(OWN_THREAD);
    expect((await callReport(OWN_THREAD)).status).toBe(429);

    approvedMock.mockResolvedValue({ user: { id: 7503, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7503, title: null }];

    expect((await callReport(OWN_THREAD)).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /api/admin/assistant-eval/[id]/export — byte fidelity (G2-12)
// ---------------------------------------------------------------------------

describe("export — admin-gated JSON download, BYTE-identical to the stored row", () => {
  test("403s a non-admin caller and reads NOTHING", async () => {
    adminMock.mockRejectedValue(new AppError("Admin access required", "FORBIDDEN", 403));

    const { status } = await callExport("1");

    expect(status).toBe(403);
    expect(db.assistantEvalReport.findUnique).not.toHaveBeenCalled();
  });

  test("an eval-run row exports byte-for-byte as the T10 DTO", async () => {
    await callEvalPost(evalUpload());
    const stored = evalRows[0];

    const { status, text, res } = await callExport("1");

    expect(status).toBe(200);
    // The comparand is built from the FRESHLY RE-READ row, not from the request.
    expect(text).toBe(serializeEvalExport(toEvalExportDto(stored)));
    expect(JSON.parse(text)).toEqual({
      id: 1,
      runAt: stored.runAt.toISOString(),
      environment: "dev",
      model: "claude-opus-5",
      corpusRev: "corpus-2026-08-11",
      source: "eval-run",
      report: evalUpload(),
      createdAt: stored.createdAt.toISOString(),
    });
    // Field ORDER is part of the contract (T10) — the serialization is canonical.
    expect(Object.keys(JSON.parse(text))).toEqual([
      "id",
      "runAt",
      "environment",
      "model",
      "corpusRev",
      "source",
      "report",
      "createdAt",
    ]);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="assistant-eval-1.json"',
    );
  });

  test("a USER-REPORT row exports the same way (both sources, one route)", async () => {
    approvedMock.mockResolvedValue({ user: { id: 7601, isAdmin: false } });
    threads = [{ id: OWN_THREAD, userId: 7601, title: null }];
    seedTurn(1, { rows: [{ sku: "A-1", qty: 3 }] });
    await callReport(OWN_THREAD, { reporterNote: "note" });
    const stored = evalRows[0];

    const { status, text } = await callExport("1");

    expect(status).toBe(200);
    expect(text).toBe(serializeEvalExport(toEvalExportDto(stored)));
    const parsed = JSON.parse(text);
    expect(parsed.source).toBe("user-report");
    expect(parsed.model).toBeNull();
    expect(parsed.corpusRev).toBeNull();
    // The whole transcript round-trips — that is what makes it corpus-ready.
    expect(parsed.report.turns[0].messages[1].parts[0].output).toEqual({
      rows: [{ sku: "A-1", qty: 3 }],
    });
  });

  test("a missing row is 404 NOT_FOUND; a non-numeric id is 400 VALIDATION_ERROR", async () => {
    const missing = await callExport("99");
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.text).code).toBe("NOT_FOUND");

    const bad = await callExport("abc");
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).code).toBe("VALIDATION_ERROR");
  });
});
