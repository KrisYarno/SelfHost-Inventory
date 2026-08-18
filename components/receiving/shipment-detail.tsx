"use client";

import { Badge } from "@/components/ui/badge";
import type { ShipmentDetail as LegacyShipmentDetail } from "@/lib/shipments/queries";

/**
 * THE LEGACY RECEIPT — READ-ONLY HISTORY (contract pack C4b.2, spec §9).
 *
 * This used to be the receiving detail: counts, per-line pricing, the freight
 * calculator, graduation, the box picker, close and cancel. The supply-order
 * flow replaced every one of those acts, and a W1 header (`orderedAt IS NULL`)
 * is now what it always was underneath — a RECEIPT THAT ALREADY HAPPENED.
 *
 * So this file renders and does not write. It takes the detail as a PROP (the
 * screen has already read it — one fetch per page, not two), holds no mutation,
 * no draft state and no CSRF token, and imports nothing from the pre-staging
 * surface that retires with it.
 *
 * The truthful-data rules it still carries, because history has to keep meaning
 * what it meant when it was recorded:
 *   - an UNCOUNTED line is UNKNOWN, never "0 off";
 *   - an UNEXPECTED arrival (NULL expected) says so and counts in full;
 *   - an unpriced line is "Not priced", never $0.00 — and a genuine zero IS
 *     $0.00, because a free sample is a fact;
 *   - over and under are reported separately and never cancel out.
 */

/** INT cents -> money. NULL is "not priced", never $0.00 (truthful-data). */
function formatCents(cents: number | null): string {
  if (cents === null) return "Not priced";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The per-line verdict, in words. "Not counted" is deliberately NOT "0 off":
 * an uncounted line is UNKNOWN, and an unexpected arrival says so out loud
 * because nobody predicted the box that was nonetheless on the dock.
 */
function LineFlag({ item }: { item: LegacyShipmentDetail["items"][number] }) {
  const { counted, expectedMissing, delta, direction } = item.flags;

  if (!counted || delta === null) {
    return (
      <span
        data-testid="line-flag"
        className="text-xs font-medium text-muted-foreground"
      >
        Not counted yet
      </span>
    );
  }

  const unexpected = expectedMissing ? "Unexpected arrival — " : "";
  if (direction === "MATCH") {
    return (
      <span data-testid="line-flag" className="text-xs font-medium text-positive">
        {`${unexpected}matches`}
      </span>
    );
  }

  return (
    <span
      data-testid="line-flag"
      className="text-xs font-medium text-amber-700 dark:text-amber-400"
    >
      {`${unexpected}${Math.abs(delta)} ${direction === "OVER" ? "over" : "under"}`}
    </span>
  );
}

interface ShipmentDetailProps {
  shipment: LegacyShipmentDetail;
}

export function ShipmentDetail({ shipment }: ShipmentDetailProps) {
  const { discrepancy } = shipment;
  const isOpen = shipment.status === "OPEN";
  const isCancelled = shipment.status === "CANCELLED";

  return (
    <div className="space-y-6">
      <p
        data-testid="legacy-banner"
        className="rounded-lg border border-border bg-surface p-3 text-sm text-muted-foreground"
      >
        Legacy receipt (read-only history)
      </p>

      {/* Header + rollup */}
      <div
        data-testid="shipment-header"
        className="rounded-lg border border-border bg-surface p-4 space-y-3"
      >
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-lg font-semibold">
            {shipment.supplierRef ?? shipment.id}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={isOpen ? "default" : isCancelled ? "outline" : "secondary"}>
              {shipment.status}
            </Badge>
            {shipment.creator && <span>opened by {shipment.creator.username}</span>}
            <span>{new Date(shipment.createdAt as unknown as string).toLocaleDateString()}</span>
            {shipment.closedAt && (
              <span>
                {`closed ${new Date(
                  shipment.closedAt as unknown as string,
                ).toLocaleDateString()}`}
                {shipment.closedBy !== null ? ` by user ${shipment.closedBy}` : ""}
              </span>
            )}
          </div>
          {shipment.notes && (
            <p className="text-sm text-muted-foreground">{shipment.notes}</p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Lines</dt>
            <dd className="font-medium tabular-nums">{shipment.itemCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Counted</dt>
            <dd className="font-medium tabular-nums">{discrepancy.countedItemCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Over</dt>
            <dd className="font-medium tabular-nums">{discrepancy.totalOver}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Under</dt>
            <dd className="font-medium tabular-nums">{discrepancy.totalUnder}</dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          Over and under are reported separately and never cancel out.
        </p>
      </div>

      {/* Lines. Cards, not a table: this is read on a phone at the dock. */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Lines</h3>
        {shipment.items.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted-foreground">
            No boxes were linked to this receipt.
          </p>
        ) : (
          <ul className="space-y-3">
            {shipment.items.map((item) => (
              <li
                key={item.id}
                data-testid={`receiving-line-${item.id}`}
                className="rounded-lg border border-border bg-surface p-3 space-y-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{item.description}</p>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{item.status}</Badge>
                    <span>
                      {`Expected ${item.expectedQuantity ?? "—"} · Counted ${item.countedQuantity ?? "—"}`}
                    </span>
                    {item.location && <span>{item.location.name}</span>}
                    <span data-testid="line-cost">{formatCents(item.unitCostCents)}</span>
                  </div>
                  <LineFlag item={item} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
