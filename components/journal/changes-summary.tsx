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
    <Card className="mb-6 border-primary/50 bg-primary/5">
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Package className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium">{adjustmentCount} products</span>
            </div>

            <div className="h-8 w-px bg-border" />

            <div className="flex items-center gap-4">
              {totalChanges.additions > 0 && (
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-medium text-green-600">
                    +{totalChanges.additions}
                  </span>
                </div>
              )}
              
              {totalChanges.removals > 0 && (
                <div className="flex items-center gap-2">
                  <TrendingDown className="h-4 w-4 text-red-600" />
                  <span className="text-sm font-medium text-red-600">
                    -{totalChanges.removals}
                  </span>
                </div>
              )}

              <Badge variant="outline" className="font-mono">
                Net: {totalChanges.total > 0 ? "+" : ""}{totalChanges.total}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear All
            </Button>
            <Button size="sm" onClick={onReview} className="gap-2">
              <Eye className="h-4 w-4" />
              Review Changes
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}