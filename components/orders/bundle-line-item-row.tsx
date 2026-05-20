"use client";

import { useState } from "react";
import { ChevronRight, ChevronDown, Boxes, AlertCircle, CheckCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ComponentSnapshot {
  internalProductId: number;
  internalProductName: string;
  quantity: number;
  sortOrder: number;
}

interface ShortageMap {
  [internalProductId: number]: { available: number; required: number };
}

interface Props {
  itemName: string;
  externalSku: string | null;
  quantity: number;
  price: number | string;
  snapshot: ComponentSnapshot[];
  shortages?: ShortageMap;
}

export function BundleLineItemRow({
  itemName,
  externalSku,
  quantity,
  price,
  snapshot,
  shortages = {},
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasShortage = Object.keys(shortages).length > 0;

  return (
    <div className="border border-border/60 rounded-md">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 p-3 text-left hover:bg-muted/30"
      >
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span className="font-medium">{itemName} × {quantity}</span>
        <Badge
          variant="outline"
          className="text-[10px] border-purple-500/60 text-purple-700 dark:text-purple-300"
        >
          <Boxes className="h-2.5 w-2.5 mr-0.5" /> BUNDLE
        </Badge>
        {hasShortage && (
          <Badge variant="outline" className="text-[10px] border-destructive/60 text-destructive">
            <AlertCircle className="h-2.5 w-2.5 mr-0.5" /> Stock short
          </Badge>
        )}
        {externalSku && <span className="text-xs text-muted-foreground ml-2">SKU: {externalSku}</span>}
        <span className="ml-auto text-sm tabular-nums">${Number(price).toFixed(2)}</span>
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-3 py-2 bg-muted/20 space-y-1">
          {snapshot.map((c) => {
            const shortage = shortages[c.internalProductId];
            const required = c.quantity * quantity;
            return (
              <div
                key={c.internalProductId}
                className={cn(
                  "flex items-center gap-2 text-xs py-1",
                  shortage && "text-destructive",
                )}
              >
                <span className="font-mono">{required}×</span>
                <span className="flex-1">{c.internalProductName}</span>
                {shortage ? (
                  <span>
                    Stock: {shortage.available}/{shortage.required} ❌
                  </span>
                ) : (
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    <CheckCircle className="h-3 w-3 text-green-600" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
