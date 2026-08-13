"use client";

import { Loader2, ArrowUpRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type StagingStatus = "RECEIVED" | "GRADUATED" | "DISCARDED";

export interface StagingItem {
  id: number;
  description: string;
  status: StagingStatus;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  /** The receipt line's unit cost in INT cents (W1-3b / pack REV-3 T3). */
  unitCostCents?: number | null;
  vendor: string | null;
  reference: string | null;
  locationId: number;
  receivedAt: string;
  location?: { id: number; name: string } | null;
  resolvedProduct?: { id: number; name: string } | null;
  receivedByUser?: { id: number; username: string } | null;
}

interface StagingQueueProps {
  items: StagingItem[];
  loading: boolean;
  onGraduate: (item: StagingItem) => void;
  onDiscard: (item: StagingItem) => void;
  pendingId?: number | null;
}

function statusBadgeVariant(
  status: StagingStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "RECEIVED":
      return "default";
    case "GRADUATED":
      return "secondary";
    case "DISCARDED":
      return "outline";
    default:
      return "outline";
  }
}

export function StagingQueue({
  items,
  loading,
  onGraduate,
  onDiscard,
  pendingId,
}: StagingQueueProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading items…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No items in this list.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Expected</TableHead>
            <TableHead className="text-right">Counted</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>Reference</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Received by</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const isPending = pendingId === item.id;
            return (
              <TableRow key={item.id}>
                <TableCell className="font-medium">
                  {item.description}
                  {item.resolvedProduct && (
                    <span className="block text-xs text-muted-foreground">
                      → {item.resolvedProduct.name}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.expectedQuantity ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.countedQuantity ?? "—"}
                </TableCell>
                <TableCell>{item.vendor || "—"}</TableCell>
                <TableCell>{item.reference || "—"}</TableCell>
                <TableCell>{item.location?.name ?? `#${item.locationId}`}</TableCell>
                <TableCell>{item.receivedByUser?.username ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(item.status)}>
                    {item.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {item.status === "RECEIVED" ? (
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={() => onGraduate(item)}
                        disabled={isPending}
                      >
                        <ArrowUpRight className="mr-1 h-4 w-4" />
                        Graduate
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onDiscard(item)}
                        disabled={isPending}
                      >
                        {isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
