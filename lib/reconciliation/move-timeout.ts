/**
 * THE MOVE'S OWN CLOCK (pack CB2.5e.4; the seam check of P2-B2.5). ONE owner
 * for the two callers that post a move — the workbench's raw fetch
 * (`app/(app)/workbench/page.tsx`) and the admin hook (`hooks/use-admin.ts`)
 * — so the sentence and the abort rule have one spelling. Next-free, no
 * imports: safe in either bundle.
 */
export const MOVE_TIMEOUT_MS = 60_000;

/** VERBATIM: the dialog renders `error` as the server's own sentence would be. */
export const MOVE_TIMEOUT_SENTENCE =
  "The move did not answer in time — check the batch before trying again";

/**
 * `AbortSignal.timeout` rejects the fetch with a `DOMException` NAMED
 * `TimeoutError`. The NAME is what is checked, not the class: an abort can
 * arrive from another realm, and a plain `AbortController` abort (name
 * `AbortError`) is deliberately NOT this — nobody aborts a move by hand.
 */
export function isTimeoutAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}
