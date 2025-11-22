"use client";

import { Package, TrendingUp, TrendingDown, Eye } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ValueChip } from "@/components/ui/value-chip";

interface ChangesSummaryProps {
  totalChanges: {
    additions: number;
    removals: number;
    total: number;
  };
  adjustmentCount: number;
  onReview: () => void;
  onClear: () => void;
}

export function ChangesSummary({
  totalChanges,
  adjustmentCount,
  onReview,
  onClear,
}: ChangesSummaryProps) {
  return (
    <Card className="mb-6 border-primary/30 bg-primary/5 rounded-lg shadow-sm sticky top-0 z-10 sm:static sm:shadow-none" role="region" aria-label="Changes summary">
      <CardContent className="pt-4 sm:pt-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium" role="status" aria-label="{adjustmentCount} products have adjustments">
                {adjustmentCount} products
              </span>
            </div>

            <div className="h-6 w-px bg-border hidden sm:block" role="separator" aria-orientation="vertical" />

            <div className="flex items-center gap-4">
              {totalChanges.additions > 0 && (
                <ValueChip
                  tone="positive"
                  role="status"
                  aria-label={`${totalChanges.additions} units will be added`}
                  className="gap-1"
                >
                  <TrendingUp className="h-3 w-3" aria-hidden="true" />
                  +{totalChanges.additions}
                </ValueChip>
              )}
              
              {totalChanges.removals > 0 && (
                <ValueChip
                  tone="negative"
                  role="status"
                  aria-label={`${totalChanges.removals} units will be removed`}
                  className="gap-1"
                >
                  <TrendingDown className="h-3 w-3" aria-hidden="true" />
                  -{totalChanges.removals}
                </ValueChip>
              )}

              <ValueChip
                tone={
                  totalChanges.total > 0
                    ? "positive"
                    : totalChanges.total < 0
                    ? "negative"
                    : "neutral"
                }
                role="status"
                aria-label={`Net change: ${totalChanges.total > 0 ? "+" : ""}${totalChanges.total} units`}
              >
                Net: {totalChanges.total > 0 ? "+" : ""}{totalChanges.total}
              </ValueChip>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:ml-auto">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={onClear}
              aria-label="Clear all adjustments"
            >
              Clear All
            </Button>
            <Button 
              size="sm" 
              onClick={onReview} 
              className="gap-2"
              aria-label="Review all changes before submitting"
            >
              <Eye className="h-4 w-4" aria-hidden="true" />
              Review Changes
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
