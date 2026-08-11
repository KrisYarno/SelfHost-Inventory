"use client";

/**
 * app/(app)/admin/usage/page.tsx — the admin assistant usage page (spec C8;
 * Kris decision 2). Admin-gated by `app/(app)/admin/layout.tsx`; the API behind it is
 * independently `requireAdmin()`-gated.
 *
 * TOKENS ONLY — no dollar estimate is shown, because none exists to show.
 *
 * PRIVACY (spec C8, the precise wording): no PRIVATE conversation content appears on
 * this page. The C9 section — admin-curated corpus excerpts and USER-INITIATED
 * reports, the one explicit labelled exception — mounts at EVAL_SECTION_MOUNT_ID and
 * is built by task 3.2. 3.1 leaves the anchor empty on purpose.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenRollupTable } from "@/components/admin/usage/token-rollup-table";
import { ToolMixPanel } from "@/components/admin/usage/tool-mix-panel";
import { IncompleteRequestsDisclosure } from "@/components/admin/usage/incomplete-requests-disclosure";
import { UsageRangePicker } from "@/components/admin/usage/usage-range-picker";
import { EvalSection } from "@/components/admin/usage/eval-section";
import {
  TOKENS_ONLY_NOTE,
  PRIVACY_NOTE,
  EVAL_SECTION_MOUNT_ID,
} from "@/components/admin/usage/usage-definitions";
import {
  DEFAULT_RANGE_DAYS,
  rangeForDays,
  useAssistantUsage,
} from "@/hooks/use-assistant-usage";

export default function AdminUsagePage() {
  const [days, setDays] = React.useState<number>(DEFAULT_RANGE_DAYS);
  const range = React.useMemo(() => rangeForDays(days), [days]);
  const usageQuery = useAssistantUsage(range);

  const data = usageQuery.data;

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <Link
          href="/admin/settings"
          className="inline-flex items-center gap-1 text-body-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> System Settings
        </Link>
        <div className="flex items-center gap-2">
          <Gauge className="h-7 w-7" />
          <h1 className="text-display">Assistant usage</h1>
        </div>
        <p className="text-body text-muted-foreground">{TOKENS_ONLY_NOTE}</p>
        <p className="text-body text-muted-foreground">{PRIVACY_NOTE}</p>
      </div>

      <UsageRangePicker days={days} onDaysChange={setDays} range={data?.range ?? range} />

      {usageQuery.isLoading ? (
        <div className="space-y-3" data-testid="usage-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-[240px] w-full" />
        </div>
      ) : usageQuery.isError || !data ? (
        <div className="rounded-md border border-negative-border bg-negative-muted p-4">
          <p className="text-body text-negative-foreground">Could not load assistant usage.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => usageQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <TokenRollupTable rollups={data.tokenRollups} />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              <ToolMixPanel toolMix={data.toolMix} horizonNote={data.horizonNote} />
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-surface">
              <IncompleteRequestsDisclosure rollups={data.tokenRollups} />
            </div>
          </div>
        </>
      )}

      {/* MOUNT POINT — the spec-C9 bounded live-eval + user-report section (task
          3.2). It is the page's ONE labelled exception to the privacy note above:
          admin-curated corpus prompts/excerpts, and rows for user-INITIATED reports
          whose transcripts leave only by the deliberate per-row export. */}
      <div id={EVAL_SECTION_MOUNT_ID} data-testid="assistant-eval-mount">
        <EvalSection />
      </div>
    </div>
  );
}
