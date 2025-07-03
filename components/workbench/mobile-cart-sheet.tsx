"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import { OrderList } from "./order-list";
import { RotateCcw, ShoppingCart } from "lucide-react";

interface MobileCartSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderReference: string;
  onOrderReferenceChange: (value: string) => void;
  totalItems: number;
  totalQuantity: number;
  onClearOrder: () => void;
  onCompleteOrder: () => void;
  canComplete: boolean;
}

export function MobileCartSheet({
  open,
  onOpenChange,
  orderReference,
  onOrderReferenceChange,
  totalItems,
  totalQuantity,
  onClearOrder,
  onCompleteOrder,
  canComplete,
}: MobileCartSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" />
            Current Order
          </SheetTitle>
          <SheetDescription>
            Review and complete your order
          </SheetDescription>
        </SheetHeader>

        {/* Order Reference */}
        <div className="py-4 space-y-2">
          <Label htmlFor="mobile-order-reference">Order Reference</Label>
          <Input
            id="mobile-order-reference"
            placeholder="Enter order number..."
            value={orderReference}
            onChange={(e) => onOrderReferenceChange(e.target.value)}
            className="font-mono"
          />
        </div>

        {/* Order Items */}
        <div className="flex-1 overflow-hidden -mx-6 px-6">
          <OrderList />
        </div>

        {/* Order Summary and Actions */}
        <div className="space-y-4 pt-4 border-t">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total items:</span>
              <span className="font-medium">{totalItems}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Total quantity:</span>
              <span className="font-medium">{totalQuantity} units</span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={onClearOrder}
              disabled={totalItems === 0}
              className="flex-1"
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Clear
            </Button>
            <Button
              onClick={onCompleteOrder}
              disabled={!canComplete}
              className="flex-1"
            >
              Complete Order
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}