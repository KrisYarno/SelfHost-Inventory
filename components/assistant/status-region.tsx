"use client";

/**
 * components/assistant/status-region.tsx — the SINGLE visually-hidden live
 * region (spec §12 D-B10). Streamed transcript text carries NO aria-live; this
 * one polite, atomic `role="status"` region announces lifecycle MILESTONES only
 * ("Assistant is responding." / a tool label / "Response complete." /
 * "Response stopped." / "Assistant response failed." / "Assistant response timed
 * out." / …). Milestone text is set by the transcript as the machine advances —
 * `milestoneFor` in transcript.tsx is the exhaustive list, one string per state.
 */

export function StatusRegion({ message }: { message: string }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
