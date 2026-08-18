"use client";

/**
 * THE SHARED CLIENT BASE for every receiving read and write (contract pack
 * C4a.1, seam S23; trimmed by the Receiving/Labeling overhaul's M6).
 *
 * This module used to own the W1 header's own hooks as well. They are gone with
 * the flow they served — the polymorphic reads and every supply-order mutation
 * live in `hooks/use-supply-orders.ts`, the queue read in `hooks/use-labeling.ts`,
 * the pre-staging archive in `hooks/use-receiving-legacy.ts`. What survives here
 * is what those three have to AGREE about and therefore may not each define:
 *
 *   - `shipmentKeys` — one cache-key family over one dataset. Two definitions
 *     would mean a verify invalidating a list nobody is reading.
 *   - `ShipmentApiError` + `readShipmentError` — one parse of the house error
 *     envelope, carrying the server's STRUCTURED refusal whole.
 *   - `ShipmentListFilter` — the canonical, serializable list key.
 */

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
