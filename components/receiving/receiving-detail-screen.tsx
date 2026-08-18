"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { ShipmentDetail } from "@/components/receiving/shipment-detail";
import { SupplyOrderDetail } from "@/components/receiving/supply-order-detail";
import { useSupplyOrder } from "@/hooks/use-supply-orders";

/**
 * /receiving/[id] — ONE READ, TWO SHAPES (contract pack C4b.1).
 *
 * The dataset is one (spec §2): a header with an `orderedAt` is a SUPPLY ORDER
 * in the new flow, and a header without one is a W1 pre-staging RECEIPT. The
 * server discriminates once, in `lib/supply-orders/queries.ts`, and hands back a
 * union tagged with `model`; this screen is where that tag turns into a screen.
 *
 * The fork lives HERE, above both renderers, for two reasons:
 *
 *   - ONE FETCH. `useSupplyOrder(id)` is called once and the legacy branch is
 *     handed its already-loaded detail as a prop. A legacy renderer that fetched
 *     for itself would read the same row twice and could disagree with the half
 *     of the screen that already rendered.
 *   - ONE PLACE THAT KNOWS THE READ CAN FAIL. Loading and the load error belong
 *     to whoever performed the read. Neither renderer has an honest thing to say
 *     about a request it did not make — the legacy detail's own empty state
 *     ("no boxes were linked") after a failed read would be a lie about history.
 */

export interface ReceivingDetailScreenProps {
  id: string;
}

export function ReceivingDetailScreen({ id }: ReceivingDetailScreenProps) {
  const { data: detail, isPending, isError, error } = useSupplyOrder(id);

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading the order…
      </div>
    );
  }

  if (isError || !detail) {
    return (
      <div
        data-testid="shipment-detail-error"
        className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium">This order could not be loaded.</p>
          <p className="text-muted-foreground">
            {error?.message ?? "It may have been removed."}
          </p>
        </div>
      </div>
    );
  }

  if (detail.model === "legacy") {
    return <ShipmentDetail shipment={detail.legacy} />;
  }

  return <SupplyOrderDetail detail={detail} />;
}
