"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUpdateProduct } from "@/hooks/use-products";
import {
  useStockIn,
  type CostPrompt,
  type ShipmentApiError,
  type StockInResult,
} from "@/hooks/use-supply-orders";
import type { Location } from "@/hooks/use-locations";

/**
 * THE BATCH ROW (contract pack C4b.0, seam S21; spec §4.3.2-3).
 *
 * ONE business action — "these N labeled units went to this location" — mounted
 * in the two places an operator performs it: the order detail's fast path for a
 * line that skips the bench (M4b), and the labeling queue (M5). It is a single
 * component because idempotency and the cost prompt are the two things a second
 * copy would get subtly wrong.
 *
 * THREE RULES, all load-bearing:
 *
 *   1. THE QUANTITY IS TYPED. The field starts EMPTY and returns to empty after
 *      every attempt; it is never seeded from `remaining` or from the verified
 *      count. A pre-filled number is a number nobody counted, and the whole
 *      point of booking a batch is that somebody just physically labeled it.
 *   2. THE TOAST REPORTS WHAT WAS PERSISTED. `batch.quantity` and
 *      `batch.locationId` come back from the server, and a REPLAY (the same
 *      `bookingKey` re-sent after a retry) reports the ORIGINAL batch —
 *      "already stocked 5 at Main — not repeated" — which is only truthful if
 *      nothing here recomputes it from what was typed.
 *   3. D-COST IS THE SERVER'S DECISION. The prompt opens only for a successful,
 *      NON-replayed booking that carries a `costPrompt`. The server's
 *      "first batch on this line" rule is the once-per-line authority; a client
 *      "already shown" flag would drift from it the moment a tab reloads. The
 *      durable `cost-differs` exception row is written either way — this prompt
 *      only offers to move the product's standing cost, through the ordinary
 *      product PUT (same authorization, same audit) and never a back door.
 *
 * The bookingKey lives in `useStockIn` (C4a.1): the caller cannot pass one, so
 * it cannot pass a stale one.
 */

export interface BatchRowProps {
  /** The order the line belongs to — the route's `[id]`. */
  orderId: string;
  lineId: number;
  /** Verified minus stocked minus disposed, from the server's line view. */
  remaining: number;
  /** `line.locationId` — where the LAST batch went; the next-batch default. */
  priorLocationId: number | null;
  locations: Location[];
  /** Fired after a booking lands (replay included) with the server's result. */
  onStocked?: (result: StockInResult) => void;
  /** Fired when the server refused, with the parsed error (the caller may log). */
  onRefused?: (error: ShipmentApiError) => void;
  /** The host has its own reason to hold the row (a settled order, no CSRF). */
  disabled?: boolean;
  className?: string;
}

/** INT cents -> money. NULL is "no representable cost", never $0.00. */
function formatCents(cents: number | null): string {
  if (cents === null) return "Not priced";
  return `$${(cents / 100).toFixed(2)}`;
}

export function BatchRow({
  orderId,
  lineId,
  remaining,
  priorLocationId,
  locations,
  onStocked,
  onRefused,
  disabled = false,
  className,
}: BatchRowProps) {
  const { data: session } = useSession();
  const stockIn = useStockIn(orderId);
  const updateProduct = useUpdateProduct();

  // RULE 1, in one line: the initial state is the empty string, and the only
  // thing that ever writes it is the operator's keyboard (or the reset after a
  // settled attempt).
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [locationId, setLocationId] = useState<number | null>(
    priorLocationId ?? session?.user?.defaultLocationId ?? null,
  );
  // WHOSE CHOICE IS THIS (spec REV-10 clause 10). The session resolves
  // asynchronously and `priorLocationId` arrives with the line's next refetch,
  // both of them AFTER this row first renders — so the default is re-applied
  // until the operator touches the select, and never afterwards. A ref, not
  // state: touching the select must not re-render anything by itself.
  const locationTouched = useRef(false);
  const sessionDefaultLocationId = session?.user?.defaultLocationId ?? null;
  useEffect(() => {
    if (locationTouched.current) return;
    setLocationId(priorLocationId ?? sessionDefaultLocationId ?? null);
  }, [priorLocationId, sessionDefaultLocationId]);
  // The refusal stays ON SCREEN (C4b.4): the server's sentence names the
  // counters this attempt collided with, and a toast that scrolls away takes the
  // one piece of information the operator needs to decide what to type next.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [costPrompt, setCostPrompt] = useState<CostPrompt | null>(null);

  const typed = /^\d+$/.test(quantity.trim()) ? Number(quantity.trim()) : null;
  const canBook = typed !== null && typed >= 1 && locationId !== null && !disabled;

  const locationName = (id: number | null): string => {
    if (id === null) return "no location";
    return locations.find((location) => location.id === id)?.name ?? `location ${id}`;
  };

  const handleBook = async () => {
    if (!canBook || typed === null || locationId === null) return;
    setRefusal(null);
    try {
      const result = await stockIn.mutateAsync({
        lineId,
        quantity: typed,
        locationId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });

      // RULE 2 — every number in this sentence came back from the server.
      const { batch } = result;
      toast.success(
        batch.replayed
          ? `Already stocked ${batch.quantity} at ${locationName(batch.locationId)} — not repeated`
          : `Stocked ${batch.quantity} at ${locationName(batch.locationId)}`,
      );
      setQuantity("");
      setNote("");
      // The line's next-batch default follows the batch that just landed.
      setLocationId(batch.locationId);
      // RULE 3 — a replay books nothing, so it prices nothing.
      if (!batch.replayed && result.costPrompt) setCostPrompt(result.costPrompt);
      onStocked?.(result);
    } catch (error) {
      // The caches have already been refreshed (the mutation invalidates on
      // settle and `mutateAsync` rejects after that), so the message lands NEXT
      // TO the refreshed truth rather than next to the stale one.
      const apiError = error as ShipmentApiError;
      const message =
        apiError instanceof Error ? apiError.message : "Failed to record the batch";
      setRefusal(message);
      onRefused?.(apiError);
    }
  };

  const handleCostUpdate = async () => {
    if (!costPrompt) return;
    try {
      await updateProduct.mutateAsync({
        id: costPrompt.productId,
        data: { costPrice: costPrompt.receiptCents / 100 },
      });
      toast.success("Product cost updated from the receipt");
      setCostPrompt(null);
    } catch (error) {
      console.error("Error updating product cost:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update the cost");
    }
  };

  return (
    <div
      data-testid={`batch-row-${lineId}`}
      className={`space-y-3 rounded-lg border border-border bg-surface p-3 ${className ?? ""}`}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,7rem)_minmax(0,12rem)_minmax(0,1fr)]">
        <div className="space-y-1.5">
          <Label htmlFor={`batch-quantity-${lineId}`} className="text-xs">
            Quantity
          </Label>
          <Input
            id={`batch-quantity-${lineId}`}
            data-testid={`batch-quantity-${lineId}`}
            inputMode="numeric"
            className="h-9"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="Units labeled"
            disabled={disabled}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`batch-location-${lineId}`} className="text-xs">
            Location
          </Label>
          <Select
            value={locationId === null ? undefined : String(locationId)}
            onValueChange={(value) => {
              locationTouched.current = true;
              setLocationId(Number(value));
            }}
            disabled={disabled}
          >
            <SelectTrigger
              id={`batch-location-${lineId}`}
              className="h-9"
              aria-label="Location"
            >
              <SelectValue placeholder="Choose a location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.id} value={String(location.id)}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={`batch-note-${lineId}`} className="text-xs">
            Note
          </Label>
          <Input
            id={`batch-note-${lineId}`}
            className="h-9"
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional"
            disabled={disabled}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={handleBook} disabled={!canBook || stockIn.isPending}>
          {stockIn.isPending
            ? "Recording…"
            : typed === null
              ? "Stock labeled units"
              : `Stock ${typed} labeled units`}
        </Button>
        <span className="text-xs text-muted-foreground">
          {`${remaining} left to label on this line`}
        </span>
        {locationId === null && (
          <span className="text-xs text-muted-foreground">
            Choose a location — a batch is stocked somewhere specific.
          </span>
        )}
      </div>

      {refusal && (
        <p
          data-testid={`batch-refusal-${lineId}`}
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          {refusal}
        </p>
      )}

      <Dialog
        open={costPrompt !== null}
        onOpenChange={(next) => {
          // Dismissing IS "Keep": the stock is already booked at the receipt's
          // cost, and the product's standing cost is what it always was.
          if (!next) setCostPrompt(null);
        }}
      >
        <DialogContent className="sm:max-w-[440px]" data-testid="cost-prompt">
          <DialogHeader>
            <DialogTitle>This receipt was priced differently</DialogTitle>
            <DialogDescription>
              The stock is already booked at the receipt&apos;s cost. Nothing has been
              changed on the product.
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-2 gap-2 rounded-md border border-border bg-surface p-3 text-sm">
            <dt className="text-muted-foreground">Product cost</dt>
            <dd className="text-right font-medium">
              {formatCents(costPrompt?.currentCents ?? null)}
            </dd>
            <dt className="text-muted-foreground">This receipt</dt>
            <dd className="text-right font-medium">
              {formatCents(costPrompt?.receiptCents ?? null)}
            </dd>
          </dl>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCostPrompt(null)}
              disabled={updateProduct.isPending}
            >
              Keep current cost
            </Button>
            <Button onClick={handleCostUpdate} disabled={updateProduct.isPending}>
              {updateProduct.isPending ? "Updating…" : "Update product cost"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
