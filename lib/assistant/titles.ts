/**
 * lib/assistant/titles.ts — model-generated thread titles (spec C6; contract pack
 * T6, seam S6).
 *
 * **WAVE-1 STUB.** The route's detached dispatch site is real from task 1.2 — the
 * seam exists, is typed, and is exercised by the route's tests — but this function
 * resolves immediately and WRITES NOTHING: no `assistant_threads.title`, no
 * `assistant_requests` title row (which is why W1's telemetry matrix carries the
 * title cases as skipped charters, not failures). Task 2.3 fills it in: the
 * "creating-model" branch does the detached model call (AbortController + 10s race,
 * maxOutputTokens 24, sanitize to <= 120 chars, conditional
 * `UPDATE ... WHERE title IS NULL`, truncation fallback on failure), and the
 * "later-fallback" branch does NO model call at all — it backfills from the first
 * persisted user text only when the thread is still untitled and its first chat
 * request failed or aborted.
 *
 * MUST stay Next-free.
 */

/**
 * Which title path a finished turn earned. `creating-model` rides the turn that
 * CREATED the thread (its first user text is already in hand — no read needed);
 * `later-fallback` is every other finished turn, where a still-untitled thread gets
 * a no-model backfill.
 */
export type TitleJob =
  | {
      mode: "creating-model";
      userId: number;
      threadId: string;
      firstUserText: string;
      membershipScope: string[];
    }
  | { mode: "later-fallback"; userId: number; threadId: string };

/** Detached: the caller fires this with `void` and never awaits it — a title is
 *  never allowed to delay or fail a turn. */
export function generateThreadTitle(job: TitleJob): Promise<void> {
  void job;
  return Promise.resolve();
}
