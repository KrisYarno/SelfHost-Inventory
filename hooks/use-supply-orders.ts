"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { invalidateInventoryCaches } from "@/hooks/use-inventory-mutations";
import { labelingKeys } from "@/hooks/use-labeling-keys";
import {
  readShipmentError,
  ShipmentApiError,
  shipmentKeys,
  type ShipmentListFilter,
} from "@/hooks/use-inbound-shipments";
import type { BookingCostPrompt, BookingResult, DiscardResult } from "@/lib/supply-orders/booking";
import type { VerifyResult } from "@/lib/supply-orders/verify";
import type { Resolution } from "@/lib/exceptions/kinds";

/**
 * THE SUPPLY-ORDER CLIENT SURFACE (contract pack C4a.1; seams S22/S23).
 *
 * Every read and every write of the new flow lives here, and the reason it is
 * one module rather than one per screen is that three of these operations have
 * to agree about state that is not theirs:
 *
 *   - INVALIDATION. A verify moves the labeling queue; a stock-in moves
 *     inventory; both move the Orders list. `invalidateSupplyOrderCaches` is the
 *     ONE definition of that set, so a new mutation cannot quietly refresh two
 *     of the three families and leave /inventory disagreeing with receiving.
 *   - THE BOOKING KEY. Idempotency is a contract between one client attempt and
 *     one server row, and it only holds if exactly one place decides when a key
 *     is still live. That decision is the KEEP/RETIRE matrix below.
 *   - REFUSALS. The lane's 409s carry structure (which lines, which counters),
 *     so every hook parses the body BEFORE checking `res.ok` and hands the whole
 *     thing on as `ShipmentApiError.details` — the screen shows the server's
 *     sentence verbatim rather than a sentence of its own invention.
 *
 * `retry: false` everywhere: these 409s are CLAIMS. Re-firing one behind the
 * operator's back is precisely the stale-tab bug the frozen envelopes exist to
 * make visible.
 *
 * The wire types are re-exported as TYPES ONLY from `lib/supply-orders/queries`
 * — the UI reads that module's shapes and never its runtime (it holds Prisma).
 */

export type {
  SupplyOrderSummary,
  SupplyOrderDetail,
  SupplyOrderLineView,
  SupplyOrderExceptionView,
  SupplyOrderModel,
  LabelingQueueOrder,
} from "@/lib/supply-orders/queries";
export type { BookingCostPrompt, BookingResult } from "@/lib/supply-orders/booking";
export { ShipmentApiError, shipmentKeys } from "@/hooks/use-inbound-shipments";

import type {
  SupplyOrderDetail,
  SupplyOrderExceptionView,
  SupplyOrderLineView,
  SupplyOrderSummary,
} from "@/lib/supply-orders/queries";

// ---------------------------------------------------------------------------
// Invalidation — ONE definition of "what a supply-order write touches"
// ---------------------------------------------------------------------------

/**
 * The three families every supply-order mutation refreshes: the Orders list and
 * detail, the labeling queue, and the whole inventory cache set.
 *
 * The inventory half is not optional even for writes that move no stock: a
 * verify decides what the queue may book, and the operator who follows a verify
 * with a stock-in in another tab must not be looking at a pre-verify ceiling.
 */
export function invalidateSupplyOrderCaches(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: shipmentKeys.all }),
    queryClient.invalidateQueries({ queryKey: labelingKeys.all }),
    invalidateInventoryCaches(queryClient),
  ]);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The Orders list filter — multi-status plus the model discriminator. */
export type SupplyOrdersFilter = ShipmentListFilter;

function listUrl(filter: SupplyOrdersFilter): string {
  const params = new URLSearchParams();
  if (filter.statuses && filter.statuses.length > 0) {
    params.set("status", [...filter.statuses].join(","));
  }
  if (filter.model) params.set("model", filter.model);
  const query = params.toString();
  return query ? `/api/inbound-shipments?${query}` : "/api/inbound-shipments";
}

/**
 * THE POLYMORPHIC ORDERS LIST.
 *
 * A failure THROWS rather than resolving to `[]` (W25-3): the operator's answer
 * to an empty list is to enter a new order, which is the wrong move when the
 * truth was only that the read did not land.
 */
export function useSupplyOrders(filter: SupplyOrdersFilter, enabled = true) {
  return useQuery<SupplyOrderSummary[], ShipmentApiError>({
    queryKey: shipmentKeys.list(filter),
    enabled,
    queryFn: async ({ signal }) => {
      const res = await fetch(listUrl(filter), { signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw readShipmentError(res, json, "Failed to load the orders list");
      return ((json as { shipments?: SupplyOrderSummary[] })?.shipments ??
        []) as SupplyOrderSummary[];
    },
  });
}

/** ONE order — a supply order with its lines and exceptions, or a legacy receipt. */
export function useSupplyOrder(id: string | null) {
  return useQuery<SupplyOrderDetail, ShipmentApiError>({
    queryKey: shipmentKeys.detail(id ?? ""),
    enabled: !!id,
    queryFn: async ({ signal }) => {
      const res = await fetch(`/api/inbound-shipments/${id}`, { signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw readShipmentError(res, json, "Failed to load the order");
      return json as SupplyOrderDetail;
    },
  });
}

// ---------------------------------------------------------------------------
// Request bodies (mirrors of `lib/validation/supply-orders.ts`, hand-declared so
// the client never imports a zod schema it does not enforce)
// ---------------------------------------------------------------------------

export type ProductSelector =
  | { mode: "existing"; productId: number }
  | { mode: "new"; productFields: Record<string, unknown> };

export interface SupplyOrderLineInput {
  product: ProductSelector;
  orderedQuantity: number;
  lineTotalCents: number;
  labelingRequired?: boolean;
  notes?: string;
}

export interface CreateSupplyOrderBody {
  supplier?: string;
  supplierRef?: string;
  /** A LEXICAL calendar day (`YYYY-MM-DD`) — never a serialized Date. */
  orderedAt: string;
  notes?: string;
  feesCents?: number;
  feesNote?: string;
  lines: SupplyOrderLineInput[];
}

export interface PatchSupplyOrderBody {
  supplier?: string | null;
  supplierRef?: string | null;
  orderedAt?: string;
  notes?: string | null;
  feesCents?: number | null;
  feesNote?: string | null;
  action?: "close" | "cancel";
}

/** An ordered line added while the header is ORDERED, or an UNORDERED ARRIVAL. */
export interface AddLineBody {
  product?: ProductSelector;
  orderedQuantity?: number;
  lineTotalCents?: number | null;
  verifiedQuantity?: number;
  labelingRequired?: boolean;
  notes?: string;
  note?: string;
}

export interface PatchLineBody {
  product?: ProductSelector;
  orderedQuantity?: number;
  lineTotalCents?: number;
  labelingRequired?: boolean;
  notes?: string;
}

export interface VerifyLineBody {
  verifiedQuantity: number;
  note?: string;
  labelingRequired?: boolean;
  deliveredProduct?: ProductSelector;
}

/** The DISCARD of a whole (never-verified) line. */
export interface DiscardLineResult {
  id: number;
  shipmentId: string;
  status: string;
  reason: string | null;
}

/** M3b's verify response: the core's result plus the refreshed line view. */
export type VerifyLineResult = VerifyResult & { line: SupplyOrderLineView };

/**
 * M3b's stock-in response: the booking primitive's result PLUS the refreshed
 * line view. `line` is NULLABLE because the route's refresh read is a second
 * read — an order closed or re-shaped between the booking and the refresh
 * answers with no line, and saying so beats claiming a stale one.
 */
export type StockInResult = BookingResult & { line: SupplyOrderLineView | null };

/** M3b's discard-remaining response. */
export type DiscardRemainingResult = DiscardResult;

// ---------------------------------------------------------------------------
// The mutation plumbing
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * The house idiom (`hooks/use-orders.ts`): parse the body FIRST, then decide.
 * A structured refusal is only readable if the body was read before `res.ok`
 * short-circuited it.
 */
async function requestJson<T>(
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw readShipmentError(res, json, fallback);
  return json as T;
}

// ---------------------------------------------------------------------------
// The bookingKey discipline (PK3-6, spec §11 — seam S22)
// ---------------------------------------------------------------------------

/** `sessionStorage['supply-order:booking-attempt:<lineId>']`. */
export const BOOKING_ATTEMPT_STORAGE_PREFIX = "supply-order:booking-attempt:";

type BookingAttempt = { attempt: number; key: string };

/**
 * The fallback when sessionStorage is unavailable (private modes, quota, an
 * embedded webview). A booking must never be BLOCKED by storage — losing
 * cross-reload idempotency is a smaller harm than refusing to record stock.
 */
const memoryAttempts = new Map<string, BookingAttempt>();

function attemptStorageKey(lineId: number): string {
  return `${BOOKING_ATTEMPT_STORAGE_PREFIX}${lineId}`;
}

function parseAttempt(raw: string | null): BookingAttempt | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<BookingAttempt>;
    if (typeof parsed?.key === "string" && typeof parsed?.attempt === "number") {
      return { attempt: parsed.attempt, key: parsed.key };
    }
  } catch {
    // A corrupt record is no record: the next call mints a fresh key.
  }
  return null;
}

function readAttempt(lineId: number): BookingAttempt | null {
  const storageKey = attemptStorageKey(lineId);
  let stored: string | null = null;
  try {
    stored = globalThis.sessionStorage?.getItem(storageKey) ?? null;
  } catch {
    stored = null;
  }
  return parseAttempt(stored) ?? memoryAttempts.get(storageKey) ?? null;
}

function writeAttempt(lineId: number, attempt: BookingAttempt): void {
  const storageKey = attemptStorageKey(lineId);
  // The memory mirror is written FIRST and unconditionally, so a storage that
  // throws on write still leaves the attempt recoverable in this tab.
  memoryAttempts.set(storageKey, attempt);
  try {
    globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(attempt));
  } catch {
    // Fallback already holds it.
  }
}

function clearAttempt(lineId: number): void {
  const storageKey = attemptStorageKey(lineId);
  memoryAttempts.delete(storageKey);
  try {
    globalThis.sessionStorage?.removeItem(storageKey);
  } catch {
    // Fallback already cleared.
  }
}

/** Retire the current record and persist its successor in the same breath. */
function mintAttempt(lineId: number): BookingAttempt {
  const prior = readAttempt(lineId);
  const next: BookingAttempt = {
    attempt: (prior?.attempt ?? 0) + 1,
    key: crypto.randomUUID(),
  };
  writeAttempt(lineId, next);
  return next;
}

/**
 * KEEP the key only while the server's answer is genuinely UNKNOWN or the
 * attempt is provably unsettled:
 *
 *   - no HTTP response at all (the request may have been executed);
 *   - 5xx (same reason — the transaction's fate is not reported);
 *   - 409 CEILING / CONFLICT (the write did not happen and the operator may
 *     legitimately retry the SAME batch once the line moves).
 *
 * Every other outcome RETIRES it. A 2xx is settled (a replay included — the
 * server already told us what it stored); a 4xx that is not one of those two is
 * a decision, and reusing a key across a changed request is exactly what
 * IDEMPOTENCY_MISMATCH exists to refuse.
 */
function keepsBookingKey(status: number, code?: string): boolean {
  if (status >= 500) return true;
  return status === 409 && (code === "CEILING" || code === "CONFLICT");
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Every mutation invalidates on SETTLE, not on success (C4b.4): a 409 is the
 * moment the client's picture is most likely to be stale, and awaiting the
 * refresh before the caller's catch runs is what lets a screen show the server's
 * sentence NEXT TO the refreshed truth instead of next to the stale one.
 */
function useSupplyOrderMutationDefaults() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return {
    csrfToken,
    onSettled: () => invalidateSupplyOrderCaches(queryClient),
  };
}

export function useCreateSupplyOrder() {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<SupplyOrderDetail, ShipmentApiError, CreateSupplyOrderBody>({
    retry: false,
    mutationFn: (body) =>
      requestJson<SupplyOrderDetail>(
        "/api/inbound-shipments",
        {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        },
        "Failed to enter the supply order",
      ),
    onSettled,
  });
}

/** Header edits AND the two lifecycle actions (`close` / `cancel`). */
export function usePatchSupplyOrder(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<SupplyOrderDetail, ShipmentApiError, PatchSupplyOrderBody>({
    retry: false,
    mutationFn: (body) =>
      requestJson<SupplyOrderDetail>(
        `/api/inbound-shipments/${id}`,
        {
          method: "PATCH",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        },
        "Failed to update the order",
      ),
    onSettled,
  });
}

/** An ordered line (header ORDERED) or an unordered arrival (RECEIVING|CLOSED). */
export function useAddLine(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<SupplyOrderLineView, ShipmentApiError, AddLineBody>({
    retry: false,
    mutationFn: (body) =>
      requestJson<SupplyOrderLineView>(
        `/api/inbound-shipments/${id}/lines`,
        {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        },
        "Failed to add the line",
      ),
    onSettled,
  });
}

export function usePatchLine(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<
    SupplyOrderLineView,
    ShipmentApiError,
    { lineId: number; body: PatchLineBody }
  >({
    retry: false,
    mutationFn: ({ lineId, body }) =>
      requestJson<SupplyOrderLineView>(
        `/api/inbound-shipments/${id}/lines/${lineId}`,
        {
          method: "PATCH",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        },
        "Failed to update the line",
      ),
    onSettled,
  });
}

export function useDiscardLine(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<
    DiscardLineResult,
    ShipmentApiError,
    { lineId: number; reason?: string }
  >({
    retry: false,
    mutationFn: ({ lineId, reason }) =>
      requestJson<DiscardLineResult>(
        `/api/inbound-shipments/${id}/lines/${lineId}/discard`,
        {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(reason === undefined ? {} : { reason }),
        },
        "Failed to remove the line",
      ),
    onSettled,
  });
}

export function useVerifyLine(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<
    VerifyLineResult,
    ShipmentApiError,
    { lineId: number; body: VerifyLineBody }
  >({
    retry: false,
    mutationFn: ({ lineId, body }) =>
      requestJson<VerifyLineResult>(
        `/api/inbound-shipments/${id}/lines/${lineId}/verify`,
        {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        },
        "Failed to record the count",
      ),
    onSettled,
  });
}

/**
 * ONE labeled batch into ONE location.
 *
 * The `bookingKey` is NOT a caller argument: the whole point of the discipline
 * is that exactly one place decides when an attempt is still live, and a caller
 * that could pass its own key could also pass a stale one.
 */
export function useStockIn(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<
    StockInResult,
    ShipmentApiError,
    { lineId: number; quantity: number; locationId: number; note?: string }
  >({
    retry: false,
    mutationFn: async ({ lineId, quantity, locationId, note }) => {
      const active = readAttempt(lineId) ?? mintAttempt(lineId);
      const body = {
        bookingKey: active.key,
        quantity,
        locationId,
        ...(note === undefined ? {} : { note }),
      };

      let res: Response;
      try {
        res = await fetch(`/api/inbound-shipments/${id}/lines/${lineId}/stock-in`, {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        });
      } catch (networkError) {
        // NO RESPONSE: the server may have committed the batch. KEEP the key so
        // the retry is a replay rather than a second booking.
        throw new ShipmentApiError(
          networkError instanceof Error
            ? `The batch could not be sent (${networkError.message})`
            : "The batch could not be sent",
          0,
          "NETWORK_ERROR",
        );
      }

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        const error = readShipmentError(res, json, "Failed to record the batch");
        if (!keepsBookingKey(res.status, error.code)) {
          if (error.code === "IDEMPOTENCY_MISMATCH") {
            // Retire AND re-mint in one step: the next click must not be able to
            // resend the key the server has already refused.
            mintAttempt(lineId);
          } else {
            clearAttempt(lineId);
          }
        }
        throw error;
      }

      // Settled — including a replay, whose returned batch is the truth the UI
      // reports ("already stocked N at <location>"), never the attempted body.
      clearAttempt(lineId);
      return json as StockInResult;
    },
    onSettled,
  });
}

export function useDiscardRemaining(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<
    DiscardRemainingResult,
    ShipmentApiError,
    { lineId: number; reason: string }
  >({
    retry: false,
    mutationFn: ({ lineId, reason }) =>
      requestJson<DiscardRemainingResult>(
        `/api/inbound-shipments/${id}/lines/${lineId}/discard-remaining`,
        {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify({ reason }),
        },
        "Failed to write off the remainder",
      ),
    onSettled,
  });
}

export interface ResolveExceptionBody {
  lineId: number;
  exceptionKey: string;
  resolution: Resolution;
  note?: string;
  relatedShipmentId?: string;
  creditRef?: string;
}

/**
 * M3b's resolve response. The settlement is a fact about the EXCEPTION and a
 * fact about the LINE (spec §6: every resolution refreshes the row's money), so
 * the route answers with both and the hook hands both on. Either may be null:
 * the refresh read runs after the transaction, not inside it.
 */
export type ResolveExceptionResult = {
  key: string;
  resolution: Resolution;
  lineId: number;
  exception: SupplyOrderExceptionView | null;
  line: SupplyOrderLineView | null;
};

export function useResolveException(id: string) {
  const { csrfToken, onSettled } = useSupplyOrderMutationDefaults();
  return useMutation<ResolveExceptionResult, ShipmentApiError, ResolveExceptionBody>({
    retry: false,
    mutationFn: ({ lineId, ...body }) =>
      requestJson<ResolveExceptionResult>(
        `/api/inbound-shipments/${id}/lines/${lineId}/resolve`,
        {
          method: "POST",
          headers: withCSRFHeaders({ ...JSON_HEADERS }, csrfToken),
          body: JSON.stringify(body),
        },
        "Failed to settle the exception",
      ),
    onSettled,
  });
}

/** Re-exported for the D-COST prompt the shared batch row owns (M4b). */
export type CostPrompt = BookingCostPrompt;
