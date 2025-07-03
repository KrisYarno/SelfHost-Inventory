'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StockLevelBadge, StockLevelIndicator } from '@/components/inventory/stock-level-badge';
import { ChevronDown, ChevronUp, Plus, TrendingUp, MapPin } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CurrentInventoryLevel } from '@/types/inventory';

interface GroupedProductCardProps {
  productGroup: CurrentInventoryLevel[];
  onStockIn: (product: CurrentInventoryLevel) => void;
  onAdjust: (product: CurrentInventoryLevel) => void;
}

export function GroupedProductCard({ 
  productGroup, 
  onStockIn, 
  onAdjust 
}: GroupedProductCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  
  // Calculate aggregated data
  const aggregatedData = useMemo(() => {
    const baseName = productGroup[0]?.product.baseName || productGroup[0]?.product.name;
    const totalQuantity = productGroup.reduce((sum, item) => sum + item.quantity, 0);
    const lowStockThreshold = productGroup[0]?.product.lowStockThreshold || 10;
    
    // Sort locations by quantity (highest first)
    const sortedLocations = [...productGroup].sort((a, b) => b.quantity - a.quantity);
    
    // Check if there are different variants
    const variants = new Set(productGroup.map(item => item.product.variant).filter(Boolean));
    const hasVariants = variants.size > 0;
    
    return {
      baseName,
      totalQuantity,
      lowStockThreshold,
      locations: sortedLocations,
      productId: productGroup[0]?.productId,
      hasVariants,
      variantCount: variants.size
    };
  }, [productGroup]);

  if (productGroup.length === 0) return null;

  const firstProduct = productGroup[0];

  return (
    <Card className="group overflow-hidden hover:shadow-md transition-shadow">
      <CardContent className="p-0">
        {/* Main Product Section */}
        <div className="p-4 sm:p-6 space-y-3 sm:space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1 flex-1 min-w-0">
              <h3 className="font-semibold text-base sm:text-lg truncate">{aggregatedData.baseName}</h3>
              <p className="text-xs sm:text-sm text-muted-foreground">
                {productGroup.length > 1 
                  ? `${productGroup.length} locations` 
                  : productGroup[0].location.name
                }
                {aggregatedData.hasVariants && 
                  ` • ${aggregatedData.variantCount} variant${aggregatedData.variantCount > 1 ? 's' : ''}`
                }
              </p>
            </div>
            
            {/* Total Quantity Display */}
            <div className="text-right space-y-1">
              <p className="text-2xl sm:text-3xl font-bold">{aggregatedData.totalQuantity}</p>
              <p className="text-xs text-muted-foreground">Total Units</p>
            </div>
          </div>

          {/* Stock Status Indicators */}
          <div className="space-y-2 sm:space-y-3">
            <div className="flex items-center gap-2">
              <StockLevelBadge 
                quantity={aggregatedData.totalQuantity} 
                lowStockThreshold={aggregatedData.lowStockThreshold}
                showQuantity={false}
              />
              {productGroup.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="gap-1 h-7 px-2 text-xs touch-manipulation"
                >
                  <MapPin className="h-3 w-3" />
                  <span className="hidden sm:inline">{isExpanded ? 'Hide' : 'Show'} Locations</span>
                  <span className="sm:hidden">{productGroup.length}</span>
                  {isExpanded ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </Button>
              )}
            </div>
            
            <StockLevelIndicator 
              quantity={aggregatedData.totalQuantity}
              maxQuantity={aggregatedData.lowStockThreshold * 10}
              lowStockThreshold={aggregatedData.lowStockThreshold}
            />
          </div>

          {/* Quick Actions - Always visible on mobile, hover on desktop */}
          <div className="flex gap-2 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onStockIn(firstProduct)}
              className="flex-1 gap-1 touch-manipulation min-h-[44px] sm:min-h-[36px]"
            >
              <Plus className="h-3 w-3" />
              <span className="hidden sm:inline">Stock In</span>
              <span className="sm:hidden">Add</span>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAdjust(firstProduct)}
              className="flex-1 gap-1 touch-manipulation min-h-[44px] sm:min-h-[36px]"
            >
              <TrendingUp className="h-3 w-3" />
              Adjust
            </Button>
          </div>
        </div>

        {/* Expandable Location Details */}
        {productGroup.length > 1 && (
          <div
            className={cn(
              "border-t bg-muted/30 overflow-hidden transition-all duration-300 ease-in-out",
              isExpanded ? "max-h-[400px]" : "max-h-0"
            )}
          >
            <div className="p-3 sm:p-4 space-y-2">
              <p className="text-xs sm:text-sm font-medium text-muted-foreground mb-2 sm:mb-3">
                Location Breakdown
              </p>
              <div className="space-y-2">
                {aggregatedData.locations.map((item) => (
                  <div 
                    key={`${item.productId}-${item.locationId}`}
                    className="flex items-center justify-between p-2 sm:p-3 rounded-md bg-background"
                  >
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                      <MapPin className="h-3 sm:h-4 w-3 sm:w-4 text-muted-foreground flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{item.location.name}</p>
                        {item.product.variant && (
                          <p className="text-xs text-muted-foreground truncate">
                            {item.product.variant}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3">
                      <StockLevelBadge 
                        quantity={item.quantity} 
                        lowStockThreshold={item.product.lowStockThreshold || 10}
                        showQuantity={false}
                        className="h-5 sm:h-6"
                      />
                      <span className="text-base sm:text-lg font-semibold min-w-[2.5rem] text-right">
                        {item.quantity}
                      </span>
                      <div className="flex gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onStockIn(item)}
                          className="h-8 w-8 sm:h-7 sm:w-7 p-0 touch-manipulation"
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onAdjust(item)}
                          className="h-8 w-8 sm:h-7 sm:w-7 p-0 touch-manipulation"
                        >
                          <TrendingUp className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}