"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ShipmentDetail } from "@/components/receiving/shipment-detail";

interface ReceivingDetailPageProps {
  params: { id: string };
}

/**
 * /receiving/[id] — one receipt: its lines, their counts, their costs, and the
 * lifecycle actions the T4 state matrix allows from here.
 *
 * A route rather than an in-page panel so a receipt is LINKABLE: the list, the
 * exceptions register (W3) and a message to whoever counted can all point at
 * the same URL.
 */
export default function ReceivingDetailPage({ params }: ReceivingDetailPageProps) {
  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <Link
          href="/receiving"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          All shipments
        </Link>

        <ShipmentDetail shipmentId={params.id} />
      </div>
    </div>
  );
}
