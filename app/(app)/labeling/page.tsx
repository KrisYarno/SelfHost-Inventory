import { Tag } from "lucide-react";
import { LabelingQueue } from "@/components/labeling/labeling-queue";

export const dynamic = "force-dynamic";

interface LabelingPageProps {
  searchParams?: { orderId?: string | string[] };
}

/**
 * /labeling — THE LABELING QUEUE (contract pack C5.2, spec §4.3).
 *
 * Deliberately thin, and a SERVER page: the `(app)` layout is the auth gate for
 * everything under it, so this route adds none of its own, and the only work
 * left here is reading one query parameter.
 *
 * `?orderId=` is the "Label now" link from an order detail. A URL can carry the
 * same key twice (`?orderId=a&orderId=b`), which Next hands over as an ARRAY —
 * normalized to one string here so the client, the cache key and the request
 * can never disagree about which order is being shown. An empty value is no
 * filter at all rather than a filter on "".
 */
export default function LabelingPage({ searchParams }: LabelingPageProps) {
  const raw = searchParams?.orderId;
  const orderId = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-3xl font-bold">
            <Tag className="h-7 w-7" />
            Labeling
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything verified and not yet stocked. Label a batch, say where it went,
            and the count moves — partial progress is kept between sessions.
          </p>
        </div>

        <LabelingQueue orderId={orderId ? orderId : undefined} />
      </div>
    </div>
  );
}
