"use client";

import { useCallback, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// THE SUBMIT LATCH — one write per Confirm, and no dismissal while it is in
// flight (reconciliation Part 2, pack § P2-B3-1R, M-a.1). Extracted from the
// adjust dialog's FR4 latch (`submittingRef` + `handleOpenChange`) and the
// move-batch dialog's `pendingRef`.
//
// TWO halves, set together and cleared together:
//
// - The REF is the truth. It is set SYNCHRONOUSLY when `run` is called, before
//   `fn` is awaited, so a second Confirm or a dismissal arriving in the instant
//   after the click (before any render has caught up — B3-1 FD3-1) is refused.
//   Every check here reads the ref.
// - `busy` is the same fact for RENDERING (a disabled fieldset, a "Saving..."
//   label). It is set in the same synchronous step, but a rendered value only
//   changes on the next render, so nothing here ever reads it.
//
// Both are cleared in `finally`, so a FAILED write releases the latch too
// (B3-1 FD4-1): Confirm sends again, Cancel closes.
//
// `run` RETHROWS `fn`'s error. Adopting handlers catch their own errors (the
// toast, the refusal line); the latch only guarantees the release.
//
// `guardOpenChange(onOpenChange)` wraps the host's callback for Radix's
// `onOpenChange` (Escape, an outside click, the X) and the Cancel button ONLY:
// it drops `open === false` while the latch is held and passes everything else.
//
// THE SUCCESS CLOSE inside `fn` goes through the HOST's raw, unguarded
// `onOpenChange(false)` — never through the guard. `fn` runs while the latch is
// held, so a close sent through the guard would be dropped and the dialog would
// stay open after the write landed.
// ---------------------------------------------------------------------------

export interface SubmitLatch {
  /** True while a `run` is in flight — for rendering only; the checks read the ref. */
  busy: boolean;
  /**
   * Runs `fn` under the latch. Returns `undefined` at once, WITHOUT calling `fn`,
   * while another run holds it; otherwise `fn`'s result. Rethrows `fn`'s error.
   */
  run<T>(fn: () => Promise<T>): Promise<T | undefined>;
  /** Drops `open === false` while the latch is held; passes everything else through. */
  guardOpenChange(onOpenChange: (open: boolean) => void): (open: boolean) => void;
}

/**
 * One write per Confirm, no dismissal while it is in flight. Wire Radix's
 * `onOpenChange` and the Cancel button through `guardOpenChange`; close on
 * success with the host's RAW `onOpenChange(false)` — through the guard, a
 * close issued while the latch is held is dropped.
 */
export function useSubmitLatch(): SubmitLatch {
  const heldRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (heldRef.current) return undefined;
    // Both halves, synchronously, before `fn` is awaited.
    heldRef.current = true;
    setBusy(true);
    try {
      return await fn();
    } finally {
      heldRef.current = false;
      setBusy(false);
    }
  }, []);

  const guardOpenChange = useCallback(
    (onOpenChange: (open: boolean) => void) => (open: boolean) => {
      if (!open && heldRef.current) return;
      onOpenChange(open);
    },
    [],
  );

  return { busy, run, guardOpenChange };
}
