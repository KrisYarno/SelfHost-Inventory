"use client";

import { Package, TrendingUp, TrendingDown, Eye } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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
    <Card className="mb-6 border-primary/50 bg-primary/5" role="region" aria-label="Changes summary">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <span className="font-medium" role="status" aria-label="{adjustmentCount} products have adjustments">
                {adjustmentCount} products
              </span>
            </div>

            <div className="h-8 w-px bg-border" role="separator" aria-orientation="vertical" />

            <div className="flex items-center gap-4">
              {totalChanges.additions > 0 && (
                <div className="flex items-center gap-2" role="status">
                  <TrendingUp className="h-4 w-4 text-green-600" aria-hidden="true" />
                  <span className="text-sm font-medium text-green-600" aria-label="{totalChanges.additions} units will be added">
                    +{totalChanges.additions}
                  </span>
                </div>
              )}
              
              {totalChanges.removals > 0 && (
                <div className="flex items-center gap-2" role="status">
                  <TrendingDown className="h-4 w-4 text-red-600" aria-hidden="true" />
                  <span className="text-sm font-medium text-red-600" aria-label="{totalChanges.removals} units will be removed">
                    -{totalChanges.removals}
                  </span>
                </div>
              )}

              <Badge 
                variant="outline" 
                className="font-mono"
                role="status"
                aria-label={`Net change: ${totalChanges.total > 0 ? "+" : ""}${totalChanges.total} units`}
              >
                Net: {totalChanges.total > 0 ? "+" : ""}{totalChanges.total}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-2">
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