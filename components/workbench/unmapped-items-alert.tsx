"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { ProductMapDialog } from "@/components/products/product-map-dialog";
import {
  AlertTriangle,
  ChevronDown,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
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

  if (items.length === 0) return null;

  // Split items by kind: bundles are surfaced separately because they ARE
  // mapped (just not addable to the workbench cart, which is 1:1 with a
  // single internal product). The label and Map button differ.
  const bundleItems = items.filter((i) => i.isBundle);
  const unmappedItems = items.filter((i) => !i.isBundle);

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
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className={cn(
            "flex w-full items-center justify-between gap-2 px-3 py-2.5",
            "text-left text-sm transition-colors hover:bg-amber-500/5"
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="font-medium text-amber-700 dark:text-amber-400">
              {unmappedItems.length > 0 && (
                <>
                  {unmappedItems.length} unmapped{" "}
                  {unmappedItems.length === 1 ? "item" : "items"}
                </>
              )}
              {unmappedItems.length > 0 && bundleItems.length > 0 && " + "}
              {bundleItems.length > 0 && (
                <>
                  {bundleItems.length} bundle{" "}
                  {bundleItems.length === 1 ? "item" : "items"}
                </>
              )}
              {" "}will be skipped
            </span>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-amber-500 transition-transform duration-200",
              isExpanded && "rotate-180"
            )}
          />
        </button>

        {/* Item list */}
        <div
          className={cn(
            "overflow-hidden transition-all duration-300 ease-in-out",
            isExpanded ? "max-h-[600px]" : "max-h-0"
          )}
        >
          <div className="px-3 pb-2.5 space-y-1.5">
            {items.map((item, index) => (
              <div
                key={`${item.name}-${item.sku ?? ""}-${index}`}
                className={cn(
                  "flex items-center justify-between gap-2 rounded-md",
                  "bg-amber-500/5 px-2.5 py-1.5"
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate text-foreground">
                    {item.name}
                    {item.isBundle && (
                      <span className="ml-2 text-[10px] font-medium uppercase tracking-wider rounded-sm px-1 py-0.5 bg-purple-500/15 text-purple-700 dark:text-purple-300 border border-purple-500/40">
                        Bundle
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {item.sku && <span>SKU: {item.sku}</span>}
                    <span>Qty: {item.quantity}</span>
                    {item.isBundle && (
                      <span className="italic">
                        Fulfill via Order Details
                      </span>
                    )}
                  </div>
                </div>

                {/* Admin-only Map button — hidden for bundle items (already
                    mapped; can be edited from the bulk-map page if needed). */}
                {!item.isBundle && isAdmin && integrationId && (
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
