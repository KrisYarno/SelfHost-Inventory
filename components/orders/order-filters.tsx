"use client";

import { useState, useEffect } from "react";
import { Search, X, Filter } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { PlatformType, InternalOrderStatus } from "@/types/external-orders";

interface Company {
  id: string;
  name: string;
  slug: string;
}

interface OrderFiltersProps {
  companies: Company[];
  selectedCompanyId: string | null;
  onCompanyChange: (companyId: string) => void;
  platform: PlatformType | "ALL";
  onPlatformChange: (platform: PlatformType | "ALL") => void;
  status: InternalOrderStatus | "all";
  onStatusChange: (status: InternalOrderStatus | "all") => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  className?: string;
}

export function OrderFilters({
  companies,
  selectedCompanyId,
  onCompanyChange,
  platform,
  onPlatformChange,
  status,
  onStatusChange,
  searchQuery,
  onSearchChange,
  className,
}: OrderFiltersProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Count active filters
  const activeFilterCount =
    (platform !== "ALL" ? 1 : 0) + (status !== "all" ? 1 : 0) + (searchQuery ? 1 : 0);

  const clearFilters = () => {
    onPlatformChange("ALL");
    onStatusChange("all");
    onSearchChange("");
    setIsFilterOpen(false);
  };

  // Desktop filters
  const DesktopFilters = () => (
    <div className={cn("space-y-4", className)}>
      {/* Company Tabs - Always visible on desktop */}
      {companies.length > 0 && (
        <div className="border-b pb-4">
          <Tabs
            value={selectedCompanyId || companies[0]?.id}
            onValueChange={onCompanyChange}
            className="w-full"
          >
            <TabsList className="grid w-full" style={{ gridTemplateColumns: `repeat(${companies.length}, 1fr)` }}>
              {companies.map((company) => (
                <TabsTrigger key={company.id} value={company.id} className="text-sm">
                  {company.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Filter Row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by order number..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => onSearchChange("")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Platform Filter */}
        <Select value={platform} onValueChange={(v) => onPlatformChange(v as PlatformType | "ALL")}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Platform" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All Platforms</SelectItem>
            <SelectItem value="SHOPIFY">Shopify</SelectItem>
            <SelectItem value="WOOCOMMERCE">WooCommerce</SelectItem>
          </SelectContent>
        </Select>

        {/* Status Tabs */}
        <Tabs value={status} onValueChange={(v) => onStatusChange(v as InternalOrderStatus | "all")}>
          <TabsList>
            <TabsTrigger value="all" className="text-xs">
              All
            </TabsTrigger>
            <TabsTrigger value="pending" className="text-xs">
              Pending
            </TabsTrigger>
            <TabsTrigger value="processing" className="text-xs">
              Processing
            </TabsTrigger>
            <TabsTrigger value="fulfilled" className="text-xs">
              Fulfilled
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Clear Filters */}
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
            <Badge variant="secondary" className="ml-2 px-1.5">
              {activeFilterCount}
            </Badge>
          </Button>
        )}
      </div>
    </div>
  );

  // Mobile filter sheet
  const MobileFilters = () => (
    <div className={cn("space-y-4", className)}>
      {/* Company selector - Mobile */}
      {companies.length > 0 && (
        <Select
          value={selectedCompanyId || companies[0]?.id}
          onValueChange={onCompanyChange}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select company" />
          </SelectTrigger>
          <SelectContent>
            {companies.map((company) => (
              <SelectItem key={company.id} value={company.id}>
                {company.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <div className="flex gap-2">
        {/* Search */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search orders..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => onSearchChange("")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Filter Sheet Trigger */}
        <Sheet open={isFilterOpen} onOpenChange={setIsFilterOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="relative">
              <Filter className="h-4 w-4" />
              {activeFilterCount > 0 && (
                <Badge
                  variant="destructive"
                  className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-[10px]"
                >
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
              <SheetDescription>Filter orders by platform and status</SheetDescription>
            </SheetHeader>
            <div className="space-y-6 mt-6">
              {/* Platform Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Platform</label>
                <Select value={platform} onValueChange={(v) => onPlatformChange(v as PlatformType | "ALL")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select platform" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">All Platforms</SelectItem>
                    <SelectItem value="SHOPIFY">Shopify</SelectItem>
                    <SelectItem value="WOOCOMMERCE">WooCommerce</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Status Filter */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Status</label>
                <Select value={status} onValueChange={(v) => onStatusChange(v as InternalOrderStatus | "all")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="fulfilled">Fulfilled</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Clear Filters */}
              {activeFilterCount > 0 && (
                <Button variant="outline" className="w-full" onClick={clearFilters}>
                  Clear All Filters
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Status tabs - visible on mobile */}
      <Tabs value={status} onValueChange={(v) => onStatusChange(v as InternalOrderStatus | "all")} className="w-full">
        <TabsList className="w-full grid grid-cols-4">
          <TabsTrigger value="all" className="text-xs">
            All
          </TabsTrigger>
          <TabsTrigger value="pending" className="text-xs">
            Pending
          </TabsTrigger>
          <TabsTrigger value="processing" className="text-xs">
            Processing
          </TabsTrigger>
          <TabsTrigger value="fulfilled" className="text-xs">
            Fulfilled
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );

  return isMobile ? <MobileFilters /> : <DesktopFilters />;
}
