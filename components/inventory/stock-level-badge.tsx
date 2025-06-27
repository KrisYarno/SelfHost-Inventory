'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface StockLevelBadgeProps {
  quantity: number;
  lowStockThreshold?: number;
  outOfStockThreshold?: number;
  className?: string;
  showQuantity?: boolean;
}

export function StockLevelBadge({
  quantity,
  lowStockThreshold = 10,
  outOfStockThreshold = 0,
  className,
  showQuantity = true,
}: StockLevelBadgeProps) {
  const getStockStatus = () => {
    if (quantity <= outOfStockThreshold) {
      return {
        label: 'Out of Stock',
        variant: 'destructive' as const,
        className: 'bg-red-500 hover:bg-red-600',
      };
    } else if (quantity <= lowStockThreshold) {
      return {
        label: 'Low Stock',
        variant: 'secondary' as const,
        className: 'bg-orange-500 hover:bg-orange-600 text-white',
      };
    } else {
      return {
        label: 'In Stock',
        variant: 'default' as const,
        className: 'bg-green-500 hover:bg-green-600',
      };
    }
  };

  const status = getStockStatus();

  return (
    <Badge 
      variant={status.variant}
      className={cn(status.className, className)}
    >
      {showQuantity ? `${quantity} units` : status.label}
    </Badge>
  );
}

interface StockLevelIndicatorProps {
  quantity: number;
  maxQuantity?: number;
  lowStockThreshold?: number;
  className?: string;
}

export function StockLevelIndicator({
  quantity,
  maxQuantity = 100,
  lowStockThreshold = 10,
  className,
}: StockLevelIndicatorProps) {
  const percentage = Math.min((quantity / maxQuantity) * 100, 100);
  const isLowStock = quantity <= lowStockThreshold;
  const isOutOfStock = quantity <= 0;

  return (
    <div className={cn('space-y-1', className)}>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{quantity} units</span>
        <span className="text-muted-foreground">{percentage.toFixed(0)}%</span>
      </div>
      <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full transition-all duration-300',
            isOutOfStock 
              ? 'bg-red-500' 
              : isLowStock 
              ? 'bg-orange-500' 
              : 'bg-green-500'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}