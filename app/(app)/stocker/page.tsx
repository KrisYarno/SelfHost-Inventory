"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download, Search, X, Printer, CheckCircle2, ChevronDown, ChevronRight, ArrowRightLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { exportToCSV } from "@/lib/export-utils";
import { useLocation } from "@/contexts/location-context";
import { PageHeader } from "@/components/layout/page-header";
import {
  StockInTransferDialog,
  type StockInProduct,
} from "@/components/inventory/stock-in-transfer-dialog";
import type { ProductLocationQuantity } from "@/types/inventory";

interface StockerItem {
  productId: number;
  productName: string;
  baseName?: string | null;
  unit?: string | null;
  numericValue?: number | null;
  currentQuantity: number;
  minQuantity: number;
  shortage: number;
}

interface StockerLocation {
  id: number;
  name: string;
}

interface StockerResponse {
  location: StockerLocation;
  items: StockerItem[];
}

function parseProductName(name: string): { base: string; size: number | null } {
  const trimmed = name.trim();
  // Match patterns like "Tirz 5mg", "AOD (2mg)", "B-12 10 mL"
  const match = trimmed.match(/^(.*?)(\d+(?:\.\d+)?)\s*(mg|ml|mL|mcg|g|units?)?\)?$/i);
  if (!match) {
    return { base: trimmed.toLowerCase(), size: null };
  }
  const base = match[1].trim().toLowerCase();
  const size = Number.parseFloat(match[2]);
  if (Number.isNaN(size)) {
    return { base, size: null };
  }
  return { base, size };
}

function getSortFields(item: StockerItem): { base: string; size: number | null } {
  const base =
    (item.baseName && item.baseName.trim().toLowerCase()) || item.productName.trim().toLowerCase();

  let size: number | null = null;
  if (item.numericValue != null) {
    const numeric = Number(item.numericValue);
    if (!Number.isNaN(numeric)) {
      size = numeric;
    }
  }

  if (size === null) {
    return parseProductName(item.productName);
  }

  return { base, size };
}

type SortOption = "urgency" | "name" | "units-needed";

interface SurplusLocation {
  locationId: number;
  locationName: string;
  available: number;
  surplus: number; // amount above what that location needs
  version: number;
}

interface TransferSuggestionsProps {
  item: StockerItem;
  destinationLocationId: number;
  onRequestTransfer: (item: StockerItem) => void;
}

function TransferSuggestions({ item, destinationLocationId, onRequestTransfer }: TransferSuggestionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [surplusLocations, setSurplusLocations] = useState<SurplusLocation[]>([]);
  const [hasFetched, setHasFetched] = useState(false);

  const fetchSurplusData = useCallback(async () => {
    if (hasFetched) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/inventory/product/${item.productId}/locations`);
      if (!res.ok) throw new Error("Failed to fetch");
      const data: { locations: ProductLocationQuantity[] } = await res.json();

      // Filter to locations that have stock and are not the current location
      const otherLocations = data.locations
        .filter((loc) => loc.locationId !== destinationLocationId && loc.quantity > 0)
        .map((loc) => ({
          locationId: loc.locationId,
          locationName: loc.locationName,
          available: loc.quantity,
          surplus: loc.quantity, // simplified: all available stock is potential surplus
          version: loc.version,
        }))
        .sort((a, b) => b.available - a.available);

      setSurplusLocations(otherLocations);
      setHasFetched(true);
    } catch (err) {
      console.error("Error fetching surplus data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [item.productId, destinationLocationId, hasFetched]);

  const handleToggle = () => {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen && !hasFetched) {
      fetchSurplusData();
    }
  };

  return (
    <div className="border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <ArrowRightLeft className="h-3 w-3" />
        <span>Transfer from...</span>
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : surplusLocations.length === 0 ? (
            <p className="text-xs text-muted-foreground italic py-1">
              No other locations have this product in stock.
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                {surplusLocations.map((loc) => {
                  const suggestedQty = Math.min(loc.available, item.shortage);
                  return (
                    <div
                      key={loc.locationId}
                      className="flex items-center justify-between rounded-md bg-muted/50 px-2.5 py-1.5 text-xs"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-foreground truncate block">
                          {loc.locationName}
                        </span>
                        <span className="text-muted-foreground">
                          {loc.available} available
                        </span>
                      </div>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0.5 ml-2 shrink-0">
                        can send {suggestedQty}
                      </Badge>
                    </div>
                  );
                })}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full text-xs gap-1.5"
                onClick={() => onRequestTransfer(item)}
              >
                <ArrowRightLeft className="h-3 w-3" />
                Request Transfer
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function StockerPage() {
  const { selectedLocationId, selectedLocation } = useLocation?.() ?? {
    selectedLocationId: undefined,
    selectedLocation: null,
  };
  const [location, setLocation] = useState<StockerLocation | null>(null);
  const [items, setItems] = useState<StockerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sort and filter state
  const [sortBy, setSortBy] = useState<SortOption>("name");
  const [searchQuery, setSearchQuery] = useState("");

  // Stock In dialog state
  const [stockInDialogOpen, setStockInDialogOpen] = useState(false);
  const [stockInProduct, setStockInProduct] = useState<StockInProduct | null>(null);

  // Print ref
  const printRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedLocationId) {
        params.set("locationId", String(selectedLocationId));
      }
      const query = params.toString();
      const url = query ? `/api/stocker/minimums?${query}` : "/api/stocker/minimums";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load stocker data");
      const data: StockerResponse = await res.json();
      setLocation(data.location);
      setItems(data.items ?? []);
    } catch (err) {
      console.error("Error loading stocker data", err);
      setError("Unable to load refill list. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }, [selectedLocationId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStockIn = (item: StockerItem) => {
    setStockInProduct({
      productId: item.productId,
      productName: item.productName,
      quantity: item.currentQuantity,
      minQuantity: item.minQuantity,
      shortage: item.shortage,
    });
    setStockInDialogOpen(true);
  };

  const handleStockInSuccess = () => {
    loadData();
  };

  // Filter items by search query
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.trim().toLowerCase();
    return items.filter((item) => item.productName.toLowerCase().includes(q));
  }, [items, searchQuery]);

  // Sort items based on selected sort option
  const sortedItems = useMemo(() => {
    return filteredItems.slice().sort((a, b) => {
      if (sortBy === "urgency") {
        // Most critical first: lowest fill percentage
        const aFill = a.minQuantity > 0 ? a.currentQuantity / a.minQuantity : 1;
        const bFill = b.minQuantity > 0 ? b.currentQuantity / b.minQuantity : 1;
        if (aFill !== bFill) return aFill - bFill;
        // Tie-break by name
        return a.productName.localeCompare(b.productName, undefined, { sensitivity: "base" });
      }

      if (sortBy === "units-needed") {
        // Most units needed first
        if (a.shortage !== b.shortage) return b.shortage - a.shortage;
        return a.productName.localeCompare(b.productName, undefined, { sensitivity: "base" });
      }

      // Default: sort by name (base name + numeric size)
      const aParsed = getSortFields(a);
      const bParsed = getSortFields(b);

      if (aParsed.base !== bParsed.base) {
        return aParsed.base.localeCompare(bParsed.base, undefined, {
          sensitivity: "base",
        });
      }

      if (aParsed.size !== null && bParsed.size !== null && aParsed.size !== bParsed.size) {
        return aParsed.size - bParsed.size;
      }

      return a.productName.localeCompare(b.productName, undefined, {
        sensitivity: "base",
      });
    });
  }, [filteredItems, sortBy]);

  const handleExportCSV = useCallback(() => {
    if (sortedItems.length === 0) return;
    const locationName = selectedLocation?.name ?? location?.name ?? "all";
    exportToCSV(
      sortedItems,
      [
        { key: "productName", label: "Product" },
        { key: "currentQuantity", label: "Current Stock" },
        { key: "minQuantity", label: "Minimum" },
        { key: "shortage", label: "Units Needed" },
      ],
      `low-stock-${locationName}-${new Date().toISOString().split("T")[0]}.csv`
    );
  }, [sortedItems, selectedLocation?.name, location?.name]);

  const handlePrintPickList = useCallback(() => {
    const escapeHTML = (str: string) =>
      str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const locationName = escapeHTML(selectedLocation?.name ?? location?.name ?? "Unknown");
    const dateStr = new Date().toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });

    const rows = sortedItems
      .map(
        (item) =>
          `<tr>
            <td style="padding:6px 12px;border-bottom:1px solid #ddd;text-align:left">${escapeHTML(item.productName)}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #ddd;text-align:center">${item.currentQuantity}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #ddd;text-align:center">${item.minQuantity}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #ddd;text-align:center;font-weight:600">${item.shortage}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #ddd;width:80px"></td>
          </tr>`
      )
      .join("");

    const totalNeeded = sortedItems.reduce((sum, item) => sum + item.shortage, 0);

    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Pick List - ${locationName}</title>
  <style>
    @media print {
      body { margin: 0; padding: 16px; }
      .no-print { display: none !important; }
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #222; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .meta { font-size: 13px; color: #666; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { padding: 8px 12px; border-bottom: 2px solid #333; text-align: left; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    th:not(:first-child) { text-align: center; }
    .summary { margin-top: 12px; font-size: 13px; color: #666; }
    .btn-print { margin-bottom: 16px; padding: 8px 16px; font-size: 14px; cursor: pointer; background: #222; color: #fff; border: none; border-radius: 6px; }
    .btn-print:hover { background: #444; }
  </style>
</head>
<body>
  <button class="btn-print no-print" onclick="window.print()">Print this page</button>
  <h1>Pick List &mdash; ${locationName}</h1>
  <div class="meta">${dateStr} &bull; ${sortedItems.length} product${sortedItems.length === 1 ? "" : "s"} &bull; ${totalNeeded} unit${totalNeeded === 1 ? "" : "s"} needed</div>
  <table>
    <thead>
      <tr>
        <th>Product</th>
        <th>Stock</th>
        <th>Min</th>
        <th>Need</th>
        <th>Picked</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="summary">Generated from Inventory app on ${dateStr}</div>
</body>
</html>`;

    const printWindow = window.open("", "_blank");
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.focus();
    }
  }, [sortedItems, selectedLocation?.name, location?.name]);

  const totalProducts = filteredItems.length;
  const totalUnitsNeeded = filteredItems.reduce((sum, item) => sum + item.shortage, 0);

  // Distinguish: do we have any items at all (before filtering)?
  const hasAnyItems = items.length > 0;
  // Are the filtered results empty because of the search query?
  const isSearchFiltered = searchQuery.trim().length > 0 && sortedItems.length === 0 && hasAnyItems;

  return (
    <div className="space-y-4 px-4 pb-24 pt-4 sm:px-6">
      <PageHeader
        title={`Stocker${selectedLocation?.name ? ` \u2013 ${selectedLocation.name}` : location ? ` \u2013 ${location.name}` : ""}`}
        description="Products that are at or below their location minimum. Use this list to pull stock from storage, prep labels, or move inventory between locations."
        className="-mx-4 -mt-4 sm:-mx-6"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {totalProducts} product{totalProducts === 1 ? "" : "s"} need refill
          </Badge>
          <Badge variant="outline">
            {totalUnitsNeeded} unit{totalUnitsNeeded === 1 ? "" : "s"} needed
          </Badge>
          {items.length > 0 && (
            <>
              <Button variant="outline" size="sm" onClick={handlePrintPickList}>
                <Printer className="h-4 w-4" />
                <span className="hidden sm:inline ml-1">Print</span>
              </Button>
              <Button variant="outline" size="sm" onClick={handleExportCSV}>
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline ml-1">CSV</span>
              </Button>
            </>
          )}
        </div>
      </PageHeader>

      {/* Search and Sort Controls */}
      {!isLoading && !error && hasAnyItems && (
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-10"
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSearchQuery("")}
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
            <SelectTrigger className="w-full sm:w-[180px]">
              <SelectValue placeholder="Sort by..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Sort: Name</SelectItem>
              <SelectItem value="urgency">Sort: Urgency</SelectItem>
              <SelectItem value="units-needed">Sort: Units Needed</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          <div className="h-16 rounded-lg bg-muted" />
          <div className="h-16 rounded-lg bg-muted" />
          <div className="h-16 rounded-lg bg-muted" />
        </div>
      )}

      {!isLoading && error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Empty state: everything is stocked */}
      {!isLoading && !error && !hasAnyItems && (
        <Card className="border border-positive-border bg-positive-muted">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle2 className="h-12 w-12 text-positive mb-4" />
            <h2 className="text-lg font-semibold mb-1">All products are above their minimum levels</h2>
            <p className="text-sm text-muted-foreground max-w-md">
              Everything is fully stocked at
              {location ? ` ${location.name}` : " this location"}.
              Check back after stock movements or minimum changes.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Empty state: search returned no results */}
      {!isLoading && !error && isSearchFiltered && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="mb-2 text-lg font-medium">No matching products</p>
          <p className="text-sm text-muted-foreground">
            No low-stock products match &ldquo;{searchQuery}&rdquo;.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setSearchQuery("")}>
            Clear search
          </Button>
        </div>
      )}

      {!isLoading && !error && sortedItems.length > 0 && (
        <div ref={printRef} className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {sortedItems.map((item) => {
            const shortage = item.shortage;
            const stock =
              item.currentQuantity != null
                ? item.currentQuantity
                : item.minQuantity != null && item.shortage != null
                  ? Math.max(0, item.minQuantity - item.shortage)
                  : 0;
            const isOut = stock <= 0;
            const fillPercent =
              item.minQuantity > 0
                ? Math.max(0, Math.min(100, (stock / item.minQuantity) * 100))
                : 0;

            let severityLabel = "Needs refill";
            let severityClass =
              "bg-warning-muted text-warning-foreground border border-warning-border";

            if (isOut) {
              severityLabel = "Out of stock";
              severityClass =
                "bg-negative-muted text-negative-foreground border border-negative-border";
            } else if (fillPercent <= 25) {
              severityLabel = "Critical";
              severityClass =
                "bg-negative-muted text-negative-foreground border border-negative-border";
            } else if (fillPercent <= 50) {
              severityLabel = "Low";
              severityClass =
                "bg-warning-muted text-warning-foreground border border-warning-border";
            }

            return (
              <Card
                key={item.productId}
                className={cn(
                  "flex flex-col border border-border/70 bg-gradient-to-br from-card to-muted/40",
                  "shadow-sm hover:shadow-md",
                  "transition-all duration-200 hover:-translate-y-[2px]",
                  "rounded-xl"
                )}
              >
                <CardHeader className="space-y-2 pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base font-semibold">{item.productName}</CardTitle>
                    </div>
                    <Badge className={cn("text-[11px] px-2 py-1", severityClass)}>
                      {severityLabel}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Stock: <span className="font-medium text-foreground">{stock}</span>
                    </span>
                    <span>
                      Min: <span className="font-medium text-foreground">{item.minQuantity}</span>
                    </span>
                    <span>
                      Need: <span className="font-medium text-foreground">{shortage}</span>
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="h-1.5 w-full rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        isOut ? "bg-negative" : fillPercent <= 50 ? "bg-warning" : "bg-positive"
                      )}
                      style={{ width: `${fillPercent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs"
                      type="button"
                      onClick={() => handleStockIn(item)}
                    >
                      Stock In
                    </Button>
                  </div>
                  <TransferSuggestions
                    item={item}
                    destinationLocationId={selectedLocationId ?? location?.id ?? 0}
                    onRequestTransfer={handleStockIn}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Stock In Transfer Dialog */}
      <StockInTransferDialog
        open={stockInDialogOpen}
        onOpenChange={setStockInDialogOpen}
        product={stockInProduct}
        destinationLocationId={selectedLocationId ?? location?.id ?? 0}
        destinationLocationName={selectedLocation?.name ?? location?.name ?? "Unknown"}
        onSuccess={handleStockInSuccess}
      />
    </div>
  );
}
