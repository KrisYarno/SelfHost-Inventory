"use client";

import * as React from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, MapPin, AlertCircle, Package } from 'lucide-react';
import { useLocation } from '@/contexts/location-context';
import { useProductLocationQuantity } from '@/hooks/use-product-location-quantity';
import { useTransferInventory, type ApiMutationError } from '@/hooks/use-inventory-mutations';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { DialogProduct } from '@/types/inventory';
import { ContextTag } from '@/components/ui/context-tag';
import { ValueChip } from '@/components/ui/value-chip';
import { InlineHighlight } from '@/components/ui/inline-highlight';
import { cn } from '@/lib/utils';

type TransferDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: DialogProduct;
  onSuccess?: () => void;
};

type TransferPayload = {
  productId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
};

/**
 * The source could not cover the transfer (§ P2-B3-1R, MS-1-6). `available` is
 * the server's own count, or `null` when its answer did not carry one — an
 * unknown is said as unknown, never as 0.
 */
type InsufficientState = {
  visible: boolean;
  available: number | null;
  source: string;
};

const unitWord = (n: number) => (n === 1 ? 'unit' : 'units');

export function TransferDialog({ open, onOpenChange, product, onSuccess }: TransferDialogProps) {
  const { locations, selectedLocationId } = useLocation();

  const [fromLocationId, setFromLocationId] = React.useState<number | null>(null);
  const [toLocationId, setToLocationId] = React.useState<number | null>(null);
  const [quantity, setQuantity] = React.useState<string>('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [insufficient, setInsufficient] = React.useState<InsufficientState | null>(null);
  // "Change the quantity" hands focus back to this field when the alert closes.
  const qtyRef = React.useRef<HTMLInputElement>(null);

  const fromQuantityQuery = useProductLocationQuantity(product.id, fromLocationId, {
    enabled: open,
  });
  const toQuantityQuery = useProductLocationQuantity(product.id, toLocationId, {
    enabled: open,
  });
  const transferMutation = useTransferInventory();

  const fromQuantity = fromQuantityQuery.data ?? null;
  const loadingFromQuantity = fromQuantityQuery.isLoading;
  const loadingToQuantity = toQuantityQuery.isLoading;

  // Seed defaults on open
  React.useEffect(() => {
    if (!open || !locations.length) return;

    setQuantity('');

    const initialFrom = selectedLocationId ?? locations[0]?.id ?? null;
    const initialTo = locations.find((l) => l.id !== initialFrom)?.id ?? null;
    setFromLocationId(initialFrom);
    setToLocationId(initialTo);
  }, [open, locations, selectedLocationId]);

  const qtyNum = Number.parseInt(quantity || '0', 10) > 0 ? Number.parseInt(quantity || '0', 10) : 0;
  const canSubmit = !!fromLocationId && !!toLocationId && fromLocationId !== toLocationId && qtyNum > 0;
  const sourceDisplayQty = fromQuantity ?? 0;
  const destinationDisplayQty = toQuantityQuery.data ?? 0;
  const projectedSource = qtyNum > 0 ? sourceDisplayQty - qtyNum : sourceDisplayQty;
  const projectedDestination = qtyNum > 0 ? destinationDisplayQty + qtyNum : destinationDisplayQty;
  const hasSameLocation = Boolean(fromLocationId && toLocationId && fromLocationId === toLocationId);

  const handleIncrement = () => {
    setQuantity((prev) => {
      const current = Number.parseInt(prev || '0', 10) > 0 ? Number.parseInt(prev || '0', 10) : 0;
      const next = current + 1;
      if (fromQuantity !== null && next > fromQuantity) {
        return String(fromQuantity);
      }
      return String(next);
    });
  };

  const handleDecrement = () => {
    setQuantity((prev) => {
      const current = Number.parseInt(prev || '0', 10) > 0 ? Number.parseInt(prev || '0', 10) : 0;
      const next = Math.max(current - 1, 1);
      return String(next);
    });
  };

  const fromLoc = locations.find((loc) => loc.id === fromLocationId);
  const toLoc = locations.find((loc) => loc.id === toLocationId);

  const handleSubmit = async () => {
    if (!canSubmit) {
      toast.error('Please complete the transfer form');
      return;
    }
    // Do not block here; the server answers a short source with a structured
    // insufficient-stock response, and the alert below asks for a new quantity.

    const payload: TransferPayload = {
      productId: product.id,
      fromLocationId: fromLocationId as number,
      toLocationId: toLocationId as number,
      quantity: qtyNum,
    };

    setIsSubmitting(true);
    try {
      await transferMutation.mutateAsync(payload);

      toast.success(`Moved ${payload.quantity} units of ${product.name}`);
      onOpenChange(false);
      setQuantity('');
      setInsufficient(null);
      onSuccess?.();
    } catch (error) {
      const apiError = error as ApiMutationError;
      if (apiError.code === 'INVENTORY_INSUFFICIENT_STOCK') {
        // § P2-B3-1R (MS-1-6, row 108): the source is short, so the transfer is
        // refused and the operator changes the quantity. This dialog never
        // creates stock to cover a shortfall.
        const d = apiError.data ?? {};
        setInsufficient({
          visible: true,
          available: typeof d.currentQuantity === 'number' ? d.currentQuantity : null,
          source: fromLoc?.name ?? 'the source location',
        });
        return;
      }
      console.error('Error performing transfer:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to transfer inventory');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md w-[95vw] sm:w-full overflow-hidden border border-border bg-background p-0 shadow-2xl">
          <div className="space-y-5 p-6">
            <DialogHeader className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <DialogTitle className="flex items-center gap-2 text-base md:text-lg font-semibold text-foreground">
                    <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                    Transfer inventory
                  </DialogTitle>
                  <DialogDescription className="text-sm text-muted-foreground">
                    Move stock between locations for this product.
                  </DialogDescription>
                </div>
              </div>

              <div className="mt-2 rounded-lg border border-border bg-surface px-3 py-2">
                <div className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground truncate">{product.name}</p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <ContextTag icon={<MapPin className="h-3 w-3 text-muted-foreground" />}>
                    {fromLoc?.name ?? 'Select a source'}
                  </ContextTag>
                  {fromQuantityQuery.isError ? (
                    <span className="text-destructive">Could not load current stock</span>
                  ) : (
                    <ValueChip
                      tone={sourceDisplayQty > 0 ? 'positive' : sourceDisplayQty < 0 ? 'negative' : 'neutral'}
                      className="uppercase tracking-wide"
                    >
                      {loadingFromQuantity ? 'Loading...' : `${sourceDisplayQty} units`}
                    </ValueChip>
                  )}
                </div>
              </div>
            </DialogHeader>

            {/* From / To location selectors */}
            <div className="space-y-4 md:grid md:grid-cols-2 md:gap-4 md:space-y-0">
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  From location
                </Label>
                <Select
                  value={fromLocationId ? String(fromLocationId) : undefined}
                  onValueChange={(value) => {
                    const id = Number(value);
                    setFromLocationId(id);
                    if (id === toLocationId) {
                      const alt = locations.find((loc) => loc.id !== id);
                      setToLocationId(alt?.id ?? null);
                    }
                  }}
                >
                  <SelectTrigger className="mt-0.5 h-10 w-full rounded-md border border-border bg-surface text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent className="bg-surface text-foreground">
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Current stock:</span>
                  {fromQuantityQuery.isError ? (
                    <span className="text-destructive">Could not load current stock</span>
                  ) : (
                    <ValueChip
                      tone={sourceDisplayQty > 0 ? 'positive' : sourceDisplayQty < 0 ? 'negative' : 'neutral'}
                      className="text-[10px]"
                    >
                      {loadingFromQuantity ? '...' : `${sourceDisplayQty} units`}
                    </ValueChip>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  To location
                </Label>
                <Select
                  value={toLocationId ? String(toLocationId) : undefined}
                  onValueChange={(value) => setToLocationId(Number(value))}
                >
                  <SelectTrigger className="mt-0.5 h-10 w-full rounded-md border border-border bg-surface text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent className="bg-surface text-foreground">
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Current stock:</span>
                  {toQuantityQuery.isError ? (
                    <span className="text-destructive">Could not load current stock</span>
                  ) : (
                    <ValueChip
                      tone={destinationDisplayQty > 0 ? 'positive' : destinationDisplayQty < 0 ? 'negative' : 'neutral'}
                      className="text-[10px]"
                    >
                      {loadingToQuantity ? '...' : `${destinationDisplayQty} units`}
                    </ValueChip>
                  )}
                </div>
                {hasSameLocation && (
                  <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                    <AlertCircle className="h-3 w-3" />
                    Source and destination must be different.
                  </p>
                )}
              </div>
            </div>

            {/* Quantity + stepper */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Quantity to move</p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 rounded-md border-border bg-surface text-xl text-foreground"
                  aria-label="Decrease quantity"
                  onClick={handleDecrement}
                  disabled={isSubmitting}
                >
                  −
                </Button>
                <Input
                  ref={qtyRef}
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="h-10 w-24 rounded-md border-border bg-surface text-center text-lg font-semibold tracking-wider text-foreground"
                  placeholder="0"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-10 w-10 rounded-md border-border bg-surface text-xl text-foreground"
                  aria-label="Increase quantity"
                  onClick={handleIncrement}
                  disabled={isSubmitting}
                >
                  +
                </Button>
              </div>
              <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
                {qtyNum > 0 ? (
                  <>
                    After transfer:{' '}
                    <InlineHighlight className="text-foreground">
                      {fromLoc?.name ?? 'Source'}
                    </InlineHighlight>{' '}
                    -&gt;{' '}
                    <span className={projectedSource < 0 ? 'text-destructive font-semibold' : 'text-foreground font-semibold'}>
                      {projectedSource} units
                    </span>{' '}
                    |{' '}
                    <InlineHighlight className="text-foreground">
                      {toLoc?.name ?? 'Destination'}
                    </InlineHighlight>{' '}
                    -&gt;{' '}
                    <span className="text-success font-semibold">
                      {projectedDestination} units
                    </span>
                  </>
                ) : null}
              </p>
            </div>

            <DialogFooter className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="h-10 w-full sm:w-auto"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 sm:w-auto"
                onClick={handleSubmit}
                disabled={!canSubmit || isSubmitting}
              >
                {isSubmitting ? 'Transferring...' : qtyNum > 0 ? `Transfer ${qtyNum} units` : 'Transfer'}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      {/* The source is short (§ P2-B3-1R, MS-1-6; the add action REMOVED, row
          108). ONE way out: change the quantity. It is the alert's Cancel —
          styled primary — so Radix focuses it when the alert opens (an Action
          would leave focus on the Transfer button behind the alert), and on
          close focus goes to the quantity field. */}
      <AlertDialog
        open={insufficient?.visible ?? false}
        onOpenChange={(next) => {
          // The sentence stays put while the alert animates out.
          if (!next) setInsufficient((prev) => (prev ? { ...prev, visible: false } : prev));
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            qtyRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Not enough stock at source location</AlertDialogTitle>
            <AlertDialogDescription>
              {insufficient === null
                ? null
                : insufficient.available === null
                  ? `Couldn't read the stock at ${insufficient.source}.`
                  : `Only ${insufficient.available} ${unitWord(insufficient.available)} at ${insufficient.source}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={cn(buttonVariants(), 'border-0 hover:text-primary-foreground')}>
              Change the quantity
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
