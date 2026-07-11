"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Undo2 } from "lucide-react";
import {
  useThresholds,
  useSaveThresholds,
  useSaveLowStockDefault,
  type ProductMinimum,
} from "@/hooks/use-admin";
import { effectiveLowStockThreshold } from "@/lib/stock-threshold";
import { cn } from "@/lib/utils";

// combinedMin is the RAW alert-threshold value (R-L13 tri-state): null = inherit
// the system default, 0 = alerts off, >0 = explicit override. `undefined` = the
// row has no pending edit (fall back to the product's stored value).
type MinEdit = {
  combinedMin?: number | null;
  perLocation?: Record<number, number>;
};

type EditsMap = Record<number, MinEdit>;
type FilterType = "all" | "needsSetup" | "edited";
type ViewMode = "matrix" | "list";

function clampNumber(value: string) {
  const parsed = parseInt(value || "0", 10);
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
  const { data, isLoading, isError, dataUpdatedAt, errorUpdatedAt } = useThresholds();
  const saveThresholds = useSaveThresholds();
  const saveDefault = useSaveLowStockDefault();
  const products = useMemo(() => data?.products ?? [], [data]);
  const locations = useMemo(() => data?.locations ?? [], [data]);
  const systemDefault = data?.lowStockDefault ?? 10;
  const isSaving = saveThresholds.isPending;

  const [visibleLocationIds, setVisibleLocationIds] = useState<number[]>([]);
  const [showCombined, setShowCombined] = useState(true);
  const [edits, setEdits] = useState<EditsMap>({});
  const [history, setHistory] = useState<EditsMap[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [view, setView] = useState<ViewMode>("matrix");
  const [drawerProduct, setDrawerProduct] = useState<ProductMinimum | null>(null);

  // Draft of the system default input (D-L9 header control). Seeded from the
  // loaded value on every fresh dataset.
  const [defaultDraft, setDefaultDraft] = useState<number>(10);

  // Whenever a fresh dataset loads (mount + after a save-triggered refetch),
  // default all locations visible and clear pending edits/history — mirrors the
  // old loadData() resets. dataUpdatedAt changes on every completed fetch.
  useEffect(() => {
    if (data) {
      setVisibleLocationIds(data.locations.map((l) => l.id));
      setEdits({});
      setHistory([]);
      setError(null);
      setDefaultDraft(data.lowStockDefault ?? 10);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  // Surface load failures the same way loadData did.
  useEffect(() => {
    if (isError) {
      setError("Failed to load product minimums");
      toast.error("Failed to load product minimums");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isError, errorUpdatedAt]);

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

  // Tri-state alert-threshold change: null = inherit / 0 = off / n = custom.
  const handleCombinedChange = (productId: number, value: number | null) => {
    pushHistory();
    setEdits((prev) => ({
      ...prev,
      [productId]: {
        ...(prev[productId] ?? {}),
        combinedMin: value,
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

  // Resolve a product's pending-or-stored raw alert threshold (null/0/>0).
  const rawThresholdFor = (product: ProductMinimum): number | null => {
    const edit = edits[product.id];
    return edit?.combinedMin !== undefined ? edit.combinedMin : product.combinedMinimum;
  };

  const filteredProducts = useMemo(() => {
    const query = search.toLowerCase();
    const base = !search.trim()
      ? products
      : products.filter((p) => p.name.toLowerCase().includes(query));

    return base.filter((product) => {
      const edit = edits[product.id];
      const raw = edit?.combinedMin !== undefined ? edit.combinedMin : product.combinedMinimum;
      // "Needs setup" = inheriting the default (never explicitly configured).
      const combinedMissing = raw === null;
      const perLocationEdits = Object.keys(edit?.perLocation ?? {}).length > 0;
      const hasChanged = perLocationEdits || edit?.combinedMin !== undefined;
      const hasMissingLocation = product.perLocation.some(
        (loc) => (edit?.perLocation?.[loc.locationId] ?? loc.minQuantity ?? 0) <= 0
      );

      switch (filter) {
        case "needsSetup":
          return combinedMissing || hasMissingLocation;
        case "edited":
          return hasChanged;
        case "all":
        default:
          return true;
      }
    });
  }, [products, search, edits, filter]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (changesCount > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [changesCount]);

  const handleSave = async () => {
    if (!changesCount) {
      toast.info("No changes to save");
      return;
    }

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

      // Cache invalidation refetches thresholds, which resets edits/history/
      // visibleLocationIds via the effect above (was: await loadData()).
      await saveThresholds.mutateAsync(updates);

      toast.success("Minimums saved");
    } catch (err) {
      console.error("Error saving minimums", err);
      setError("Failed to save minimums");
      toast.error("Failed to save minimums");
    }
  };

  const handleSaveDefault = async () => {
    try {
      await saveDefault.mutateAsync(Math.max(0, defaultDraft));
      toast.success("Default low-stock threshold saved");
    } catch (err) {
      console.error("Error saving default", err);
      toast.error("Failed to save default threshold");
    }
  };

  const visibleLocations = locations.filter((loc) => visibleLocationIds.includes(loc.id));
  const defaultDirty = defaultDraft !== systemDefault;

  return (
    <div className="space-y-4 pb-44 sm:pb-28">
      <div className="border-b border-border bg-background/80 px-4 py-4 sm:px-6 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Product minimums</h1>
            <p className="text-sm text-muted-foreground">
              Low-stock alert thresholds and per-location refill minimums.
            </p>
          </div>
          {view === "matrix" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={showCombined ? "default" : "outline"}
                size="sm"
                onClick={() => setShowCombined((prev) => !prev)}
                aria-pressed={showCombined}
              >
                Alert threshold
              </Button>
              {locations.map((location) => {
                const active = visibleLocationIds.includes(location.id);
                return (
                  <Button
                    key={location.id}
                    variant={active ? "default" : "outline"}
                    size="sm"
                    onClick={() =>
                      setVisibleLocationIds((prev) =>
                        active ? prev.filter((id) => id !== location.id) : [...prev, location.id]
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

        {/* D-L9: system default input lives at the top of the matrix page. */}
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <label htmlFor="default-threshold" className="text-sm font-medium">
              Default low-stock threshold
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="default-threshold"
                type="number"
                min={0}
                className="h-9 w-24"
                value={Number.isFinite(defaultDraft) ? defaultDraft : ""}
                onChange={(e) => setDefaultDraft(clampNumber(e.target.value))}
              />
              <span className="text-sm text-muted-foreground">units</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Used by products set to system default.
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleSaveDefault}
            disabled={!defaultDirty || saveDefault.isPending}
          >
            {saveDefault.isPending ? "Saving..." : "Save default"}
          </Button>
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
              {(["all", "needsSetup", "edited"] as FilterType[]).map((item) => (
                <Button
                  key={item}
                  variant={filter === item ? "default" : "outline"}
                  size="sm"
                  onClick={() => setFilter(item)}
                >
                  {item === "all" && "All products"}
                  {item === "needsSetup" && "Needs setup"}
                  {item === "edited" && "Edited (unsaved)"}
                </Button>
              ))}
            </div>
            <div className="ml-auto flex gap-1">
              <Button
                variant={view === "matrix" ? "default" : "outline"}
                size="sm"
                onClick={() => setView("matrix")}
              >
                Matrix
              </Button>
              <Button
                variant={view === "list" ? "default" : "outline"}
                size="sm"
                onClick={() => setView("list")}
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
        ) : view === "matrix" ? (
          <div className="overflow-auto border border-border rounded-lg">
            <table className="min-w-full text-sm">
              <thead className="bg-muted/60 sticky top-0 z-10">
                <tr>
                  <th className="sticky left-0 z-20 bg-muted/80 px-3 py-2 text-left">Product</th>
                  {showCombined && (
                    <th className="px-3 py-2 text-right whitespace-nowrap">
                      Low-stock alert threshold
                    </th>
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
                  const raw = rawThresholdFor(product);
                  const effective = effectiveLowStockThreshold(raw, systemDefault);
                  const belowCombined = effective > 0 && product.totalStock <= effective;
                  const edit = edits[product.id];

                  return (
                    <tr key={product.id} className="border-t border-border">
                      <td className="sticky left-0 z-10 bg-background px-3 py-2 max-w-[260px]">
                        <div className="flex items-center gap-2 max-w-[240px] sm:max-w-none">
                          <span className="flex-1 min-w-0 truncate font-medium text-sm sm:text-base">
                            {product.name}
                          </span>
                          {belowCombined && (
                            <span
                              className="inline-block h-2 w-2 rounded-full bg-rose-400"
                              aria-label="Below alert threshold"
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
                          <ThresholdControl
                            raw={raw}
                            systemDefault={systemDefault}
                            onChange={(value) => handleCombinedChange(product.id, value)}
                          />
                        </td>
                      )}
                      {visibleLocations.map((loc) => {
                        const perMin = edit?.perLocation?.[loc.id];
                        const currentLoc = product.perLocation.find((l) => l.locationId === loc.id);
                        const value = perMin ?? currentLoc?.minQuantity ?? 0;
                        const belowLoc = currentLoc && value > 0 && currentLoc.quantity < value;
                        return (
                          <td
                            key={`${product.id}-${loc.id}`}
                            className={cn(
                              "px-3 py-2 text-right",
                              belowLoc &&
                                "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200"
                            )}
                          >
                            <NumericInput
                              value={value}
                              onChange={(val) => handleLocationChange(product.id, loc.id, val)}
                              label={`Minimum for ${product.name} at ${loc.name}`}
                            />
                            <div className="text-[10px] text-muted-foreground">
                              {currentLoc ? `Stock: ${currentLoc.quantity}` : "Stock: 0"}
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
              const raw = rawThresholdFor(product);
              const effective = effectiveLowStockThreshold(raw, systemDefault);
              const belowCombined = effective > 0 && product.totalStock <= effective;
              const edit = edits[product.id];
              const hasEdits =
                edit?.combinedMin !== undefined || Object.keys(edit?.perLocation ?? {}).length > 0;

              return (
                <div key={product.id} className="px-3 py-3 sm:px-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 truncate font-medium">{product.name}</span>
                        {belowCombined && (
                          <span
                            className="inline-block h-2 w-2 rounded-full bg-rose-400"
                            aria-label="Below alert threshold"
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
                      <span className="text-xs text-muted-foreground">Alert</span>
                      <ThresholdControl
                        raw={raw}
                        systemDefault={systemDefault}
                        onChange={(value) => handleCombinedChange(product.id, value)}
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
          systemDefault={systemDefault}
          onClose={() => setDrawerProduct(null)}
          onCombinedChange={(value) => handleCombinedChange(drawerProduct.id, value)}
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

/**
 * ONE tri-state alert-threshold control (D-L9), used in the matrix, the list, and
 * the drawer. Mode select (Default / Custom / Off) + a value input for custom;
 * the effective value is always shown inline, and a legacy `=1` row gets a
 * "custom: 1" tag so its old-schema-default origin stays visible + hand-correctable.
 */
function ThresholdControl({
  raw,
  systemDefault,
  onChange,
}: {
  raw: number | null;
  systemDefault: number;
  onChange: (value: number | null) => void;
}) {
  const mode: "inherit" | "custom" | "off" =
    raw === null ? "inherit" : raw === 0 ? "off" : "custom";
  const effective = effectiveLowStockThreshold(raw, systemDefault);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <select
          aria-label="Alert threshold mode"
          className="h-8 rounded-md border border-border bg-background px-1 text-sm"
          value={mode}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "inherit") onChange(null);
            else if (next === "off") onChange(0);
            else onChange(raw && raw > 0 ? raw : systemDefault);
          }}
        >
          <option value="inherit">Use system default ({systemDefault})</option>
          <option value="custom">Custom threshold</option>
          <option value="off">Alerts off</option>
        </select>
        {mode === "custom" && (
          <Input
            type="number"
            min={0}
            aria-label="Custom threshold value"
            className="h-8 w-16 text-right"
            value={raw ?? 0}
            onChange={(e) => {
              const parsed = parseInt(e.target.value || "0", 10);
              onChange(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
            }}
          />
        )}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {raw === 1 && (
          <Badge variant="outline" className="text-[10px]">
            custom: 1
          </Badge>
        )}
        <span>{effective > 0 ? `Effective: ${effective}` : "alerts off"}</span>
      </div>
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
    <div
      className={cn(
        "fixed left-0 right-0 md:left-64 z-40 border-t backdrop-blur",
        changes > 0
          ? "border-amber-300 bg-amber-50/90 dark:border-amber-700 dark:bg-amber-900/30"
          : "border-border bg-background/90"
      )}
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 4.75rem)" }}
    >
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
        <Button variant="ghost" size="sm" onClick={onReset} disabled={changes === 0}>
          Reset
        </Button>
        <div className="flex-1 text-sm text-muted-foreground">
          {changes > 0 ? `${changes} change${changes > 1 ? "s" : ""} pending` : "No changes"}
          {error && <span className="ml-2 text-destructive">{error}</span>}
        </div>
        <Button onClick={onSave} disabled={changes === 0 || saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

function Drawer({
  product,
  edits,
  systemDefault,
  onClose,
  onCombinedChange,
  onLocationChange,
  onSetAll,
}: {
  product: ProductMinimum;
  edits?: MinEdit;
  systemDefault: number;
  onClose: () => void;
  onCombinedChange: (value: number | null) => void;
  onLocationChange: (locationId: number, value: number) => void;
  onSetAll: (value: number) => void;
}) {
  const raw = edits?.combinedMin !== undefined ? edits.combinedMin : product.combinedMinimum;
  const perLocation = edits?.perLocation ?? {};

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 max-h-[90%] rounded-t-2xl border border-border bg-background shadow-lg">
        <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">{product.name}</p>
            <p className="text-xs text-muted-foreground">{product.perLocation.length} locations</p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <div className="space-y-4 overflow-y-auto px-4 py-3">
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              Low-stock alert threshold
            </label>
            <ThresholdControl raw={raw} systemDefault={systemDefault} onChange={onCombinedChange} />
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
                      <p className="text-[11px] text-muted-foreground">Stock: {loc.quantity}</p>
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
        -
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
