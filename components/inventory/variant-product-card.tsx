'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ValueChip } from '@/components/ui/value-chip';
import { StatusBadge } from '@/components/ui/status-badge';
import { 
  Plus, 
  Edit, 
  MapPin, 
  ChevronDown, 
  ChevronUp,
  ArrowLeftRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface LocationQuantity {
  locationId: number;
  locationName: string;
  quantity: number;
  minQuantity: number;
}

interface VariantProductCardProps {
  product: {
    id: number;
    name: string;
    baseName: string;
    variant: string | null;
    locations: LocationQuantity[];
    totalQuantity: number;
    combinedMinimum: number;
  };
  onStockIn: (productId: number, locationId?: number) => void;
  onAdjust: (productId: number, locationId?: number) => void;
  onTransfer?: (productId: number, locationId?: number) => void;
}

export function VariantProductCard({ product, onStockIn, onAdjust, onTransfer }: VariantProductCardProps) {
  const [isExpanded, setIsExpanded] = useState(false); // Default to collapsed

  const totalBelowMinimum =
    product.combinedMinimum > 0 &&
    product.totalQuantity < product.combinedMinimum;

  return (
    <Card className="overflow-hidden group">
      <div className="p-4 md:p-6 space-y-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1">
            <h3 className="font-semibold text-base md:text-lg">
              {product.baseName}
              {product.variant && (
                <span className="font-semibold ml-2">
                  ({product.variant})
                </span>
              )}
            </h3>
          </div>
          <div className="flex flex-col items-end gap-1 text-right">
            {(product.totalQuantity <= 0 || totalBelowMinimum) && (
              <StatusBadge
                tone={product.totalQuantity <= 0 ? 'negative' : 'warning'}
                className="self-end"
              >
                {product.totalQuantity <= 0 ? 'Out' : 'Below min'}
              </StatusBadge>
            )}
            <ValueChip
              tone={
                product.totalQuantity > 0
                  ? 'positive'
                  : product.totalQuantity < 0
                  ? 'negative'
                  : 'neutral'
              }
            >
              {product.totalQuantity} units
            </ValueChip>
          </div>
        </div>

        {/* Quick actions - always visible on mobile, hover on desktop */}
        <div className="flex gap-2 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <Button
            size="sm"
            variant="outline"
            className="flex-1 h-11 min-h-[44px]"
            onClick={() => onStockIn(product.id)}
          >
            <Plus className="h-4 w-4 mr-1" />
            Stock In
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 h-11 min-h-[44px]"
            onClick={() => onAdjust(product.id)}
          >
            <Edit className="h-4 w-4 mr-1" />
            Adjust
          </Button>
          {onTransfer && (
            <Button
              size="sm"
              variant="outline"
              className="flex-1 h-11 min-h-[44px]"
              onClick={() => onTransfer(product.id)}
            >
              <ArrowLeftRight className="h-4 w-4 mr-1" />
              Transfer
            </Button>
          )}
        </div>

        {/* Location breakdown */}
        <div className="mt-4 border-t pt-4">
          <button
            className="flex items-center justify-between w-full text-sm font-medium hover:text-foreground transition-colors mb-3"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            <span className="flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              Location Breakdown ({product.locations.length} locations)
            </span>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          <div
            className={cn(
              "overflow-hidden transition-all duration-200",
              isExpanded ? "max-h-96" : "max-h-0"
            )}
          >
            <div className="space-y-2">
              {product.locations.length > 0 ? (
                product.locations
                  .slice()
                  .sort((a, b) => b.quantity - a.quantity)
                  .map((location) => {
                    const isBelowLocation =
                      location.minQuantity > 0 &&
                      location.quantity < location.minQuantity;
                    return (
                      <div
                        key={location.locationId}
                        className={cn(
                          'flex items-center justify-between rounded-lg border px-3 py-2',
                          isBelowLocation
                            ? 'border-amber-500/50 bg-amber-500/10'
                            : location.quantity > 0
                            ? 'border-emerald-500/30 bg-emerald-500/5'
                            : location.quantity < 0
                            ? 'border-red-500/40 bg-red-500/10'
                            : 'border-border bg-muted/30'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <span className="text-sm font-medium">
                              {location.locationName}
                            </span>
                            {location.minQuantity > 0 && (
                              <p className="text-xs text-muted-foreground">
                                Min {location.minQuantity} units
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <ValueChip
                            tone={
                              isBelowLocation
                                ? 'negative'
                                : location.quantity > 0
                                ? 'positive'
                                : 'neutral'
                            }
                          >
                            {location.quantity} units
                          </ValueChip>
                          {isBelowLocation && (
                            <StatusBadge tone="warning">Below min</StatusBadge>
                          )}
                        </div>
                      </div>
                    );
                  })
              ) : (
                <div className="text-center py-4 text-sm text-muted-foreground">
                  No location data available
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </Card>
  );
}
