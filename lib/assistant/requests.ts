/**
 * lib/assistant/requests.ts — `assistant_requests` writers for the TITLE surface,
 * plus the ONE UTC dayKey source both surfaces share (contract pack T3; spec C6/C8).
 *
 * CHAT request rows are written by lib/assistant/threads.ts (claim transaction +
 * fenced finalizer). This module owns the detached title call's audit row, which is
 * real spend and is attributed even when the call fails.
 *
 * G2 (truthful telemetry) is enforced HERE, once, for title rows: usage columns are
 * written EXACTLY as reported — `undefined` becomes NULL, never 0-as-measurement.
 *
 * MUST stay Next-free (and `ai`-free: threads.ts imports `utcDayKey`).
 */

import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import type { UsageTriple } from "@/lib/assistant/thread-contracts";

/**
 * The stored rollup dimension (C1 `dayKey`, C8 rollups). Prisma cannot group a
 * computed date and MySQL's `DATE(createdAt)` would silently use the session
 * timezone, so the UTC day is computed once at insert — HERE, by this function,
 * everywhere.
 */
export function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Create the `running` title row. NOT fenced — it is the row a later
 *  `finalizeTitleRequest` fences on. */
export async function insertTitleRequest(row: {
  userId: number;
  threadId: string;
  providerKind: string;
  model: string;
  membershipScope: string[];
}): Promise<number> {
  const created = await prisma.assistantRequest.create({
    data: {
      threadId: row.threadId,
      userId: row.userId,
      kind: "title",
      providerKind: row.providerKind,
      model: row.model,
      status: "running",
      membershipScope: row.membershipScope as Prisma.InputJsonValue,
      dayKey: utcDayKey(new Date()),
    },
    select: { id: true },
  });
  return created.id;
}

export type TitleRequestOutcome =
  | { ok: true; usage: UsageTriple | null; durationMs: number }
  | { ok: false; errorCode: string; durationMs: number };

/**
 * Finalize a title row, FENCED on `status = "running"`: a hung title call's late
 * result can never re-open a row someone else already closed. Zero affected rows is
 * a normal outcome, not an error.
 */
export async function finalizeTitleRequest(id: number, outcome: TitleRequestOutcome): Promise<void> {
  const data = outcome.ok
    ? {
        status: "ok",
        errorCode: null,
        inputTokens: outcome.usage?.inputTokens ?? null,
        outputTokens: outcome.usage?.outputTokens ?? null,
        totalTokens: outcome.usage?.totalTokens ?? null,
        durationMs: outcome.durationMs,
      }
    : {
        status: "error",
        errorCode: outcome.errorCode,
        durationMs: outcome.durationMs,
      };

  await prisma.assistantRequest.updateMany({ where: { id, status: "running" }, data });
}
