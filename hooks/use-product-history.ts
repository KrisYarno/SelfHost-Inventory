"use client";

/**
 * hooks/use-product-history.ts — the per-product History timeline query
 * (Lane 3 Task 3, Lane W2-A). Wraps GET /api/products/[id]/history in a
 * TanStack useInfiniteQuery whose page param IS the keyset TimelineCursor:
 *
 *   - "Load more" = fetchNextPage; pages accumulate (select flat-maps entries);
 *   - the compound cursor is encoded base64url(JSON) into the `before` param;
 *   - `enabled` is gated on the History tab being active (lazy fetch — the query
 *     never fires while the Performance tab is shown).
 */

import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import type { TimelineEntry, TimelineCursor } from "@/lib/history/union-timeline";

export interface ProductHistoryPage {
  entries: TimelineEntry[];
  nextCursor: TimelineCursor | null;
  dataStart: { events: string | null; ledger: string | null };
}

export interface ProductHistoryData {
  entries: TimelineEntry[];
  dataStart: { events: string | null; ledger: string | null };
}

// base64url(JSON) of the cursor. A TimelineCursor is an ISO ts + two ints, so it
// is ASCII-safe for btoa; Buffer is the SSR/test fallback.
function encodeCursor(cursor: TimelineCursor): string {
  const json = JSON.stringify(cursor);
  const b64 =
    typeof btoa !== "undefined" ? btoa(json) : Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Module-scope select (a per-render closure would hand back fresh arrays every
// render — see use-reports.ts). dataStart comes from the first page (it is
// keyset-invariant across pages).
const selectHistory = (data: InfiniteData<ProductHistoryPage>): ProductHistoryData => ({
  entries: data.pages.flatMap((p) => p.entries),
  dataStart: data.pages[0]?.dataStart ?? { events: null, ledger: null },
});

export function useProductHistory(
  id: string | undefined,
  opts: { enabled: boolean; limit?: number },
) {
  const { enabled, limit } = opts;
  return useInfiniteQuery({
    queryKey: ["product-history", id, { limit: limit ?? null }],
    enabled: enabled && !!id,
    queryFn: async ({ pageParam, signal }) => {
      const qp = new URLSearchParams();
      if (limit) qp.set("limit", String(limit));
      if (pageParam) qp.set("before", encodeCursor(pageParam as TimelineCursor));
      const qs = qp.toString();
      const res = await fetch(`/api/products/${id}/history${qs ? `?${qs}` : ""}`, { signal });
      if (!res.ok) throw new Error("Failed to load history");
      return (await res.json()) as ProductHistoryPage;
    },
    initialPageParam: null as TimelineCursor | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: selectHistory,
  });
}
