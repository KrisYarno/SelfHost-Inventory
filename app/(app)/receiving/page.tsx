"use client";

import { Inbox } from "lucide-react";
import { ShipmentList } from "@/components/receiving/shipment-list";

/**
 * /receiving — the SHIPMENT-grain surface (plan REV-2, W1-4b).
 *
 * Pre-Staging stays the ITEM-grain queue: it is where a box gets logged. This
 * page is where boxes become a RECEIPT — expected against counted, a
 * discrepancy that survives the shift, and a freight bill that lands on the
 * lines instead of evaporating. Neither page replaces the other, and both are
 * in Stock Ops for everyone (receiving is dock work, not admin work).
 */
export default function ReceivingPage() {
  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Inbox className="h-7 w-7" />
            Receiving
          </h1>
          <p className="text-sm text-muted-foreground">
            Open a shipment when a delivery arrives, link the boxes you log to
            it, count them, and price them. What you counted stays on the record.
          </p>
        </div>

        <ShipmentList />
      </div>
    </div>
  );
}
