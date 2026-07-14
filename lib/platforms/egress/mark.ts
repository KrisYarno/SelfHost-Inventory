/**
 * lib/platforms/egress/mark.ts — how the CI network interceptor recognises
 * traffic that came from the chokepoint.
 *
 * PRIVATE to lib/platforms/egress/ (plus the interceptor itself, which is
 * explicitly allowlisted in the import-boundary test).
 *
 * This is a DIFFERENT mechanism from the authorization token in `http.ts`, and
 * the distinction matters:
 *
 *   - The AUTHORIZATION token (http.ts, a module-private WeakSet) is the real,
 *     in-process guarantee: `send()` refuses any request the gate did not mint.
 *     It is unforgeable because the WeakSet is never exported — there is nothing
 *     to import, copy, or guess.
 *
 *   - This MARK is only a TEST-TIME label. `http.ts` attaches it to the fetch
 *     init so the interceptor can answer "did this platform-bound request come
 *     from egress?" without inspecting stack traces (which are forgeable and
 *     unstable under jest's transforms — RV-1).
 *
 * Could a bypass import this module and forge the mark? Yes — and that import is
 * itself a CI failure (Layer B, the import boundary), which is the point of
 * having three independent layers instead of one clever one.
 */

/**
 * Symbol key attached to the `RequestInit` that `http.ts` passes to fetch.
 * `fetch` ignores unknown properties on init, so this is inert at runtime and
 * visible to the interceptor.
 */
export const EGRESS_MARK: unique symbol = Symbol("lane6.egress.mark");

/** Shape of a marked init, for the interceptor's type-safe read. */
export type MarkedRequestInit = RequestInit & {
  [EGRESS_MARK]?: true;
};

/** True when this init was minted by the egress chokepoint. */
export function isEgressMarked(init: unknown): boolean {
  return (
    typeof init === "object" &&
    init !== null &&
    (init as MarkedRequestInit)[EGRESS_MARK] === true
  );
}
