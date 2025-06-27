"use client";

import { useState } from "react";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface JournalFilters {
  showActive: boolean;
  showInactive: boolean;
  showWithChanges: boolean;
  showWithoutChanges: boolean;
  stockLevel: "all" | "low" | "out" | "normal";
  sortBy: "name" | "quantity" | "changes";
}

interface JournalFiltersProps {
  onFilterChange: (filters: JournalFilters) => void;
}

export function JournalFilters({ onFilterChange }: JournalFiltersProps) {
  const [filters, setFilters] = useState<JournalFilters>({
    showActive: true,
    showInactive: false,
    showWithChanges: true,
    showWithoutChanges: true,
    stockLevel: "all",
    sortBy: "name",
  });

  const handleFilterChange = (updates: Partial<JournalFilters>) => {
    const newFilters = { ...filters, ...updates };
    setFilters(newFilters);
    onFilterChange(newFilters);
  };

  const activeFilterCount = [
    !filters.showActive && "inactive hidden",
    filters.showInactive && "inactive shown",
    !filters.showWithoutChanges && "unchanged hidden",
    filters.stockLevel !== "all" && `stock: ${filters.stockLevel}`,
    filters.sortBy !== "name" && `sort: ${filters.sortBy}`,
  ].filter(Boolean).length;

  const resetFilters = () => {
    const defaultFilters: JournalFilters = {
      showActive: true,
      showInactive: false,
      showWithChanges: true,
      showWithoutChanges: true,
      stockLevel: "all",
      sortBy: "name",
    };
    setFilters(defaultFilters);
    onFilterChange(defaultFilters);
  };

  return (
    <div className="space-y-4">
      {activeFilterCount > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {activeFilterCount} filter{activeFilterCount !== 1 ? "s" : ""} active
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="gap-1"
          >
            <X className="h-3 w-3" />
            Reset
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Product Status */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Product Status</Label>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="active"
                checked={filters.showActive}
                onCheckedChange={(checked) =>
                  handleFilterChange({ showActive: !!checked })
                }
              />
              <label
                htmlFor="active"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Active Products
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="inactive"
                checked={filters.showInactive}
                onCheckedChange={(checked) =>
                  handleFilterChange({ showInactive: !!checked })
                }
              />
              <label
                htmlFor="inactive"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Inactive Products
              </label>
            </div>
          </div>
        </div>

        {/* Change Status */}
        <div className="space-y-2">
          <Label className="text-sm font-medium">Change Status</Label>
          <div className="space-y-2">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="with-changes"
                checked={filters.showWithChanges}
                onCheckedChange={(checked) =>
                  handleFilterChange({ showWithChanges: !!checked })
                }
              />
              <label
                htmlFor="with-changes"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                With Changes
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="without-changes"
                checked={filters.showWithoutChanges}
                onCheckedChange={(checked) =>
                  handleFilterChange({ showWithoutChanges: !!checked })
                }
              />
              <label
                htmlFor="without-changes"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Without Changes
              </label>
            </div>
          </div>
        </div>

        {/* Stock Level & Sort */}
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="stock-level" className="text-sm font-medium">
              Stock Level
            </Label>
            <Select
              value={filters.stockLevel}
              onValueChange={(value: JournalFilters["stockLevel"]) =>
                handleFilterChange({ stockLevel: value })
              }
            >
              <SelectTrigger id="stock-level">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Levels</SelectItem>
                <SelectItem value="low">Low Stock</SelectItem>
                <SelectItem value="out">Out of Stock</SelectItem>
                <SelectItem value="normal">Normal Stock</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sort-by" className="text-sm font-medium">
              Sort By
            </Label>
            <Select
              value={filters.sortBy}
              onValueChange={(value: JournalFilters["sortBy"]) =>
                handleFilterChange({ sortBy: value })
              }
            >
              <SelectTrigger id="sort-by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Product Name</SelectItem>
                <SelectItem value="quantity">Current Quantity</SelectItem>
                <SelectItem value="changes">Change Amount</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}