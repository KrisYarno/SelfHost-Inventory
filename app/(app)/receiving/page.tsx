"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import {
  DEFAULT_ORDERS_FILTER,
  ShipmentList,
  supplyOrdersQuery,
  type OrdersFilter,
} from "@/components/receiving/shipment-list";
import { SupplyOrderDialog } from "@/components/receiving/supply-order-dialog";
import { useSupplyOrders } from "@/hooks/use-supply-orders";

/**
 * /receiving — THE ORDERS SURFACE (spec §9, contract pack C4a.4).
 *
 * A supply order is entered when it is PLACED, and this is the queue it lands
 * in: what was ordered, what has been verified against it, and what did not add
 * up. Verification happens in the order detail; labeling happens in /labeling.
 *
 * The page owns the server state deliberately. A LIST that fetched for itself
 * would have to decide what to render when the read fails, and the honest answer
 * ("the list could not be loaded") is not the list's to give — its empty state
 * says "no supply orders yet", and showing that after a failed request tells the
 * operator to enter an order that may already exist (W25-3).
 */
export default function ReceivingPage() {
  const [filter, setFilter] = useState<OrdersFilter>(DEFAULT_ORDERS_FILTER);
  const [createOpen, setCreateOpen] = useState(false);

  const { statuses, model } = supplyOrdersQuery(filter);
  const {
    data: orders = [],
    isPending,
    isError,
    error,
  } = useSupplyOrders({ statuses, model });

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Inbox className="h-7 w-7" />
            Receiving
          </h1>
          <p className="text-sm text-muted-foreground">
            Enter a supply order when you place it, verify each line as the delivery
            lands, and the labeling queue picks up what still has to be labeled.
          </p>
          {/* The retired flow's boxes still have to be findable (D8). */}
          <Link
            href="/receiving/legacy"
            className="inline-block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Pre-staging history (read-only)
          </Link>
        </div>

        {isPending && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            Loading orders…
          </div>
        )}

        {isError && (
          <div
            data-testid="shipment-list-error"
            className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">The orders list could not be loaded.</p>
              <p className="text-muted-foreground">
                {error?.message ?? "Reload the page to try again."}
              </p>
            </div>
          </div>
        )}

        {!isPending && !isError && (
          <ShipmentList
            orders={orders}
            filter={filter}
            onFilterChange={setFilter}
            onNew={() => setCreateOpen(true)}
          />
        )}

        <SupplyOrderDialog open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    </div>
  );
}
