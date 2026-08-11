/**
 * app/api/assistant/threads/[id]/report/route.ts — "Report this conversation to
 * the admin" (spec C9 + REV-9; contract pack T10, seams S13/S15/S16).
 *
 * CONSENT-ONLY. This route is the ONLY path by which private conversation text
 * reaches an admin: there is no admin-initiated request flow and no admin browsing
 * of threads, by design (Kris 2026-08-10). Ownership is the WHERE clause and there
 * is no admin bypass — a foreign thread answers EXACTLY as a missing one (404
 * NOT_FOUND, byte-identical body), so the route is not an existence oracle.
 *
 * FULL TRANSCRIPT INCLUDING TOOL OUTPUTS (Kris's call): prompts, answers, tool calls
 * and their structured outputs verbatim. Prose-vs-structured comparison is the
 * faithfulness method that found every truthfulness defect in reviews #1-#3, and the
 * tool outputs are the ground truth AT REPORT TIME — without them, QA means
 * re-running tools against drifted data.
 *
 * The 2 MB cap degrades TRUTHFULLY: oldest turns' tool OUTPUTS become markers first,
 * recent turns stay complete, and the truncation is disclosed INSIDE the stored
 * payload. When even that is not enough (REV-9), the answer is 413 and NO ROW —
 * dropping prompts, answers or whole turns would leave a stored record of a
 * conversation nobody had.
 *
 * D9: coverage-registry PERMANENT_EXEMPT — assistant feature state (an evaluation
 * artefact derived from the caller's own chat), never business state.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { apiHandler, requireApproved, requireCSRF } from "@/lib/api-utils";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { AppError } from "@/lib/error-handling";
import {
  REPORT_CAP_BYTES,
  reportRequestSchema,
  truncateUserReport,
  type UserReport,
} from "@/lib/assistant/eval-contracts";
import type {
  AssistantMessageMetadata,
  ThreadMessageDto,
} from "@/lib/assistant/thread-contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Spec C9: 5 per hour, per user. Reporting is a deliberate human act; this bounds
 *  a scripted one without getting in a real reporter's way. */
const RATE_LIMIT = { limit: 5, ttl: 60 * 60 * 1000 } as const;

interface RouteParams {
  params: { id: string };
}

type MessageRow = {
  id: string;
  role: string;
  parts: unknown;
  metadata: unknown;
};

/**
 * The recorded environment. The app cannot tell staging from production — a staging
 * build IS a production build — so it records only what it actually knows, and the
 * "staging" value of the C1 vocabulary is reachable through the eval-run upload,
 * which is told where it ran. (Registered: naming staging here would need a
 * deploy-time variable, which this task does not invent.)
 */
function reportEnvironment(): string {
  return process.env.NODE_ENV === "production" ? "production" : "dev";
}

/** A turn starts at each user message; anything before the first one is its own
 *  leading turn (the `lib/assistant/threads.ts` grouping rule, verbatim). */
function groupIntoTurns(rows: ThreadMessageDto[]): Array<{ messages: ThreadMessageDto[] }> {
  const turns: Array<{ messages: ThreadMessageDto[] }> = [];
  let current: ThreadMessageDto[] | null = null;
  for (const row of rows) {
    if (current === null || row.role === "user") {
      current = [];
      turns.push({ messages: current });
    }
    current.push(row);
  }
  return turns;
}

export const POST = apiHandler(async (request: NextRequest, { params }: RouteParams) => {
  const { user } = await requireApproved();
  await requireCSRF(request);
  const rateLimitHeaders = enforceRateLimit(request, "assistant:report", {
    identifier: user.id,
    limit: RATE_LIMIT.limit,
    ttl: RATE_LIMIT.ttl,
  });

  // An empty body is a report with no note, not a malformed request.
  const raw = await request.json().catch(() => ({}));
  const { reporterNote } = reportRequestSchema.parse(raw ?? {});

  const threadId = params.id;
  const thread = await prisma.assistantThread.findFirst({
    where: { id: threadId, userId: user.id },
    select: { id: true },
  });
  // Existence is never leaked (G1), and there is no admin bypass: an admin reporting
  // someone else's thread would be the admin-browsing flow this design refuses.
  if (!thread) throw new AppError("Thread not found", "NOT_FOUND", 404);

  const rows: MessageRow[] = await prisma.assistantMessage.findMany({
    where: { threadId },
    orderBy: { sequence: "asc" },
    select: { id: true, role: true, parts: true, metadata: true },
  });

  const messages: ThreadMessageDto[] = rows.map((row) => ({
    id: row.id,
    role: row.role as ThreadMessageDto["role"],
    // Parts pass through UNCHANGED — tool outputs included. This is the one place in
    // the product where that is the requirement rather than a hazard.
    parts: (Array.isArray(row.parts) ? row.parts : []) as unknown[],
    metadata: (row.metadata ?? null) as AssistantMessageMetadata | null,
  }));

  const report: UserReport = {
    threadId,
    userId: user.id,
    // Absent, not empty: an empty string would claim the reporter wrote nothing when
    // they were never asked.
    ...(reporterNote ? { reporterNote } : {}),
    turns: groupIntoTurns(messages),
    truncation: { applied: false, omittedToolOutputCount: 0 },
  };

  const bounded = truncateUserReport(report, REPORT_CAP_BYTES);
  if (!bounded.fits) {
    throw new AppError(
      "This conversation is too large to report even with every tool output omitted",
      "VALIDATION_ERROR",
      413,
    );
  }

  const row = await prisma.assistantEvalReport.create({
    data: {
      runAt: new Date(),
      environment: reportEnvironment(),
      // C1: a user report has no corpus revision and may span models. NULL is the
      // truth; a plausible-looking value would be a fabrication.
      model: null,
      corpusRev: null,
      source: "user-report",
      // The `threads.ts` cast idiom: a UserReport is JSON by construction (it came
      // out of JSON columns), but its named type is not an InputJsonObject.
      report: bounded.report as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return applyRateLimitHeaders(
    NextResponse.json(
      // The reporter is told what actually crossed, including any degradation.
      { reported: true, id: row.id, truncation: bounded.report.truncation },
      { status: 201 },
    ),
    rateLimitHeaders,
  );
});
