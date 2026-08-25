"use client";

/**
 * components/admin/reconciliation/page-shell.tsx — the /admin/reconciliation
 * tab shell (pack C4a.1; spec REV-7 §7).
 *
 * Three tabs are named by the spec; ONE of them exists today. The other two are
 * DISABLED and say why, and nothing is mounted behind them: a tab that opens
 * onto an empty panel reads as "there is nothing to see here", which is a
 * different claim from "this ships next" — and on a reconciliation surface the
 * difference between "no exceptions" and "no exceptions tab yet" is exactly the
 * kind of thing this lane exists to stop happening.
 *
 * The `?tab=` sync is the `/admin/logs` idiom (`router.replace`); admin-only is
 * enforced server-side by `app/(app)/admin/layout.tsx`, which also makes the
 * whole /admin subtree dynamic — so `useSearchParams` needs no Suspense
 * boundary here, exactly as /admin/logs relies on.
 */

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AttributionTab } from "./attribution-tab";

type TabKey = "attribution" | "exceptions" | "unmapped";

/** The tabs this release can actually render. */
const AVAILABLE_TABS: readonly TabKey[] = ["attribution"];

/** Honest, minimal, and replaced by M4b. */
export const TAB_COMING_TITLE = "coming in this release";

export function ReconciliationPageShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams?.get("tab") as TabKey | null;
  const [tab, setTab] = React.useState<TabKey>(
    requested !== null && AVAILABLE_TABS.includes(requested) ? requested : "attribution",
  );

  React.useEffect(() => {
    router.replace(`/admin/reconciliation?tab=${tab}`);
  }, [tab, router]);

  return (
    <div className="container mx-auto space-y-6 overflow-x-hidden p-4 sm:p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Reconciliation</h1>
        <p className="text-muted-foreground">
          Which outbound batches belong to which orders, how that was decided, and what this
          report cannot see.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
        <TabsList className="flex flex-wrap gap-2">
          <TabsTrigger value="attribution">Attribution</TabsTrigger>
          <TabsTrigger value="exceptions" disabled title={TAB_COMING_TITLE}>
            Exceptions
          </TabsTrigger>
          <TabsTrigger value="unmapped" disabled title={TAB_COMING_TITLE}>
            Unmapped
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attribution" className="space-y-6">
          <AttributionTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
