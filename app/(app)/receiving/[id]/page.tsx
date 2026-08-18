"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { ReceivingDetailScreen } from "@/components/receiving/receiving-detail-screen";

interface ReceivingDetailPageProps {
  params: { id: string };
}

/**
 * /receiving/[id] — one order: what was ordered, what arrived, what was labeled,
 * and what is still being followed up. A legacy W1 receipt renders here too, as
 * read-only history.
 *
 * A route rather than an in-page panel so an order is LINKABLE: the orders list,
 * the labeling queue and a message to whoever counted can all point at the same
 * URL. The page itself is deliberately thin — the read, the `model` fork and
 * every control live in `ReceivingDetailScreen` (contract pack C4b.1).
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
          All orders
        </Link>

        <ReceivingDetailScreen id={params.id} />
      </div>
    </div>
  );
}
