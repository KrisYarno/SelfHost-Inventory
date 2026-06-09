"use client";

import * as React from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, MapPin, AlertCircle, Package } from 'lucide-react';
import { useLocation } from '@/contexts/location-context';
import { useProductLocationQuantity } from '@/hooks/use-product-location-quantity';
import {
  useAdjustInventory,
  useTransferInventory,
  type ApiMutationError,
} from '@/hooks/use-inventory-mutations';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
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
  AlertDialogAction,
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

type TransferDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: DialogProduct;
  onSuccess?: () => void;
};

type PendingTransferPayload = {
  productId: number;
  fromLocationId: number;
  toLocationId: number;
  quantity: number;
};

type InsufficientState = {
  visible: boolean;
  message: string;
  shortfall: number;
  available: number;
};

export function TransferDialog({ open, onOpenChange, product, onSuccess }: TransferDialogProps) {
  const { locations, selectedLocationId } = useLocation();

  const [fromLocationId, setFromLocationId] = React.useState<number | null>(null);
  const [toLocationId, setToLocationId] = React.useState<number | null>(null);
  const [quantity, setQuantity] = React.useState<string>('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [insufficient, setInsufficient] = React.useState<InsufficientState | null>(null);
  const [pendingTransfer, setPendingTransfer] = React.useState<PendingTransferPayload | null>(null);

  const fromQuantityQuery = useProductLocationQuantity(product.id, fromLocationId, {
    enabled: open,
  });
  const toQuantityQuery = useProductLocationQuantity(product.id, toLocationId, {
    enabled: open,
  });
  const transferMutation = useTransferInventory();
  const adjustMutation = useAdjustInventory();

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

  const submitTransfer = async (payload: PendingTransferPayload) => {
    try {
      await transferMutation.mutateAsync(payload);
    } catch (err) {
      const apiError = err as ApiMutationError;
      if (apiError.code === 'INVENTORY_INSUFFICIENT_STOCK') {
        const d = apiError.data ?? {};
        setInsufficient({
          visible: true,
          message: apiError.message || 'Insufficient stock at source',
          available: typeof d.currentQuantity === 'number' ? d.currentQuantity : 0,
          shortfall: typeof d.shortfall === 'number' ? d.shortfall : 0,
        });
        setPendingTransfer(payload);
        return;
      }
      throw err;
    }

    toast.success(`Moved ${payload.quantity} units of ${product.name}`);
    onOpenChange(false);
    setQuantity('');
    setPendingTransfer(null);
    setInsufficient(null);
    onSuccess?.();
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      toast.error('Please complete the transfer form');
      return;
    }
    // Do not block here; allow server to return a structured
    // insufficient-stock response so we can offer auto-add.

    const payload: PendingTransferPayload = {
      productId: product.id,
      fromLocationId: fromLocationId as number,
      toLocationId: toLocationId as number,
      quantity: qtyNum,
    };

    setIsSubmitting(true);
    try {
      await submitTransfer(payload);
    } catch (error) {
      console.error('Error performing transfer:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to transfer inventory');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmAutoAdd = async () => {
    if (!pendingTransfer || !insufficient) {
      setInsufficient(null);
      setPendingTransfer(null);
      return;
    }
    const shortfall = insufficient.shortfall;
    if (shortfall <= 0) {
      setInsufficient(null);
      setPendingTransfer(null);
      return;
    }

    setIsSubmitting(true);
    try {
      await adjustMutation.mutateAsync({
        productId: pendingTransfer.productId,
        locationId: pendingTransfer.fromLocationId,
        delta: shortfall,
        autoAddForTransfer: true,
      });

      await submitTransfer(pendingTransfer);
    } catch (error) {
      console.error('Error auto-adding stock for transfer:', error);
      toast.error(error instanceof Error ? error.message : 'Unable to auto-add stock for transfer');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelAutoAdd = () => {
    setInsufficient(null);
    setPendingTransfer(null);
  };

  const fromLoc = locations.find((loc) => loc.id === fromLocationId);
  const toLoc = locations.find((loc) => loc.id === toLocationId);

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

      {/* Auto-add confirmation dialog */}
      <AlertDialog open={insufficient?.visible ?? false} onOpenChange={(open) => { if (!open) { handleCancelAutoAdd(); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Not enough stock at source location</AlertDialogTitle>
            <AlertDialogDescription>
              {insufficient?.message ?? 'There is not enough stock at the selected source location to complete this transfer.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(() => {
            const available = insufficient?.available ?? 0;
            const shortfall = insufficient?.shortfall ?? 0;
            const requested = pendingTransfer?.quantity ?? 0;
            const afterAdd = available + shortfall;
            const afterTransfer = afterAdd - requested;
            return (
              <div role="status" className="mt-2 space-y-1 text-sm">
                <p>
                  Available now: <span className="font-semibold">{available}</span>
                </p>
                <p>
                  Shortfall to complete transfer: <span className="font-semibold">{shortfall}</span>
                </p>
                <p className="mt-2">
                  This will add <span className="font-semibold">{shortfall}</span> units of
                  {' '}<span className="font-semibold">{product.name}</span>
                  {fromLoc ? <> at <span className="font-semibold">{fromLoc.name}</span></> : null}
                  {' '}so you can move <span className="font-semibold">{requested}</span>.
                </p>
                <p className="text-muted-foreground">
                  After add: {afterAdd}. After transfer: {afterTransfer} at the source.
                </p>
              </div>
            );
          })()}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={isSubmitting} onClick={handleConfirmAutoAdd}>
              Add missing stock &amp; transfer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
