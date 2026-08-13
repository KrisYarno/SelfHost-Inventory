"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useInboundShipments,
  type ShipmentStatusFilter,
  type ShipmentSummary,
} from "@/hooks/use-inbound-shipments";
import { CreateShipmentDialog } from "@/components/receiving/create-shipment-dialog";

/**
 * The receiving list (seam S10 — it renders W1-2a's T4 shapes and computes
 * nothing).
 *
 * Two rules carry the whole surface:
 *
 *   1. OVER AND UNDER NEVER CANCEL. The server reports them as separate
 *      magnitudes, and so does this list. A shipment 5 over on one line and 3
 *      under on another is NOT "+2" — netting them is precisely how a big
 *      shortage hides behind a big surplus.
 *   2. UNCOUNTED IS UNKNOWN. A line nobody counted contributes nothing to the
 *      totals; it is reported on its own, because it is the only thing that can
 *      block the close.
 *
 * Plus the aging cue: an OPEN receipt is unfinished work, so it wears its age.
 */

const STATUS_TABS: { value: ShipmentStatusFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "OPEN", label: "Open" },
  { value: "CLOSED", label: "Closed" },
  { value: "CANCELLED", label: "Cancelled" },
];

/** Past this many days an OPEN receipt is stale enough to call out. */
const STALE_OPEN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function daysOpen(createdAt: string): number {
  const opened = new Date(createdAt).getTime();
  if (!Number.isFinite(opened)) return 0;
  return Math.max(0, Math.floor((Date.now() - opened) / DAY_MS));
}

function statusVariant(
  status: ShipmentSummary["status"],
): "default" | "secondary" | "outline" {
  if (status === "OPEN") return "default";
  if (status === "CLOSED") return "secondary";
  return "outline";
}

/**
 * The discrepancy cell. Uncounted lines are reported FIRST and separately —
 * "nothing missed" is only sayable once everything has been counted.
 */
function DiscrepancyCell({ shipment }: { shipment: ShipmentSummary }) {
  const { totalOver, totalUnder, uncountedItemCount } = shipment.discrepancy;
  const parts: string[] = [];
  if (totalOver > 0) parts.push(`${totalOver} over`);
  if (totalUnder > 0) parts.push(`${totalUnder} under`);

  return (
    <div data-testid="discrepancy-cell" className="text-sm">
      {parts.length > 0 ? (
        <span className="font-medium text-amber-700 dark:text-amber-400">
          {parts.join(" · ")}
        </span>
      ) : uncountedItemCount === 0 && shipment.itemCount > 0 ? (
        <span className="text-muted-foreground">No discrepancies</span>
      ) : shipment.itemCount === 0 ? (
        <span className="text-muted-foreground">No lines yet</span>
      ) : null}
      {uncountedItemCount > 0 && (
        <span className="block text-xs text-muted-foreground">
          {`${uncountedItemCount} uncounted`}
        </span>
      )}
    </div>
  );
}

export function ShipmentList() {
  const [status, setStatus] = useState<ShipmentStatusFilter>("ALL");
  const [createOpen, setCreateOpen] = useState(false);

  const { data: shipments = [], isPending, isError, error } = useInboundShipments(status);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((tab) => (
            <Button
              key={tab.value}
              size="sm"
              variant={status === tab.value ? "default" : "outline"}
              onClick={() => setStatus(tab.value)}
            >
              {tab.label}
            </Button>
          ))}
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New shipment
        </Button>
      </div>

      {isPending && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading shipments…
        </div>
      )}

      {isError && (
        <div
          data-testid="shipment-list-error"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">The shipment list could not be loaded.</p>
            <p className="text-muted-foreground">
              {error?.message ?? "Reload the page to try again."}
            </p>
          </div>
        </div>
      )}

      {!isPending && !isError && shipments.length === 0 && (
        <div
          data-testid="shipment-list-empty"
          className="rounded-lg border border-border bg-surface p-8 text-center space-y-3"
        >
          <p className="text-sm text-muted-foreground">
            {status === "ALL"
              ? "No shipments yet. Open one when a delivery arrives — then link each box you log to it."
              : `No ${status.toLowerCase()} shipments.`}
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New shipment
          </Button>
        </div>
      )}

      {!isError && shipments.length > 0 && (
        <ul className="space-y-2">
          {shipments.map((shipment) => {
            const age = daysOpen(shipment.createdAt);
            const stale = shipment.status === "OPEN" && age >= STALE_OPEN_DAYS;
            return (
              <li
                key={shipment.id}
                data-testid={`shipment-row-${shipment.id}`}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <Link
                      href={`/receiving/${shipment.id}`}
                      className="block truncate font-medium hover:underline"
                    >
                      {shipment.supplierRef ?? shipment.id}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant={statusVariant(shipment.status)}>
                        {shipment.status}
                      </Badge>
                      <span>{`${shipment.itemCount} line(s)`}</span>
                      {shipment.graduatedItemCount > 0 && (
                        <span>{`${shipment.graduatedItemCount} stocked`}</span>
                      )}
                      {shipment.creator && <span>by {shipment.creator.username}</span>}
                      {shipment.status === "OPEN" && (
                        <span
                          data-testid="aging-cue"
                          data-stale={stale ? "true" : "false"}
                          className={cn(
                            stale && "font-medium text-amber-700 dark:text-amber-400",
                          )}
                        >
                          {age === 1 ? "Open 1 day" : `Open ${age} days`}
                        </span>
                      )}
                    </div>
                  </div>
                  <DiscrepancyCell shipment={shipment} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <CreateShipmentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
