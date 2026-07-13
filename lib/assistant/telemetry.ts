/**
 * lib/assistant/telemetry.ts — read-telemetry for BOTH surfaces (spec R-A4).
 *
 * One row per tool invocation into `assistant_runs`. Metadata ONLY — never prompts,
 * args, or results. Best-effort: NEVER throws into the caller (a failed telemetry
 * write must not break a read). Retention prune keeps the newest 10k rows.
 *
 * MUST stay Next-free.
 */

import prisma from "@/lib/prisma";
import type { ProviderKind } from "@/lib/assistant/providers";

const RETENTION_KEEP = 10_000;
const PRUNE_EVERY = 500;

export type RecordRun = typeof recordAssistantRun;

/**
 * Record one tool invocation. Best-effort (logs + swallows on failure). The
 * retention prune runs opportunistically (every PRUNE_EVERY-th insert) so the hot
 * path stays a single INSERT.
 */
export async function recordAssistantRun(row: {
  userId?: number;
  tokenId?: string;
  surface: "assistant" | "mcp";
  providerKind?: ProviderKind;
  model?: string;
  toolName: string;
  outcome: "ok" | "error" | "truncated";
  durationMs: number;
  resultBytes: number;
}): Promise<void> {
  try {
    const created = await prisma.assistantRun.create({
      data: {
        userId: row.userId ?? null,
        tokenId: row.tokenId ?? null,
        surface: row.surface,
        providerKind: row.providerKind ?? null,
        model: row.model ?? null,
        toolName: row.toolName,
        outcome: row.outcome,
        durationMs: row.durationMs,
        resultBytes: row.resultBytes,
      },
      select: { id: true },
    });

    if (created.id % PRUNE_EVERY === 0) {
      const cutoff = await prisma.assistantRun.findMany({
        orderBy: { id: "desc" },
        skip: RETENTION_KEEP,
        take: 1,
        select: { id: true },
      });
      if (cutoff[0]) {
        await prisma.assistantRun.deleteMany({ where: { id: { lte: cutoff[0].id } } });
      }
    }
  } catch (err) {
    console.error("[assistant-telemetry] recordAssistantRun failed (non-fatal)", err);
  }
}
