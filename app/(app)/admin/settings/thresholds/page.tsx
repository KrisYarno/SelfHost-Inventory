'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Undo2 } from 'lucide-react';
import { useCSRF, withCSRFHeaders } from '@/hooks/use-csrf';
import { cn } from '@/lib/utils';

interface LocationMeta {
  id: number;
  name: string;
}

interface MinimumLocation {
  locationId: number;
  locationName: string;
  quantity: number;
  minQuantity: number;
}

interface ProductMinimum {
  id: number;
  name: string;
  combinedMinimum: number;
  totalStock: number;
  perLocation: MinimumLocation[];
}

type MinEdit = {
  combinedMin?: number;
  perLocation?: Record<number, number>;
};

type EditsMap = Record<number, MinEdit>;
type FilterType = 'all' | 'needsSetup' | 'edited';
type ViewMode = 'matrix' | 'list';

function clampNumber(value: string) {
  const parsed = parseInt(value || '0', 10);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, parsed);
}

function countChanges(edits: EditsMap) {
  return Object.values(edits).reduce((acc, edit) => {
    const perLoc = Object.keys(edit.perLocation ?? {}).length;
    return acc + (edit.combinedMin !== undefined ? 1 : 0) + perLoc;
  }, 0);
}

export default function MinimumSettingsPage() {
  const [products, setProducts] = useState<ProductMinimum[]>([]);
  const [locations, setLocations] = useState<LocationMeta[]>([]);
  const [visibleLocationIds, setVisibleLocationIds] = useState<number[]>([]);
  const [showCombined, setShowCombined] = useState(true);
  const [edits, setEdits] = useState<EditsMap>({});
  const [history, setHistory] = useState<EditsMap[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [view, setView] = useState<ViewMode>('matrix');
  const [drawerProduct, setDrawerProduct] = useState<ProductMinimum | null>(null);
  const { token: csrfToken } = useCSRF();

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/products/thresholds');
      if (!res.ok) throw new Error('Failed to load minimums');
      const data = await res.json();

      setProducts(data.products);
      setLocations(data.locations);
      // Default: show all locations; user can toggle off as needed
      setVisibleLocationIds(data.locations.map((l: LocationMeta) => l.id));
      setEdits({});
      setHistory([]);
      setError(null);
    } catch (err) {
      console.error('Error loading minimums', err);
      setError('Failed to load product minimums');
      toast.error('Failed to load product minimums');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const pushHistory = () => setHistory((prev) => [...prev, edits]);

  const resetEdits = () => {
    setEdits({});
    setHistory([]);
  };

  const undo = () => {
    setEdits((prev) => {
      if (!history.length) return prev;
      const undoState = history[history.length - 1];
      setHistory((h) => h.slice(0, -1));
      return undoState;
    });
  };

  const handleCombinedChange = (productId: number, value: string) => {
    pushHistory();
    const nextValue = clampNumber(value);
    setEdits((prev) => ({
      ...prev,
      [productId]: {
        ...(prev[productId] ?? {}),
        combinedMin: nextValue,
      },
    }));
  };

  const handleLocationChange = (productId: number, locationId: number, value: string) => {
    pushHistory();
    const nextValue = clampNumber(value);
    setEdits((prev) => {
      const existing = prev[productId] ?? {};
      const perLocation = { ...(existing.perLocation ?? {}), [locationId]: nextValue };
      return { ...prev, [productId]: { ...existing, perLocation } };
    });
  };

  const handleSetAllLocations = (productId: number, value: number) => {
    pushHistory();
    setEdits((prev) => {
      const existing = prev[productId] ?? {};
      const product = products.find((p) => p.id === productId);
      const nextPerLocation: Record<number, number> = { ...(existing.perLocation ?? {}) };
      product?.perLocation.forEach((loc) => {
        nextPerLocation[loc.locationId] = value;
      });
      return { ...prev, [productId]: { ...existing, perLocation: nextPerLocation } };
    });
  };

  const changesCount = useMemo(() => countChanges(edits), [edits]);

  const filteredProducts = useMemo(() => {
    const query = search.toLowerCase();
    const base = !search.trim()
      ? products
      : products.filter((p) => p.name.toLowerCase().includes(query));

    return base.filter((product) => {
      const edit = edits[product.id];
      const combinedValue = edit?.combinedMin ?? product.combinedMinimum;
      const combinedMissing = combinedValue <= 0;
      const perLocationEdits = Object.keys(edit?.perLocation ?? {}).length > 0;
      const hasChanged = perLocationEdits || edit?.combinedMin !== undefined;
      const hasMissingLocation = product.perLocation.some(
        (loc) => (edit?.perLocation?.[loc.locationId] ?? loc.minQuantity ?? 0) <= 0,
      );

      switch (filter) {
        case 'needsSetup':
          return combinedMissing || hasMissingLocation;
        case 'edited':
          return hasChanged;
        case 'all':
        default:
          return true;
      }
    });
  }, [products, search, edits, filter]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (changesCount > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [changesCount]);

  const handleSave = async () => {
    if (!changesCount) {
      toast.info('No changes to save');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const updates = Object.entries(edits).map(([productId, edit]) => ({
        productId: Number(productId),
        combinedMinimum: edit.combinedMin,
        perLocation: edit.perLocation
          ? Object.entries(edit.perLocation).map(([locationId, min]) => ({
              locationId: Number(locationId),
              minQuantity: min,
            }))
          : undefined,
      }));

      const res = await fetch('/api/admin/products/thresholds', {
        method: 'PATCH',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify({ updates }),
      });

      if (!res.ok) throw new Error('Failed to save minimums');

      toast.success('Minimums saved');
      await loadData();
    } catch (err) {
      console.error('Error saving minimums', err);
      setError('Failed to save minimums');
      toast.error('Failed to save minimums');
    } finally {
      setIsSaving(false);
    }
  };

  const visibleLocations = locations.filter((loc) => visibleLocationIds.includes(loc.id));

  return (
    <div className="space-y-4 pb-24">
      <div className="border-b border-border bg-background/80 px-4 py-4 sm:px-6 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Product minimums</h1>
            <p className="text-sm text-muted-foreground">
              Combined order minimums and per-location refill minimums.
            </p>
          </div>
          {view === 'matrix' && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={showCombined ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowCombined((prev) => !prev)}
                aria-pressed={showCombined}
              >
                Combined min
              </Button>
              {locations.map((location) => {
                const active = visibleLocationIds.includes(location.id);
                return (
                  <Button
                    key={location.id}
                    variant={active ? 'default' : 'outline'}
                    size="sm"
                    onClick={() =>
                      setVisibleLocationIds((prev) =>
                        active ? prev.filter((id) => id !== location.id) : [...prev, location.id],
                      )
                    }
                    aria-pressed={active}
                  >
                    {location.name}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-md flex-1">
            <Input
              placeholder="Search products..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search products"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-2">
              {(['all', 'needsSetup', 'edited'] as FilterType[]).map((item) => (
                <Button
                  key={item}
                  variant={filter === item ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setFilter(item)}
                >
                  {item === 'all' && 'All products'}
                  {item === 'needsSetup' && 'Needs setup'}
                  {item === 'edited' && 'Edited (unsaved)'}
                </Button>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              <Button
                variant={view === 'matrix' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setView('matrix')}
              >
                Matrix
              </Button>
              <Button
                variant={view === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setView('list')}
              >
                List
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6">
        {error && <div className="mb-3 text-sm text-destructive">{error}</div>}

        {isLoading ? (
          <div className="space-y-2">
            <div className="h-10 rounded-md bg-muted" />
            <div className="h-10 rounded-md bg-muted" />
            <div className="h-10 rounded-md bg-muted" />
          </div>
        ) : view === 'matrix' ? (
          <div className="overflow-auto border border-border rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/60 sticky top-0 z-10">
                <tr>
                  <th className="sticky left-0 z-20 bg-muted/80 px-3 py-2 text-left">Product</th>
                  {showCombined && (
                    <th className="px-3 py-2 text-right">Combined min</th>
                  )}
                  {visibleLocations.map((loc) => (
                    <th key={loc.id} className="px-3 py-2 text-right whitespace-nowrap">
                      {loc.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((product) => {
                  const edit = edits[product.id];
                  const combinedValue = edit?.combinedMin ?? product.combinedMinimum;
                  const belowCombined =
                    combinedValue > 0 && product.totalStock < combinedValue;

                  return (
                    <tr key={product.id} className="border-t border-border">
                      <td className="sticky left-0 z-10 bg-background px-3 py-2 max-w-[260px]">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{product.name}</span>
                          {belowCombined && (
                            <span
                              className="inline-block h-2 w-2 rounded-full bg-rose-400"
                              aria-label="Below combined minimum"
                            />
                          )}
                          {(edit?.combinedMin !== undefined ||
                            Object.keys(edit?.perLocation ?? {}).length > 0) && (
                            <Badge variant="secondary" className="text-[10px]">
                              Edited
                            </Badge>
                          )}
                        </div>
                      </td>
                      {showCombined && (
                        <td className="px-3 py-2 text-right">
                          <NumericInput
                            value={combinedValue}
                            onChange={(val) => handleCombinedChange(product.id, val)}
                            label={`Combined minimum for ${product.name}`}
                          />
                        </td>
                      )}
                      {visibleLocations.map((loc) => {
                        const perMin = edit?.perLocation?.[loc.id];
                        const currentLoc = product.perLocation.find(
                          (l) => l.locationId === loc.id,
                        );
                        const value = perMin ?? currentLoc?.minQuantity ?? 0;
                        const belowLoc =
                          currentLoc && value > 0 && currentLoc.quantity < value;
                        return (
                          <td
                            key={`${product.id}-${loc.id}`}
                            className={cn(
                              'px-3 py-2 text-right',
                              belowLoc && 'bg-amber-500/10 text-amber-100',
                            )}
                          >
                            <NumericInput
                              value={value}
                              onChange={(val) =>
                                handleLocationChange(product.id, loc.id, val)
                              }
                              label={`Minimum for ${product.name} at ${loc.name}`}
                            />
                            <div className="text-[10px] text-muted-foreground">
                              {currentLoc ? `Stock: ${currentLoc.quantity}` : 'Stock: 0'}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border bg-background/80">
            {filteredProducts.map((product) => {
              const edit = edits[product.id];
              const combinedValue = edit?.combinedMin ?? product.combinedMinimum;
              const belowCombined =
                combinedValue > 0 && product.totalStock < combinedValue;
              const hasEdits =
                edit?.combinedMin !== undefined ||
                Object.keys(edit?.perLocation ?? {}).length > 0;

              return (
                <div key={product.id} className="px-3 py-3 sm:px-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{product.name}</span>
                        {belowCombined && (
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-rose-400"
                            aria-label="Below combined minimum"
                          />
                        )}
                        {hasEdits && (
                          <Badge variant="secondary" className="text-[10px]">
                            Edited
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Locations: {product.perLocation.length}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Combined</span>
                      <StepperInput
                        value={combinedValue}
                        onChange={(val) =>
                          handleCombinedChange(product.id, String(val))
                        }
                        ariaLabel={`Combined minimum for ${product.name}`}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDrawerProduct(product)}
                        aria-label={`Edit per-location minimums for ${product.name}`}
                      >
                        Locations
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {drawerProduct && (
        <Drawer
          product={drawerProduct}
          edits={edits[drawerProduct.id]}
          onClose={() => setDrawerProduct(null)}
          onCombinedChange={(value) =>
            handleCombinedChange(drawerProduct.id, String(value))
          }
          onLocationChange={(locationId, value) =>
            handleLocationChange(drawerProduct.id, locationId, String(value))
          }
          onSetAll={(value) => handleSetAllLocations(drawerProduct.id, value)}
        />
      )}

      <StickySaveBar
        changes={changesCount}
        saving={isSaving}
        onSave={handleSave}
        onUndo={undo}
        onReset={resetEdits}
        error={error}
      />
    </div>
  );
}

function NumericInput({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (val: string) => void;
  label: string;
}) {
  return (
    <Input
      type="number"
      min={0}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className="h-9 text-right"
    />
  );
}

function StickySaveBar({
  changes,
  saving,
  onSave,
  onUndo,
  onReset,
  error,
}: {
  changes: number;
  saving: boolean;
  onSave: () => void;
  onUndo: () => void;
  onReset: () => void;
  error: string | null;
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3 sm:px-6">
        <Button
          variant="outline"
          size="sm"
          onClick={onUndo}
          disabled={changes === 0}
          className="flex items-center gap-1"
        >
          <Undo2 className="h-4 w-4" />
          Undo
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReset}
          disabled={changes === 0}
        >
          Reset
        </Button>
        <div className="flex-1 text-sm text-muted-foreground">
          {changes > 0 ? `${changes} change${changes > 1 ? 's' : ''} pending` : 'No changes'}
          {error && <span className="ml-2 text-destructive">{error}</span>}
        </div>
        <Button onClick={onSave} disabled={changes === 0 || saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function StepperInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number;
  onChange: (val: number) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center rounded-md border border-border">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => onChange(Math.max(0, value - 1))}
        aria-label="Decrease"
      >
        −
      </Button>
      <Input
        type="number"
        min={0}
        className="h-8 w-16 border-0 text-center"
        value={value}
        onChange={(event) => onChange(clampNumber(event.target.value))}
        aria-label={ariaLabel}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => onChange(value + 1)}
        aria-label="Increase"
      >
        +
      </Button>
    </div>
  );
}

function Drawer({
  product,
  edits,
  onClose,
  onCombinedChange,
  onLocationChange,
  onSetAll,
}: {
  product: ProductMinimum;
  edits?: MinEdit;
  onClose: () => void;
  onCombinedChange: (value: number) => void;
  onLocationChange: (locationId: number, value: number) => void;
  onSetAll: (value: number) => void;
}) {
  const combinedValue = edits?.combinedMin ?? product.combinedMinimum;
  const perLocation = edits?.perLocation ?? {};

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[90%] rounded-t-2xl border border-border bg-background shadow-lg">
        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">{product.name}</p>
            <p className="text-xs text-muted-foreground">
              {product.perLocation.length} locations
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="space-y-4 overflow-y-auto px-4 py-3">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Combined minimum
            </label>
            <StepperInput
              value={combinedValue}
              onChange={(val) => onCombinedChange(val)}
              ariaLabel={`Combined minimum for ${product.name}`}
            />
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
              {[0, 1, 5, 10, 25].map((chip) => (
                <Button
                  key={chip}
                  size="sm"
                  variant="secondary"
                  onClick={() => onCombinedChange(chip)}
                  className="h-7"
                >
                  {chip}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Locations</p>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">Set all:</span>
                {[0, 1, 5, 10].map((chip) => (
                  <Button
                    key={chip}
                    size="sm"
                    variant="outline"
                    className="h-7"
                    onClick={() => onSetAll(chip)}
                  >
                    {chip}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              {product.perLocation.map((loc) => {
                const value = perLocation[loc.locationId] ?? loc.minQuantity ?? 0;
                return (
                  <div
                    key={loc.locationId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-medium">{loc.locationName}</p>
                      <p className="text-[11px] text-muted-foreground">
                        Stock: {loc.quantity}
                      </p>
                    </div>
                    <StepperInput
                      value={value}
                      onChange={(val) => onLocationChange(loc.locationId, val)}
                      ariaLabel={`Minimum for ${loc.locationName}`}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="h-4" />
      </div>
    </div>
  );
}
