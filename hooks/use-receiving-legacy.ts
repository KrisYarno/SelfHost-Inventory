"use client";

import { useQuery } from "@tanstack/react-query";
import {
  readShipmentError,
  ShipmentApiError,
} from "@/hooks/use-inbound-shipments";
import type { LegacyLineView } from "@/lib/supply-orders/queries";

/**
 * THE PRE-STAGING ARCHIVE'S READ (contract pack C5.1).
 *
 * Its own tiny module, and deliberately not part of `use-labeling`: this is
 * RECEIVING HISTORY — the boxes of the retired flow — and the only thing it
 * shares with the labeling queue is that both are lines. Giving it the labeling
 * cache key would mean every stock-in invalidated an archive that cannot change.
 *
 * There is no mutation here and there never will be: the rows are kept so a
 * receipt stays findable, not so it can be edited.
 */

export const legacyLineKeys = {
  all: ["receiving", "legacy-lines"] as const,
};

/**
 * The archive page: the newest `LEGACY_LINE_LIMIT` rows PLUS how many older
 * ones the bound left off (spec REV-10 clause 6). The counts travel with the
 * rows because the cue that renders them must never be able to contradict them.
 */
type LegacyLinesPage = {
  lines: LegacyLineView[];
  count: number;
  moreCount: number;
};

/** The newest page of GRADUATED/DISCARDED boxes (`LEGACY_LINE_LIMIT`). */
export function useLegacyLines() {
  return useQuery<LegacyLinesPage, ShipmentApiError>({
    queryKey: legacyLineKeys.all,
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/receiving/legacy-lines", { signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw readShipmentError(res, json, "Failed to load the pre-staging history");
      }
      const page = json as Partial<LegacyLinesPage>;
      const lines = page?.lines ?? [];
      return {
        lines,
        count: page?.count ?? lines.length,
        moreCount: page?.moreCount ?? 0,
      };
    },
  });
}
