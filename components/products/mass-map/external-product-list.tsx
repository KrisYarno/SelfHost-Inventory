"use client";

import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CatalogRow } from "@/types/bulk-map";
import { rowKey } from "@/types/bulk-map";
import { RowStatusBadge, type RowStatus } from "./row-status-badge";
import { Badge } from "@/components/ui/badge";

interface Props {
  rows: CatalogRow[];
  activeRowKey: string | null;
  savingKey: string | null;
  errorKey: string | null;
  onRowSelect: (row: CatalogRow) => void;
}

interface VirtualItem {
  kind: "header" | "row";
  parentTitle: string;
  row?: CatalogRow;
  key: string;
}

export function ExternalProductList({
  rows,
  activeRowKey,
  savingKey,
  errorKey,
  onRowSelect,
}: Props) {
  const items: VirtualItem[] = useMemo(() => {
    const grouped = new Map<string, CatalogRow[]>();
    for (const r of rows) {
      const arr = grouped.get(r.parentTitle) ?? [];
      arr.push(r);
      grouped.set(r.parentTitle, arr);
    }
    const flat: VirtualItem[] = [];
    for (const [parentTitle, parentRows] of Array.from(grouped.entries())) {
      flat.push({ kind: "header", parentTitle, key: `h::${parentTitle}` });
      for (const r of parentRows) {
        flat.push({
          kind: "row",
          parentTitle,
          row: r,
          key: `r::${rowKey(r)}`,
        });
      }
    }
    return flat;
  }, [rows]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (items[i].kind === "header" ? 32 : 56),
    overscan: 8,
  });

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const item = items[vi.index];
          return (
            <div
              key={item.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {item.kind === "header" ? (
                <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-background/60">
                  {item.parentTitle}
                </div>
              ) : item.row ? (
                <RowButton
                  row={item.row}
                  active={rowKey(item.row) === activeRowKey}
                  saving={rowKey(item.row) === savingKey}
                  hasError={rowKey(item.row) === errorKey}
                  onSelect={() => item.row && onRowSelect(item.row)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RowButton({
  row,
  active,
  saving,
  hasError,
  onSelect,
}: {
  row: CatalogRow;
  active: boolean;
  saving: boolean;
  hasError: boolean;
  onSelect: () => void;
}) {
  const status: RowStatus = saving
    ? "saving"
    : hasError
    ? "error"
    : row.alreadyMapped
    ? "mapped"
    : "unmapped";
  return (
    <button
      onClick={onSelect}
      className={cn(
        "w-full text-left flex items-center gap-3 px-3 py-2 border-b border-border/40 hover:bg-muted/40 transition-colors",
        active && "bg-primary/5 ring-1 ring-inset ring-primary/40",
      )}
    >
      <RowStatusBadge status={status} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate flex items-center gap-1.5">
          <span className="truncate">{row.variantTitle ?? row.parentTitle}</span>
          {(row.isBundleCandidate || row.existingMapping?.isBundle) && (
            <Badge
              variant="outline"
              className="text-[9px] px-1 py-0 border-purple-500/60 text-purple-700 dark:text-purple-300 shrink-0"
            >
              BUNDLE
            </Badge>
          )}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          {row.sku ? `SKU: ${row.sku}` : `ID: ${row.externalVariantId ?? row.externalProductId}`}
          {row.alreadyMapped && row.existingMapping && (
            <span className="ml-2">
              {row.existingMapping.isBundle
                ? `→ Bundle (${row.existingMapping.componentCount ?? 0} components)`
                : `→ ${row.existingMapping.internalProductName}`}
            </span>
          )}
        </p>
      </div>
      {row.alreadyMapped && !saving && (
        <Check className="h-4 w-4 text-green-600 shrink-0" />
      )}
    </button>
  );
}
