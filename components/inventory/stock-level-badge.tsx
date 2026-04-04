'use client';

import React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface StockLevelBadgeProps {
  quantity: number;
  threshold?: number;
  className?: string;
  showQuantity?: boolean;
}

export function StockLevelBadge({
  quantity,
  threshold = 0,
  className,
  showQuantity = true,
}: StockLevelBadgeProps) {
  const isOut = quantity <= 0;
  const isLow = !isOut && threshold > 0 && quantity <= threshold;

  let label = 'In Stock';
  let variant: 'default' | 'secondary' | 'destructive' = 'default';
  let styles = 'bg-positive-muted text-positive-foreground border border-positive-border';

  if (isOut) {
    label = 'Out of Stock';
    variant = 'destructive';
    styles = 'bg-negative-muted text-negative-foreground border border-negative-border';
  } else if (isLow) {
    label = 'Below Minimum';
    variant = 'secondary';
    styles = 'bg-warning-muted text-warning-foreground border border-warning-border';
  }

  return (
    <Badge variant={variant} className={cn(styles, className)}>
      {showQuantity ? `${quantity} units` : label}
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
              ? 'bg-negative'
              : isLowStock
              ? 'bg-warning'
              : 'bg-positive'
          )}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
