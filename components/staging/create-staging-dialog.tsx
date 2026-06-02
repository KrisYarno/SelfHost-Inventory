"use client";

import { useState, useEffect } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
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

interface Location {
  id: number;
  name: string;
}

interface CreateStagingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function CreateStagingDialog({
  open,
  onOpenChange,
  onSuccess,
}: CreateStagingDialogProps) {
  const { data: session } = useSession();
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();

  const [locations, setLocations] = useState<Location[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const [description, setDescription] = useState("");
  const [expectedQuantity, setExpectedQuantity] = useState("");
  const [vendor, setVendor] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [locationId, setLocationId] = useState<number | undefined>(undefined);

  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch locations when the dialog opens (mirrors create-product-dialog).
  useEffect(() => {
    if (open && csrfToken && !csrfLoading) {
      setLocationsLoading(true);
      setLocationError(null);
      fetch("/api/locations", {
        headers: withCSRFHeaders({}, csrfToken),
      })
        .then(async (res) => {
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "Failed to fetch locations");
          }
          return res.json();
        })
        .then((data) => {
          // /api/locations returns a bare array; tolerate { locations } too.
          const list: Location[] = data?.locations ?? data ?? [];
          setLocations(list);
          const userDefault = session?.user?.defaultLocationId;
          const resolved =
            list.find((l) => l.id === userDefault)?.id ?? list[0]?.id;
          setLocationId(resolved);
        })
        .catch((err) => {
          console.error("Failed to fetch locations:", err);
          setLocationError(
            err instanceof Error ? err.message : "Failed to fetch locations"
          );
        })
        .finally(() => setLocationsLoading(false));
    }
  }, [open, csrfToken, csrfLoading, session?.user?.defaultLocationId]);

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

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/staging-items", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          description: trimmedDescription,
          expectedQuantity: expectedNum,
          vendor: vendor.trim() || undefined,
          reference: reference.trim() || undefined,
          notes: notes.trim() || undefined,
          locationId,
        }),
      });

      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(json.error || "Failed to log item");
      }

      toast.success(`Logged "${trimmedDescription}"`);
      resetForm();
      onOpenChange(false);
      onSuccess?.();
    } catch (error) {
      console.error("Error logging staging item:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to log item"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Log New Item</DialogTitle>
          <DialogDescription>
            Record an unlabeled box into the pre-staging queue. You can graduate
            it into real inventory once it has been counted.
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
              {locationError && (
                <p className="text-sm text-destructive">{locationError}</p>
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
