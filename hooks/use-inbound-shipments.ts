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
  /** Linked lines, any status. */
  itemCount: number;
  /** Linked lines carrying a count, any status. */
  countedItemCount: number;
  /**
   * Linked + RECEIVED + never counted (QA-5) — the same number the close guard
   * enforces, so the three counts here deliberately do NOT add up: a discarded
   * or graduated line that was never counted is settled work, not outstanding.
   */
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
 * An API failure that carries the server's STRUCTURED refusal WHOLE (contract
 * pack C4a.1, seam S23).
 *
 * The overhaul's 409s each name something different — the lines that blocked a
 * close, the counters a ceiling was measured against, the stocked/disposed pair
 * that locked a verified count — so no fixed field list can hold them. `details`
 * is the entire parsed body; the two W1 fields survive as GETTERS off it, which
 * keeps every existing reader working without teaching this class the shape of
 * every refusal that will ever exist.
 *
 * Losing that payload would reduce "these three boxes are uncounted" to
 * "conflict", which is the difference between an actionable screen and a dead
 * end.
 */
export class ShipmentApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The WHOLE parsed response body — `{}` when the server sent no JSON. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShipmentApiError";
  }

  /** W1 compatibility: the uncounted lines a close refusal named. */
  get uncountedItemIds(): number[] | undefined {
    return this.details.uncountedItemIds as number[] | undefined;
  }

  /** W1 compatibility: the graduated lines an unlink refusal named. */
  get graduatedItemIds(): number[] | undefined {
    return this.details.graduatedItemIds as number[] | undefined;
  }
}

/**
 * Build the error from a response whose body has ALREADY been parsed.
 *
 * The house mutation idiom reads the body BEFORE checking `res.ok` (a body can
 * only be consumed once), so the parse and the error construction have to be
 * separable — and every supply-order hook in `use-supply-orders.ts` needs the
 * same construction.
 */
export function readShipmentError(
  res: Pick<Response, "status">,
  json: unknown,
  fallback = "The request failed",
): ShipmentApiError {
  const body = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const message = typeof body.error === "string" && body.error ? body.error : fallback;
  const code = typeof body.code === "string" ? body.code : undefined;
  return new ShipmentApiError(message, res.status, code, body);
}

async function readError(res: Response, fallback: string): Promise<ShipmentApiError> {
  const json = await res.json().catch(() => ({}));
  return readShipmentError(res, json, fallback);
}

/**
 * The list filter, as a CANONICAL cache key (C4a.1).
 *
 * The Orders list is multi-select over five statuses plus a model
 * discriminator, so the key has to survive the same set arriving in a different
 * order — `["ORDERED","RECEIVING"]` and `["RECEIVING","ORDERED"]` are ONE query,
 * and two cache entries for them is two answers to the same question. An absent
 * status set is the server's own default set, keyed as the empty string: a
 * stable tail, which `undefined` is not.
 */
export interface ShipmentListFilter {
  statuses?: readonly string[];
  model?: "legacy" | "supply-order";
}

/** Stable query keys. Invalidating the bare prefix refreshes list AND detail. */
export const shipmentKeys = {
  all: ["inbound-shipments"] as const,
  list: (filter: ShipmentListFilter) =>
    [
      "inbound-shipments",
      "list",
      [...(filter.statuses ?? [])].sort().join(","),
      filter.model ?? "all",
    ] as const,
  detail: (id: string) => ["inbound-shipments", "detail", id] as const,
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Receiving headers, newest first. "ALL" sends no filter at all.
 *
 * `enabled` mirrors `useLocations`: the W2.5 shipment picker lives inside a
 * dialog that is mounted long before it is opened, and a header list nobody can
 * see yet is a request nobody asked for.
 *
 * A FAILURE THROWS, and callers must carry that through rather than defaulting
 * `data` to `[]` and rendering the result as "no shipments exist" (W25-3): the
 * operator's answer to an empty list is to open a NEW receipt, which is the
 * wrong move when the truth was only that the read did not land.
 */
export function useInboundShipments(
  status: ShipmentStatusFilter = "ALL",
  enabled = true,
) {
  return useQuery<ShipmentSummary[], ShipmentApiError>({
    // "ALL" sends no filter, so it keys as the server's default set.
    queryKey: shipmentKeys.list(status === "ALL" ? {} : { statuses: [status] }),
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
    enabled,
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
 * The receiving detail's writes against a staging LINE — the MANUAL per-line
 * cost save and link/unlink — through the existing `PATCH /api/staging-items/[id]`.
 *
 * A freight BILL no longer comes through here (FD3-1): see
 * `useAllocateShipmentCosts`.
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

/**
 * One line of a freight bill: the frozen basis it was computed from, and — on
 * the lines this bill writes — the cost to set (FD4-1).
 *
 * A line without `unitCostCents` is VERIFY-ONLY: the split rests on its cost and
 * quantity, so the server claims and checks it, but nothing about it changes.
 */
export interface AllocateShipmentCostLine {
  id: number;
  /** Which quantity the share was divided by — the server's WHERE depends on it. */
  qtySource: "counted" | "expected" | "none";
  /** That quantity, frozen. */
  qty: number;
  /** The cost precondition. NULL is legal and means "still unpriced". */
  ifUnitCostCents: number | null;
  /** Present = write this cost. Absent = verify only. */
  unitCostCents?: number;
}

/**
 * THE WHOLE FREIGHT BILL, in one request (FD3-1).
 *
 * The calculator's Accept used to fan out into one staging PATCH per line, which
 * meant a failure halfway left some lines carrying their share of the freight
 * and some not — and the recovery on offer ("re-enter the full bill")
 * double-applied it onto the ones that had landed. `POST
 * /api/inbound-shipments/[id]/costs` writes every line in one transaction, so
 * there are exactly two outcomes and the failing one wrote nothing.
 *
 * FD4-1: the request carries the panel's WHOLE frozen session — the lines being
 * written and the lines the split merely rests on — so the server can check the
 * entire basis rather than the part of it that happens to be changing.
 *
 * Invalidation is on SETTLE, not on success: a refusal is the moment the panel's
 * frozen bill is most likely to be describing rows that have moved, and after it
 * there is nothing partial to leave stale.
 */
export function useAllocateShipmentCosts() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation<
    ShipmentDetail,
    ShipmentApiError,
    { id: string; lines: AllocateShipmentCostLine[] }
  >({
    mutationFn: async ({ id, lines }) => {
      const res = await fetch(`/api/inbound-shipments/${id}/costs`, {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ lines }),
      });
      if (!res.ok) throw await readError(res, "Failed to write the landed costs");
      return res.json();
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: shipmentKeys.all });
      await queryClient.invalidateQueries({ queryKey: ["staging-items"] });
    },
  });
}
