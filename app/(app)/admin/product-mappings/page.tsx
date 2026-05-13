"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Link2, Search, Trash2, Plus, Loader2, DollarSign, Check, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Separator } from "@/components/ui/separator";
import { ProductMapDialog } from "@/components/products/product-map-dialog";
import { BulkMapChooserDialog } from "@/components/products/mass-map/bulk-map-chooser-dialog";
import { PlatformBadge } from "@/components/orders/platform-badge";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import type { PlatformType } from "@/types/external-orders";

interface MappingEntry {
  id: string;
  integrationId: string;
  internalProductId: number;
  externalProductId: string;
  externalVariantId: string | null;
  externalSku: string | null;
  externalTitle: string | null;
  createdAt: string;
  internalProduct: {
    id: number;
    name: string;
    baseName: string | null;
    variant: string | null;
    priceSourceLinkId: string | null;
    retailPrice: number;
  };
  integration: {
    id: string;
    name: string;
    platform: string;
    storeUrl: string;
  };
}

interface MappingsResponse {
  mappings: MappingEntry[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

interface Integration {
  id: string;
  name: string;
  platform: string;
  storeUrl: string;
}

export default function AdminProductMappingsPage() {
  const router = useRouter();
  const { token: csrfToken } = useCSRF();
  const [mappings, setMappings] = useState<MappingEntry[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [integrationFilter, setIntegrationFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  // Delete confirmation
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingMapping, setDeletingMapping] = useState<MappingEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Bulk map chooser dialog
  const [chooserOpen, setChooserOpen] = useState(false);

  // Add mapping dialog
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addIntegrationId, setAddIntegrationId] = useState<string | null>(null);
  const [settingPriceSource, setSettingPriceSource] = useState<string | null>(null);

  const handleSetPriceSource = async (
    mapping: MappingEntry,
    clear: boolean = false
  ) => {
    if (!csrfToken) return;
    setSettingPriceSource(mapping.id);
    try {
      const response = await fetch(
        `/api/products/${mapping.internalProductId}/price-source`,
        {
          method: "POST",
          headers: withCSRFHeaders(
            { "Content-Type": "application/json" },
            csrfToken
          ),
          body: JSON.stringify({
            linkId: clear ? null : mapping.id,
            syncNow: !clear,
          }),
        }
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to set price source");
      }

      if (clear) {
        toast.success(`Cleared price source for ${mapping.internalProduct.name}`);
      } else {
        toast.success(
          `Price source set for ${mapping.internalProduct.name}${
            data.retailPrice != null ? ` → $${Number(data.retailPrice).toFixed(2)}` : ""
          }`
        );
      }
      await fetchMappings();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update price source"
      );
    } finally {
      setSettingPriceSource(null);
    }
  };

  const fetchMappings = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        page: page.toString(),
        pageSize: "50",
      });
      if (integrationFilter && integrationFilter !== "all") {
        params.set("integrationId", integrationFilter);
      }
      if (search) {
        params.set("search", search);
      }

      const response = await fetch(`/api/admin/product-mappings?${params}`);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          router.push("/auth/signin");
          return;
        }
        throw new Error("Failed to fetch mappings");
      }

      const data: MappingsResponse = await response.json();
      setMappings(data.mappings);
      setTotalPages(data.pagination.totalPages);
      setTotal(data.pagination.total);
    } catch (error) {
      console.error("Error fetching mappings:", error);
      toast.error("Failed to load product mappings");
    } finally {
      setLoading(false);
    }
  }, [page, integrationFilter, search, router]);

  const fetchIntegrations = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/integrations");
      if (response.ok) {
        const data = await response.json();
        const intList = data.integrations || data || [];
        setIntegrations(intList);
      }
    } catch (error) {
      console.error("Error fetching integrations:", error);
    }
  }, []);

  useEffect(() => {
    fetchMappings();
  }, [fetchMappings]);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  const handleDelete = async () => {
    if (!deletingMapping || !csrfToken) return;

    setIsDeleting(true);
    try {
      const params = new URLSearchParams({ linkId: deletingMapping.id });
      const response = await fetch(
        `/api/admin/product-mappings?${params}`,
        {
          method: "DELETE",
          headers: withCSRFHeaders({}, csrfToken),
        }
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete mapping");
      }

      toast.success("Product mapping deleted");
      setDeleteDialogOpen(false);
      setDeletingMapping(null);
      fetchMappings();
    } catch (error) {
      console.error("Error deleting mapping:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to delete mapping"
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBulkMap = () => {
    if (integrations.length === 0) {
      toast.error("No integrations configured. Add an integration first.");
      return;
    }
    if (integrationFilter !== "all") {
      router.push(`/admin/product-mappings/${integrationFilter}/map`);
      return;
    }
    if (integrations.length === 1) {
      router.push(`/admin/product-mappings/${integrations[0].id}/map`);
      return;
    }
    setChooserOpen(true);
  };

  const handleAddMapping = () => {
    if (integrations.length === 0) {
      toast.error("No integrations configured. Add an integration first.");
      return;
    }
    // Use the first integration or the selected filter
    const defaultIntId =
      integrationFilter !== "all" ? integrationFilter : integrations[0]?.id;
    setAddIntegrationId(defaultIntId || null);
    setAddDialogOpen(true);
  };

  // Group mappings by integration
  const groupedMappings: Record<string, MappingEntry[]> = {};
  for (const mapping of mappings) {
    const key = mapping.integrationId;
    if (!groupedMappings[key]) {
      groupedMappings[key] = [];
    }
    groupedMappings[key].push(mapping);
  }

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div>
            <h1 className="text-3xl font-bold">Product Mappings</h1>
            <p className="text-sm text-muted-foreground">
              Map external products to internal inventory products
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button onClick={handleBulkMap} variant="outline">
              <Layers className="h-4 w-4 mr-2" />
              Bulk Map
            </Button>
            <Button onClick={handleAddMapping}>
              <Plus className="h-4 w-4 mr-2" />
              Add Mapping
            </Button>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
              <div className="w-full sm:w-48">
                <Select
                  value={integrationFilter}
                  onValueChange={(value) => {
                    setIntegrationFilter(value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All Integrations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Integrations</SelectItem>
                    {integrations.map((integration) => (
                      <SelectItem key={integration.id} value={integration.id}>
                        {integration.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 max-w-md min-w-0">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by product name or SKU..."
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    className="pl-9"
                  />
                </div>
              </div>
              <div className="text-sm text-muted-foreground self-center">
                {total} {total === 1 ? "mapping" : "mappings"}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Empty state */}
        {!loading && mappings.length === 0 && (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Link2 className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-1">No product mappings</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {search || integrationFilter !== "all"
                  ? "No mappings match your filters."
                  : "Create your first mapping to link external products to internal inventory."}
              </p>
              {!search && integrationFilter === "all" && (
                <Button onClick={handleAddMapping} variant="outline">
                  <Plus className="h-4 w-4 mr-2" />
                  Add Mapping
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* Grouped mappings */}
        {!loading &&
          Object.entries(groupedMappings).map(
            ([integrationId, integrationMappings]) => {
              const integration = integrationMappings[0]?.integration;
              if (!integration) return null;

              return (
                <Card key={integrationId}>
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-base">
                      <PlatformBadge
                        platform={integration.platform as PlatformType}
                        size="sm"
                      />
                      <span>{integration.name}</span>
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {integrationMappings.length}{" "}
                        {integrationMappings.length === 1
                          ? "mapping"
                          : "mappings"}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {/* Table Header */}
                      <div className="hidden sm:grid sm:grid-cols-[1fr_auto_1fr_auto] gap-4 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <span>Internal Product</span>
                        <span className="w-8 text-center" />
                        <span>External Product</span>
                        <span className="w-10" />
                      </div>
                      <Separator />

                      {integrationMappings.map((mapping) => (
                        <div
                          key={mapping.id}
                          className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr_auto] gap-2 sm:gap-4 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors items-center"
                        >
                          {/* Internal product */}
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">
                              {mapping.internalProduct.name}
                            </p>
                            {mapping.internalProduct.baseName && (
                              <p className="text-xs text-muted-foreground">
                                {mapping.internalProduct.baseName}
                                {mapping.internalProduct.variant
                                  ? ` / ${mapping.internalProduct.variant}`
                                  : ""}
                              </p>
                            )}
                          </div>

                          {/* Arrow */}
                          <div className="hidden sm:flex items-center justify-center w-8">
                            <Link2 className="h-4 w-4 text-muted-foreground" />
                          </div>

                          {/* External product */}
                          <div className="min-w-0">
                            <p className="text-sm truncate">
                              {mapping.externalTitle || mapping.externalProductId}
                            </p>
                            {mapping.externalSku && (
                              <p className="text-xs text-muted-foreground">
                                SKU: {mapping.externalSku}
                              </p>
                            )}
                            {mapping.externalVariantId && (
                              <p className="text-xs text-muted-foreground">
                                Variant ID: {mapping.externalVariantId}
                              </p>
                            )}
                          </div>

                          {/* Price source + Delete buttons */}
                          <div className="flex items-center justify-end gap-1">
                            {mapping.internalProduct.priceSourceLinkId === mapping.id ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-xs text-green-700 dark:text-green-400"
                                disabled={settingPriceSource === mapping.id}
                                onClick={() => handleSetPriceSource(mapping, true)}
                                title="Clear price source"
                              >
                                {settingPriceSource === mapping.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <>
                                    <Check className="h-3 w-3 mr-1" />
                                    Price Source
                                  </>
                                )}
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 px-2 text-xs text-muted-foreground"
                                disabled={settingPriceSource === mapping.id}
                                onClick={() => handleSetPriceSource(mapping)}
                                title="Set as price source for retail price"
                              >
                                {settingPriceSource === mapping.id ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <>
                                    <DollarSign className="h-3 w-3 mr-1" />
                                    Set Price
                                  </>
                                )}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => {
                                setDeletingMapping(mapping);
                                setDeleteDialogOpen(true);
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            }
          )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex justify-center gap-2">
            <Button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              variant="outline"
              size="sm"
            >
              Previous
            </Button>
            <span className="px-4 py-2 text-sm">
              Page {page} of {totalPages}
            </span>
            <Button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              variant="outline"
              size="sm"
            >
              Next
            </Button>
          </div>
        )}
      </div>

      <BulkMapChooserDialog
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        integrations={integrations}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Product Mapping</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingMapping && (
                <>
                  Are you sure you want to delete the mapping between{" "}
                  <span className="font-medium">
                    {deletingMapping.internalProduct.name}
                  </span>{" "}
                  and{" "}
                  <span className="font-medium">
                    {deletingMapping.externalTitle ||
                      deletingMapping.externalProductId}
                  </span>
                  ? Order items using this mapping will become unmapped.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete Mapping"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Mapping Dialog - opens ProductMapDialog in proactive mode */}
      {addIntegrationId && (
        <ProductMapDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          integrationId={addIntegrationId}
          onMapped={() => {
            fetchMappings();
          }}
        />
      )}
    </div>
  );
}
