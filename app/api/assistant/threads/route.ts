/**
 * app/api/assistant/threads/route.ts — the caller's thread list (spec C5).
 *
 * G1 posture: ownership is SERVER-DERIVED. `userId` comes from the session and
 * rides in the WHERE clause — there is no client-supplied owner to spoof and no
 * admin bypass for thread content.
 *
 * `messageCount` is one grouped count over the page's ids, never a per-row query:
 * the sidebar renders 20 threads at a time and an N+1 here would be 21 round trips
 * per paint.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z, ZodError } from "zod";
import prisma from "@/lib/prisma";
import { requireApproved, errorResponse } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import type { ThreadListResponse } from "@/lib/assistant/thread-contracts";

// Node runtime (Prisma needs it) and never cached — the list is per-session.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/**
 * Plain `z.object` (house rule). A malformed page request is a 400, but a valid
 * page request that is simply too big is CLAMPED to MAX_LIMIT rather than
 * rejected: `limit` is a client hint, and the response echoes the limit actually
 * applied so the caller's next `offset` stays correct either way.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Map a guard/parse failure to plain JSON (the sibling app/api/assistant/route.ts
 *  pattern: AppError carries its own safe message/code/status). */
function guardError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return errorResponse(err.errors[0]?.message || "Invalid request", 400, "VALIDATION_ERROR");
  }
  if (err instanceof AppError) {
    return errorResponse(err.message, err.statusCode, err.code);
  }
  console.error("[assistant-threads] list error", err instanceof Error ? err.name : "unknown");
  return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { user } = await requireApproved();

    const params = request.nextUrl.searchParams;
    const parsed = listQuerySchema.parse({
      limit: params.get("limit") ?? undefined,
      offset: params.get("offset") ?? undefined,
    });
    const limit = Math.min(parsed.limit, MAX_LIMIT);
    const offset = parsed.offset;

    // One row of over-fetch is the whole "is there a next page" mechanism — a
    // second COUNT(*) over the same predicate would cost more and could disagree
    // with the page under concurrent writes.
    const rows = await prisma.assistantThread.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      skip: offset,
      take: limit + 1,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const counts =
      page.length > 0
        ? await prisma.assistantMessage.groupBy({
            by: ["threadId"],
            where: { threadId: { in: page.map((row) => row.id) } },
            _count: { _all: true },
          })
        : [];
    const countByThread = new Map(counts.map((c) => [c.threadId, c._count._all]));

    const body: ThreadListResponse = {
      items: page.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // A thread with no grouped row genuinely has no messages (0 is measured
        // here, not assumed).
        messageCount: countByThread.get(row.id) ?? 0,
      })),
      limit,
      offset,
      nextOffset: hasMore ? offset + page.length : null,
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return guardError(err);
  }
}
