/**
 * app/api/assistant/threads/[id]/route.ts — one thread's transcript, and its
 * deletion (spec C5).
 *
 * G1 posture: the ownership check IS the WHERE clause (`id` AND session `userId`).
 * A thread that belongs to someone else is reported EXACTLY as a thread that does
 * not exist — same status, same body — so the route is not an existence oracle.
 * No admin bypass: thread content is the user's.
 *
 * `activeRequest` is the bounded answer to the refresh-during-streaming race: a
 * `running` chat request YOUNGER than the claim lease means another session is
 * generating into this thread. A `running` row older than the lease is a hung row,
 * not a live turn — it deliberately surfaces NOTHING here (it stays visible as an
 * incomplete row on the usage page until the next claim fences it, spec C5/C2).
 *
 * DELETE owns no database logic of its own: `deleteThreadGuarded` runs the same
 * claim lock the chat route uses, so a delete can never race a live finalizer.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireCSRF, errorResponse } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { deleteThreadGuarded } from "@/lib/assistant/threads";
import { CLAIM_STALE_MS } from "@/lib/assistant/timing";
import type {
  AssistantMessageMetadata,
  ThreadDetailResponse,
  ThreadMessageDto,
} from "@/lib/assistant/thread-contracts";

// Node runtime (Prisma needs it) and never cached — the transcript is per-session.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Map a guard failure to plain JSON (the sibling app/api/assistant/route.ts
 *  pattern: AppError carries its own safe message/code/status — NOT_FOUND 404,
 *  THREAD_BUSY 409, CSRF_INVALID 403, FORBIDDEN 403, UNAUTHORIZED 401). */
function guardError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return errorResponse(err.message, err.statusCode, err.code);
  }
  console.error("[assistant-threads] detail error", err instanceof Error ? err.name : "unknown");
  return errorResponse("Internal server error", 500, "INTERNAL_ERROR");
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const { user } = await requireApproved();
    const threadId = params.id;

    const thread = await prisma.assistantThread.findFirst({
      where: { id: threadId, userId: user.id },
      select: { id: true, title: true },
    });
    // Existence is never leaked (G1): unowned reads the same as absent.
    if (!thread) throw new AppError("Thread not found", "NOT_FOUND", 404);

    const staleCutoff = new Date(Date.now() - CLAIM_STALE_MS);
    const [rows, live] = await Promise.all([
      prisma.assistantMessage.findMany({
        where: { threadId },
        orderBy: { sequence: "asc" },
        select: { id: true, role: true, parts: true, metadata: true },
      }),
      prisma.assistantRequest.findFirst({
        where: {
          threadId,
          kind: "chat",
          status: "running",
          createdAt: { gt: staleCutoff },
        },
        select: { id: true },
      }),
    ]);

    const body: ThreadDetailResponse = {
      id: thread.id,
      title: thread.title,
      messages: rows.map((row) => ({
        id: row.id,
        role: row.role as ThreadMessageDto["role"],
        parts: row.parts as unknown[],
        // SQL NULL stays null: a persisted turn with no terminal metadata is not
        // the same as one that finished cleanly, and `{}` would erase that.
        metadata: (row.metadata ?? null) as AssistantMessageMetadata | null,
      })),
      activeRequest: live ? { status: "running" } : null,
    };

    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return guardError(err);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  try {
    const { user } = await requireApproved();
    await requireCSRF(request);
    // Ownership (404), the claim lock and THREAD_BUSY (409) all live in the
    // module; this route only surfaces its vocabulary.
    await deleteThreadGuarded(user.id, params.id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return guardError(err);
  }
}
