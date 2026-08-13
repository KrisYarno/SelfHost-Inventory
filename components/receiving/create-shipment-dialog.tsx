"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCSRF } from "@/hooks/use-csrf";
import {
  useCreateInboundShipment,
  type ShipmentSummary,
} from "@/hooks/use-inbound-shipments";

/**
 * Open a receiving header (W1-4b).
 *
 * A shipment carries NO quantities of its own — lines arrive later by linking
 * received boxes to it. So this dialog asks for the two things a header is:
 * what the supplier called it, and anything worth remembering about it. Both
 * optional; the id alone is a legitimate receipt.
 */

interface CreateShipmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (shipment: ShipmentSummary) => void;
}

export function CreateShipmentDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateShipmentDialogProps) {
  const { token: csrfToken } = useCSRF();
  const createMutation = useCreateInboundShipment();
  const [supplierRef, setSupplierRef] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setSupplierRef("");
      setNotes("");
    }
  }, [open]);

  const handleCreate = async () => {
    try {
      const shipment = await createMutation.mutateAsync({
        supplierRef: supplierRef.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      toast.success("Shipment opened");
      onOpenChange(false);
      onCreated?.(shipment);
    } catch (error) {
      console.error("Error opening inbound shipment:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to open the shipment",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Open a shipment</DialogTitle>
          <DialogDescription>
            A receiving header to attach today&apos;s boxes to. You can link
            received items to it as they are logged.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="supplier-ref">Supplier reference</Label>
            <Input
              id="supplier-ref"
              value={supplierRef}
              onChange={(e) => setSupplierRef(e.target.value)}
              maxLength={255}
              placeholder="e.g. PO-2026-0142"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shipment-notes">Notes</Label>
            <Textarea
              id="shipment-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={5000}
              rows={3}
              placeholder="Carrier, pallet count, anything worth remembering"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={createMutation.isPending || !csrfToken}
          >
            {createMutation.isPending ? "Opening…" : "Open shipment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
