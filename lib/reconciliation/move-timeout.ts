/**
 * THE MOVE'S OWN CLOCK — and the OUTCOME-UNKNOWN classification (pack CB2.5e.4;
 * the seam check of P2-B2.5, amended B25-FR1/F2). ONE owner for the two callers
 * that post a move — the workbench's raw fetch (`app/(app)/workbench/page.tsx`)
 * and the admin hook (`hooks/use-admin.ts`) — so the sentence, the clock and the
 * refusal rule have one spelling. Next-free, no imports: safe in either bundle.
 *
 * The distinction this module owns: a REFUSAL is an answer (the server told us
 * the move did NOT happen, so the batch is exactly where it was); everything
 * else — a timeout, a fetch that rejected mid-flight, an ingress 502 whose body
 * is not the house envelope — is an OUTCOME WE DO NOT HAVE. The two are handled
 * differently by both callers, so neither may guess.
 */
export const MOVE_TIMEOUT_MS = 60_000;

/**
 * VERBATIM — the ONE sentence for EVERY outcome-unknown door (the timeout, a
 * rejected fetch, a response that arrived with no refusal code). The dialog
 * renders `error` exactly as it would the server's own sentence.
 */
export const MOVE_UNANSWERED_SENTENCE =
  "The move did not answer — check the batch before trying again";

/** The envelope both callers reject with when they have no outcome. */
export type MoveUnanswered = { error: typeof MOVE_UNANSWERED_SENTENCE; code: "TIMEOUT" | "UNANSWERED" };

/**
 * `AbortSignal.timeout` rejects the fetch with a `DOMException` NAMED
 * `TimeoutError`. The NAME is what is checked, not the class: an abort can
 * arrive from another realm, and a plain `AbortController` abort (name
 * `AbortError`) is deliberately NOT this — nobody aborts a move by hand.
 */
export function isTimeoutAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

/**
 * The clock, GUARDED. `AbortSignal.timeout` is absent on older WebViews, and an
 * unguarded call throws BEFORE the fetch — inside the caller's try, where it
 * reads as a server refusal forever. Where it is missing the fetch simply runs
 * on the browser's own clock rather than failing before it starts.
 */
export function moveAbortSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(MOVE_TIMEOUT_MS)
    : undefined;
}

/**
 * A REFUSAL is a response that ARRIVED and PARSED with a string `code` — 503
 * BUSY included, which is a DEFINITE rollback. Anything else (an empty body, a
 * bare `{ error }`, a numeric code, a string, null) is not a refusal and must
 * not be read as one.
 */
export function isMoveRefusal(body: unknown): body is { error: string; code: string } {
  if (typeof body !== "object" || body === null) return false;
  const { error, code } = body as { error?: unknown; code?: unknown };
  return typeof code === "string" && code.length > 0 && typeof error === "string";
}

/**
 * The envelope for a rejected fetch: TIMEOUT for the abort we asked for,
 * UNANSWERED for every other rejection (a dead network mid-response is exactly
 * as unknown as a timeout — the request went out and nothing came back).
 */
export function moveUnanswered(err: unknown): MoveUnanswered {
  return {
    error: MOVE_UNANSWERED_SENTENCE,
    code: isTimeoutAbort(err) ? "TIMEOUT" : "UNANSWERED",
  };
}
