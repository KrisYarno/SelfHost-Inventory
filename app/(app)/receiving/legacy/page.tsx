import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { LegacyLinesList } from "@/components/labeling/legacy-lines-list";

export const dynamic = "force-dynamic";

/**
 * /receiving/legacy — THE PRE-STAGING ARCHIVE (contract pack C5.2, spec D8).
 *
 * Read-only history of the retired pre-staging flow, on its own route rather
 * than a tab on Receiving: it is not part of anybody's day, and the drain
 * precedes the deploy. Thin, like the other pages in this lane — the `(app)`
 * layout is the auth gate and the list owns its own read.
 */
export default function ReceivingLegacyPage() {
  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <Link
          href="/receiving"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Receiving
        </Link>

        <div className="space-y-1">
          <h1 className="text-3xl font-bold">Pre-staging history</h1>
          <p className="text-sm text-muted-foreground">
            The boxes logged by the retired pre-staging flow, kept so a receipt stays
            findable. Read-only — nothing here can be changed.
          </p>
        </div>

        <LegacyLinesList />
      </div>
    </div>
  );
}
