"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
import type {
  StagingItem,
  StagingStatus,
} from "@/components/staging/staging-queue";

export interface Location {
  id: number;
  name: string;
}

/** Stable query keys. Staging list is keyed by status; invalidating the bare
 *  ["staging-items"] prefix refreshes every status view at once. */
export const stagingKeys = {
  items: (status: StagingStatus) => ["staging-items", status] as const,
};

export const locationKeys = {
  all: ["locations"] as const,
};

interface StatusError extends Error {
  status?: number;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Locations catalog. GET needs no CSRF; shared cache across every dialog. */
export function useLocations(enabled = true) {
  return useQuery<Location[]>({
    queryKey: locationKeys.all,
    queryFn: async () => {
      const res = await fetch("/api/locations");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to fetch locations");
      }
      const data = await res.json();
      // /api/locations returns a bare array; tolerate { locations } too.
      return (data?.locations ?? data ?? []) as Location[];
    },
    enabled,
  });
}

/** Pre-staging queue for a given status. A 401 surfaces as error.status so the
 *  caller can redirect to sign-in (matching the pre-migration guard). */
export function useStagingItems(status: StagingStatus) {
  return useQuery<StagingItem[], StatusError>({
    queryKey: stagingKeys.items(status),
    queryFn: async () => {
      const res = await fetch(`/api/staging-items?status=${status}`);
      if (!res.ok) {
        const err = new Error("Failed to fetch staging items") as StatusError;
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return (data.items ?? []) as StagingItem[];
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateStagingInput {
  description: string;
  expectedQuantity?: number;
  vendor?: string;
  reference?: string;
  notes?: string;
  locationId: number;
}

export function useCreateStagingItem() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (input: CreateStagingInput) => {
      const res = await fetch("/api/staging-items", {
        method: "POST",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to log item");
      }
      return res.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["staging-items"] }),
  });
}

export function useDiscardStagingItem() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/staging-items/${id}/discard`, {
        method: "POST",
        headers: withCSRFHeaders({}, csrfToken),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to discard item");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["staging-items"] }),
  });
}

export interface GraduateNewProductFields {
  baseName: string;
  variant: string;
  unit?: string;
  numericValue?: number;
  lowStockThreshold?: number;
  costPrice?: number;
  retailPrice?: number;
  locationId: number;
}

export type GraduateBody =
  | {
      mode: "existing";
      productId: number;
      countedQuantity: number;
      locationId: number;
    }
  | {
      mode: "new";
      countedQuantity: number;
      locationId: number;
      productFields: GraduateNewProductFields;
    };

/** Graduation creates products + stock, so it invalidates the staging queue
 *  AND the full inventory/product cache set (products, inventory-variants,
 *  inventory-products, logs, transfers, product-location-quantity, dashboard). */
export function useGraduateStagingItem() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: GraduateBody }) => {
      const res = await fetch(`/api/staging-items/${id}/graduate`, {
        method: "POST",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to graduate item");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["staging-items"] });
      // productId omitted -> invalidate ALL product-location-quantity entries.
      await invalidateInventoryCaches(queryClient);
    },
  });
}
