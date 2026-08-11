"use client";

/**
 * hooks/use-assistant-usage.ts — the admin assistant-usage query and, per the
 * ops-health precedent (`hooks/use-admin.ts`), the HOME of the wire contract:
 * `AssistantUsageResponse` is contract pack T11 verbatim, and the route imports it
 * type-only so no client bundle ever pulls in a route handler.
 *
 * TOKENS ONLY (spec C8 / Kris decision 2): there is no dollar field here and there
 * never will be — token counts are provider-reported facts, prices are not.
 *
 * Truthful data: `inputTokens` / `outputTokens` / `totalTokens` are NULLABLE on
 * purpose. NULL means "the provider reported no usage for these requests", which is
 * a different fact from "0 tokens" — consumers must render the reason, never a zero.
 */

import { useQuery } from "@tanstack/react-query";

export type AssistantUsageKind = "chat" | "title";

export interface AssistantUsageRollup {
  userId: number;
  displayName: string;
  dayKey: string;
  model: string;
  kind: AssistantUsageKind;
  requests: number;
  /** NULL = no contributing request reported usage. Never 0-as-measurement. */
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  aborted: number;
  errored: number;
  running: number;
  /** Requests whose usage columns are NULL — spend attempts carrying no token truth. */
  nullUsageRequests: number;
}

export interface AssistantUsageToolMixEntry {
  toolName: string;
  calls: number;
}

export interface AssistantUsageResponse {
  /** Inclusive UTC dayKeys. */
  range: { from: string; to: string };
  tokenRollups: AssistantUsageRollup[];
  toolMix: AssistantUsageToolMixEntry[];
  horizonNote: string;
}

export interface UsageFetchError extends Error {
  status?: number;
}

/** The range picker's default window (spec C8). The route carries its own copy of
 *  this number for callers that omit `from`/`to`; both are documented as 14. */
export const DEFAULT_RANGE_DAYS = 14;

export const RANGE_PRESET_DAYS = [7, 14, 30, 90] as const;

const DAY_MS = 86_400_000;

/**
 * The INCLUSIVE UTC dayKey window ending on `now`'s UTC day. The picker runs in the
 * browser, so this arithmetic is necessarily client-side — but it produces the exact
 * same `YYYY-MM-DD` strings the server stores in `assistant_requests.dayKey`, which
 * is why the range is expressed in dayKeys rather than timestamps.
 */
export function rangeForDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - (days - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

export function useAssistantUsage(range: { from: string; to: string }) {
  return useQuery<AssistantUsageResponse, UsageFetchError>({
    queryKey: ["assistant-usage", range.from, range.to],
    queryFn: async () => {
      const query = new URLSearchParams({ from: range.from, to: range.to });
      const res = await fetch(`/api/admin/assistant-usage?${query.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error || `Request failed (${res.status})`) as UsageFetchError;
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as AssistantUsageResponse;
    },
  });
}
