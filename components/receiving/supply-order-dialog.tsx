"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SupplyOrderForm } from "@/components/receiving/supply-order-form";

/**
 * "New supply order" — a CONTROLLED DIALOG, not a route (contract pack C4a.3).
 *
 * The same shape the receiving surface already used for creating a header: the
 * Orders list stays on screen behind it, so an operator entering the third order
 * of a delivery run never loses the queue they are working through.
 *
 * The dialog owns nothing but visibility. Every field, every bound and every
 * request lives in `SupplyOrderForm`, which is why the form is testable without
 * a portal and why M4b can mount it somewhere else if it ever needs to.
 */

interface SupplyOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SupplyOrderDialog({ open, onOpenChange }: SupplyOrderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>New supply order</DialogTitle>
          <DialogDescription>
            What was ordered, from whom, on what day, and what it cost. The delivery is
            verified against this later — line by line.
          </DialogDescription>
        </DialogHeader>

        {/* Remounted per open, so a cancelled draft never reappears half-filled. */}
        {open && (
          <SupplyOrderForm
            onCreated={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
