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
 * THE URL IS THE ONLY SOURCE OF TRUTH FOR THE TAB (OCa-7 → FD-3 → FD2-1).
 * Reading `?tab=` once into local state made the drill-down's finder links
 * inert, and every attempt to reconcile a local mirror WITH the URL (a
 * render-time adjust, then a last-written ref) was correct for exactly one
 * in-flight replace and wrong for two. So there is no mirror: the tab IS
 * `?tab=`, a click is a `router.replace` inside a transition, and the only
 * local value is the clicked tab shown while that transition is pending —
 * bounded by `isPending`, so nothing outlives the navigation that wrote it.
 * The replace carries the other params through (a link's or the admin's).
 */

import * as React from "react";
import { cn } from "@/lib/utils";
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
  const [isPending, startTransition] = React.useTransition();
  const requested = (searchParams?.get("tab") ?? null) as TabKey | null;
  /** The tab the URL names, or null when it names nothing this release renders. */
  const urlTab =
    requested !== null && AVAILABLE_TABS.includes(requested) ? requested : null;

  // The clicked tab, shown ONLY while its navigation is pending: once the
  // transition settles the URL is the answer again, landed or not.
  const [clicked, setClicked] = React.useState<TabKey | null>(null);
  const tab: TabKey = isPending && clicked !== null ? clicked : (urlTab ?? "attribution");

  const goTo = React.useCallback(
    (next: TabKey) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("tab", next);
      setClicked(next);
      startTransition(() => {
        router.replace(`/admin/reconciliation?${params.toString()}`);
      });
    },
    [router, searchParams],
  );

  // A URL naming no renderable tab is written ONCE per such episode, so a reload
  // lands where the admin was (the /admin/logs idiom). The ref makes "once"
  // structural: a router whose identity changes per render (a test double) must
  // not turn this into a transition loop.
  const wroteDefaultRef = React.useRef(false);
  React.useEffect(() => {
    if (urlTab !== null) {
      wroteDefaultRef.current = false;
      return;
    }
    if (wroteDefaultRef.current) return;
    wroteDefaultRef.current = true;
    goTo("attribution");
  }, [urlTab, goTo]);

  return (
    <div className="container mx-auto space-y-6 overflow-x-hidden p-4 sm:p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Reconciliation</h1>
        <p className="text-muted-foreground">
          Which outbound batches belong to which orders, how that was decided, and what this
          report cannot see.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => goTo(value as TabKey)}>
        <TabsList
          className={cn("flex flex-wrap gap-2", isPending && "opacity-70")}
          aria-busy={isPending || undefined}
        >
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
