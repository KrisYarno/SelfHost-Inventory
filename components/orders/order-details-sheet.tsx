"use client";

import { useState } from "react";
import { Package, X, Check, Lock, Unlock } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Order } from "@/types/orders";
import { formatDistanceToNow } from "date-fns";
import { useLockOrder, useUnlockOrder, useCompleteOrder } from "@/hooks/use-orders";
import { useSession } from "next-auth/react";

interface OrderDetailsSheetProps {
  order: Order | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OrderDetailsSheet({ order, open, onOpenChange }: OrderDetailsSheetProps) {
  const { data: session } = useSession();
  const lockOrderMutation = useLockOrder();
  const unlockOrderMutation = useUnlockOrder();
  const completeOrderMutation = useCompleteOrder();
  
  const [isProcessing, setIsProcessing] = useState(false);

  if (!order) return null;

  const isLocked = !!order.lockedBy;
  const isOwnLock = order.lockedBy?.userId === session?.user?.id;
  const canProcess = !isLocked || isOwnLock;
  const timeElapsed = formatDistanceToNow(new Date(order.createdAt), { addSuffix: true });

  const handleLockToggle = async () => {
    if (!session?.user?.id) return;
    
    setIsProcessing(true);
    try {
      if (isOwnLock) {
        await unlockOrderMutation.mutateAsync(order.id);
      } else {
        await lockOrderMutation.mutateAsync({
          orderId: order.id,
          userId: session.user.id,
        });
      }
    } finally {
      setIsProcessing(false);
    }
  };

  const handleComplete = async () => {
    setIsProcessing(true);
    try {
      await completeOrderMutation.mutateAsync(order.id);
      onOpenChange(false);
    } finally {
      setIsProcessing(false);
    }
  };

  // Haptic feedback (if available)
  const triggerHaptic = () => {
    if ('vibrate' in navigator) {
      navigator.vibrate(10);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[85vh] flex flex-col">
        <SheetHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div>
              <SheetTitle className="text-2xl font-bold">
                {order.orderNumber}
              </SheetTitle>
              <SheetDescription>
                Created {timeElapsed}
              </SheetDescription>
            </div>
            <Badge 
              variant="secondary" 
              className={cn(
                "text-sm",
                order.status === 'pending' && "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
                order.status === 'packing' && "bg-blue-500/10 text-blue-700 dark:text-blue-400",
                order.status === 'completed' && "bg-green-500/10 text-green-700 dark:text-green-400",
              )}
            >
              {order.status.replace('_', ' ')}
            </Badge>
          </div>
          
          {isLocked && (
            <div className="flex items-center gap-2 mt-3 p-3 bg-orange-500/10 rounded-lg">
              <Lock className="w-4 h-4 text-orange-600 dark:text-orange-400" />
              <span className="text-sm text-orange-600 dark:text-orange-400">
                Locked by {isOwnLock ? 'you' : order.lockedBy?.userName}
              </span>
            </div>
          )}
        </SheetHeader>

        <Separator />

        <ScrollArea className="flex-1 py-4">
          <div className="space-y-4">
            <div>
              <h3 className="font-semibold mb-3 text-lg">Order Items</h3>
              <div className="space-y-3">
                {order.items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg"
                  >
                    <div className="w-12 h-12 bg-muted rounded-md flex items-center justify-center">
                      <Package className="w-6 h-6 text-muted-foreground" />
                    </div>
                    <div className="flex-1">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-sm text-muted-foreground">
                        Qty: {item.quantity}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-lg">{item.quantity}</p>
                      <p className="text-sm text-muted-foreground">
                        Stock: {item.currentStock}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            <div className="flex items-center justify-between py-2">
              <span className="font-semibold text-lg">Total</span>
              <span className="font-bold text-2xl">${order.total?.toFixed(2) || '0.00'}</span>
            </div>

            {order.notes && (
              <>
                <Separator />
                <div>
                  <h3 className="font-semibold mb-2">Notes</h3>
                  <p className="text-sm text-muted-foreground">{order.notes}</p>
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        <SheetFooter className="gap-2 sm:gap-2">
          {order.status !== 'completed' && (
            <>
              <Button
                variant="outline"
                size="lg"
                onClick={() => {
                  triggerHaptic();
                  handleLockToggle();
                }}
                disabled={isProcessing || (isLocked && !isOwnLock)}
                className="flex-1 h-12"
              >
                {isOwnLock ? (
                  <>
                    <Unlock className="w-4 h-4 mr-2" />
                    Unlock Order
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 mr-2" />
                    Lock Order
                  </>
                )}
              </Button>
              
              <Button
                size="lg"
                onClick={() => {
                  triggerHaptic();
                  handleComplete();
                }}
                disabled={isProcessing || !canProcess || !isOwnLock}
                className="flex-1 h-12"
              >
                <Check className="w-4 h-4 mr-2" />
                Complete Order
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}