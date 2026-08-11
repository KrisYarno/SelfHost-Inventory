/**
 * app/api/admin/assistant-eval/route.ts — the bounded live-eval surface
 * (spec C9 / Kris decision 3; contract pack T10, seams S13/S15/S16).
 *
 * POST uploads ONE scored run of the curated corpus (the C7 replay driver in LIVE
 * mode produces it); GET feeds the usage page's eval section.
 *
 * D9: the POST is a coverage-registry PERMANENT_EXEMPT entry — it writes assistant
 * FEATURE state (an evaluation artefact), never business state, and will never
 * migrate to `recordChange`. The GET is read-only and takes no entry at all.
 *
 * SOURCE DISCRIMINATION (spec C1): this route writes `eval-run` rows and only
 * `eval-run` rows. `model` and `corpusRev` are REQUIRED here because a scored run
 * always knows both; the user-report path leaves them NULL because a production
 * report has no corpus revision and may span models. A `source` key in the uploaded
 * body is not read — the writer decides what it wrote.
 *
 * EXCERPTS, NOT TRANSCRIPTS: `answerExcerpt` is capped at 500 characters BY THE
 * SCHEMA (spec C9). Prod-dump-derived answers are summarized here, never dumped —
 * the full-transcript exception belongs to the owner-initiated report path alone.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { apiHandler, requireAdmin, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { serializedBytes } from "@/lib/assistant/threads";
import { EVAL_CAP_BYTES, evalReportSchema } from "@/lib/assistant/eval-contracts";
import type {
  AssistantEvalResponse,
  AssistantEvalSummary,
} from "@/hooks/use-assistant-eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many rows the section lists. Small table (spec C1), bounded anyway — and the
 *  bound is DISCLOSED in the response rather than silently applied. */
const HISTORY_LIMIT = 50;

const SUMMARY_SELECT = {
  id: true,
  runAt: true,
  environment: true,
  model: true,
  corpusRev: true,
  source: true,
  createdAt: true,
} as const;

type SummaryRow = {
  id: number;
  runAt: Date;
  environment: string;
  model: string | null;
  corpusRev: string | null;
  source: string;
  createdAt: Date;
};

/** Columns pass through as stored (the 3.1 `kind` precedent): the write sites are
 *  the only producers, and relabelling stored text would be a fabrication. */
function toSummary(row: SummaryRow): AssistantEvalSummary {
  return {
    id: row.id,
    runAt: row.runAt.toISOString(),
    environment: row.environment,
    model: row.model,
    corpusRev: row.corpusRev,
    source: row.source as AssistantEvalSummary["source"],
    createdAt: row.createdAt.toISOString(),
  };
}

export const POST = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  await requireCSRF(request);

  const body = await request.json();

  // The cap is measured on the CANONICAL serialization, the same representation the
  // C2 message cap and the history budget use — and BEFORE validation, so an
  // oversized upload is refused without walking it.
  if (serializedBytes(body) > EVAL_CAP_BYTES) {
    throw new AppError(
      `Eval report exceeds the ${EVAL_CAP_BYTES}-byte upload cap`,
      "VALIDATION_ERROR",
      413,
    );
  }

  const report = evalReportSchema.parse(body);

  const row = await prisma.assistantEvalReport.create({
    data: {
      runAt: new Date(report.runAt),
      environment: report.environment,
      model: report.model,
      corpusRev: report.corpusRev,
      source: "eval-run",
      // The stored document is the validated upload itself: the columns exist to be
      // queried, the JSON exists to be exported, and both are written from the one
      // parsed object so they cannot disagree.
      report,
    },
    select: SUMMARY_SELECT,
  });

  return NextResponse.json(toSummary(row), { status: 201 });
});

export const GET = apiHandler(async () => {
  await requireAdmin();

  const [latest, history] = await Promise.all([
    // The newest SCORED RUN, not the newest row: a user report arriving after the
    // last eval must not be displayed as "the latest evaluation".
    prisma.assistantEvalReport.findFirst({
      where: { source: "eval-run" },
      orderBy: { runAt: "desc" },
    }),
    prisma.assistantEvalReport.findMany({
      orderBy: { runAt: "desc" },
      take: HISTORY_LIMIT,
      select: SUMMARY_SELECT,
    }),
  ]);

  const response: AssistantEvalResponse = {
    latest: latest ? { ...toSummary(latest), report: latest.report } : null,
    // Summaries ONLY. A user report holds a full conversation; it crosses to an admin
    // screen by the deliberate per-row export, never as a payload the list page
    // happens to carry.
    history: history.map(toSummary),
    historyNote: `Showing the ${HISTORY_LIMIT} most recent reports (newest first).`,
  };

  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
});
