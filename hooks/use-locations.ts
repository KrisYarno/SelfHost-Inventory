"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * THE ONE HOME of the locations query (plan P-9, contract pack C2c.4).
 *
 * There were two copies of this hook — one in `use-staging`, one in
 * `use-account` — and both wrote the SAME react-query key `["locations"]` with
 * DIFFERENT parsers. That is a real bug, not untidiness: whichever hook mounted
 * first decided what shape the other hook's consumers read out of the cache, so
 * a dialog could be handed a payload its own parser would have normalized.
 *
 * The merge keeps everything both copies did well:
 *   - `enabled`, so a dialog that is closed does not fetch (use-staging);
 *   - the ABORT SIGNAL, so an unmount cancels the request (use-account);
 *   - the TOLERANT PARSE, because `/api/locations` returns a bare array today
 *     and `{ locations }` is the house envelope it may grow into;
 *   - the SERVER'S error message when it sends one.
 *
 * `locationKeys` lives here too — the key and its parser belong together, which
 * is the whole lesson of the two copies.
 */

export interface Location {
  id: number;
  name: string;
}

export const locationKeys = {
  all: ["locations"] as const,
};

/** Locations catalog. GET needs no CSRF; shared cache across every dialog. */
export function useLocations(enabled = true) {
  return useQuery<Location[]>({
    queryKey: locationKeys.all,
    enabled,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/locations", { signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to fetch locations");
      return (json?.locations ?? json ?? []) as Location[];
    },
  });
}
