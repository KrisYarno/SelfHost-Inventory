"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { ProductMapDialog } from "@/components/products/product-map-dialog";
import {
  AlertTriangle,
  ChevronDown,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SKIPPED_LINE_CLASSES,
  SKIPPED_LINE_COPY,
  SKIPPED_LINE_LABEL,
  SKIPPED_LINE_NOUN,
  classifySkippedLine,
  type SkippedLineClass,
} from "@/lib/workbench/skipped-lines";

// ---------------------------------------------------------------------------
// W1-4b: the PAGE-level twin of the complete-order dialog's checklist (T6).
//
// This banner used to call EVERY non-bundle line "unmapped" and print a
// bundle-only footnote — so the same `unmappedExternalItems` array told one
// story here and a different one inside the dialog W0.5-a rebuilt. It now reads
// the shared classifier and the shared copy (lib/workbench/skipped-lines.ts),
// which is what makes the two surfaces impossible to drift apart again.
//
// It stays a NOTICE, not a gate: acknowledgement is the dialog's job (that is
// where the irreversible deduction happens). Here the operator gets the truth
// per class and, where it is actually actionable, the inline Map affordance.
// ---------------------------------------------------------------------------

interface UnmappedItemsAlertProps {
  items: Array<{
    name: string;
    sku?: string;
    quantity: number;
    externalProductId?: string;
    externalVariantId?: string;
    isBundle?: boolean;
  }>;
  integrationId?: string;
  onItemMapped?: () => void;
}

type AlertItem = UnmappedItemsAlertProps["items"][number];

// Shape of the item passed to the map dialog. Carries external IDs so the
// dialog can open with a real mapping target (P2: was passing empty string).
interface MapDialogItem {
  name: string;
  sku?: string;
  externalProductId?: string;
  externalVariantId?: string;
}

// Threshold for auto-collapsing the item list
const AUTO_COLLAPSE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function UnmappedItemsAlert({
  items,
  integrationId,
  onItemMapped,
}: UnmappedItemsAlertProps) {
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin ?? false;

  const [isExpanded, setIsExpanded] = useState(
    items.length <= AUTO_COLLAPSE_THRESHOLD
  );
  const [mapDialogOpen, setMapDialogOpen] = useState(false);
  const [mapDialogItem, setMapDialogItem] = useState<MapDialogItem | null>(null);

  // One classification, reused by the header count and the grouped list, so the
  // summary can never disagree with the lines underneath it.
  const grouped = useMemo(() => {
    const buckets = new Map<SkippedLineClass, AlertItem[]>();
    for (const item of items) {
      const lineClass = classifySkippedLine(item);
      const bucket = buckets.get(lineClass);
      if (bucket) bucket.push(item);
      else buckets.set(lineClass, [item]);
    }
    return SKIPPED_LINE_CLASSES.map((lineClass) => ({
      lineClass,
      lines: buckets.get(lineClass) ?? [],
    })).filter((group) => group.lines.length > 0);
  }, [items]);

  if (items.length === 0) return null;

  const handleMapClick = (item: MapDialogItem) => {
    // P2: only allow mapping when we actually have an external reference,
    // otherwise the POST would create a broken ProductLink with empty ids.
    if (!item.externalProductId) {
      return;
    }
    setMapDialogItem(item);
    setMapDialogOpen(true);
  };

  const handleMapped = () => {
    setMapDialogOpen(false);
    setMapDialogItem(null);
    onItemMapped?.();
  };

  return (
    <>
      <div
        className={cn(
          "rounded-lg border-l-4 border-l-amber-500",
          "border border-amber-500/30 bg-amber-500/10"
        )}
      >
        {/* Header — one clause per class that is actually present. A bundle is
            never counted as "unmapped": it IS mapped, it just ships from the
            Order Details sheet. */}
        <button
          data-testid="skipped-lines-header"
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            "flex w-full items-center justify-between gap-2 px-3 py-2.5",
            "text-left text-sm transition-colors hover:bg-amber-500/5"
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="font-medium text-amber-700 dark:text-amber-400">
              {grouped
                .map(({ lineClass, lines }) => {
                  const [singular, plural] = SKIPPED_LINE_NOUN[lineClass];
                  return `${lines.length} ${lines.length === 1 ? singular : plural}`;
                })
                .join(" + ")}
              {" will not be deducted"}
            </span>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-amber-500 transition-transform duration-200",
              isExpanded && "rotate-180"
            )}
          />
        </button>

        {/* Item list, grouped by class — the same grouping and the same per-line
            copy the complete-order dialog prints. */}
        <div
          className={cn(
            "overflow-hidden transition-all duration-300 ease-in-out",
            isExpanded ? "max-h-[600px]" : "max-h-0"
          )}
        >
          <div className="px-3 pb-2.5 space-y-2.5">
            {grouped.map(({ lineClass, lines }) => (
              <div
                key={lineClass}
                data-testid={`skipped-group-${lineClass}`}
                className="space-y-1.5"
              >
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {`${SKIPPED_LINE_LABEL[lineClass]} (${lines.length})`}
                </p>
                <ul className="space-y-1.5">
                  {lines.map((item, index) => (
                    <li
                      key={`${item.name}-${item.sku ?? ""}-${index}`}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-md",
                        "bg-amber-500/5 px-2.5 py-1.5"
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate text-foreground">
                          {item.name}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          {item.sku && <span>SKU: {item.sku}</span>}
                          <span>Qty: {item.quantity}</span>
                          <span className="italic">
                            {SKIPPED_LINE_COPY[lineClass]}
                          </span>
                        </div>
                      </div>

                      {/* Admin-only Map button. UNCHANGED semantics — it opens
                          the same dialog for the same lines it always worked
                          for. It is simply no longer rendered on lines where
                          handleMapClick already refused to act (no external
                          reference), because offering an inert button next to
                          copy that says the line IS mapped is the divergence
                          this pass exists to close. */}
                      {lineClass === "unmapped" &&
                        item.externalProductId &&
                        isAdmin &&
                        integrationId && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0 h-7 text-xs border-amber-500/40 hover:border-amber-500/60"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMapClick(item);
                            }}
                          >
                            <Link2 className="h-3 w-3 mr-1" />
                            Map
                          </Button>
                        )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ProductMapDialog for inline mapping (admin only). Guarded on
          externalProductId so we never open the dialog with empty IDs. */}
      {isAdmin && integrationId && mapDialogItem?.externalProductId && (
        <ProductMapDialog
          open={mapDialogOpen}
          onOpenChange={setMapDialogOpen}
          integrationId={integrationId}
          externalProduct={{
            externalId: mapDialogItem.externalProductId,
            externalVariantId: mapDialogItem.externalVariantId,
            title: mapDialogItem.name,
            sku: mapDialogItem.sku,
          }}
          onMapped={handleMapped}
        />
      )}
    </>
  );
}
