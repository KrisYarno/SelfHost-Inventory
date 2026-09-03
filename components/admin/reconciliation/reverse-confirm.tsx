"use client";

/**
 * components/admin/reconciliation/reverse-confirm.tsx — the last panel before a
 * batch is put back (reconciliation Part 2, pack CB2b.4; spec §2.5).
 *
 * The SHAPE of `attribute-confirm.tsx`, deliberately: an inline panel inside the
 * drill-down Sheet, not a Dialog. A dialog over a sheet is a second modal layer
 * for a decision the admin is already looking at the evidence for.
 *
 * TWO SENTENCES, because there are two things to know:
 *
 *   1. WHAT THIS WILL DO, at most — the batch's own units and products, as the
 *      report read them.
 *   2. WHAT IT WILL NOT DO — restore anything that has already been put back.
 *      The SERVER computes the remainder from the restoration ledger; this panel
 *      never guesses at it, and says so rather than printing a number it cannot
 *      stand behind (CH-5: restorations made by the pre-B2 Undo are invisible to
 *      that ledger, so "up to" is the honest word here).
 *
 * Every refusal renders VERBATIM (the F7 rule). `ALREADY_REVERSED` arrives with
 * its own numbers in its sentence, which is exactly what an admin needs.
 *
 * THE LATCH IS A REF (F5/OC-5, corrected by F16 — `MoveBatchDialog` had no latch
 * of its own to copy, and now carries the same one). React Query's `isPending`
 * is set on a later tick and so is React state, so two clicks inside ONE tick
 * both read `false` and both POST — and a reverse posted twice is a second
 * restoration attempt against a ledger the first one is still writing. A ref is
 * written and read in the same statement, before the await; `result` latches the
 * settled case.
 *
 * AND THERE IS A WAY OUT. A confirm panel with no Cancel leaves the admin
 * closing the whole Sheet to change their mind (OC-5).
 */

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useReverseBatch, type ReconciliationError } from "@/hooks/use-admin";

/** VERBATIM (pack CB2b.4 / CH-5). */
export const REVERSE_REMAINDER_SENTENCE =
  "Restores only what has not been put back through this action";

export function ReverseConfirm({
  batchId,
  units,
  productCount,
  onDone,
}: {
  batchId: string;
  /** The batch's outbound units, as the report row read them. */
  units: number;
  productCount: number;
  onDone: () => void;
}) {
  const reverse = useReverseBatch(batchId);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  /** The latch itself (F16). `pending` only drives the disabled attribute. */
  const pendingRef = React.useRef(false);
  const [result, setResult] = React.useState<string | null>(null);

  async function submit() {
    // SYNCHRONOUS, before the await: a second click in the same tick would
    // otherwise read a `pending` neither react-query nor React has set yet.
    if (pendingRef.current || result !== null) return;
    pendingRef.current = true;
    setRefusal(null);
    setPending(true);
    try {
      const answer = await reverse.mutateAsync();
      setResult(answer.message);
      // The SERVER's own sentence, numbers and all — this surface never
      // recomputes what was restored.
      toast.success(answer.message);
      onDone();
    } catch (err) {
      setRefusal((err as ReconciliationError).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <p className="text-body" data-testid="reverse-scope">
        {`Reverse this batch — restores up to ${units} units across ${productCount} product(s)`}
      </p>
      <p className="text-body-sm text-muted-foreground" data-testid="reverse-remainder">
        {REVERSE_REMAINDER_SENTENCE}
      </p>

      {refusal !== null && (
        <p
          className="rounded-md border border-negative-border bg-negative-muted p-3 text-body-sm text-negative-foreground"
          data-testid="reverse-refusal"
          role="alert"
        >
          {refusal}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          data-testid="reverse-confirm-submit"
          onClick={submit}
          disabled={pending || result !== null || reverse.isPending}
        >
          Reverse this batch
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="reverse-confirm-cancel"
          onClick={onDone}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
