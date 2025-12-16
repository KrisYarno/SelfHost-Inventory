"use client";

import { useState, useEffect, useCallback } from "react";
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
import { toast } from "sonner";
import { Plug, Plus, Pencil, Trash2, Copy, Link2, Power, PowerOff } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

interface Company {
  id: string;
  name: string;
  slug: string;
}

interface Integration {
  id: string;
  companyId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  name: string;
  storeUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  company: {
    name: string;
  };
}

interface FormData {
  companyId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  name: string;
  storeUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
}

export default function AdminIntegrationsPage() {
  const router = useRouter();
  const { token: csrfToken } = useCSRF();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingIntegration, setEditingIntegration] = useState<Integration | null>(null);
  const [formData, setFormData] = useState<FormData>({
    companyId: "",
    platform: "SHOPIFY",
    name: "",
    storeUrl: "",
    apiKey: "",
    apiSecret: "",
    webhookSecret: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [integrationsRes, companiesRes] = await Promise.all([
        fetch("/api/admin/integrations"),
        fetch("/api/admin/companies"),
      ]);

      if (!integrationsRes.ok || !companiesRes.ok) {
        if (integrationsRes.status === 401 || companiesRes.status === 401) {
          router.push("/auth/signin");
          return;
        }
        throw new Error("Failed to fetch data");
      }

      const [integrationsData, companiesData] = await Promise.all([
        integrationsRes.json(),
        companiesRes.json(),
      ]);

      setIntegrations(integrationsData.integrations || []);
      setCompanies(companiesData.companies || []);
    } catch (error) {
      console.error("Error fetching data:", error);
      toast.error("Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const response = await fetch("/api/admin/integrations", {
        method: "POST",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create integration");
      }

      const result = await response.json();

      // Show webhook URL
      const baseUrl = window.location.origin;
      const generatedWebhookUrl = `${baseUrl}/api/webhooks/${result.integration.id}`;
      setWebhookUrl(generatedWebhookUrl);

      toast.success("Integration created successfully");
      await fetchData();
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
      const response = await fetch(`/api/admin/integrations/${editingIntegration.id}`, {
        method: "PUT",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update integration");
      }

      toast.success("Integration updated successfully");
      setIsEditDialogOpen(false);
      setEditingIntegration(null);
      resetForm();
      await fetchData();
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
      const response = await fetch(`/api/admin/integrations/${integration.id}`, {
        method: "DELETE",
        headers: withCSRFHeaders({}, csrfToken),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete integration");
      }

      toast.success("Integration deleted successfully");
      await fetchData();
    } catch (error) {
      console.error("Error deleting integration:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete integration");
    }
  };

  const handleToggleActive = async (integration: Integration) => {
    try {
      const response = await fetch(`/api/admin/integrations/${integration.id}`, {
        method: "PUT",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify({
          isActive: !integration.isActive,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update integration");
      }

      toast.success(
        `Integration ${!integration.isActive ? "activated" : "deactivated"}`
      );
      await fetchData();
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
      apiKey: "",
      apiSecret: "",
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
      apiKey: "",
      apiSecret: "",
      webhookSecret: "",
    });
  };

  const copyWebhookUrl = (integrationId: string) => {
    const baseUrl = window.location.origin;
    const url = `${baseUrl}/api/webhooks/${integrationId}`;
    navigator.clipboard.writeText(url);
    toast.success("Webhook URL copied to clipboard");
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
                    <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                      <h3 className="font-semibold text-green-900 mb-2">Integration Created!</h3>
                      <p className="text-sm text-green-800 mb-3">
                        Configure this webhook URL in your {formData.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"} store:
                      </p>
                      <div className="flex gap-2">
                        <Input
                          value={webhookUrl}
                          readOnly
                          className="font-mono text-sm"
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

                    <div className="space-y-2">
                      <label htmlFor="apiKey" className="text-sm font-medium">
                        {formData.platform === "SHOPIFY"
                          ? "Admin API Access Token"
                          : "API Key"}
                      </label>
                      <Input
                        id="apiKey"
                        type="password"
                        value={formData.apiKey}
                        onChange={(e) =>
                          setFormData({ ...formData, apiKey: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "shpat_... (Admin API access token)"
                            : formData.platform === "WOOCOMMERCE"
                              ? "ck_... (WooCommerce consumer key)"
                              : "Enter API key"
                        }
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="apiSecret" className="text-sm font-medium">
                        {formData.platform === "SHOPIFY"
                          ? "API Secret Key"
                          : "API Secret"}
                      </label>
                      <Input
                        id="apiSecret"
                        type="password"
                        value={formData.apiSecret}
                        onChange={(e) =>
                          setFormData({ ...formData, apiSecret: e.target.value })
                        }
                        placeholder={
                          formData.platform === "SHOPIFY"
                            ? "Your app's API secret key (used for webhook HMAC)"
                            : formData.platform === "WOOCOMMERCE"
                              ? "cs_... (WooCommerce consumer secret)"
                              : "Enter API secret"
                        }
                        required
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
                            ? "Optional (defaults to API Secret)"
                            : "Enter WooCommerce webhook secret"
                        }
                        required={formData.platform === "WOOCOMMERCE"}
                      />
                      <p className="text-xs text-muted-foreground">
                        {formData.platform === "SHOPIFY"
                          ? "Used to verify incoming webhooks (Shopify uses your app API Secret by default)."
                          : "Used to verify incoming webhooks (matches the WooCommerce webhook secret)."}
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
                      {companyIntegrations.map((integration) => (
                        <TableRow key={integration.id}>
                          <TableCell>
                            <Badge variant="outline">
                              {integration.platform === "SHOPIFY" ? "Shopify" : "WooCommerce"}
                            </Badge>
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
                            >
                              {integration.storeUrl}
                              <Link2 className="h-3 w-3" />
                            </a>
                          </TableCell>
                          <TableCell>
                            <Badge variant={integration.isActive ? "default" : "secondary"}>
                              {integration.isActive ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {integration.lastSyncAt
                              ? new Date(integration.lastSyncAt).toLocaleString()
                              : "Never"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
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
                      ))}
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

              <div className="space-y-2">
                <label htmlFor="edit-apiKey" className="text-sm font-medium">
                  {formData.platform === "SHOPIFY"
                    ? "Admin API Access Token"
                    : "API Key"}
                </label>
                <Input
                  id="edit-apiKey"
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) =>
                    setFormData({ ...formData, apiKey: e.target.value })
                  }
                  placeholder={
                    formData.platform === "SHOPIFY"
                      ? "Leave blank to keep current token"
                      : "Leave blank to keep current value"
                  }
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="edit-apiSecret" className="text-sm font-medium">
                  {formData.platform === "SHOPIFY"
                    ? "API Secret Key"
                    : "API Secret"}
                </label>
                <Input
                  id="edit-apiSecret"
                  type="password"
                  value={formData.apiSecret}
                  onChange={(e) =>
                    setFormData({ ...formData, apiSecret: e.target.value })
                  }
                  placeholder={
                    formData.platform === "SHOPIFY"
                      ? "Leave blank to keep current secret"
                      : "Leave blank to keep current value"
                  }
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
    </div>
  );
}
