"use client";

import { formatDistanceToNow } from "date-fns";
import { Package, ChevronRight, User, Mail, DollarSign } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlatformBadge } from "@/components/orders/platform-badge";
import { cn } from "@/lib/utils";
import type { ExternalOrder, InternalOrderStatus } from "@/types/external-orders";
import { STATUS_COLORS } from "@/types/external-orders";

interface ExternalOrderCardProps {
  order: ExternalOrder;
  onSelect: (order: ExternalOrder) => void;
  className?: string;
}

export function ExternalOrderCard({ order, onSelect, className }: ExternalOrderCardProps) {
  const itemCount = order.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
  const timeElapsed = formatDistanceToNow(new Date(order.externalCreatedAt || order.createdAt), {
    addSuffix: true,
  });

  // Calculate fulfillment progress
  const totalItems = order.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
  const fulfilledItems = order.items?.reduce((sum, item) => sum + item.fulfilledQty, 0) || 0;
  const fulfillmentPercent = totalItems > 0 ? Math.round((fulfilledItems / totalItems) * 100) : 0;

  // Status badge styling
  const statusColors = STATUS_COLORS;
  const statusColor = statusColors[order.internalStatus as InternalOrderStatus];

  return (
    <Card
      className={cn(
        "relative overflow-hidden transition-all duration-200",
        "hover:shadow-md hover:-translate-y-0.5",
        "active:scale-[0.98]",
        className
      )}
    >
      <Button
        variant="ghost"
        className="w-full p-0 h-auto justify-start"
        onClick={() => onSelect(order)}
      >
        <div className="flex items-start gap-4 p-4 w-full">
          {/* Order Number Section */}
          <div className="flex-shrink-0">
            <div className="text-xl sm:text-2xl font-bold text-foreground">
              #{order.orderNumber}
            </div>
            <div className="text-xs text-muted-foreground mt-1">{timeElapsed}</div>
          </div>

          {/* Order Details Section */}
          <div className="flex-1 min-w-0 space-y-2">
            {/* Platform and Status Badges */}
            <div className="flex items-center gap-2 flex-wrap">
              {order.integration && (
                <PlatformBadge platform={order.integration.platform} size="sm" />
              )}
              <Badge variant="outline" className={cn("text-xs border", statusColor)}>
                {order.internalStatus.charAt(0).toUpperCase() + order.internalStatus.slice(1)}
              </Badge>
              {fulfillmentPercent > 0 && fulfillmentPercent < 100 && (
                <Badge variant="secondary" className="text-xs">
                  {fulfillmentPercent}% Fulfilled
                </Badge>
              )}
            </div>

            {/* Customer Info */}
            {(order.customerName || order.customerEmail) && (
              <div className="space-y-1">
                {order.customerName && (
                  <div className="flex items-center gap-1.5 text-sm">
                    <User className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="truncate font-medium">{order.customerName}</span>
                  </div>
                )}
                {order.customerEmail && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Mail className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate">{order.customerEmail}</span>
                  </div>
                )}
              </div>
            )}

            {/* Items and Total */}
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-1">
                <Package className="w-4 h-4 text-muted-foreground" />
                <span className="font-medium">{itemCount}</span>
                <span className="text-muted-foreground">
                  {itemCount === 1 ? "item" : "items"}
                </span>
              </div>

              <div className="flex items-center gap-1 font-semibold">
                <DollarSign className="w-4 h-4 text-muted-foreground" />
                <span>{order.total.toFixed(2)}</span>
                <span className="text-xs text-muted-foreground font-normal">
                  {order.currency}
                </span>
              </div>
            </div>

            {/* Store name (if available) */}
            {order.integration && (
              <div className="text-xs text-muted-foreground truncate">
                {order.integration.name}
              </div>
            )}
          </div>

          {/* Action Indicator */}
          <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0 self-center" />
        </div>
      </Button>

      {/* Status indicator bar on left */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1",
          order.internalStatus === "pending" && "bg-yellow-500",
          order.internalStatus === "processing" && "bg-blue-500",
          order.internalStatus === "fulfilled" && "bg-green-500",
          order.internalStatus === "cancelled" && "bg-gray-400"
        )}
      />
    </Card>
  );
}
