"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { Link2, Loader2, ArrowUpRight, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { useCSRF } from "@/hooks/use-csrf";
import { useUpdateStagingLine } from "@/hooks/use-inbound-shipments";
import {
  ShipmentPicker,
  shipmentLabel,
  shortShipmentId,
  useShipmentChoice,
} from "@/components/staging/shipment-picker";

export type StagingStatus = "RECEIVED" | "GRADUATED" | "DISCARDED";

export interface StagingItem {
  id: number;
  description: string;
  status: StagingStatus;
  expectedQuantity: number | null;
  countedQuantity: number | null;
  /** The receipt line's unit cost in INT cents (W1-3b / pack REV-3 T3). */
  unitCostCents?: number | null;
  /**
   * The receiving header this box belongs to, or `null` while it is unattributed
   * (W1-4b). W2.5: the queue RENDERS it — for two waves it sat in this type and
   * on the wire while the table drew nothing with it, which is exactly how the
   * operator surface for receiving ended up blind to receiving.
   */
  shipmentId?: string | null;
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

/** Kept next to the header row: the assign editor spans the whole table. */
const COLUMN_COUNT = 10;

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
  const { token: csrfToken } = useCSRF();
  // The OPEN headers serve two purposes here: the assign control's options, and
  // the names on the badges. A header this list does not carry (a closed one)
  // still gets a short id rather than nothing — "which receipt" always has an
  // answer once there is a shipmentId.
  const choice = useShipmentChoice();
  const updateLine = useUpdateStagingLine();
  const [editingId, setEditingId] = useState<number | null>(null);

  const labels = useMemo(() => {
    const map = new Map<string, string>();
    for (const shipment of choice.shipments) {
      map.set(shipment.id, shipmentLabel(shipment));
    }
    return map;
  }, [choice.shipments]);

  const openEditor = (item: StagingItem) => {
    choice.reset(item.shipmentId ?? undefined);
    setEditingId(item.id);
  };

  /**
   * Join / leave a receipt through the SAME `PATCH /api/staging-items/[id]` the
   * receiving detail uses. Its guards are the server's — a header that closed
   * underneath this editor, a line that graduated mid-edit — and their sentences
   * are rendered word for word rather than second-guessed here.
   */
  const handleAssign = async (item: StagingItem) => {
    let target: string | null;
    try {
      target = await choice.resolve();
    } catch (error) {
      console.error("Error opening inbound shipment:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to open the shipment"
      );
      return;
    }

    if (target === (item.shipmentId ?? null)) {
      setEditingId(null);
      return;
    }

    try {
      await updateLine.mutateAsync({ id: item.id, body: { shipmentId: target } });
      toast.success(
        target === null
          ? "Box unlinked — it stays in pre-staging"
          : "Box linked to the shipment"
      );
      setEditingId(null);
    } catch (error) {
      console.error("Error linking staging item:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update the shipment link"
      );
    }
  };

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
            <TableHead>Shipment</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Received by</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const isPending = pendingId === item.id;
            const shipmentId = item.shipmentId ?? null;
            // Only a RECEIVED line's link is still movable: after graduation the
            // receipt is the history of real stock, and the PATCH freezes it.
            const linkable = item.status === "RECEIVED";
            const editing = editingId === item.id;
            const busy = updateLine.isPending || choice.isCreating;

            return (
              <Fragment key={item.id}>
                <TableRow>
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
                  <TableCell data-testid={`staging-shipment-cell-${item.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      {shipmentId ? (
                        <Link href={`/receiving/${shipmentId}`}>
                          <Badge variant="secondary" className="cursor-pointer">
                            {labels.get(shipmentId) ?? shortShipmentId(shipmentId)}
                          </Badge>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Unattributed
                        </span>
                      )}
                      {linkable && !editing && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => openEditor(item)}
                          disabled={isPending || !csrfToken}
                        >
                          <Link2 className="mr-1 h-3.5 w-3.5" />
                          {shipmentId ? "Change" : "Assign to shipment"}
                        </Button>
                      )}
                    </div>
                  </TableCell>
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

                {editing && (
                  <TableRow data-testid={`staging-assign-${item.id}`}>
                    <TableCell colSpan={COLUMN_COUNT} className="bg-surface">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                        <div className="min-w-0 flex-1 sm:max-w-sm">
                          <ShipmentPicker
                            id={`staging-shipment-${item.id}`}
                            choice={choice}
                            noneLabel="None (leave it unattributed)"
                            currentShipmentId={shipmentId}
                            disabled={busy}
                          />
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => handleAssign(item)}
                            disabled={busy || !csrfToken}
                          >
                            {busy ? "Saving…" : "Save"}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingId(null)}
                            disabled={busy}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
