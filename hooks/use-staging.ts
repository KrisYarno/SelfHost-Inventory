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
  // W0-RETAIL: NULL = retail unknown (never coerced to 0 downstream).
  retailPrice?: number | null;
  locationId: number;
}

/**
 * W1-3a (pack REV-3 T2): the graduate request carries NO quantity. The server
 * books the staging ROW's count, read inside the graduation transaction — a
 * body that still carries `countedQuantity` is refused at 400.
 *
 * The ONLY way to book a different number is the override PAIR, and it is
 * both-or-neither: a quantity without a reason is refused too.
 */
export interface GraduateOverrideFields {
  overrideQuantity: number;
  overrideReason: string;
}

export type GraduateBody =
  | ({
      mode: "existing";
      productId: number;
      locationId: number;
    } & Partial<GraduateOverrideFields>)
  | ({
      mode: "new";
      locationId: number;
      productFields: GraduateNewProductFields;
    } & Partial<GraduateOverrideFields>);

/**
 * W1-3b (pack REV-3 T3, seam S11): the receipt priced these units differently
 * from the product's standing cost, and the server wrote NOTHING. Sent only to
 * an ADMIN — they are the ones who can settle it, through the real product PUT.
 * Everyone else gets `null` here, and the server has already written a
 * `cost-differs` row to the exception register instead.
 */
export interface GraduateCostPrompt {
  productId: number;
  /** NULL when the product's stored cost carries no representable value. */
  currentCents: number | null;
  receiptCents: number;
}

export interface GraduateResponse {
  productId: number;
  approvalStatus: "APPROVED" | "PENDING_REVIEW";
  locationId: number;
  /** What the dock reported. */
  countedQuantity: number;
  /** What the ledger booked (differs only on an audited override). */
  bookedQuantity: number;
  receiptCost: { unitCostCents: number | null; source: "line" | "product" };
  costPrompt: GraduateCostPrompt | null;
}

/** Graduation creates products + stock, so it invalidates the staging queue
 *  AND the full inventory/product cache set (products, inventory-variants,
 *  inventory-products, logs, transfers, product-location-quantity, dashboard). */
export function useGraduateStagingItem() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<GraduateResponse, Error, { id: number; body: GraduateBody }>({
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

/**
 * The count endpoint's response (W1-2b, `POST /api/staging-items/[id]/count`).
 * `countedQuantity` here is the SERVER's number — every count surface renders
 * this rather than the value it typed, so what the UI shows is always what the
 * row holds.
 */
export interface CountStagingResponse {
  id: number;
  status: "RECEIVED";
  countedQuantity: number;
  previousCountedQuantity: number | null;
  recount: boolean;
  countedBy: number;
  countedAt: string;
  expectedQuantity: number | null;
  shipmentId: string | null;
  discrepancy: {
    counted: boolean;
    expectedMissing: boolean;
    delta: number | null;
    direction: "OVER" | "UNDER" | "MATCH" | null;
  };
}

/**
 * Record a physical count (pack REV-3 T2 count-entry UX).
 *
 * Counting is its OWN request, never a field that rides a graduation: the count
 * stamps who counted and when and is always audited, and graduation books
 * whatever the row holds afterwards. A `countedQuantity` of 0 is legal here —
 * "the box was empty" is a fact about the dock; the "a zero count is a Discard"
 * rule belongs to graduation.
 */
export function useCountStagingItem() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<
    CountStagingResponse,
    Error,
    { id: number; countedQuantity: number }
  >({
    mutationFn: async ({ id, countedQuantity }) => {
      const res = await fetch(`/api/staging-items/${id}/count`, {
        method: "POST",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify({ countedQuantity }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Failed to record the count");
      }
      return res.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["staging-items"] }),
  });
}
