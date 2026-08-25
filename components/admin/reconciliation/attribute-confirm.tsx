"use client";

/**
 * components/admin/reconciliation/attribute-confirm.tsx — the last panel before
 * a manual attribution is written (pack C4a.2; spec REV-7 D4).
 *
 * Three sentences, in this order, because they answer the three questions an
 * admin is actually asking:
 *
 *   1. WHAT DO THESE TWO HAVE IN COMMON? The overlap between the order's items
 *      and the batch's products — and when it cannot be computed, THAT, in
 *      words. An empty overlap rendered as a list reads as "nothing in common",
 *      which is a claim this panel is in no position to make (spec §4.2).
 *   2. WHAT EXACTLY WILL MOVE? The row count, the target and its internal
 *      status.
 *   3. WHAT WILL NOT MOVE? The frozen sentence: this records attribution only.
 *
 * A batch that is already stamped additionally demands a REASON — moving a
 * batch off an existing stamp is a correction of somebody's earlier decision,
 * and it is recorded with its reason or not at all (D4, 400 REASON_REQUIRED).
 * The button is disabled rather than the server consulted: the refusal is
 * knowable here.
 */

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAttributeBatch, type ReconciliationError } from "@/hooks/use-admin";

/** VERBATIM (pack C4a.2 / spec D4). */
export const ATTRIBUTION_ONLY_SENTENCE =
  "This records attribution only — it does not stock out or fulfil the order.";

/**
 * What this surface knows about the candidate order. Everything but the id is
 * NULLABLE: the picker learns an order through the search (which returns a
 * number, a status and an item count), while an R2b lock names an order by ID
 * only — and a number this page never read is not a number it may print.
 */
export interface AttributeTarget {
  id: string;
  orderNumber: string | null;
  internalStatus: string | null;
  itemCount: number | null;
}

export function overlapSentence(target: AttributeTarget): string {
  return target.itemCount === null
    ? "overlap cannot be computed — this page did not read this order's line items"
    : `overlap cannot be computed — this page reads this order's item count (${target.itemCount}), not its line items`;
}

export function AttributeConfirm({
  batchId,
  target,
  rowCount,
  previousOrderRecordId,
  onDone,
  onBatchMoved,
}: {
  batchId: string;
  target: AttributeTarget;
  /** The batch's population rows, as the drill-down read them; null when it could not. */
  rowCount: number | null;
  /** The id the ROW DISPLAYED — the stale-client guard's whole point (D4). */
  previousOrderRecordId: string | null;
  onDone: () => void;
  onBatchMoved: () => void;
}) {
  const attribute = useAttributeBatch(batchId);
  const [reason, setReason] = React.useState("");
  const [refusal, setRefusal] = React.useState<string | null>(null);

  const reasonRequired = previousOrderRecordId !== null;
  const label = target.orderNumber === null ? `#${target.id}` : `#${target.orderNumber}`;
  const status =
    target.internalStatus === null
      ? "internal status: not read on this page"
      : `internal status: ${target.internalStatus}`;

  async function submit() {
    setRefusal(null);
    try {
      const result = await attribute.mutateAsync({
        orderRecordId: target.id,
        expectPreviousOrderRecordId: previousOrderRecordId,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success(
        result.changed
          ? `Batch attributed to ${label}`
          : `This batch was already attributed to ${label}`,
      );
      onDone();
    } catch (err) {
      const refused = err as ReconciliationError;
      // Every refusal renders VERBATIM: the server named the truth, and a
      // paraphrase would send the admin back to guess at it. The refetch is the
      // mutation's own `onSettled`.
      setRefusal(refused.message);
      if (refused.code === "BATCH_MOVED") {
        const moved = refused.currentOrderRecordId;
        toast.info(
          moved
            ? `someone attributed this batch to #${moved} while you were looking — refreshed`
            : "someone changed this batch's attribution while you were looking — refreshed",
        );
        onBatchMoved();
      }
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <p className="text-body-sm text-muted-foreground" data-testid="confirm-overlap">
        {overlapSentence(target)}
      </p>
      <p className="text-body" data-testid="confirm-scope">
        {rowCount === null
          ? `Attributing this batch to ${label} (${status}). The batch's row count could not be read.`
          : `Attributing ${rowCount} ledger rows to ${label} (${status}).`}
      </p>
      <p className="text-body font-medium" data-testid="confirm-attribution-only">
        {ATTRIBUTION_ONLY_SENTENCE}
      </p>

      {reasonRequired && (
        <div className="space-y-1">
          <Label htmlFor="attribute-reason">
            Reason (required — this batch is already attributed)
          </Label>
          <Textarea
            id="attribute-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why does this batch belong to the other order?"
          />
        </div>
      )}

      {refusal !== null && (
        <p
          className="rounded-md border border-negative-border bg-negative-muted p-3 text-body-sm text-negative-foreground"
          data-testid="attribute-refusal"
          role="alert"
        >
          {refusal}
        </p>
      )}

      <Button
        type="button"
        onClick={submit}
        disabled={attribute.isPending || (reasonRequired && reason.trim().length === 0)}
      >
        Attribute this batch
      </Button>
    </div>
  );
}
