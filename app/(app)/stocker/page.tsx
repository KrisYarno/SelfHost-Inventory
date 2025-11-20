'use client';

import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLocation } from '@/contexts/location-context';

interface StockerItem {
  productId: number;
  productName: string;
  baseName?: string | null;
  unit?: string | null;
  numericValue?: number | null;
  quantity: number;
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
  const match =
    trimmed.match(/^(.*?)(\d+(?:\.\d+)?)\s*(mg|ml|mL|mcg|g|units?)?\)?$/i);
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
    (item.baseName && item.baseName.trim().toLowerCase()) ||
    item.productName.trim().toLowerCase();

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

export default function StockerPage() {
  const { selectedLocationId, selectedLocation } = useLocation?.() ?? {
    selectedLocationId: undefined,
    selectedLocation: null,
  };
  const [location, setLocation] = useState<StockerLocation | null>(null);
  const [items, setItems] = useState<StockerItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (selectedLocationId) {
          params.set('locationId', String(selectedLocationId));
        }
        const query = params.toString();
        const url = query ? `/api/stocker/minimums?${query}` : '/api/stocker/minimums';
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to load stocker data');
        const data: StockerResponse = await res.json();
        setLocation(data.location);
        setItems(data.items ?? []);
      } catch (err) {
        console.error('Error loading stocker data', err);
        setError('Unable to load refill list. Please try again.');
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [selectedLocationId]);

  const sortedItems = useMemo(() => {
    return items
      .slice()
      .sort((a, b) => {
        const aParsed = getSortFields(a);
        const bParsed = getSortFields(b);

        // First sort by base name alphabetically
        if (aParsed.base !== bParsed.base) {
          return aParsed.base.localeCompare(bParsed.base, undefined, {
            sensitivity: 'base',
          });
        }

        // Within the same base name, sort by numeric size if available
        if (aParsed.size !== null && bParsed.size !== null && aParsed.size !== bParsed.size) {
          return aParsed.size - bParsed.size;
        }

        // Fallback to full product name for stability
        return a.productName.localeCompare(b.productName, undefined, {
          sensitivity: 'base',
        });
      });
  }, [items]);

  const totalProducts = items.length;
  const totalUnitsNeeded = items.reduce((sum, item) => sum + item.shortage, 0);

  return (
    <div className="space-y-4 px-4 pb-24 pt-4 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">
          Stocker{selectedLocation?.name
            ? ` – ${selectedLocation.name}`
            : location
            ? ` – ${location.name}`
            : ''}
        </h1>
        <p className="text-sm text-muted-foreground">
          Products that are at or below their location minimum. Use this list to pull stock from
          storage, prep labels, or move inventory between locations.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">
            {totalProducts} product{totalProducts === 1 ? '' : 's'} need refill
          </Badge>
          <Badge variant="outline">
            {totalUnitsNeeded} unit{totalUnitsNeeded === 1 ? '' : 's'} needed
          </Badge>
        </div>
      </header>

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

      {!isLoading && !error && sortedItems.length === 0 && (
        <Card className="border border-emerald-500/30 bg-emerald-500/5">
          <CardHeader>
            <CardTitle className="text-base">All set at this location</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            No products are currently below their minimum at
            {location ? ` ${location.name}` : ' this location'}. Check back after stock movements
            or minimum changes.
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && sortedItems.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {sortedItems.map((item) => {
            const shortage = item.shortage;
            const stock =
              item.quantity != null
                ? item.quantity
                : item.minQuantity != null && item.shortage != null
                ? Math.max(0, item.minQuantity - item.shortage)
                : 0;
            const isOut = stock <= 0;
            const fillPercent =
              item.minQuantity > 0
                ? Math.max(0, Math.min(100, (stock / item.minQuantity) * 100))
                : 0;

            let severityLabel = 'Needs refill';
            let severityClass =
              'bg-amber-500/10 text-amber-100 border border-amber-400/40';

            if (isOut) {
              severityLabel = 'Out of stock';
              severityClass = 'bg-red-500/10 text-red-100 border border-red-400/40';
            } else if (fillPercent <= 25) {
              severityLabel = 'Critical';
              severityClass = 'bg-red-500/10 text-red-100 border border-red-400/40';
            } else if (fillPercent <= 50) {
              severityLabel = 'Low';
              severityClass = 'bg-amber-500/10 text-amber-100 border border-amber-400/40';
            }

            return (
              <Card
                key={item.productId}
                className={cn(
                  'flex flex-col border-border bg-card',
                  'transition-colors',
                )}
              >
                <CardHeader className="space-y-2 pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base font-semibold">
                        {item.productName}
                      </CardTitle>
                    </div>
                    <Badge className={cn('text-[11px] px-2 py-1', severityClass)}>
                      {severityLabel}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Stock:{' '}
                      <span className="font-medium text-foreground">
                        {stock}
                      </span>
                    </span>
                    <span>
                      Min: <span className="font-medium text-foreground">{item.minQuantity}</span>
                    </span>
                    <span>
                      Need:{' '}
                      <span className="font-medium text-foreground">
                        {shortage}
                      </span>
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  <div className="h-1.5 w-full rounded-full bg-muted">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        isOut
                          ? 'bg-red-500'
                          : fillPercent <= 50
                          ? 'bg-amber-500'
                          : 'bg-emerald-500',
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
                      onClick={() => {
                        // Placeholder: wire to stock-in or transfer modal.
                        console.info('Open product from stocker', {
                          productId: item.productId,
                          productName: item.productName,
                        });
                      }}
                    >
                      Open product
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
