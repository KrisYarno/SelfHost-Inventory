"use client";

import type { ProductWithQuantity } from "@/types/product";
// TYPE-ONLY (facelift F2 A17): no client file value-imports the helper's module.
import type { StockState } from "@/lib/stock-threshold";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/**
 * Facelift FR1-14: the ONE map of the five state words. The badges below and
 * the Products list's CSV (`Stock state`) both read it; `ok` has no badge and
 * exports as `OK`.
 */
export const STOCK_STATE_WORDS: Record<StockState, string> = {
  ok: "OK",
  low: "Low",
  out: "Out",
  "below-zero": "Below zero",
  "no-record": "No record",
};

/**
 * Facelift F2-6: the state word beside the total, in its tone. `stockState` is
 * read from the response (A24); the UI never recomputes it. `ok` has no badge.
 */
const STATE_TONES: Record<Exclude<StockState, "ok">, StatusTone> = {
  low: "warning",
  out: "negative",
  "below-zero": "negative",
  "no-record": "neutral",
};

interface ProductStockProps {
  product: Pick<ProductWithQuantity, "totalQuantity" | "hereQuantity" | "stockState">;
  /** The answer's `hereLocationId` echo: the location every `hereQuantity` describes. */
  hereLocationId: number | null | undefined;
  /** The CONFIRMED location's id (`useLocation().selectedLocationId`), or null. */
  selectedLocationId: number | null;
  /** The table shows "here" in its own column, so its Stock cell leaves the line out. */
  showHere?: boolean;
  /** Referenced by the row's and tile's `aria-describedby` (B12). */
  id?: string;
  className?: string;
}

/**
 * The stock figure shared by the row, the tile and the table (facelift F2-6,
 * A15, B9, B12): the all-locations total, its state word, and the "here" line.
 *
 * - A `null` total is a structural "no stock row": `—`, hidden from assistive
 *   tech, with the `No record` badge carrying the meaning (no extra sr text).
 * - The here line shows ONLY when a location is confirmed AND the answer's
 *   `hereLocationId` is that location, so placeholder data read for another
 *   location never labels itself "here".
 * - An `undefined` field renders NOTHING: no `—`, no `0`.
 */
export function ProductStock({
  product,
  hereLocationId,
  selectedLocationId,
  showHere = true,
  id,
  className,
}: ProductStockProps) {
  const { totalQuantity, hereQuantity, stockState } = product;
  const badge =
    stockState === undefined || stockState === "ok"
      ? null
      : { tone: STATE_TONES[stockState], word: STOCK_STATE_WORDS[stockState] };
  const hereShown =
    showHere &&
    selectedLocationId !== null &&
    hereLocationId === selectedLocationId &&
    hereQuantity !== undefined;

  if (totalQuantity === undefined && !badge && !hereShown) return null;

  // The `{" "}` text nodes keep the words apart in the accessible description
  // ("48 Low 4 here"); a flex container drops whitespace-only text from layout.
  return (
    <div id={id} className={cn("flex flex-col gap-0.5", className)}>
      {(totalQuantity !== undefined || badge) && (
        <div className="flex items-center gap-2">
          {totalQuantity === null ? (
            <span aria-hidden="true" className="text-base font-semibold tabular-nums text-foreground">
              —
            </span>
          ) : totalQuantity !== undefined ? (
            <span className="text-base font-semibold tabular-nums text-foreground">{totalQuantity}</span>
          ) : null}{" "}
          {badge && <StatusBadge tone={badge.tone}>{badge.word}</StatusBadge>}
        </div>
      )}{" "}
      {hereShown && (
        <div className="text-xs text-muted-foreground">
          {hereQuantity === null ? "No record here" : `${hereQuantity} here`}
        </div>
      )}
    </div>
  );
}
