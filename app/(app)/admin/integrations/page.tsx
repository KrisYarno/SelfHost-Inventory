"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Plug, Plus, Pencil, Trash2, Copy, Link2, Power, PowerOff, RefreshCw, Loader2, ChevronDown, ChevronRight, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  useIntegrations,
  useCompanies,
  useCreateIntegration,
  useUpdateIntegration,
  useToggleIntegrationField,
  useDeleteIntegration,
  useSyncIntegration,
  useStockSyncIntegration,
  usePriceSyncIntegration,
  type Integration,
  type IntegrationFormData,
} from "@/hooks/use-integrations";

export default function AdminIntegrationsPage() {
  const router = useRouter();

  const integrationsQuery = useIntegrations();
  const companiesQuery = useCompanies();
  const integrations = integrationsQuery.data ?? [];
  const companies = companiesQuery.data ?? [];
  const loading = integrationsQuery.isLoading || companiesQuery.isLoading;

  const createIntegration = useCreateIntegration();
  const updateIntegration = useUpdateIntegration();
  const toggleFieldMutation = useToggleIntegrationField();
  const deleteIntegration = useDeleteIntegration();
  const syncIntegration = useSyncIntegration();
  const stockSyncIntegration = useStockSyncIntegration();
  const priceSyncIntegration = usePriceSyncIntegration();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingIntegration, setEditingIntegration] = useState<Integration | null>(null);
  const [formData, setFormData] = useState<IntegrationFormData>({
    companyId: "",
    platform: "SHOPIFY",
    name: "",
    storeUrl: "",
    writeKey: "",
    writeSecret: "",
    readKey: "",
    readSecret: "",
    webhookSecret: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [syncTarget, setSyncTarget] = useState<Integration | null>(null);
  const [syncLookbackDays, setSyncLookbackDays] = useState("1");
  const [syncMaxOrders, setSyncMaxOrders] = useState("250");
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [stockSyncing, setStockSyncing] = useState<Set<string>>(new Set());
  const [priceSyncing, setPriceSyncing] = useState<Set<string>>(new Set());
  const [togglingField, setTogglingField] = useState<string | null>(null);

  // Redirect on auth failure; toast other load errors (mirrors the original fetchData catch).
  useEffect(() => {
    const err = integrationsQuery.error || companiesQuery.error;
    if (!err) return;
    if (err.status === 401) {
      router.push("/auth/signin");
    } else {
      toast.error("Failed to load data");
    }
  }, [integrationsQuery.error, companiesQuery.error, router]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const result = await createIntegration.mutateAsync(formData);

      // Show webhook URL
      const baseUrl = window.location.origin;
      const generatedWebhookUrl = `${baseUrl}/api/webhooks/${result.integration.id}`;
      setWebhookUrl(generatedWebhookUrl);

      toast.success("Integration created successfully");
    } catch (error) {
      console.error("Error creating integration:", error);
      toast.error(error instanceof Error ? error.message : "Failed to create integration");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingIntegration) return;

    setSubmitting(true);

    try {
      await updateIntegration.mutateAsync({ id: editingIntegration.id, body: formData });

      toast.success("Integration updated successfully");
      setIsEditDialogOpen(false);
      setEditingIntegration(null);
      resetForm();
    } catch (error) {
      console.error("Error updating integration:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update integration");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (integration: Integration) => {
    if (
      !confirm(
        `Are you sure you want to delete the integration for ${integration.name}? This will also delete all associated orders. This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      await deleteIntegration.mutateAsync(integration.id);

      toast.success("Integration deleted successfully");
    } catch (error) {
      console.error("Error deleting integration:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete integration");
    }
  };

  const handleToggleActive = async (integration: Integration) => {
    try {
      await updateIntegration.mutateAsync({
        id: integration.id,
        body: { isActive: !integration.isActive },
      });

      toast.success(
        `Integration ${!integration.isActive ? "activated" : "deactivated"}`
      );
    } catch (error) {
      console.error("Error toggling integration:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update integration");
    }
  };

  const openEditDialog = (integration: Integration) => {
    setEditingIntegration(integration);
    setFormData({
      companyId: integration.companyId,
      platform: integration.platform,
      name: integration.name,
      storeUrl: integration.storeUrl,
      writeKey: "",
      writeSecret: "",
      readKey: "",
      readSecret: "",
      webhookSecret: "",
    });
    setIsEditDialogOpen(true);
  };

  const resetForm = () => {
    setFormData({
      companyId: "",
      platform: "SHOPIFY",
      name: "",
      storeUrl: "",
      writeKey: "",
      writeSecret: "",
      readKey: "",
      readSecret: "",
      webhookSecret: "",
    });
  };

  const copyWebhookUrl = (integrationId: string) => {
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/api/webhooks/${integrationId}`;
    navigator.clipboard.writeText(url);
    toast.success("Webhook URL copied to clipboard");
  };

  const handleSync = async (integration: Integration, options?: { lookbackDays?: number; maxOrders?: number }) => {
    try {
      const data = await syncIntegration.mutateAsync({ id: integration.id, options: options || {} });

      toast.success(
        `Synced ${integration.name}: ${data.result?.upserted ?? 0} updated, ${data.result?.skipped ?? 0} skipped`
      );
    } catch (error) {
      console.error("Error syncing integration:", error);
      toast.error(error instanceof Error ? error.message : "Sync failed");
    }
  };

  const openSyncDialog = (integration: Integration) => {
    setSyncTarget(integration);
    setSyncLookbackDays("1");
    setSyncMaxOrders("250");
    setSyncDialogOpen(true);
  };

  const toggleExpanded = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleField = async (
    integration: Integration,
    field: "stockSyncEnabled" | "fulfillmentPushEnabled",
    value: boolean
  ) => {
    const key = `${integration.id}-${field}`;
    setTogglingField(key);
    try {
      await toggleFieldMutation.mutateAsync({ id: integration.id, field, value });

      const label = field === "stockSyncEnabled" ? "Stock sync" : "Fulfillment push";
      toast.success(`${label} ${value ? "enabled" : "disabled"}`);
    } catch (error) {
      console.error(`Error toggling ${field}:`, error);
      toast.error(error instanceof Error ? error.message : `Failed to update ${field}`);
    } finally {
      setTogglingField(null);
    }
  };

  const handleStockSyncNow = async (integration: Integration) => {
    setStockSyncing((prev) => new Set(prev).add(integration.id));
    try {
      const data = await stockSyncIntegration.mutateAsync(integration.id);

      const result = data.result || data;
      toast.success(
        `Stock sync complete: ${result.synced ?? 0} synced, ${result.failed ?? 0} failed`
      );
    } catch (error) {
      console.error("Error syncing stock:", error);
      toast.error(error instanceof Error ? error.message : "Stock sync failed");
    } finally {
      setStockSyncing((prev) => {
        const next = new Set(prev);
        next.delete(integration.id);
        return next;
      });
    }
  };

  const handlePriceSyncNow = async (integration: Integration) => {
    setPriceSyncing((prev) => new Set(prev).add(integration.id));
    try {
      const data = await priceSyncIntegration.mutateAsync(integration.id);

      const result = data.result || data;
      toast.success(
        `Price sync complete: ${result.synced ?? 0} synced, ${result.skipped ?? 0} skipped, ${(result.failed ?? []).length} failed`
      );
    } catch (error) {
      console.error("Error syncing prices:", error);
      toast.error(error instanceof Error ? error.message : "Price sync failed");
    } finally {
      setPriceSyncing((prev) => {
        const next = new Set(prev);
        next.delete(integration.id);
        return next;
      });
    }
  };

  const closeCreateDialog = () => {
    setIsCreateDialogOpen(false);
    setWebhookUrl("");
    resetForm();
  };

  const groupedIntegrations = integrations.reduce((acc, integration) => {
    const companyName = integration.company.name;
    if (!acc[companyName]) {
      acc[companyName] = [];
    }
    acc[companyName].push(integration);
    return acc;
  }, {} as Record<string, Integration[]>);

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div>
            <h1 className="text-3xl font-bold">Integrations</h1>
            <p className="text-sm text-muted-foreground">
              Manage e-commerce platform integrations
            </p>
          </div>
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Integration
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <form onSubmit={handleCreate}>
                <DialogHeader>
                  <DialogTitle>Create New Integration</DialogTitle>
                  <DialogDescription>
                    Connect a new e-commerce platform
                  </DialogDescription>
                </DialogHeader>

                {webhookUrl ? (
                  <div className="space-y-4 py-4">
                    <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950/30 p-4 space-y-4">
                      <h3 className="font-semibold text-green-900 dark:text-green-300">Integration Created!</h3>

                      <div className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wider text-green-800 dark:text-green-400">
                          Webhook Delivery URL
                        </p>
                        <p className="text-xs text-green-700 dark:text-green-400">
                          Paste this into your {formData.platform === "WOOCOMMERCE" ? "WooCommerce → Settings → Advanced → Webhooks" : "Shopify → Settings → Notifications → Webhooks"} setup.
                        </p>
                        <div className="flex gap-2">
                          <Input
                            value={webhookUrl}
                            readOnly
                            className="font-mono text-xs"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(webhookUrl);
                              toast.success("Webhook URL copied!");
                            }}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="text-xs font-medium uppercase tracking-wider text-green-800 dark:text-green-400">
                          Webhook Secret
                        </p>
                        <p className="text-xs text-green-700 dark:text-green-400">
                          Use this exact secret in the &quot;Secret&quot; field when creating each webhook.
                        </p>
                        <div className="flex gap-2">
                          <Input
                            value={formData.webhookSecret}
                            readOnly
                            type={showWebhookSecret ? "text" : "password"}
                            className="font-mono text-xs"
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                          >
                            {showWebhookSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              navigator.clipboard.writeText(formData.webhookSecret);
                              toast.success("Webhook secret copied!");
                            }}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {formData.platform === "WOOCOMMERCE" && (
                        <div className="rounded-md border border-green-300 dark:border-green-800 bg-green-100/50 dark:bg-green-900/20 p-3 text-xs text-green-800 dark:text-green-300 space-y-1">
                          <p className="font-medium">WooCommerce Setup Steps:</p>
                          <ol className="list-decimal list-inside space-y-0.5 text-green-700 dark:text-green-400">
                            <li>Go to WooCommerce → Settings → Advanced → Webhooks</li>
                            <li>Click &quot;Add webhook&quot;</li>
                            <li>Set Topic to &quot;Order created&quot;, paste the Delivery URL and Secret above</li>
                            <li>Set API Version to &quot;WP REST API Integration v3&quot;</li>
                            <li>Repeat for &quot;Order updated&quot;, &quot;Order deleted&quot;, and &quot;Order restored&quot;</li>
                          </ol>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <label htmlFor="company" className="text-sm font-medium">
                        Company
                      </label>
                      <Select
                        value={formData.companyId}
                        onValueChange={(value) =>
                          setFormData({ ...formData, companyId: value })
                        }
                        required
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a company" />
                        </SelectTrigger>
                        <SelectContent>
                          {companies.map((company) => (
                            <SelectItem key={company.id} value={company.id}>
                              {company.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="platform" className="text-sm font-medium">
                        Platform
                      </label>
                      <Select
                        value={formData.platform}
                        onValueChange={(value: "SHOPIFY" | "WOOCOMMERCE") =>
                          setFormData({ ...formData, platform: value })
                        }
                        required
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="SHOPIFY">Shopify</SelectItem>
                          <SelectItem value="WOOCOMMERCE">WooCommerce</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="name" className="text-sm font-medium">
                        Store Name
                      </label>
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) =>
                          setFormData({ ...formData, name: e.target.value })
                        }
                        placeholder="My Store"
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="storeUrl" className="text-sm font-medium">
                        Store URL
                      </label>
                      <Input
                        id="storeUrl"
                        type="url"
                        value={formData.storeUrl}
                        onChange={(e) =>
                          setFormData({ ...formData, storeUrl: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "https://mystore.myshopify.com"
                            : "https://mystore.com"
                        }
                        required
                      />
                    </div>

                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-1">
                      <p className="text-sm font-medium">Write credential</p>
                      <p className="text-xs text-muted-foreground">
                        The only key that can change anything in your store. Used
                        exclusively by stock-status and order-status pushes, and only
                        when the platform-write posture allows them.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="writeKey" className="text-sm font-medium">
                        {formData.platform === "SHOPIFY"
                          ? "Admin API Access Token (write)"
                          : "Write Consumer Key"}
                      </label>
                      <Input
                        id="writeKey"
                        type="password"
                        value={formData.writeKey}
                        onChange={(e) =>
                          setFormData({ ...formData, writeKey: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "shpat_... (Admin API access token)"
                            : "ck_... (WooCommerce key with Write permission)"
                        }
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="writeSecret" className="text-sm font-medium">
                        {formData.platform === "SHOPIFY"
                          ? "API Secret Key (write)"
                          : "Write Consumer Secret"}
                      </label>
                      <Input
                        id="writeSecret"
                        type="password"
                        value={formData.writeSecret}
                        onChange={(e) =>
                          setFormData({ ...formData, writeSecret: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "Your app's API secret key"
                            : "cs_... (WooCommerce consumer secret)"
                        }
                        required
                      />
                    </div>

                    <div className="rounded-md border border-border bg-surface p-3 space-y-1">
                      <p className="text-sm font-medium">
                        Read credential{" "}
                        <span className="text-muted-foreground font-normal">
                          (recommended)
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        A <strong>Read</strong>-permission key. Every sync, catalog
                        fetch, and product search uses this one — so none of them can
                        alter your store even if something goes wrong. Leave blank to
                        reuse the write key for reads; a health warning will remind you
                        until you set it.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="readKey" className="text-sm font-medium">
                        {formData.platform === "SHOPIFY"
                          ? "Admin API Access Token (read-only)"
                          : "Read Consumer Key"}
                      </label>
                      <Input
                        id="readKey"
                        type="password"
                        value={formData.readKey}
                        onChange={(e) =>
                          setFormData({ ...formData, readKey: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "shpat_... (read-only scopes)"
                            : "ck_... (WooCommerce key with Read permission)"
                        }
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="readSecret" className="text-sm font-medium">
                        {formData.platform === "SHOPIFY"
                          ? "API Secret Key (read-only)"
                          : "Read Consumer Secret"}
                      </label>
                      <Input
                        id="readSecret"
                        type="password"
                        value={formData.readSecret}
                        onChange={(e) =>
                          setFormData({ ...formData, readSecret: e.target.value })
                        }
                        placeholder="cs_... (paired with the read key)"
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="webhookSecret" className="text-sm font-medium">
                        Webhook Secret
                      </label>
                      <Input
                        id="webhookSecret"
                        type="password"
                        value={formData.webhookSecret}
                        onChange={(e) =>
                          setFormData({ ...formData, webhookSecret: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "Your Shopify webhook signing secret"
                            : "Enter WooCommerce webhook secret"
                        }
                        required={formData.platform === "WOOCOMMERCE"}
                      />
                      <p className="text-xs text-muted-foreground">
                        Used to verify incoming webhooks. This is a{" "}
                        <strong>separate secret</strong> from the API credentials above
                        — the app no longer falls back to the API secret for signature
                        verification.
                      </p>
                    </div>
                  </div>
                )}

                <DialogFooter>
                  {webhookUrl ? (
                    <Button type="button" onClick={closeCreateDialog}>
                      Close
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={closeCreateDialog}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={submitting || !formData.companyId}>
                        {submitting ? "Creating..." : "Create Integration"}
                      </Button>
                    </>
                  )}
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {loading ? (
          <Card>
            <CardContent className="text-center py-8 text-muted-foreground">
              Loading integrations...
            </CardContent>
          </Card>
        ) : Object.keys(groupedIntegrations).length === 0 ? (
          <Card>
            <CardContent className="text-center py-8 text-muted-foreground">
              No integrations found. Create your first integration to get started.
            </CardContent>
          </Card>
        ) : (
          Object.entries(groupedIntegrations).map(([companyName, companyIntegrations]) => (
            <Card key={companyName}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Plug className="h-5 w-5" />
                  {companyName}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Platform</TableHead>
                        <TableHead>Store Name</TableHead>
                        <TableHead>Store URL</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Last Sync</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {companyIntegrations.map((integration) => {
                        const isExpanded = expandedRows.has(integration.id);
                        const isSyncingStock = stockSyncing.has(integration.id);
                        const platformLabel = integration.platform === "SHOPIFY" ? "Shopify" : "WooCommerce";

                        return (
                          <React.Fragment key={integration.id}>
                            <TableRow
                              className="cursor-pointer"
                              onClick={() => toggleExpanded(integration.id)}
                            >
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  {isExpanded ? (
                                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                                  )}
                                  <Badge variant="outline">{platformLabel}</Badge>
                                </div>
                              </TableCell>
                              <TableCell className="font-medium">
                                {integration.name}
                              </TableCell>
                              <TableCell>
                                <a
                                  href={integration.storeUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {integration.storeUrl}
                                  <Link2 className="h-3 w-3" />
                                </a>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <Badge variant={integration.isActive ? "default" : "secondary"}>
                                    {integration.isActive ? "Active" : "Inactive"}
                                  </Badge>
                                  {/* Sync status dot */}
                                  {integration.stockSyncEnabled && (
                                    <span
                                      className={`inline-block h-2 w-2 rounded-full ${
                                        integration.lastStockSyncError
                                          ? "bg-amber-500"
                                          : "bg-green-500"
                                      }`}
                                      title={
                                        integration.lastStockSyncError
                                          ? "Stock sync has errors"
                                          : "Stock sync healthy"
                                      }
                                    />
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground">
                                {integration.lastSyncAt
                                  ? new Date(integration.lastSyncAt).toLocaleString()
                                  : "Never"}
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => copyWebhookUrl(integration.id)}
                                    title="Copy webhook URL"
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openSyncDialog(integration)}
                                    title="Sync recent orders"
                                  >
                                    <RefreshCw className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleToggleActive(integration)}
                                    title={integration.isActive ? "Deactivate" : "Activate"}
                                  >
                                    {integration.isActive ? (
                                      <PowerOff className="h-3 w-3" />
                                    ) : (
                                      <Power className="h-3 w-3" />
                                    )}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => openEditDialog(integration)}
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => handleDelete(integration)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>

                            {/* Expanded row: sync toggles, status, sync button */}
                            {isExpanded && (
                              <TableRow>
                                <TableCell colSpan={6} className="bg-muted/30 px-6 py-4">
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    {/* Stock Sync toggle */}
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Stock Sync</p>
                                          <p className="text-xs text-muted-foreground">
                                            Push stock status to {platformLabel}
                                          </p>
                                        </div>
                                        <Switch
                                          checked={integration.stockSyncEnabled}
                                          disabled={togglingField === `${integration.id}-stockSyncEnabled`}
                                          onCheckedChange={(checked) =>
                                            handleToggleField(integration, "stockSyncEnabled", checked)
                                          }
                                        />
                                      </div>

                                      {/* Last Synced display */}
                                      {integration.stockSyncEnabled && (
                                        <div className="text-xs text-muted-foreground">
                                          Last synced:{" "}
                                          {integration.lastStockSyncAt
                                            ? formatDistanceToNow(
                                                new Date(integration.lastStockSyncAt),
                                                { addSuffix: true }
                                              )
                                            : "Never"}
                                        </div>
                                      )}

                                      {/* Sync Stock Now button */}
                                      {integration.stockSyncEnabled && (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          disabled={isSyncingStock}
                                          onClick={() => handleStockSyncNow(integration)}
                                        >
                                          {isSyncingStock ? (
                                            <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                          ) : (
                                            <RefreshCw className="h-3 w-3 mr-2" />
                                          )}
                                          Sync Stock Now
                                        </Button>
                                      )}

                                      {/* Error display */}
                                      {integration.lastStockSyncError && (
                                        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                                          <div className="flex items-start gap-2">
                                            <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                                            <div className="text-xs text-amber-800 break-all">
                                              <p className="font-medium mb-1">Sync Error</p>
                                              <p>{integration.lastStockSyncError}</p>
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>

                                    {/* Fulfillment Push toggle */}
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Fulfillment Push</p>
                                          <p className="text-xs text-muted-foreground">
                                            Update order status on {platformLabel} after fulfillment
                                          </p>
                                        </div>
                                        <Switch
                                          checked={integration.fulfillmentPushEnabled}
                                          disabled={togglingField === `${integration.id}-fulfillmentPushEnabled`}
                                          onCheckedChange={(checked) =>
                                            handleToggleField(integration, "fulfillmentPushEnabled", checked)
                                          }
                                        />
                                      </div>
                                    </div>

                                    {/* Price Sync section */}
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Price Sync</p>
                                          <p className="text-xs text-muted-foreground">
                                            Pull retail prices from {platformLabel} for products with a price source set
                                          </p>
                                        </div>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          disabled={priceSyncing.has(integration.id)}
                                          onClick={() => handlePriceSyncNow(integration)}
                                        >
                                          {priceSyncing.has(integration.id) ? (
                                            <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                          ) : (
                                            <RefreshCw className="h-3 w-3 mr-2" />
                                          )}
                                          Sync All Prices Now
                                        </Button>
                                      </div>
                                    </div>

                                    {/* Webhook Delivery Health (Phase 7c.3) */}
                                    <div className="space-y-3 md:col-span-2 border-t pt-4 mt-2">
                                      <div>
                                        <p className="text-sm font-medium">Webhook Delivery</p>
                                        <p className="text-xs text-muted-foreground">
                                          Last successful delivery and failure tracking
                                        </p>
                                      </div>
                                      <div className="flex flex-col sm:flex-row sm:items-center sm:gap-6 gap-2 text-xs">
                                        <div>
                                          <span className="text-muted-foreground">Last received: </span>
                                          {integration.lastWebhookReceivedAt ? (
                                            <span className="text-green-700 dark:text-green-400 font-medium">
                                              {formatDistanceToNow(
                                                new Date(integration.lastWebhookReceivedAt),
                                                { addSuffix: true }
                                              )}
                                            </span>
                                          ) : (
                                            <span className="text-muted-foreground">Never</span>
                                          )}
                                        </div>
                                        {integration.webhookFailureCount > 0 && (
                                          <div>
                                            <span className="text-muted-foreground">Failures since last success: </span>
                                            <span className="text-red-600 dark:text-red-400 font-medium">
                                              {integration.webhookFailureCount}
                                            </span>
                                          </div>
                                        )}
                                      </div>
                                      {integration.lastWebhookError && (
                                        <div className="rounded-md border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 p-3">
                                          <div className="flex items-start gap-2">
                                            <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                                            <div className="text-xs text-red-800 dark:text-red-300 break-all">
                                              <p className="font-medium mb-1">Most recent webhook error</p>
                                              <p>{integration.lastWebhookError}</p>
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>Edit Integration</DialogTitle>
              <DialogDescription>
                Update integration settings
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Company</label>
                <Input
                  value={companies.find((c) => c.id === formData.companyId)?.name || ""}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Platform</label>
                <Input
                  value={formData.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"}
                  disabled
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-name" className="text-sm font-medium">
                  Store Name
                </label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  required
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-storeUrl" className="text-sm font-medium">
                  Store URL
                </label>
                <Input
                  id="edit-storeUrl"
                  type="url"
                  value={formData.storeUrl}
                  onChange={(e) =>
                    setFormData({ ...formData, storeUrl: e.target.value })
                  }
                  required
                />
              </div>

              {editingIntegration?.credentials && (
                <div className="rounded-md border border-border bg-surface p-3 text-xs space-y-1">
                  <p>
                    Write key:{" "}
                    <strong>
                      {editingIntegration.credentials.hasWriteCredential
                        ? "on file"
                        : "NOT SET — all platform writes are blocked"}
                    </strong>
                  </p>
                  <p>
                    Read key:{" "}
                    <strong>
                      {editingIntegration.credentials.hasReadCredential
                        ? "on file"
                        : "not set — reads fall back to the write key"}
                    </strong>
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <label htmlFor="edit-writeKey" className="text-sm font-medium">
                  {formData.platform === "SHOPIFY"
                    ? "Admin API Access Token (write)"
                    : "Write Consumer Key"}
                </label>
                <Input
                  id="edit-writeKey"
                  type="password"
                  value={formData.writeKey}
                  onChange={(e) =>
                    setFormData({ ...formData, writeKey: e.target.value })
                  }
                  placeholder="Leave blank to keep current value"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-writeSecret" className="text-sm font-medium">
                  {formData.platform === "SHOPIFY"
                    ? "API Secret Key (write)"
                    : "Write Consumer Secret"}
                </label>
                <Input
                  id="edit-writeSecret"
                  type="password"
                  value={formData.writeSecret}
                  onChange={(e) =>
                    setFormData({ ...formData, writeSecret: e.target.value })
                  }
                  placeholder="Leave blank to keep current value"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-readKey" className="text-sm font-medium">
                  {formData.platform === "SHOPIFY"
                    ? "Admin API Access Token (read-only)"
                    : "Read Consumer Key"}
                </label>
                <Input
                  id="edit-readKey"
                  type="password"
                  value={formData.readKey}
                  onChange={(e) =>
                    setFormData({ ...formData, readKey: e.target.value })
                  }
                  placeholder="Leave blank to keep current value"
                />
                <p className="text-xs text-muted-foreground">
                  A Read-permission key. Setting it makes every sync, catalog fetch,
                  and search physically incapable of changing your store.
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-readSecret" className="text-sm font-medium">
                  {formData.platform === "SHOPIFY"
                    ? "API Secret Key (read-only)"
                    : "Read Consumer Secret"}
                </label>
                <Input
                  id="edit-readSecret"
                  type="password"
                  value={formData.readSecret}
                  onChange={(e) =>
                    setFormData({ ...formData, readSecret: e.target.value })
                  }
                  placeholder="Leave blank to keep current value"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-webhookSecret" className="text-sm font-medium">
                  Webhook Secret
                </label>
                <Input
                  id="edit-webhookSecret"
                  type="password"
                  value={formData.webhookSecret}
                  onChange={(e) =>
                    setFormData({ ...formData, webhookSecret: e.target.value })
                  }
                  placeholder="Leave blank to keep current value"
                />
                <p className="text-xs text-muted-foreground">
                  A separate secret from the API credentials — the app no longer falls
                  back to the API secret to verify webhook signatures.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsEditDialogOpen(false);
                  setEditingIntegration(null);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={syncDialogOpen} onOpenChange={setSyncDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sync Recent Orders</DialogTitle>
            <DialogDescription>
              Fetch recently updated orders for this integration without pulling full history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Lookback Days</label>
              <Input
                type="number"
                min="1"
                value={syncLookbackDays}
                onChange={(e) => setSyncLookbackDays(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                If the integration has never synced, a lookback of 7 is recommended.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Max Orders</label>
              <Input
                type="number"
                min="1"
                value={syncMaxOrders}
                onChange={(e) => setSyncMaxOrders(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Caps the number of updated orders fetched in a single run.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setSyncDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!syncTarget}
              onClick={() => {
                if (!syncTarget) return;
                const lookbackDays = parseInt(syncLookbackDays, 10);
                const maxOrders = parseInt(syncMaxOrders, 10);
                handleSync(syncTarget, {
                  lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : undefined,
                  maxOrders: Number.isFinite(maxOrders) ? maxOrders : undefined,
                });
                setSyncDialogOpen(false);
              }}
            >
              Sync Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
