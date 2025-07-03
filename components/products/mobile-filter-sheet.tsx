"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet";
import { Filter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export type StockFilter = "all" | "in-stock" | "low-stock" | "out-of-stock";

interface MobileFilterSheetProps {
  stockFilter: StockFilter;
  onStockFilterChange: (filter: StockFilter) => void;
  onClearFilters: () => void;
  activeFilterCount?: number;
}

export function MobileFilterSheet({
  stockFilter,
  onStockFilterChange,
  onClearFilters,
  activeFilterCount = 0,
}: MobileFilterSheetProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="relative">
          <Filter className="h-4 w-4 mr-2" />
          Filter
          {activeFilterCount > 0 && (
            <Badge
              variant="secondary"
              className="absolute -top-2 -right-2 h-5 w-5 p-0 flex items-center justify-center text-[10px]"
            >
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-auto max-h-[80vh]">
        <SheetHeader>
          <SheetTitle>Filter Products</SheetTitle>
          <SheetDescription>
            Refine your product search with filters
          </SheetDescription>
        </SheetHeader>

        <div className="py-6 space-y-6">
          {/* Stock Status Filter */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Stock Status</Label>
            <RadioGroup
              value={stockFilter}
              onValueChange={(value) => onStockFilterChange(value as StockFilter)}
            >
              <div className="flex items-center space-x-2 py-2">
                <RadioGroupItem value="all" id="all" />
                <Label
                  htmlFor="all"
                  className="flex-1 cursor-pointer font-normal"
                >
                  All Products
                </Label>
              </div>
              <div className="flex items-center space-x-2 py-2">
                <RadioGroupItem value="in-stock" id="in-stock" />
                <Label
                  htmlFor="in-stock"
                  className="flex-1 cursor-pointer font-normal"
                >
                  In Stock Only
                  <span className="text-xs text-muted-foreground ml-2">
                    (Qty &gt; 0)
                  </span>
                </Label>
              </div>
              <div className="flex items-center space-x-2 py-2">
                <RadioGroupItem value="low-stock" id="low-stock" />
                <Label
                  htmlFor="low-stock"
                  className="flex-1 cursor-pointer font-normal"
                >
                  Low Stock
                  <span className="text-xs text-muted-foreground ml-2">
                    (Qty ≤ 10)
                  </span>
                </Label>
              </div>
              <div className="flex items-center space-x-2 py-2">
                <RadioGroupItem value="out-of-stock" id="out-of-stock" />
                <Label
                  htmlFor="out-of-stock"
                  className="flex-1 cursor-pointer font-normal"
                >
                  Out of Stock
                  <span className="text-xs text-muted-foreground ml-2">
                    (Qty = 0)
                  </span>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* Quick Filter Segmented Control */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Quick Filters</Label>
            <div className="flex rounded-lg border border-border p-1">
              <Button
                variant={stockFilter === "all" ? "default" : "ghost"}
                size="sm"
                className="flex-1 h-8"
                onClick={() => onStockFilterChange("all")}
              >
                All
              </Button>
              <Button
                variant={stockFilter === "in-stock" ? "default" : "ghost"}
                size="sm"
                className="flex-1 h-8"
                onClick={() => onStockFilterChange("in-stock")}
              >
                In Stock
              </Button>
              <Button
                variant={stockFilter === "low-stock" ? "default" : "ghost"}
                size="sm"
                className="flex-1 h-8"
                onClick={() => onStockFilterChange("low-stock")}
              >
                Low
              </Button>
              <Button
                variant={stockFilter === "out-of-stock" ? "default" : "ghost"}
                size="sm"
                className="flex-1 h-8"
                onClick={() => onStockFilterChange("out-of-stock")}
              >
                Out
              </Button>
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row gap-2">
          <SheetClose asChild>
            <Button variant="outline" className="flex-1">
              Close
            </Button>
          </SheetClose>
          <Button
            variant="secondary"
            className="flex-1"
            onClick={onClearFilters}
          >
            <X className="h-4 w-4 mr-2" />
            Clear All
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}