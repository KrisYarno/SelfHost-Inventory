"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

/**
 * The receiving header's client surface (seam S10).
 *
 * Every type here mirrors W1-2a's T4 JSON as it arrives over the wire — dates
 * are STRINGS, not Dates, and every quantity is computed server-side on read.
 * Nothing in this file recomputes a rollup: a second implementation of the
 * discrepancy arithmetic is exactly how a UI starts disagreeing with its own
 * database, and lib/shipments/rollup.ts is already the one answer.
 */

export type InboundShipmentStatus = "OPEN" | "CLOSED" | "CANCELLED";
export type ShipmentStatusFilter = InboundShipmentStatus | "ALL";

export type DiscrepancyDirection = "OVER" | "UNDER" | "MATCH";

export interface LineDiscrepancyFlags {
  counted: boolean;
  /** expectedQuantity was NULL — an unexpected arrival, counted in FULL. */
  expectedMissing: boolean;
  /** counted - COALESCE(expected, 0); NULL while the line is uncounted. */
  delta: number | null;
  direction: DiscrepancyDirection | null;
}

export interface DiscrepancyRollup {
  itemCount: number;
  countedItemCount: number;
  uncountedItemCount: number;
  discrepancyItemCount: number;
  /** Magnitudes, NON-CANCELLING: a +5 and a -3 report 5 and 3, never 2. */
  totalOver: number;
  totalUnder: number;
}

export interface ShipmentSummary {
  id: string;
  supplierRef: string | null;
  status: InboundShipmentStatus;
  notes: string | null;
  createdBy: number;
  closedBy: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  creator: { id: number; username: string } | null;
  itemCount: number;
  receivedItemCount: number;
  graduatedItemCount: number;
  /** Linked + RECEIVED + never counted — the ONLY thing that blocks a close. */
  uncountedReceivedItemCount: number;
  discrepancy: DiscrepancyRollup;
}

export interface ShipmentDetailItem {
  id: number;
  description: string;
  status: "RECEIVED" | "GRADUATED" | "DISCARDED";
  expectedQuantity: number | null;
  countedQuantity: number | null;
  unitCostCents: number | null;
  resolvedProductId: number | null;
  locationId: number;
  vendor: string | null;
  reference: string | null;
  notes: string | null;
  receivedAt: string;
  countedAt: string | null;
  countedBy: number | null;
  location: { id: number; name: string } | null;
  resolvedProduct: { id: number; name: string } | null;
  flags: LineDiscrepancyFlags;
}

export type ShipmentDetail = ShipmentSummary & { items: ShipmentDetailItem[] };

/**
 * An API failure that carries the server's STRUCTURED refusal (T4 409s name the
 * lines that blocked the transition). Losing that payload would reduce "these
 * three boxes are uncounted" to "conflict", which is the difference between an
 * actionable screen and a dead end.
 */
export class ShipmentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly uncountedItemIds?: number[],
    readonly graduatedItemIds?: number[],
  ) {
    super(message);
    this.name = "ShipmentApiError";
  }
}

async function readError(res: Response, fallback: string): Promise<ShipmentApiError> {
  const json = await res.json().catch(() => ({}));
  return new ShipmentApiError(
    json?.error || fallback,
    res.status,
    json?.code,
    json?.uncountedItemIds,
    json?.graduatedItemIds,
  );
}

/** Stable query keys. Invalidating the bare prefix refreshes list AND detail. */
export const shipmentKeys = {
  all: ["inbound-shipments"] as const,
  list: (status: ShipmentStatusFilter) => ["inbound-shipments", "list", status] as const,
  detail: (id: string) => ["inbound-shipments", "detail", id] as const,
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Receiving headers, newest first. "ALL" sends no filter at all. */
export function useInboundShipments(status: ShipmentStatusFilter = "ALL") {
  return useQuery<ShipmentSummary[], ShipmentApiError>({
    queryKey: shipmentKeys.list(status),
    queryFn: async () => {
      const url =
        status === "ALL"
          ? "/api/inbound-shipments"
          : `/api/inbound-shipments?status=${status}`;
      const res = await fetch(url);
      if (!res.ok) throw await readError(res, "Failed to load shipments");
      const data = await res.json();
      return (data.shipments ?? []) as ShipmentSummary[];
    },
  });
}

/** One header with its linked lines, per-line flags and the same rollup. */
export function useInboundShipment(id: string | null) {
  return useQuery<ShipmentDetail, ShipmentApiError>({
    queryKey: shipmentKeys.detail(id ?? ""),
    queryFn: async () => {
      const res = await fetch(`/api/inbound-shipments/${id}`);
      if (!res.ok) throw await readError(res, "Failed to load the shipment");
      return (await res.json()) as ShipmentDetail;
    },
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateInboundShipmentInput {
  supplierRef?: string;
  notes?: string;
}

export function useCreateInboundShipment() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<ShipmentSummary, ShipmentApiError, CreateInboundShipmentInput>({
    mutationFn: async (input) => {
      const res = await fetch("/api/inbound-shipments", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw await readError(res, "Failed to open the shipment");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shipmentKeys.all }),
  });
}

export interface PatchInboundShipmentInput {
  supplierRef?: string | null;
  notes?: string | null;
  /** The T4 matrix has no reopen: only CLOSED and CANCELLED are askable. */
  status?: "CLOSED" | "CANCELLED";
}

/**
 * Status transitions and field edits. The response is the SAME shape GET
 * serves, so the cache is seeded from it rather than refetched blindly.
 */
export function useUpdateInboundShipment() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<
    ShipmentDetail,
    ShipmentApiError,
    { id: string; body: PatchInboundShipmentInput }
  >({
    mutationFn: async ({ id, body }) => {
      const res = await fetch(`/api/inbound-shipments/${id}`, {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await readError(res, "Failed to update the shipment");
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: shipmentKeys.all }),
  });
}

export interface UpdateStagingLineInput {
  /** INT cents; `null` un-prices the line (unknown), which is NOT 0. */
  unitCostCents?: number | null;
  /** Join a receipt, or `null` to leave one. */
  shipmentId?: string | null;
}

/**
 * The receiving detail's writes against a staging LINE — the per-line cost and
 * link/unlink — through the existing `PATCH /api/staging-items/[id]`.
 *
 * It invalidates BOTH caches: a line's cost belongs to the shipment view and to
 * the pre-staging queue, and a link moves the row between two shipment details.
 */
export function useUpdateStagingLine() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<
    unknown,
    ShipmentApiError,
    { id: number; body: UpdateStagingLineInput }
  >({
    mutationFn: async ({ id, body }) => {
      const res = await fetch(`/api/staging-items/${id}`, {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await readError(res, "Failed to update the line");
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
      await queryClient.invalidateQueries({ queryKey: ["staging-items"] });
    },
  });
}
