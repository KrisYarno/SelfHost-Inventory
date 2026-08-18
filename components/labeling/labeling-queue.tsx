"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BatchRow } from "@/components/labeling/batch-row";
import { labelingScope, useLabelingQueue } from "@/hooks/use-labeling";
import { useLocations, type Location } from "@/hooks/use-locations";
import {
  useDiscardRemaining,
  type SupplyOrderLineView,
} from "@/hooks/use-supply-orders";

/**
 * THE LABELING QUEUE (contract pack C5.2, spec §4.3).
 *
 * Everything somebody verified and nobody has finished stocking, oldest verify
 * first, grouped by the delivery it arrived on. It is the bench's worklist, and
 * four things keep it honest:
 *
 *   1. EVERY NUMBER ARRIVES COMPUTED. Verified, stocked, disposed, remaining —
 *      the server reads them from the locked row and this screen prints them.
 *      Nothing here subtracts anything from anything.
 *   2. THE BOUND IS SAID OUT LOUD. The queue is capped (`LABELING_QUEUE_LIMIT`)
 *      and the COUNT runs in the same read transaction, so "N more to label" is
 *      a fact rather than a guess. Without it, a full bench looks finished.
 *   3. `exceptionKeys` IS `[]` ON THIS PATH (amendment 4a). The queue's read does
 *      not join exceptions; an empty array here means "this read did not ask",
 *      NOT "this line is clean" — so the screen says nothing about them and
 *      sends the operator to the order detail, which does ask.
 *   4. THE BATCH ROW IS MOUNTED, NOT REBUILT (S21). The one implementation of
 *      the booking key, the replay-aware toast and the D-COST prompt is
 *      `components/labeling/batch-row.tsx`, mounted here and in the order
 *      detail's fast path.
 *
 * DISCARD REMAINING is the other half of finishing a line: units that were
 * verified and then lost before anything was stocked. It is NOT a stock movement
 * — the units never became stock — which is exactly what the confirmation says,
 * along with how to undo one recorded by mistake.
 */

export interface LabelingQueueProps {
  /** The `?orderId=` deep link. An empty value is no filter at all (QA-9). */
  orderId?: string;
}

// ---------------------------------------------------------------------------
// Presentation helpers (display only)
// ---------------------------------------------------------------------------

/**
 * The ordered DAY, read back in UTC — `orderedAt` is the UTC midnight of a
 * calendar day somebody typed, and a local getter would show the day before it
 * to every reader west of Greenwich.
 */
function formatOrderedDay(value: Date | string): string {
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().slice(0, 10);
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "ORDERED" || status === "RECEIVING") return "default";
  if (status === "CLOSED") return "secondary";
  return "outline";
}

/** The server's sentence, or the least-wrong fallback. Never a re-wording. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

interface QueueLineProps {
  orderId: string;
  line: SupplyOrderLineView;
  locations: Location[];
}

function QueueLine({ orderId, line, locations }: QueueLineProps) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const discardRemaining = useDiscardRemaining(orderId);

  const verified = line.verifiedQuantity;
  const trimmedReason = reason.trim();

  const closePanel = () => {
    setConfirming(false);
    setReason("");
  };

  const submitDiscard = async () => {
    if (trimmedReason === "") return;
    setRefusal(null);
    try {
      const result = await discardRemaining.mutateAsync({
        lineId: line.id,
        reason: trimmedReason,
      });
      // The count comes back from the LOCKED row — never from what was on
      // screen when the button was pressed.
      toast.success(
        `Remainder written off — ${result.disposedQuantity} unit(s) disposed on this line`,
      );
      closePanel();
    } catch (error) {
      // C4b.4: the caches are already refreshed (the mutation invalidates on
      // settle), so the server's sentence lands next to the new truth.
      setRefusal(messageOf(error, "Failed to write off the remainder"));
    }
  };

  return (
    <li
      data-testid={`labeling-line-${line.id}`}
      className="space-y-3 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="truncate font-medium">{line.productName}</p>
          <p
            data-testid={`labeling-progress-${line.id}`}
            className="text-xs text-muted-foreground"
          >
            {`stocked ${line.stockedQuantity} / verified ${verified === null ? "—" : verified}`}
          </p>
        </div>
        <Badge variant={line.labelingRequired ? "outline" : "secondary"}>
          {line.labelingRequired ? "Labeling required" : "Ready to stock"}
        </Badge>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Verified</dt>
          <dd className="tabular-nums">{verified === null ? "—" : verified}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Stocked</dt>
          <dd className="tabular-nums">{line.stockedQuantity}</dd>
        </div>
        {line.disposedQuantity > 0 && (
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Disposed</dt>
            <dd data-testid={`labeling-disposed-${line.id}`} className="tabular-nums">
              {line.disposedQuantity}
            </dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-muted-foreground">Remaining</dt>
          <dd data-testid={`labeling-remaining-${line.id}`} className="tabular-nums">
            {line.remaining}
          </dd>
        </div>
      </dl>

      <BatchRow
        orderId={orderId}
        lineId={line.id}
        remaining={line.remaining}
        priorLocationId={line.locationId}
        locations={locations}
      />

      {!confirming && (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Discard remaining
        </Button>
      )}

      {confirming && (
        <div
          data-testid={`discard-remaining-${line.id}`}
          className="space-y-2 rounded-md border border-border p-3"
        >
          <p className="text-xs text-muted-foreground">
            Units verified but lost before stocking — this is a labeling loss, not a
            stock movement; a disposal recorded in error is corrected by re-raising the
            verified count in Receiving and stocking the units
          </p>
          <p
            data-testid={`discard-remaining-asof-${line.id}`}
            className="text-xs text-muted-foreground"
          >
            {`As of the last refresh: ${line.remaining} unit(s) remaining.`}
          </p>
          <Label htmlFor={`discard-remaining-reason-${line.id}`} className="text-xs">
            What happened to them?
          </Label>
          <Input
            id={`discard-remaining-reason-${line.id}`}
            data-testid={`discard-remaining-reason-${line.id}`}
            className="h-9"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid={`discard-remaining-confirm-${line.id}`}
              onClick={submitDiscard}
              disabled={trimmedReason === "" || discardRemaining.isPending}
            >
              {/* NO CACHED NUMBER (REV-10 clause 10): the server writes off
                  what the LOCKED row still has, which may not be the figure
                  this card was drawn with. The success toast reports the
                  server's count. */}
              {discardRemaining.isPending ? "Writing it off…" : "Write off the remainder"}
            </Button>
            <Button size="sm" variant="ghost" onClick={closePanel}>
              Keep them
            </Button>
          </div>
        </div>
      )}

      {refusal && (
        <p
          data-testid={`labeling-refusal-${line.id}`}
          className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
        >
          {refusal}
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export function LabelingQueue({ orderId }: LabelingQueueProps) {
  // ONE reading of "is this a deep link" (QA-9): the hook keys its cache off the
  // same normalization, so the banner can never claim one order while the read
  // asked for all of them.
  const scope = labelingScope(orderId);
  const { data, isPending, isError, error } = useLabelingQueue(scope);
  const { data: locations = [] } = useLocations();

  const groups = data?.groups ?? [];
  const shown = groups.reduce((total, group) => total + group.lines.length, 0);

  return (
    <div className="space-y-4">
      {scope && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Showing one order.</span>
          <Link href="/labeling" className="font-medium text-foreground hover:underline">
            Show all
          </Link>
        </div>
      )}

      {isPending && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading the queue…
        </div>
      )}

      {isError && (
        <div
          data-testid="labeling-queue-error"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">The labeling queue could not be loaded.</p>
            <p className="text-muted-foreground">
              {error?.message ?? "Reload the page to try again."}
            </p>
          </div>
        </div>
      )}

      {!isPending && !isError && groups.length === 0 && (
        <div
          data-testid="labeling-queue-empty"
          className="rounded-lg border border-border bg-surface p-8 text-center"
        >
          <p className="text-sm text-muted-foreground">
            Nothing to label — verified lines land here.
          </p>
        </div>
      )}

      {!isPending &&
        !isError &&
        groups.map((group) => (
          <section
            key={group.order.id}
            data-testid={`labeling-group-${group.order.id}`}
            className="space-y-3 rounded-lg border border-border bg-surface p-3"
          >
            <div className="min-w-0 space-y-1">
              <Link
                href={`/receiving/${group.order.id}`}
                className="block truncate font-medium hover:underline"
              >
                {group.order.supplierRef ?? group.order.id}
              </Link>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant={statusVariant(group.order.status)}>
                  {group.order.status}
                </Badge>
                <span className="truncate">
                  {group.order.supplier ?? "No supplier named"}
                </span>
                <span>{`Ordered ${formatOrderedDay(group.order.orderedAt)}`}</span>
              </div>
            </div>

            <ul className="space-y-3">
              {group.lines.map((line) => (
                <QueueLine
                  key={line.id}
                  orderId={group.order.id}
                  line={line}
                  locations={locations}
                />
              ))}
            </ul>
          </section>
        ))}

      {!isPending && !isError && data && data.moreCount > 0 && (
        <p data-testid="labeling-queue-more" className="text-xs text-muted-foreground">
          {`Showing the oldest ${shown} of ${data.count} lines — ${data.moreCount} more to label.`}
        </p>
      )}
    </div>
  );
}
