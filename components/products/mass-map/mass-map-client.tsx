"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, AlertCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
  SheetHeader,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PlatformBadge } from "@/components/orders/platform-badge";
import type { PlatformType } from "@/types/external-orders";
import type { CatalogRow, InternalProductIndexEntry } from "@/types/bulk-map";
import { rowKey } from "@/types/bulk-map";
import { useCatalog } from "./use-catalog";
import { useInternalProductIndex } from "./use-internal-product-index";
import { useRowActions } from "./use-row-actions";
import { ExternalProductList } from "./external-product-list";
import { InternalProductPicker, type BundleSeed } from "./internal-product-picker";
import { RefreshButton } from "./refresh-button";
import { useIsDesktop } from "./use-viewport";
import type { BundleBuilderComponent } from "./bundle-builder";

/**
 * Where the reconciliation lane's unmapped tab sends people (pack C4b.2): the
 * exact external product that has orders waiting on it, straight off the deep
 * link's query string.
 */
export interface MassMapPrefill {
  externalProductId: string;
  externalVariantId: string | null;
  sku: string | null;
}

/** VERBATIM (pack C4b.2 / spec §4.4). */
export const PREFILL_NOT_IN_CATALOG =
  "This external product is not in the store catalog — it may have been deleted; nothing to map here.";

interface Props {
  integrationId: string;
  prefill?: MassMapPrefill;
}

export function MassMapClient({ integrationId, prefill }: Props) {
  const catalog = useCatalog(integrationId);
  const { index, isLoading: indexLoading } = useInternalProductIndex();
  const { confirm, confirmBundle, editBundle } = useRowActions();
  const isDesktop = useIsDesktop();

  const [activeRow, setActiveRow] = useState<CatalogRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successFor, setSuccessFor] = useState<
    { row: CatalogRow; internalProductName: string } | null
  >(null);
  const [tab, setTab] = useState<"unmapped" | "mapped">("unmapped");
  const [bundleMode, setBundleMode] = useState(false);
  // What the bundle editor starts from, for the active row only (MS-2-1). Set
  // by `selectRow`, cleared by every close path.
  const [bundleSeed, setBundleSeed] = useState<BundleSeed | null>(null);
  // Bumped by every selection and every close, so a components fetch that
  // answers after the person moved on lands nowhere.
  const seedRequest = useRef(0);

  const rows = catalog.data?.rows ?? [];
  const unmapped = useMemo(() => rows.filter((r) => !r.alreadyMapped), [rows]);
  const mapped = useMemo(() => rows.filter((r) => r.alreadyMapped), [rows]);
  const currentRows = tab === "unmapped" ? unmapped : mapped;
  const activeKey = activeRow ? rowKey(activeRow) : null;

  // ---------------------------------------------------------------------
  // The reconciliation deep link (pack C4b.2)
  //
  // The link names the EXACT pair a person was sent here to map, so the match
  // is on `rowKey` — never on the sku, which stores reuse across variants.
  // Three outcomes and no fourth: the catalog carries it (select it, and scroll
  // the virtualizer to it), the catalog is loaded and does NOT carry it (say
  // so — it may have been deleted since the order was placed), or the catalog
  // has not answered yet, in which case there is nothing honest to claim.
  // ---------------------------------------------------------------------
  const prefillKey = prefill
    ? rowKey({
        externalProductId: prefill.externalProductId,
        externalVariantId: prefill.externalVariantId,
      })
    : null;
  // Not memoised on purpose: `rows` is the catalog query's own array, so the
  // row this finds is the SAME object reference until the catalog itself
  // changes — memoising it would only add `rows` (a `?? []` expression) to a
  // dependency list for no stability the effect below does not already have.
  const prefillRow =
    prefillKey === null ? null : (rows.find((r) => rowKey(r) === prefillKey) ?? null);
  const prefillApplied = useRef(false);

  // ---------------------------------------------------------------------
  // THE ONE ENTRY POINT for selecting a row (MS-2-1): a list click, the deep
  // link below, and Retry all come through here. It seeds the bundle editor:
  //   - no existing bundle -> ready with no components, at once;
  //   - an existing bundle -> loading until ITS components answer for THIS
  //     selection (a late answer for an earlier selection is ignored);
  //   - an error, a non-OK answer, or the link missing from the answer ->
  //     failed. The editor never opens empty over a real bundle: confirming it
  //     would replace the real components wholesale.
  // ---------------------------------------------------------------------
  const selectRow = useCallback(
    (row: CatalogRow) => {
      setError(null);
      setSuccessFor(null);
      setActiveRow(row);

      const isBundle = row.isBundleCandidate || row.existingMapping?.isBundle === true;
      setBundleMode(isBundle ?? false);

      const key = rowKey(row);
      const request = ++seedRequest.current;
      const linkId = row.existingMapping?.isBundle ? row.existingMapping.linkId : null;
      if (!linkId) {
        setBundleSeed({ key, status: "ready", components: [] });
        return;
      }

      setBundleSeed({ key, status: "loading", components: [] });
      const settle = (seed: BundleSeed) => {
        if (seedRequest.current !== request) return;
        setBundleSeed((prev) => (prev?.key === key ? seed : prev));
      };
      const failed: BundleSeed = { key, status: "failed", components: [] };

      fetch(`/api/admin/product-mappings?integrationId=${integrationId}&pageSize=500`)
        .then(async (r) => {
          if (!r.ok) return settle(failed);
          const data = (await r.json()) as {
            mappings?: Array<{
              id: string;
              bundleComponents?: Array<{
                internalProductId: number;
                quantity: number;
                sortOrder: number;
                internalProduct?: { name?: string };
              }>;
            }>;
          };
          const found = data.mappings?.find((m) => m.id === linkId);
          // The route returns `bundleComponents` only for a bundle link; a link
          // that is missing, or no longer a bundle, has no components to edit.
          if (!found || !Array.isArray(found.bundleComponents)) return settle(failed);
          settle({
            key,
            status: "ready",
            components: found.bundleComponents.map((c) => ({
              internalProductId: c.internalProductId,
              internalProductName: c.internalProduct?.name ?? "",
              quantity: c.quantity,
              sortOrder: c.sortOrder,
            })),
          });
        })
        .catch(() => settle(failed));
    },
    [integrationId],
  );

  // Every close path (both Cancels, the phone sheet's close, finish, keep)
  // comes through here: no row, no seed, and any in-flight components fetch
  // is orphaned.
  const closeSelection = () => {
    seedRequest.current += 1;
    setActiveRow(null);
    setBundleSeed(null);
  };

  useEffect(() => {
    if (prefillRow === null || prefillApplied.current) return;
    prefillApplied.current = true;
    // THE ROW'S OWN TAB (OC-9). Usually that is Unmapped — but the deep link can
    // land on a row that is already mapped (somebody fixed it between the report
    // read and the click, or the exception is about the mapping itself). Forcing
    // Unmapped there selected a row on the list the other tab is showing: an
    // empty screen with an invisible selection.
    setTab(prefillRow.alreadyMapped ? "mapped" : "unmapped");
    // Through the one entry point, so an existing bundle's components load
    // exactly as they do for a click (G1-3).
    selectRow(prefillRow);
  }, [prefillRow, selectRow]);

  const prefillMissing = prefillKey !== null && catalog.data !== undefined && prefillRow === null;

  // Decorate the matcher index with hasAnyMapping derived from the catalog's
  // existing mappings, so suggestions for internal products already linked to
  // some external in THIS integration render greyed but still selectable.
  const enrichedIndex = useMemo(() => {
    if (index.length === 0) return index;
    const mappedIds = new Set<number>();
    for (const r of rows) {
      if (r.existingMapping?.internalProductId != null) mappedIds.add(r.existingMapping.internalProductId);
    }
    if (mappedIds.size === 0) return index;
    return index.map((p) =>
      mappedIds.has(p.id) ? { ...p, hasAnyMapping: true } : p,
    );
  }, [index, rows]);

  const handleConfirm = async (product: InternalProductIndexEntry) => {
    if (!activeRow) return;
    setError(null);
    setSaving(true);
    try {
      await confirm({
        integrationId,
        row: activeRow,
        internalProductId: product.id,
        internalProductName: product.name,
      });
      setSuccessFor({ row: activeRow, internalProductName: product.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmBundle = async (components: BundleBuilderComponent[]) => {
    if (!activeRow) return;
    setError(null);
    setSaving(true);
    try {
      const payload = components.map(({ internalProductId, quantity }) => ({ internalProductId, quantity }));
      if (activeRow.existingMapping?.isBundle && activeRow.existingMapping.linkId) {
        await editBundle({
          linkId: activeRow.existingMapping.linkId,
          components: payload,
        });
      } else {
        await confirmBundle({
          integrationId,
          row: activeRow,
          components: payload,
        });
      }
      setSuccessFor({
        row: activeRow,
        internalProductName: `Bundle (${components.length} components)`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleFinishSuccess = () => {
    setSuccessFor(null);
    setBundleMode(false);
    closeSelection();
  };

  const handleKeepSuccess = () => {
    setSuccessFor(null);
    setBundleMode(false);
    closeSelection();
  };

  if (catalog.isLoading) {
    return (
      <div className="container mx-auto p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">Loading catalog…</p>
      </div>
    );
  }

  if (catalog.error) {
    return (
      <div className="container mx-auto p-4 sm:p-6 space-y-3">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm font-medium">Couldn&apos;t load catalog</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {catalog.error instanceof Error ? catalog.error.message : String(catalog.error)}
        </p>
        <Button onClick={() => catalog.refetch()}>Retry</Button>
      </div>
    );
  }

  const integration = catalog.data?.integration;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="border-b px-3 sm:px-6 py-3 space-y-2">
        <Link
          href="/admin/product-mappings"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to mappings
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            {integration && (
              <PlatformBadge platform={integration.platform as PlatformType} size="sm" />
            )}
            <h1 className="text-lg sm:text-xl font-semibold">
              {integration?.name ?? "Catalog"}
            </h1>
          </div>
          <RefreshButton
            fetchedAt={catalog.data?.fetchedAt}
            onRefresh={() => catalog.refetch()}
            refreshing={catalog.isFetching}
          />
        </div>

        {prefillRow && (
          <p data-testid="mass-map-prefill-chip" className="text-xs text-muted-foreground">
            {`pre-selected from the reconciliation page${prefill?.sku ? ` — sku ${prefill.sku}` : ""}`}
          </p>
        )}

        {prefillMissing && (
          <Card
            data-testid="mass-map-prefill-missing"
            className="border-yellow-500/40 bg-yellow-500/5 p-2 text-xs text-yellow-700 dark:text-yellow-300"
          >
            {PREFILL_NOT_IN_CATALOG}
          </Card>
        )}

        {catalog.data?.warnings.length ? (
          <Card className="bg-yellow-500/5 border-yellow-500/40 p-2 text-xs">
            <p className="font-semibold text-yellow-700 dark:text-yellow-300 mb-1">
              Partial catalog
            </p>
            <ul className="list-disc list-inside text-yellow-700/80 dark:text-yellow-300/80">
              {catalog.data.warnings.slice(0, 3).map((w, i) => (
                <li key={i}>
                  {w.kind === "page-cap-reached"
                    ? w.message
                    : `${w.parentTitle}: ${w.message}`}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "unmapped" | "mapped")}
        className="flex-1 flex flex-col min-h-0"
      >
        <TabsList className="mx-3 sm:mx-6 mt-3 self-start">
          <TabsTrigger value="unmapped">
            Unmapped <span className="ml-1 opacity-70">{unmapped.length}</span>
          </TabsTrigger>
          <TabsTrigger value="mapped">
            Mapped <span className="ml-1 opacity-70">{mapped.length}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value={tab}
          className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-0 lg:gap-4 px-0 lg:px-6 pb-6"
        >
          <Card className="flex-1 min-h-0 lg:rounded-lg rounded-none border-x-0 lg:border-x overflow-hidden">
            <ExternalProductList
              rows={currentRows}
              activeRowKey={activeKey}
              savingKey={saving && activeRow ? rowKey(activeRow) : null}
              errorKey={error && activeRow ? rowKey(activeRow) : null}
              onRowSelect={selectRow}
              scrollToKey={prefillRow === null ? null : prefillKey}
            />
          </Card>

          {isDesktop && (
            <Card className="flex flex-col p-4 sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-auto">
              <InternalProductPicker
                row={activeRow}
                index={enrichedIndex}
                indexLoading={indexLoading}
                saving={saving}
                errorMessage={error}
                successFor={successFor}
                onConfirm={handleConfirm}
                onCancel={closeSelection}
                onFinishSuccess={handleFinishSuccess}
                onKeepSuccess={handleKeepSuccess}
                bundleMode={bundleMode}
                bundleSeed={bundleSeed}
                onRetryBundleSeed={() => activeRow && selectRow(activeRow)}
                onConfirmBundle={handleConfirmBundle}
                onConvertToBundle={() => setBundleMode(true)}
                onConvertToSingle={() => setBundleMode(false)}
              />
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {!isDesktop && (
        <Sheet
          open={!!activeRow}
          onOpenChange={(o) => {
            if (!o) closeSelection();
          }}
        >
          <SheetContent side="bottom" className="h-[85vh] overflow-auto">
            <SheetHeader>
              <SheetTitle>Map product</SheetTitle>
              <SheetDescription>Pick an internal product to map.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              <InternalProductPicker
                row={activeRow}
                index={enrichedIndex}
                indexLoading={indexLoading}
                saving={saving}
                errorMessage={error}
                successFor={successFor}
                onConfirm={handleConfirm}
                onCancel={closeSelection}
                onFinishSuccess={handleFinishSuccess}
                onKeepSuccess={handleKeepSuccess}
                bundleMode={bundleMode}
                bundleSeed={bundleSeed}
                onRetryBundleSeed={() => activeRow && selectRow(activeRow)}
                onConfirmBundle={handleConfirmBundle}
                onConvertToBundle={() => setBundleMode(true)}
                onConvertToSingle={() => setBundleMode(false)}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
