"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useCSRF } from "@/hooks/use-csrf";
import { useCreateStagingItem, useLocations } from "@/hooks/use-staging";
import { useUpdateStagingLine } from "@/hooks/use-inbound-shipments";
import {
  ShipmentPicker,
  useShipmentChoice,
} from "@/components/staging/shipment-picker";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * W2.5 — logging a box is where receiving now STARTS.
 *
 * Boxes used to be creatable only here, with no shipment field at all, so
 * attributing one to a receipt meant leaving the page, opening the receiving
 * detail, and finding the box again in a link picker. That connecting step sat
 * hidden at the end of a cross-page loop; the adoption gate rides on operators
 * actually walking it.
 *
 * The shipment is a CHOICE, not a requirement: an unattributed box stays a
 * legal thing to log (the whole point of pre-staging), so "None" is the default
 * whenever the dialog is opened from /pre-staging. Opened from a receiving
 * header it is prefilled and locked instead — there is no question to ask.
 *
 * TWO REQUESTS, NOT ONE. `POST /api/staging-items` has no shipment column, so
 * the link is the existing `PATCH /api/staging-items/[id]` fired afterwards.
 * That is composable but NOT atomic, and this dialog never pretends otherwise:
 * when the link fails the box already exists, unlinked, and the dialog says
 * exactly that and points at the queue. There is no rollback call to make, and
 * inventing one (a discard) would destroy a real record of a real box.
 */

interface CreateStagingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /**
   * Opened FROM a receiving header: this box belongs to that receipt, and the
   * choice is not on offer.
   */
  lockedShipmentId?: string | null;
  /** What that header is called on screen (supplier ref, else its id). */
  lockedShipmentLabel?: string | null;
}

export function CreateStagingDialog({
  open,
  onOpenChange,
  onSuccess,
  lockedShipmentId = null,
  lockedShipmentLabel = null,
}: CreateStagingDialogProps) {
  const { data: session } = useSession();
  const { token: csrfToken } = useCSRF();

  // Locations are fetched (and cached) the moment the dialog opens.
  const {
    data: locations = [],
    isFetching: locationsLoading,
    isError: locationsIsError,
    error: locationsError,
  } = useLocations(open);
  const locationErrorMsg = locationsIsError
    ? locationsError instanceof Error
      ? locationsError.message
      : "Failed to fetch locations"
    : null;

  const createMutation = useCreateStagingItem();
  // The link is the SAME PATCH the receiving detail uses to attach a box.
  const linkMutation = useUpdateStagingLine();

  // A locked dialog never asks for the header list it could not use anyway.
  const locked = lockedShipmentId !== null;
  const choice = useShipmentChoice({ enabled: open && !locked });

  const [description, setDescription] = useState("");
  const [expectedQuantity, setExpectedQuantity] = useState("");
  const [vendor, setVendor] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [locationId, setLocationId] = useState<number | undefined>(undefined);

  /**
   * The box landed; the link did not. Kept ON SCREEN rather than in a toast —
   * it names a row that now exists in a state nobody asked for, and that is
   * precisely the message that must not scroll away.
   */
  const [linkFailure, setLinkFailure] = useState<{
    description: string;
    message: string;
  } | null>(null);

  const isSubmitting =
    createMutation.isPending || linkMutation.isPending || choice.isCreating;

  // Resolve the default location once the catalog is available.
  useEffect(() => {
    if (open && locations.length > 0) {
      const userDefault = session?.user?.defaultLocationId;
      const resolved =
        locations.find((l) => l.id === userDefault)?.id ?? locations[0]?.id;
      setLocationId(resolved);
    }
  }, [open, locations, session?.user?.defaultLocationId]);

  // A fresh open is a fresh box: the previous run's shipment choice and its
  // link failure both belong to a row that is already logged.
  useEffect(() => {
    if (open) {
      setLinkFailure(null);
      choice.reset();
    }
    // `choice.reset` is stable per initial value; re-running on every render of
    // the picker would wipe the operator's selection as he made it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const resetForm = () => {
    setDescription("");
    setExpectedQuantity("");
    setVendor("");
    setReference("");
    setNotes("");
  };

  const trimmedDescription = description.trim();
  const expectedNum =
    expectedQuantity.trim() === "" ? undefined : parseInt(expectedQuantity, 10);
  const expectedInvalid =
    expectedNum !== undefined && (Number.isNaN(expectedNum) || expectedNum < 0);

  const isValid =
    trimmedDescription.length > 0 &&
    !!locationId &&
    !expectedInvalid &&
    !!csrfToken;

  const handleSubmit = async () => {
    if (!isValid || !locationId) {
      return;
    }
    setLinkFailure(null);

    // 1. THE HEADER, when one is being opened inline. It runs before the box on
    //    purpose: a failure here has written nothing at all, which is the only
    //    step of this composition that can still say that.
    let targetShipmentId: string | null;
    try {
      targetShipmentId = locked ? lockedShipmentId : await choice.resolve();
    } catch (error) {
      console.error("Error opening inbound shipment:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to open the shipment"
      );
      return;
    }

    // 2. THE BOX. The create route carries no shipment column — every box is
    //    born unattributed and joins a receipt afterwards.
    let createdId: number;
    try {
      const created = await createMutation.mutateAsync({
        description: trimmedDescription,
        expectedQuantity: expectedNum,
        vendor: vendor.trim() || undefined,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        locationId,
      });
      createdId = (created as { id: number }).id;
    } catch (error) {
      console.error("Error logging staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to log item"
      );
      return;
    }

    // 3. THE LINK. Same PATCH the receiving detail uses; its guards (RECEIVED
    //    line, OPEN headers, the claim races) are the server's, and their
    //    refusal is reported word for word.
    if (targetShipmentId !== null) {
      try {
        await linkMutation.mutateAsync({
          id: createdId,
          body: { shipmentId: targetShipmentId },
        });
      } catch (error) {
        // TRUTHFUL, not tidy: the box exists. There is no rollback endpoint,
        // and discarding a box somebody physically has would be a worse lie
        // than the half-done state itself.
        console.error("Error linking the logged box to a shipment:", error);
        setLinkFailure({
          description: trimmedDescription,
          message:
            error instanceof Error
              ? error.message
              : "The link request failed",
        });
        resetForm();
        onSuccess?.();
        return;
      }
    }

    toast.success(`Logged "${trimmedDescription}"`);
    resetForm();
    onOpenChange(false);
    onSuccess?.();
  };

  /**
   * THE HALF-DONE OUTCOME, on its own screen. The box exists; only the link
   * failed; there is no rollback call to offer and none is pretended. So the
   * dialog stops being a form — re-submitting would log a SECOND box — and
   * becomes the report of what happened plus the way to finish it by hand.
   */
  if (linkFailure) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Box logged — but not linked</DialogTitle>
            <DialogDescription>
              Logging the box and attaching it to a shipment are two separate
              requests. The first one succeeded.
            </DialogDescription>
          </DialogHeader>

          <div
            data-testid="staging-link-failed"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-2">
              <p className="font-medium">
                {`"${linkFailure.description}" is in the pre-staging queue, UNLINKED.`}
              </p>
              <p className="text-muted-foreground">
                Nothing was undone — the shipment link is the only part that
                failed:
              </p>
              <p className="text-muted-foreground">{linkFailure.message}</p>
              <Link
                href="/pre-staging"
                className="inline-block font-medium underline underline-offset-4"
              >
                Open the pre-staging queue and assign it
              </Link>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Log New Item</DialogTitle>
          <DialogDescription>
            Record an unlabeled box into the pre-staging queue, and say which
            receiving shipment it arrived on. You can graduate it into real
            inventory once it has been counted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="staging-description">
              Description <span className="text-destructive">*</span>
            </Label>
            <Input
              id="staging-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g., Unlabeled box of vials"
              maxLength={255}
              autoFocus
            />
          </div>

          {/* The receipt this box arrived on. Optional from /pre-staging —
              logging an unattributed box is still a legitimate act — and fixed
              when the dialog was opened from a receiving header. */}
          {locked ? (
            <div className="space-y-2">
              <Label>Receiving shipment</Label>
              <p
                data-testid="staging-locked-shipment"
                className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                {lockedShipmentLabel ?? lockedShipmentId}
              </p>
              <p className="text-xs text-muted-foreground">
                This box will be linked to the shipment you opened it from.
              </p>
            </div>
          ) : (
            <ShipmentPicker id="staging-shipment" choice={choice} />
          )}

          {/* Expected quantity + Location */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="staging-expected">Expected Quantity</Label>
              <Input
                id="staging-expected"
                type="number"
                min="0"
                value={expectedQuantity}
                onChange={(e) => setExpectedQuantity(e.target.value)}
                placeholder="Optional"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="staging-location">
                Location <span className="text-destructive">*</span>
              </Label>
              <Select
                value={locationId?.toString()}
                onValueChange={(value) => setLocationId(parseInt(value, 10))}
                disabled={locationsLoading || locations.length === 0}
              >
                <SelectTrigger id="staging-location">
                  <SelectValue
                    placeholder={
                      locationsLoading ? "Loading…" : "Select a location"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((location) => (
                    <SelectItem key={location.id} value={location.id.toString()}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {locationErrorMsg && (
                <p className="text-sm text-destructive">{locationErrorMsg}</p>
              )}
            </div>
          </div>

          {/* Vendor + Reference */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="staging-vendor">Vendor</Label>
              <Input
                id="staging-vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Optional"
                maxLength={255}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="staging-reference">Reference</Label>
              <Input
                id="staging-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g., PO-2024-001"
                maxLength={255}
              />
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="staging-notes">Notes</Label>
            <Textarea
              id="staging-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth recording about this box…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting || locationsLoading}
          >
            {isSubmitting ? "Logging…" : "Log Item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
