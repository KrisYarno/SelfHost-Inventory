"use client";

/**
 * components/assistant/status-region.tsx — the SINGLE visually-hidden live
 * region (spec §12 D-B10). Streamed transcript text carries NO aria-live; this
 * one polite, atomic `role="status"` region announces lifecycle MILESTONES only
 * ("Assistant is responding." / a tool label / "Response complete." /
 * "Response stopped." / "Assistant response failed."). Milestone text is set by
 * the transcript as the machine advances.
 */

export function StatusRegion({ message }: { message: string }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
