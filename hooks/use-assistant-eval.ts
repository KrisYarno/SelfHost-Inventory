"use client";

/**
 * hooks/use-assistant-eval.ts — the admin eval-report query and, per the 3.1
 * precedent (`hooks/use-assistant-usage.ts` / ops-health), the HOME of its wire
 * contract: the route imports these types TYPE-ONLY, so no client bundle ever pulls
 * a route handler — and no client bundle pulls `lib/assistant/eval-contracts.ts`,
 * which is server-side (it reaches prisma through the canonical byte measurement).
 *
 * Truthful data: `model` and `corpusRev` are NULLABLE because a user report has
 * neither (spec C1). Consumers render a named reason — never an invented model name
 * and never a blank that reads like one.
 *
 * History rows carry NO report payload on purpose: a user report holds a full
 * conversation, and it reaches an admin screen only through the deliberate per-row
 * export below.
 */

import { useQuery } from "@tanstack/react-query";
import type { EvalSource } from "@/lib/assistant/eval-contracts";

export interface AssistantEvalSummary {
  id: number;
  runAt: string;
  environment: string;
  /** NULL on a user report — no corpus revision exists, so none is shown. */
  model: string | null;
  corpusRev: string | null;
  source: EvalSource;
  createdAt: string;
}

export interface AssistantEvalLatest extends AssistantEvalSummary {
  /** The scored-run document (spec C9 header + per-turn verdicts). */
  report: unknown;
}

export interface AssistantEvalResponse {
  /** The newest EVAL-RUN, not the newest row. */
  latest: AssistantEvalLatest | null;
  history: AssistantEvalSummary[];
  /** The applied bound, in words, so the list never looks complete when it is not. */
  historyNote: string;
}

export interface EvalFetchError extends Error {
  status?: number;
}

export const ASSISTANT_EVAL_QUERY_KEY = ["assistant-eval"] as const;

/** The per-row download (spec C9). A plain link: the browser saves the file the
 *  route names, and nothing about the payload passes through this page. */
export function evalExportHref(id: number): string {
  return `/api/admin/assistant-eval/${id}/export`;
}

export function useAssistantEvalReports() {
  return useQuery<AssistantEvalResponse, EvalFetchError>({
    queryKey: ASSISTANT_EVAL_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/admin/assistant-eval");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || `Request failed (${res.status})`) as EvalFetchError;
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as AssistantEvalResponse;
    },
  });
}
