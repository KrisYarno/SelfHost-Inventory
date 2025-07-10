"use client";

import { useState, useRef, TouchEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import { Package, Clock, Lock, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Order } from "@/types/orders";

interface OrderCardProps {
  order: Order;
  onSelect: (order: Order) => void;
  onSwipe?: (order: Order) => void;
  className?: string;
}

export function OrderCard({ order, onSelect, onSwipe, className }: OrderCardProps) {
  const [isSwipedLeft, setIsSwipedLeft] = useState(false);
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);
  
  // Minimum swipe distance
  const minSwipeDistance = 50;
  
  const onTouchStart = (e: TouchEvent) => {
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };
  
  const onTouchMove = (e: TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };
  
  const onTouchEnd = () => {
    if (!touchStart || !touchEnd) return;
    
    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;
    
    if (isLeftSwipe) {
      setIsSwipedLeft(true);
      if (onSwipe) {
        onSwipe(order);
      }
      // Reset after animation
      setTimeout(() => setIsSwipedLeft(false), 300);
    }
  };

  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const timeElapsed = formatDistanceToNow(new Date(order.createdAt), { addSuffix: true });
  const isLocked = !!order.lockedBy;
  const isOwnLock = order.lockedBy?.userId === 'current-user-id'; // Replace with actual user ID

  // Status colors
  const statusColors = {
    pending: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
    in_progress: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    completed: 'bg-green-500/10 text-green-700 dark:text-green-400',
    cancelled: 'bg-red-500/10 text-red-700 dark:text-red-400',
  };

  return (
    <div 
      className={cn("relative", className)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <Card
        className={cn(
          "relative overflow-hidden transition-all duration-300",
          "hover:shadow-md hover:-translate-y-0.5",
          "active:scale-[0.98]",
          isSwipedLeft && "translate-x-[-50px]",
          isLocked && !isOwnLock && "opacity-60"
        )}
      >
        <Button
          variant="ghost"
          className="w-full p-0 h-auto justify-start"
          onClick={() => onSelect(order)}
          disabled={isLocked && !isOwnLock}
        >
          <div className="flex items-center gap-4 p-4 w-full">
            {/* Order Number - Large and prominent */}
            <div className="flex-shrink-0">
              <div className="text-2xl font-bold text-foreground">
                {order.orderNumber.split('-').pop()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {timeElapsed}
              </div>
            </div>

            {/* Order Details */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <Badge 
                  variant="secondary" 
                  className={cn("text-xs", statusColors[order.status])}
                >
                  {order.status.replace('_', ' ')}
                </Badge>
                
                {isLocked && (
                  <Badge variant="outline" className="text-xs">
                    <Lock className="w-3 h-3 mr-1" />
                    {isOwnLock ? 'You' : order.lockedBy.userName}
                  </Badge>
                )}
              </div>
              
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1">
                  <Package className="w-4 h-4 text-muted-foreground" />
                  <span className="font-medium">{itemCount}</span>
                  <span className="text-muted-foreground">items</span>
                </div>
                
                <div className="font-medium">
                  ${order.total.toFixed(2)}
                </div>
              </div>
            </div>

            {/* Action indicator */}
            <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
          </div>
        </Button>

        {/* Lock indicator bar */}
        {isLocked && (
          <div className={cn(
            "absolute left-0 top-0 bottom-0 w-1",
            isOwnLock ? "bg-primary" : "bg-orange-500"
          )} />
        )}
      </Card>

      {/* Swipe action indicator */}
      {isSwipedLeft && (
        <div className="absolute right-4 top-1/2 -translate-y-1/2 text-primary">
          <Package className="w-6 h-6" />
        </div>
      )}
    </div>
  );
}