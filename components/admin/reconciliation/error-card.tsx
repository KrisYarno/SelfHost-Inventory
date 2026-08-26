"use client";

/**
 * components/admin/reconciliation/error-card.tsx — the ONE failed-read card the
 * three reconciliation tabs render (QA-5).
 *
 * WHAT A FAILED READ IS ALLOWED TO SAY. A 4xx is the server telling the operator
 * what is wrong with the request THEY made: a window over the 366-day span cap,
 * a cursor that belongs to another filter, a day that is not a real date. That
 * sentence is the whole repair, and a card that replaced it with "Could not load
 * the attribution report." threw the repair away and left a Retry button that
 * fails identically, forever.
 *
 * A 5xx — or a network failure, which carries no status at all — says nothing an
 * operator can act on, and the server's prose there is for a log, not a screen.
 * So those keep the caller's own copy.
 *
 * The card lives in ONE file because three copies of this rule is three chances
 * for one of them to keep rendering the generic line.
 */

import { Button } from "@/components/ui/button";
import type { ApiError } from "@/hooks/use-admin";

/** Is this the server answering the REQUEST, rather than failing on its own? */
function isClientError(error: unknown): error is ApiError {
  const status = (error as ApiError | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

export interface ReconciliationErrorCardProps {
  /** The query's error, whatever TanStack handed back. */
  error: unknown;
  /** What to say when the failure is not the operator's to fix. */
  fallback: string;
  onRetry: () => void;
}

export function ReconciliationErrorCard({
  error,
  fallback,
  onRetry,
}: ReconciliationErrorCardProps) {
  const serverMessage = isClientError(error) ? error.serverMessage : undefined;

  return (
    <div
      data-testid="reconciliation-error"
      className="rounded-lg border border-negative-border bg-negative-muted p-4 text-negative-foreground"
    >
      <p className="text-body">{serverMessage ?? fallback}</p>
      <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
