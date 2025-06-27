"use client";

import { OrderItemComponent } from "./order-item";
import { useWorkbench } from "@/hooks/use-workbench";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ShoppingCart } from "lucide-react";

export function OrderList() {
  const { orderItems, updateItemQuantity, removeItem, getTotalQuantity } = useWorkbench();

  if (orderItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 text-center">
        <ShoppingCart className="h-12 w-12 text-muted-foreground/50 mb-4" />
        <p className="text-muted-foreground">No items in order</p>
        <p className="text-sm text-muted-foreground">
          Click on products to add them
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Order Summary */}
      <div className="px-4 py-3 border-b bg-muted/50">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {orderItems.length} {orderItems.length === 1 ? "item" : "items"}
          </p>
          <p className="text-sm font-medium">
            Total: {getTotalQuantity()} units
          </p>
        </div>
      </div>

      {/* Order Items */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {orderItems.map((item) => (
            <OrderItemComponent
              key={item.product.id}
              item={item}
              onUpdateQuantity={(quantity) =>
                updateItemQuantity(item.product.id, quantity)
              }
              onRemove={() => removeItem(item.product.id)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}