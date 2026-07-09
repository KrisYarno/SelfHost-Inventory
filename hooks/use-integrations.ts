"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Company {
  id: string;
  name: string;
  slug: string;
}

export interface Integration {
  id: string;
  companyId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  name: string;
  storeUrl: string;
  isActive: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  stockSyncEnabled: boolean;
  fulfillmentPushEnabled: boolean;
  lastStockSyncAt: string | null;
  lastStockSyncError: string | null;
  lastWebhookReceivedAt: string | null;
  lastWebhookError: string | null;
  webhookFailureCount: number;
  company: {
    name: string;
  };
}

export interface IntegrationFormData {
  companyId: string;
  platform: "SHOPIFY" | "WOOCOMMERCE";
  name: string;
  storeUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookSecret: string;
}

export interface FetchError extends Error {
  status?: number;
}

async function getJSON(url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`Request failed (${res.status})`) as FetchError;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List of e-commerce integrations. Shared by the integrations admin page and
 *  the product-mappings page (which uses it for the filter + bulk-map routing). */
export function useIntegrations() {
  return useQuery<Integration[], FetchError>({
    queryKey: ["integrations"],
    queryFn: async () => {
      const data = await getJSON("/api/admin/integrations");
      return (data.integrations ?? data ?? []) as Integration[];
    },
  });
}

/** List of companies (admin). */
export function useCompanies() {
  return useQuery<Company[], FetchError>({
    queryKey: ["companies"],
    queryFn: async () => {
      const data = await getJSON("/api/admin/companies");
      return (data.companies ?? []) as Company[];
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function useCreateIntegration() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (formData: IntegrationFormData) => {
      const res = await fetch("/api/admin/integrations", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Failed to create integration");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/** PUT update — used by the edit form and the active toggle. */
export function useUpdateIntegration() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async ({
      id,
      body,
    }: {
      id: string;
      body: IntegrationFormData | Record<string, unknown>;
    }) => {
      const res = await fetch(`/api/admin/integrations/${id}`, {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Failed to update integration");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/** Toggle a boolean sync flag (stock sync / fulfillment push) with a
 *  field-specific fallback message, matching the original page behaviour. */
export function useToggleIntegrationField() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async ({
      id,
      field,
      value,
    }: {
      id: string;
      field: "stockSyncEnabled" | "fulfillmentPushEnabled";
      value: boolean;
    }) => {
      const res = await fetch(`/api/admin/integrations/${id}`, {
        method: "PUT",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || `Failed to update ${field}`);
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useDeleteIntegration() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/integrations/${id}`, {
        method: "DELETE",
        headers: withCSRFHeaders({}, csrfToken),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || "Failed to delete integration");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/** Order sync — pulls recent orders, so it also invalidates the orders list. */
export function useSyncIntegration() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async ({
      id,
      options,
    }: {
      id: string;
      options?: { lookbackDays?: number; maxOrders?: number };
    }) => {
      const res = await fetch(`/api/admin/integrations/${id}/sync`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(options || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Sync failed");
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["external-orders"] });
    },
  });
}

export function useStockSyncIntegration() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/integrations/${id}/stock-sync`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Stock sync failed");
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

/** Price sync — pulls retail prices onto internal products, so it also
 *  invalidates the products list. */
export function usePriceSyncIntegration() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/integrations/${id}/price-sync`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Price sync failed");
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
    },
  });
}
