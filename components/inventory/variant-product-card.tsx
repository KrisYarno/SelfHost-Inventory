'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StockLevelBadge } from '@/components/inventory/stock-level-badge';
import { 
  Package, 
  Plus, 
  Edit, 
  MapPin, 
  ChevronDown, 
  ChevronUp 
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface LocationQuantity {
  locationId: number;
  locationName: string;
  quantity: number;
}

interface VariantProductCardProps {
  product: {
    id: number;
    name: string;
    baseName: string;
    variant: string | null;
    locations: LocationQuantity[];
    totalQuantity: number;
  };
  onStockIn: (productId: number, locationId?: number) => void;
  onAdjust: (productId: number, locationId?: number) => void;
}

export function VariantProductCard({ product, onStockIn, onAdjust }: VariantProductCardProps) {
  const [isExpanded, setIsExpanded] = useState(false); // Default to collapsed

  return (
    <Card className="overflow-hidden group">
      <div className="p-4 md:p-6">
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
          <div className="text-right">
            <div className="text-2xl font-bold">{product.totalQuantity}</div>
            <StockLevelBadge quantity={product.totalQuantity} />
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
                  .sort((a, b) => b.quantity - a.quantity) // Sort by quantity descending
                  .map((location) => (
                  <div
                    key={location.locationId}
                    className="flex items-center justify-between p-3 bg-muted/30 rounded-lg"
                  >
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <span className="text-sm font-medium">{location.locationName}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-lg">{location.quantity}</span>
                      <span className="text-sm text-muted-foreground">units</span>
                      {location.quantity === 0 && (
                        <Badge variant="outline" className="text-orange-600 border-orange-600 ml-2">
                          Out
                        </Badge>
                      )}
                    </div>
                  </div>
                ))
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