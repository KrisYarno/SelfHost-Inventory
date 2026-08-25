"use client";

/**
 * components/admin/reconciliation/page-shell.tsx — the /admin/reconciliation
 * tab shell (pack C4a.1; spec REV-7 §7).
 *
 * Three tabs are named by the spec and all three are live (M4b lands the
 * finder and the unmapped queue). Each tab mounts ITS content and only its
 * content: on a surface whose whole subject is what a read can and cannot see,
 * mounting all three at once would fire three reads for a question nobody
 * asked, and the two the admin is not looking at would go stale in place.
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
import { ExceptionsTab } from "./exceptions-tab";
import { UnmappedTab } from "./unmapped-tab";

type TabKey = "attribution" | "exceptions" | "unmapped";

/** The tabs this release can actually render. */
const AVAILABLE_TABS: readonly TabKey[] = ["attribution", "exceptions", "unmapped"];

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
          <TabsTrigger value="exceptions">Exceptions</TabsTrigger>
          <TabsTrigger value="unmapped">Unmapped</TabsTrigger>
        </TabsList>

        <TabsContent value="attribution" className="space-y-6">
          <AttributionTab />
        </TabsContent>

        <TabsContent value="exceptions" className="space-y-6">
          <ExceptionsTab />
        </TabsContent>

        <TabsContent value="unmapped" className="space-y-6">
          <UnmappedTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
