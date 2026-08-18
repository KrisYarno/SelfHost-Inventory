"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import {
  DEFAULT_ORDERS_FILTER,
  ShipmentList,
  supplyOrdersRequests,
  type OrdersFilter,
} from "@/components/receiving/shipment-list";
import { SupplyOrderDialog } from "@/components/receiving/supply-order-dialog";
import { SUPPLY_ORDER_LIST_LIMIT, useSupplyOrders } from "@/hooks/use-supply-orders";

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
 *
 * TWO READS, ONE LIST (QA-3). `?model=` is single-valued, so the two families
 * are two requests and this page merges them. New-flow rows first: the server
 * orders by `orderedAt DESC` and a legacy header has no `orderedAt`, so it sorts
 * last there too — the merge is the same order the database would have given.
 *
 * EITHER failure is THE failure. A partial list under a chip whose half did not
 * land would say "no legacy receipts" about a request that never came back,
 * which is the W25-3 lie in a smaller box.
 */
export default function ReceivingPage() {
  const [filter, setFilter] = useState<OrdersFilter>(DEFAULT_ORDERS_FILTER);
  const [createOpen, setCreateOpen] = useState(false);

  const requests = supplyOrdersRequests(filter);
  // Both hooks are always mounted (hook order is not negotiable) and each is
  // ENABLED only when its family was asked for — a disabled query issues no
  // request, so an unticked family costs nothing.
  const newFlowOrders = useSupplyOrders(
    requests.newFlow ?? { statuses: [] },
    requests.newFlow !== null,
  );
  const legacyOrders = useSupplyOrders(
    requests.legacy ?? { statuses: [] },
    requests.legacy !== null,
  );

  const live = [
    requests.newFlow ? newFlowOrders : null,
    requests.legacy ? legacyOrders : null,
  ].filter((query) => query !== null);

  const isPending = live.some((query) => query.isPending);
  const isError = live.some((query) => query.isError);
  const error = live.find((query) => query.isError)?.error;
  // A disabled query keeps whatever its key last cached; reading it here would
  // render rows for a family the operator has since switched off.
  const orders = [
    ...(requests.newFlow ? (newFlowOrders.data ?? []) : []),
    ...(requests.legacy ? (legacyOrders.data ?? []) : []),
  ];
  // A FULL page is a CUT page: the list response carries no count, so an exactly
  // bounded answer is the only signal that more exist.
  const truncated = live.some((query) => (query.data?.length ?? 0) >= SUPPLY_ORDER_LIST_LIMIT);

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
            truncated={truncated}
            onFilterChange={setFilter}
            onNew={() => setCreateOpen(true)}
          />
        )}

        <SupplyOrderDialog open={createOpen} onOpenChange={setCreateOpen} />
      </div>
    </div>
  );
}
