"use client";

import { useMemo, useState } from "react";
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
import { InternalProductPicker } from "./internal-product-picker";
import { RefreshButton } from "./refresh-button";
import { useIsDesktop } from "./use-viewport";

interface Props {
  integrationId: string;
}

export function MassMapClient({ integrationId }: Props) {
  const catalog = useCatalog(integrationId);
  const { index, isLoading: indexLoading } = useInternalProductIndex();
  const { confirm } = useRowActions();
  const isDesktop = useIsDesktop();

  const [activeRow, setActiveRow] = useState<CatalogRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successFor, setSuccessFor] = useState<
    { row: CatalogRow; internalProductName: string } | null
  >(null);
  const [tab, setTab] = useState<"unmapped" | "mapped">("unmapped");

  const rows = catalog.data?.rows ?? [];
  const unmapped = useMemo(() => rows.filter((r) => !r.alreadyMapped), [rows]);
  const mapped = useMemo(() => rows.filter((r) => r.alreadyMapped), [rows]);
  const currentRows = tab === "unmapped" ? unmapped : mapped;
  const activeKey = activeRow ? rowKey(activeRow) : null;

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

  const handleFinishSuccess = () => {
    setSuccessFor(null);
    setActiveRow(null);
  };

  const handleKeepSuccess = () => {
    setSuccessFor(null);
    setActiveRow(null);
  };

  const handleSelectRow = (row: CatalogRow) => {
    setError(null);
    setSuccessFor(null);
    setActiveRow(row);
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
              onRowSelect={handleSelectRow}
            />
          </Card>

          {isDesktop && (
            <Card className="flex flex-col p-4 sticky top-4 self-start max-h-[calc(100vh-6rem)] overflow-auto">
              <InternalProductPicker
                row={activeRow}
                index={index}
                indexLoading={indexLoading}
                saving={saving}
                errorMessage={error}
                successFor={successFor}
                onConfirm={handleConfirm}
                onCancel={() => setActiveRow(null)}
                onFinishSuccess={handleFinishSuccess}
                onKeepSuccess={handleKeepSuccess}
              />
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {!isDesktop && (
        <Sheet
          open={!!activeRow}
          onOpenChange={(o) => !o && setActiveRow(null)}
        >
          <SheetContent side="bottom" className="h-[85vh] overflow-auto">
            <SheetHeader>
              <SheetTitle>Map product</SheetTitle>
              <SheetDescription>Pick an internal product to map.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              <InternalProductPicker
                row={activeRow}
                index={index}
                indexLoading={indexLoading}
                saving={saving}
                errorMessage={error}
                successFor={successFor}
                onConfirm={handleConfirm}
                onCancel={() => setActiveRow(null)}
                onFinishSuccess={handleFinishSuccess}
                onKeepSuccess={handleKeepSuccess}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
