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
 *
 * THE URL IS AN INPUT, NOT ONLY AN OUTPUT (OCa-7). Reading `?tab=` in the
 * `useState` initializer alone made the drill-down's finder links inert: an
 * in-place soft navigation to `?tab=unmapped` changed the URL and the shell
 * stayed where it was. And rebuilding the query string from the tab alone
 * ERASED every other param the link or the admin had put there. So the tab is
 * adjusted FROM the URL during render (the "adjusting state when props change"
 * idiom the Attribution tab already uses for its match chip), the replace
 * carries the other params through, and it only fires when the two actually
 * disagree — replacing a URL with itself is the loop.
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
  const requested = (searchParams?.get("tab") ?? null) as TabKey | null;
  /** The tab the URL names, or null when it names nothing this release renders. */
  const urlTab =
    requested !== null && AVAILABLE_TABS.includes(requested) ? requested : null;

  const [tab, setTab] = React.useState<TabKey>(urlTab ?? "attribution");

  // Adjusted DURING render, so no effect can race the replace below: when the
  // URL's tab CHANGES (a finder link), it wins; when the admin clicks a
  // trigger, the URL has not changed and the click stands.
  // FD-3: the URL changing to the tab WE last wrote is our own replace landing,
  // not a navigation — a second click made before it landed must stand. The
  // ref is consumed once, so a later genuine link to that same tab still wins.
  const lastWrittenRef = React.useRef<TabKey | null>(null);
  const [urlTabSeen, setUrlTabSeen] = React.useState<TabKey | null>(urlTab);
  if (urlTabSeen !== urlTab) {
    setUrlTabSeen(urlTab);
    if (urlTab !== null && urlTab === lastWrittenRef.current) {
      lastWrittenRef.current = null;
    } else if (urlTab !== null && urlTab !== tab) {
      setTab(urlTab);
    }
  }

  React.useEffect(() => {
    // Nothing to say: the URL already names this tab.
    if (urlTab === tab) return;
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.set("tab", tab);
    lastWrittenRef.current = tab;
    router.replace(`/admin/reconciliation?${next.toString()}`);
  }, [tab, urlTab, searchParams, router]);

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
