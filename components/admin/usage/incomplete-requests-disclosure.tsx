"use client";

/**
 * components/admin/usage/incomplete-requests-disclosure.tsx — the incomplete-requests
 * disclosure the usage page owes (spec C8).
 *
 * Two DIFFERENT incompletenesses, never merged into one number:
 *   - `running` — the request row never reached a terminal status (still streaming, or
 *     the process died mid-turn). Its outcome is unknown, not zero.
 *   - `nullUsageRequests` — no usage was ever reported (W3S-3: this INCLUDES rows
 *     still `running` — the two figures overlap until a request finalizes), so
 *     its token columns are NULL. Real spend attempts carrying no token truth.
 *
 * Both figures carry their definition inline, which is why they are disclosed here
 * rather than left as two more columns nobody reads.
 */

import { USAGE_DEFINITIONS } from "./usage-definitions";
import type { AssistantUsageRollup } from "@/hooks/use-assistant-usage";

export function IncompleteRequestsDisclosure({ rollups }: { rollups: AssistantUsageRollup[] }) {
  const running = rollups.reduce((sum, row) => sum + row.running, 0);
  const nullUsage = rollups.reduce((sum, row) => sum + row.nullUsageRequests, 0);

  if (running === 0 && nullUsage === 0) {
    return (
      <div className="p-4 sm:p-6" data-testid="incomplete-none">
        <h2 className="text-h4">Incomplete requests</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Every request in this range finalized, and every one of them reported its usage.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4 sm:p-6">
      <h2 className="text-h4">Incomplete requests</h2>

      {running > 0 && (
        <div>
          <p className="text-body">
            <span className="tabular-nums font-medium" data-testid="incomplete-running">
              {running}
            </span>{" "}
            never finalized
          </p>
          <p className="text-body-sm text-muted-foreground">{USAGE_DEFINITIONS.running}</p>
        </div>
      )}

      {nullUsage > 0 && (
        <div>
          <p className="text-body">
            <span className="tabular-nums font-medium" data-testid="incomplete-null-usage">
              {nullUsage}
            </span>{" "}
            reported no usage
          </p>
          <p className="text-body-sm text-muted-foreground">
            {USAGE_DEFINITIONS.nullUsageRequests}
          </p>
        </div>
      )}
    </div>
  );
}
