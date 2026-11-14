"use client";

import { useQuery } from "@tanstack/react-query";
import { getJSON } from "@/hooks/get-json";
import type { ProductLocationQuantity } from "@/types/inventory";

// ---------------------------------------------------------------------------
// THE COUNT'S VERSION READ (reconciliation Part 2, pack § P2-B3-2 C2-5; seam
// S-B24). The Adjust stock dialog's Count sends the row version it read with
// the number the operator counted, and the server books the difference only
// when that version is still the row's (`countAtLocation`, under the prelock).
// A version is a LOCK TOKEN, not a display number, so this read differs from
// its sibling `useProductLocationQuantity` on purpose:
//
// - READ ONCE PER OPEN. `staleTime: Infinity` — a cached answer never goes
//   stale while the dialog is open, so Count → Remove → Count never re-reads
//   under a count already typed (the version sent is the one on screen, read
//   before the count). `gcTime: 0` — no token outlives the open: the hosts
//   mount the dialog per open, so the next open reads fresh.
// - NO SILENT RE-READ. `refetchOnWindowFocus: false` (already the app default,
//   `lib/query-client.ts` — stated so its pin means something) and
//   `refetchOnReconnect: false` (the app default is ON — the load-bearing one):
//   a re-read the operator did not ask for would let a count taken before a
//   sale be checked against the version after it, and overwrite the sale.
// - The ONLY re-reads asked for are an explicit `refetch()`: the dialog's
//   `Try again` and its 409 path. "In flight" is `fetchStatus === "fetching"`
//   (the first read AND a refetch), never `status === "pending"` alone.
// - NO AUTOMATIC RETRY. `retry: false` — a failed read goes straight to
//   "failed" with `Try again` (FR2, row 130 (3)). The app default (`retry: 1`,
//   `lib/query-client.ts`) would wait a second and retry, and react-query
//   PAUSES a retry it cannot continue in a hidden tab — which the dialog shows
//   as "You're offline" while the device is online.
// - ONE re-read nobody asks for: re-entering Count after a FAILED first read
//   reads again, because a query with no data is always stale (`staleTime`
//   cannot keep fresh an answer that never came). Harmless: the dialog's count
//   field is disabled until a read is known, so nothing can have been typed
//   against the failed one.
// - NOT a root of `invalidateInventoryCaches`: a per-open read gains nothing
//   from it, and a refetch path is exactly what the token must not have.
//
// It reads the product's `/locations` route (approved callers; it synthesises
// `{ quantity: 0, version: 0 }` for a never-stocked location, which is the
// version the server's prelock materialises), never the `[id]` route.
// ---------------------------------------------------------------------------

interface ProductLocationsResponse {
  productId: number;
  productName: string;
  locations: ProductLocationQuantity[];
}

/**
 * The quantity and row version at one location, for the dialog's Count.
 * `data` is `null` only when the location is absent from the answer; a non-2xx
 * answer throws (`status: "error"`). Disabled with no location.
 */
export function useProductLocationVersion(
  productId: number,
  locationId: number | null,
  opts: { enabled: boolean },
) {
  return useQuery({
    queryKey: ["product-location-version", productId, locationId],
    queryFn: async ({ signal }): Promise<{ quantity: number; version: number } | null> => {
      const body = await getJSON<ProductLocationsResponse>(
        `/api/inventory/product/${productId}/locations`,
        { signal },
      );
      const row = body.locations.find((loc) => loc.locationId === locationId);
      return row === undefined ? null : { quantity: row.quantity, version: row.version };
    },
    enabled: opts.enabled && locationId !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
