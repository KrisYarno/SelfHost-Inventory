"use client";

import * as React from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, MapPin, AlertCircle, Package } from 'lucide-react';
import { useLocation } from '@/contexts/location-context';
import { useCSRF, withCSRFHeaders } from '@/hooks/use-csrf';
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
import type { ProductWithQuantity } from '@/types/product';

type TransferDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductWithQuantity | null;
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
  const { token: csrfToken } = useCSRF();

  const [fromLocationId, setFromLocationId] = React.useState<number | null>(null);
  const [toLocationId, setToLocationId] = React.useState<number | null>(null);
  const [fromQuantity, setFromQuantity] = React.useState<number | null>(null);
  const [loadingFromQuantity, setLoadingFromQuantity] = React.useState(false);
  const [quantity, setQuantity] = React.useState<string>('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const [insufficient, setInsufficient] = React.useState<InsufficientState | null>(null);
  const [pendingTransfer, setPendingTransfer] = React.useState<PendingTransferPayload | null>(null);

  // Seed defaults on open
  React.useEffect(() => {
    if (!open || !locations.length) return;

    setQuantity('');

    const initialFrom = selectedLocationId ?? locations[0]?.id ?? null;
    const initialTo = locations.find((l) => l.id !== initialFrom)?.id ?? null;
    setFromLocationId(initialFrom);
    setToLocationId(initialTo);
  }, [open, locations, selectedLocationId]);

  // Fetch current quantity at source
  React.useEffect(() => {
    if (!open || !product || !fromLocationId) {
      setFromQuantity(null);
      return;
    }
    setLoadingFromQuantity(true);
    fetch(`/api/inventory/product/${product.id}?locationId=${fromLocationId}`)
      .then((res) => res.json())
      .then((data) => {
        if (typeof data.currentQuantity === 'number') {
          setFromQuantity(data.currentQuantity);
        } else {
          setFromQuantity(0);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch location quantity:', err);
        toast.error('Failed to fetch current quantity');
        setFromQuantity(null);
      })
      .finally(() => setLoadingFromQuantity(false));
  }, [open, product, fromLocationId]);

  if (!product) return null;

  const qtyNum = Number.parseInt(quantity || '0', 10) > 0 ? Number.parseInt(quantity || '0', 10) : 0;
  const canSubmit = !!fromLocationId && !!toLocationId && fromLocationId !== toLocationId && qtyNum > 0;
  const sourceDisplayQty = fromQuantity ?? product.currentQuantity ?? 0;
  const projectedSource = qtyNum > 0 ? sourceDisplayQty - qtyNum : sourceDisplayQty;

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
    const response = await fetch('/api/inventory/transfer', {
      method: 'POST',
      headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      toast.success(`Moved ${payload.quantity} units of ${product.name}`);
      onOpenChange(false);
      setQuantity('');
      setFromQuantity(null);
      setPendingTransfer(null);
      setInsufficient(null);
      onSuccess?.();
      return;
    }

    const data = await response.json().catch(() => undefined);
    const errorCode = data?.error?.code;
    if (errorCode === 'INVENTORY_INSUFFICIENT_STOCK') {
      const context = data.error.context ?? {};
      setInsufficient({
        visible: true,
        message: data.error.message ?? 'Insufficient stock at source',
        available: context.currentQuantity ?? 0,
        shortfall: context.shortfall ?? 0,
      });
      setPendingTransfer(payload);
      return;
    }

    const message = data?.error?.message ?? data?.error ?? 'Failed to transfer inventory';
    throw new Error(message);
  };

  const handleSubmit = async () => {
    if (!canSubmit || !product) {
      toast.error('Please complete the transfer form');
      return;
    }
    if (fromQuantity !== null && qtyNum > fromQuantity) {
      toast.error('Cannot transfer more than available stock');
      return;
    }

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
    if (!pendingTransfer || !insufficient || !product) {
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
      const adjustResponse = await fetch('/api/inventory/adjust', {
        method: 'POST',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify({
          productId: pendingTransfer.productId,
          locationId: pendingTransfer.fromLocationId,
          delta: shortfall,
          autoAddForTransfer: true,
        }),
      });
      if (!adjustResponse.ok) {
        const data = await adjustResponse.json().catch(() => undefined);
        const message = data?.error?.message ?? data?.error ?? 'Failed to add stock before transfer';
        throw new Error(message);
      }

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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Transfer inventory</DialogTitle>
            <DialogDescription>Move stock between locations for this product.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Product info */}
            <div className="p-3 rounded-lg bg-muted/50">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ArrowLeftRight className="h-4 w-4" />
                <span>Product</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Package className="h-4 w-4" />
                <p className="font-medium">{product.name}</p>
              </div>
            </div>

            {/* From / To location selectors */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  <span>From location</span>
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
                  <SelectTrigger>
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {loadingFromQuantity ? 'Loading current quantity...' : `Current stock: ${sourceDisplayQty}`}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="flex items-center gap-1">
                  <MapPin className="h-4 w-4" />
                  <span>To location</span>
                </Label>
                <Select value={toLocationId ? String(toLocationId) : undefined} onValueChange={(value) => setToLocationId(Number(value))}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fromLocationId && toLocationId && fromLocationId === toLocationId && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Source and destination must be different.
                  </p>
                )}
              </div>
            </div>

            {/* Quantity + stepper */}
            <div className="space-y-2">
              <Label>Quantity to move</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={handleDecrement} disabled={isSubmitting}>
                  −
                </Button>
                <Input
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="h-10 text-center text-lg"
                  placeholder="0"
                />
                <Button type="button" variant="outline" size="icon" className="h-10 w-10" onClick={handleIncrement} disabled={isSubmitting}>
                  +
                </Button>
              </div>
              {qtyNum > 0 && (
                <p className="text-xs text-muted-foreground">
                  After transfer, <span className="font-medium">{fromLoc?.name ?? 'source'}</span> would have{' '}
                  <span className={projectedSource < 0 ? 'text-destructive font-semibold' : 'font-semibold'}>{projectedSource}</span> units.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? 'Transferring...' : 'Confirm transfer'}
            </Button>
          </DialogFooter>
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
          <div className="mt-2 space-y-1 text-sm">
            <p>
              Available: <span className="font-semibold">{insufficient?.available ?? 0}</span>
            </p>
            <p>
              Missing for this transfer: <span className="font-semibold">{insufficient?.shortfall ?? 0}</span>
            </p>
          </div>
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

