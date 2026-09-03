"use client";

/**
 * components/workbench/move-batch-dialog.tsx — THE ONE MOVE DIALOG, two callers
 * (reconciliation Part 2, pack CB2c.4; spec §2.6).
 *
 * "The stock left a different location than the books say." Two surfaces ask
 * that question — the workbench's completion toast, seconds after a cart went
 * out at the wrong location, and the reconciliation drill-down, days later — and
 * they ask it about the same act. So there is ONE dialog: it owns the location
 * select, the consequence sentence, the confirm, and how a refusal is rendered.
 * What it does NOT own is the request: each caller passes its own `onConfirm`,
 * because the workbench posts through a raw fetch with its own CSRF token and
 * the drill-down goes through react-query.
 *
 * ONE POST, FOR THE MANUAL BATCH ONLY (PK-1). A mixed cart wrote TWO batches,
 * and only the deduct-simple one can be moved: a fulfilment-evidenced batch is
 * put right by unfulfill + refulfil at the correct location, because unfulfill
 * restores at the request's own location and reads no restoration ledger. So the
 * order leg gets a SENTENCE and no request — a control whose only outcome is a
 * server refusal is not an affordance.
 *
 * THE UNITS IN THE CONSEQUENCE LINE ARE THE CALLER'S, AND SAY WHOSE (F3). From
 * the workbench `units` is what the completion ASKED for; from the drill-down it
 * is the batch's outbound Σ as the report read it OFF THE LEDGER. `caller`
 * selects which of the two the sentence claims to hold. Either way the SERVER
 * decides what actually moved and answers with its own `pairs`, and the result
 * line prints that figure (truthful data).
 *
 * EVERY REFUSAL RENDERS VERBATIM (the F7 rule). `ALREADY_MOVED`,
 * `INSUFFICIENT_AT_SOURCE` and `SAME_LOCATION` all arrive with their own numbers
 * in their own sentences, which is exactly what an operator needs.
 */

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useLocations } from "@/hooks/use-locations";
import type { CompletionBatchIds } from "@/components/workbench/complete-order-dialog";

/** The `unmapped-tab.tsx` select, so the two reconciliation surfaces match. */
const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border bg-background px-2 text-body-sm text-foreground";

/**
 * The move route's 200 body (pack CB2c.2), as both callers resolve it. `pairs`
 * is the SERVER's account of what moved — one entry per product, with the id its
 * two TRANSFER legs share — and it is what the result line prints.
 */
export type MoveResponse = {
  movedBatchId: string;
  batchId: string;
  orderRecordId: string | null;
  ledgerLocationId: number;
  physicalLocationId: number;
  pairs: Array<{ productId: number; units: number; transferId: string }>;
  rows: Array<{ productId: number; locationId: number; delta: number }>;
  message: string;
};

/**
 * What a caller has to know to open this dialog (seam S-B18). `caller` selects
 * the copy and NOTHING else — both callers post the same request and read the
 * same answer.
 */
export type MoveTarget = {
  batchIds: CompletionBatchIds;
  /** The location the batch's rows name — excluded from the select. */
  ledgerLocationId: number;
  ledgerLocationName: string;
  /** The CALLER's units, labelled by `caller` in the consequence line. */
  units: number;
  orderRef: string;
  /**
   * WHAT `orderRef` ACTUALLY IS (F13). The drill-down falls back to the BATCH id
   * when the row names no order number, and a uuid introduced as "Order …" is a
   * claim this dialog is in no position to make.
   */
  refKind: "order" | "batch";
  caller: "workbench" | "drilldown";
};

/**
 * WHOSE NUMBER THIS IS (F3). The workbench asks about a completion that happened
 * seconds ago, so its figure is what the cart ASKED for and the server may still
 * move less; the drill-down reads the batch's outbound Σ off the ledger. Two
 * different facts, and the sentence says which one it is holding.
 */
function unitsLabel(target: MoveTarget): string {
  return target.caller === "workbench"
    ? `${target.units} units asked`
    : `${target.units} units on the ledger`;
}

/** VERBATIM (pack CB2c.4, the OC-1 rule): where a fulfilment's repair lives. */
export const MOVE_ORDER_LEG_SENTENCE =
  "order leg: unfulfill and refulfil at the correct location";

export function MoveBatchDialog({
  target,
  onOpenChange,
  onConfirm,
}: {
  target: MoveTarget | null;
  onOpenChange: (open: boolean) => void;
  /** RESOLVES with the 200 body; REJECTS with `{ error, code }` (R6-2). */
  onConfirm: (physicalLocationId: number) => Promise<MoveResponse>;
}) {
  const locations = useLocations(target !== null);
  const [choice, setChoice] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<MoveResponse | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  // A new target is a new decision: nothing carries over from the last one.
  React.useEffect(() => {
    setChoice("");
    setPending(false);
    setResult(null);
    setRefusal(null);
  }, [target]);

  // THE LEDGER LOCATION IS NOT AN OPTION. Choosing it is `SAME_LOCATION`, and a
  // select that offers the one answer the server refuses is a trap.
  const options = (locations.data ?? []).filter(
    (location) => location.id !== target?.ledgerLocationId,
  );

  async function submit() {
    if (target === null) return;
    const physicalLocationId = Number(choice);
    if (!Number.isFinite(physicalLocationId) || physicalLocationId <= 0) return;
    // PK-1: the ONE request this dialog makes, and only for the manual batch.
    if (target.batchIds.deductSimpleBatchId === null) return;

    setRefusal(null);
    setPending(true);
    try {
      setResult(await onConfirm(physicalLocationId));
    } catch (err) {
      // The SERVER's sentence, verbatim — never a house paraphrase.
      const refused = err as { error?: unknown };
      setRefusal(
        typeof refused?.error === "string"
          ? refused.error
          : "The move could not be completed.",
      );
    } finally {
      setPending(false);
    }
  }

  const movedUnits = result === null
    ? 0
    : result.pairs.reduce((sum, pair) => sum + pair.units, 0);

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Wrong location</DialogTitle>
          <DialogDescription>
            {target === null
              ? ""
              : `${target.refKind === "batch" ? "Batch" : "Order"} ${target.orderRef} — ` +
                "where did this stock actually leave from?"}
          </DialogDescription>
        </DialogHeader>

        {target !== null && (
          <div className="space-y-3">
            <p className="text-body-sm text-muted-foreground" data-testid="move-consequence">
              {`Moves this batch's books (${unitsLabel(target)}) from ` +
                `${target.ledgerLocationName} to the chosen location — the order stays attributed`}
            </p>

            <div className="space-y-1">
              <Label htmlFor="move-dialog-location">Stock actually left</Label>
              <select
                id="move-dialog-location"
                data-testid="move-dialog-location"
                className={SELECT_CLASS}
                value={choice}
                disabled={pending || result !== null}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">Choose a location…</option>
                {options.map((location) => (
                  <option key={location.id} value={String(location.id)}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>

            {/* The WC half of a mixed cart. A SENTENCE and no request: this
                dialog never posts for a fulfilment batch. */}
            {target.batchIds.fulfilBatchId !== null && (
              <p className="text-body-sm text-muted-foreground" data-testid="move-result-order">
                {MOVE_ORDER_LEG_SENTENCE}
              </p>
            )}

            {result !== null && (
              <p className="text-body-sm text-positive-foreground" data-testid="move-result-manual">
                {`manual leg: moved ${movedUnits} units`}
              </p>
            )}

            {refusal !== null && (
              <p
                className="rounded-md border border-negative-border bg-negative-muted p-3 text-body-sm text-negative-foreground"
                data-testid="move-dialog-refusal"
                role="alert"
              >
                {refusal}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            data-testid="move-dialog-confirm"
            onClick={submit}
            disabled={
              target === null ||
              pending ||
              result !== null ||
              choice === "" ||
              target.batchIds.deductSimpleBatchId === null
            }
          >
            Move this batch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
