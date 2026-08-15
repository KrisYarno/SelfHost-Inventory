"use client";

import { useCallback, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateInboundShipment,
  useInboundShipments,
  type ShipmentSummary,
} from "@/hooks/use-inbound-shipments";

/**
 * THE receiving-shipment control (W2.5), shared by the two surfaces that
 * attribute a box to a receipt: the create dialog and the pre-staging queue's
 * row action. One implementation on purpose — two would drift into two answers
 * to "which receipts can I still join", and the operator would meet whichever
 * screen he happened to be on.
 *
 * It offers exactly the three things the server accepts: an OPEN header, a NEW
 * header, or nothing at all. OPEN is the only status a link may be made
 * against, so it is the only pre-filter here; every OTHER refusal — a header
 * closed between the read and the write, a line that graduated mid-edit — stays
 * the server's to make (`applyShipmentLink`'s claims are the guard), and both
 * callers render its sentence verbatim rather than restating the rule.
 *
 * The control never writes a link. It resolves to the id a caller should link
 * TO, creating the header first when "New shipment…" was chosen, and the caller
 * owns the PATCH and the outcome.
 */

/** Sentinels. Radix needs a non-empty value, and a cuid cannot collide. */
export const SHIPMENT_NONE = "__none__";
export const SHIPMENT_NEW = "__new__";

/** The last few characters of a cuid — enough to tell two receipts apart. */
export function shortShipmentId(id: string): string {
  return `#${id.slice(-6)}`;
}

/** What a header is called on screen: its supplier ref, else a short id. */
export function shipmentLabel(shipment: {
  id: string;
  supplierRef: string | null;
}): string {
  return shipment.supplierRef?.trim() || shortShipmentId(shipment.id);
}

export interface ShipmentChoice {
  value: string;
  setValue: (value: string) => void;
  supplierRef: string;
  setSupplierRef: (value: string) => void;
  shipments: ShipmentSummary[];
  isLoading: boolean;
  /** A header is being opened right now (the inline-create leg). */
  isCreating: boolean;
  /** Back to a known value — the initial one unless another is named. */
  reset: (value?: string) => void;
  /**
   * The id to link to, or `null` for "leave it unattributed". Opens the header
   * FIRST on the inline-create path, so a failure there leaves nothing behind.
   * Throws whatever the create route said.
   */
  resolve: () => Promise<string | null>;
}

export function useShipmentChoice(
  options: { enabled?: boolean; initialValue?: string } = {},
): ShipmentChoice {
  const { enabled = true, initialValue = SHIPMENT_NONE } = options;

  const { data: shipments = [], isFetching } = useInboundShipments("OPEN", enabled);
  const createShipment = useCreateInboundShipment();

  const [value, setValue] = useState(initialValue);
  const [supplierRef, setSupplierRef] = useState("");

  const reset = useCallback(
    (next: string = initialValue) => {
      setValue(next);
      setSupplierRef("");
    },
    [initialValue],
  );

  const resolve = useCallback(async () => {
    if (value === SHIPMENT_NONE) return null;
    if (value === SHIPMENT_NEW) {
      const created = await createShipment.mutateAsync({
        supplierRef: supplierRef.trim() || undefined,
      });
      return created.id;
    }
    return value;
  }, [value, supplierRef, createShipment]);

  return {
    value,
    setValue,
    supplierRef,
    setSupplierRef,
    shipments,
    isLoading: isFetching,
    isCreating: createShipment.isPending,
    reset,
    resolve,
  };
}

interface ShipmentPickerProps {
  /** Id for the trigger; the label points at it, so it must be unique. */
  id: string;
  choice: ShipmentChoice;
  label?: string;
  /** How "no receipt" reads on THIS surface (logging vs. unlinking). */
  noneLabel?: string;
  disabled?: boolean;
  /**
   * A header the row is ALREADY on that the OPEN list does not carry — a closed
   * receipt, say. Rendered so the control can show where the box actually is
   * instead of an empty trigger. Whether it may still be moved is the server's
   * call, not this list's.
   */
  currentShipmentId?: string | null;
}

export function ShipmentPicker({
  id,
  choice,
  label = "Receiving shipment",
  noneLabel = "None (unlinked box)",
  disabled,
  currentShipmentId = null,
}: ShipmentPickerProps) {
  const { value, setValue, supplierRef, setSupplierRef, shipments, isLoading } = choice;

  const options = useMemo(() => {
    const known = shipments.map((shipment) => ({
      id: shipment.id,
      label: shipmentLabel(shipment),
    }));
    if (currentShipmentId && !known.some((o) => o.id === currentShipmentId)) {
      return [{ id: currentShipmentId, label: shortShipmentId(currentShipmentId) }, ...known];
    }
    return known;
  }, [shipments, currentShipmentId]);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={setValue} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={SHIPMENT_NONE}>{noneLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
          <SelectItem value={SHIPMENT_NEW}>New shipment…</SelectItem>
        </SelectContent>
      </Select>

      {isLoading && (
        <p className="text-xs text-muted-foreground">Loading open shipments…</p>
      )}

      {value === SHIPMENT_NEW && (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-supplier-ref`} className="text-xs">
            Supplier reference
          </Label>
          <Input
            id={`${id}-supplier-ref`}
            value={supplierRef}
            onChange={(e) => setSupplierRef(e.target.value)}
            maxLength={255}
            placeholder="e.g. PO-2026-0142 (optional)"
          />
        </div>
      )}
    </div>
  );
}
