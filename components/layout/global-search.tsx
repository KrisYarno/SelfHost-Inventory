"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Search, Package, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProductResult {
  id: number;
  name: string;
  sku?: string | null;
}

interface SearchResult {
  id: string;
  label: string;
  description?: string;
  href: string;
  type: "product";
  icon: React.ElementType;
}

// ---------------------------------------------------------------------------
// Debounce hook
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 250);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Focus the input after the dialog renders
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Search products
  const { data: productData, isFetching } = useQuery({
    queryKey: ["global-search-products", debouncedQuery],
    queryFn: async () => {
      if (!debouncedQuery.trim()) return { products: [] };
      const params = new URLSearchParams({
        search: debouncedQuery,
        pageSize: "8",
        page: "1",
      });
      const res = await fetch(`/api/products?${params}`);
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: open && debouncedQuery.trim().length > 0,
    staleTime: 30_000,
  });

  // Build unified results list (memoized to stabilize dependency arrays)
  const results = useMemo<SearchResult[]>(() => {
    const items: SearchResult[] = [];
    if (productData?.products) {
      for (const p of productData.products as ProductResult[]) {
        items.push({
          id: `product-${p.id}`,
          label: p.name,
          description: p.sku || undefined,
          href: `/products`,
          type: "product",
          icon: Package,
        });
      }
    }
    return items;
  }, [productData]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length, debouncedQuery]);

  // Navigate to result
  const navigateToResult = useCallback(
    (result: SearchResult) => {
      setOpen(false);
      router.push(result.href);
    },
    [router]
  );

  // Keyboard navigation inside the results list
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % Math.max(results.length, 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev <= 0 ? Math.max(results.length - 1, 0) : prev - 1
        );
      } else if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        navigateToResult(results[selectedIndex]);
      }
    },
    [results, selectedIndex, navigateToResult]
  );

  const showEmpty =
    debouncedQuery.trim().length > 0 && !isFetching && results.length === 0;

  return (
    <>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Search (Cmd+K)"
      >
        <Search className="h-4 w-4" />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
          <span className="text-xs">&#8984;</span>K
        </kbd>
      </button>

      {/* Search dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
          <DialogTitle className="sr-only">Search</DialogTitle>
          {/* Search input */}
          <div className="flex items-center border-b border-border px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search products..."
              className="h-12 border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            {isFetching && (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Results */}
          <div className="max-h-[300px] overflow-y-auto">
            {/* Empty state */}
            {showEmpty && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No results found for &ldquo;{debouncedQuery}&rdquo;
              </div>
            )}

            {/* Prompt state */}
            {!debouncedQuery.trim() && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Start typing to search products...
              </div>
            )}

            {/* Products group */}
            {results.length > 0 && (
              <div>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Products
                </div>
                {results.map((result, index) => {
                  const Icon = result.icon;
                  const isSelected = index === selectedIndex;
                  return (
                    <button
                      key={result.id}
                      onClick={() => navigateToResult(result)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors ${
                        isSelected
                          ? "bg-primary/10 text-foreground"
                          : "text-foreground hover:bg-muted/50"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{result.label}</div>
                        {result.description && (
                          <div className="truncate text-xs text-muted-foreground">
                            {result.description}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer with keyboard hints */}
          {results.length > 0 && (
            <div className="flex items-center gap-4 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono">&#8593;</kbd>
                <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono">&#8595;</kbd>
                navigate
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono">&#9166;</kbd>
                select
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border bg-background px-1 py-0.5 font-mono">esc</kbd>
                close
              </span>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
