"use client";

/**
 * components/admin/reconciliation/attribution-row.tsx — ONE attributable batch,
 * in the two presentations the surface swaps at the `md:` breakpoint (pack
 * C4a.2; the `components/analytics/analytics-hub.tsx` pair).
 *
 * The cells are deliberately dumb: every sentence on this row was computed by
 * the producer (`how.sentence`) or is a literal the contract froze. The one
 * piece of judgment here is WHICH CONTROL RENDERS — the Attribute… button
 * appears only where `canAttribute` says the server would accept the write, and
 * a stamped fulfillment says who owns that change instead (D4: re-stamping it
 * here would desync `fulfilledQty` and the status already pushed to the store).
 */

import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { AttributionRow as Row } from "@/lib/reconciliation/attribution";

/** A stamp with no order record behind it — said, never left blank. */
export const ORDER_MISSING_COPY = "order missing";

/** No stamp at all. A different fact from "the order is gone". */
export const UNATTRIBUTED_COPY = "unattributed";

export function fulfilledAgainstCopy(fulfilled: NonNullable<Row["fulfilledAgainst"]>): string {
  return `fulfilled against #${fulfilled.orderNumber ?? fulfilled.orderRecordId} — change via unfulfill/refulfill`;
}

/**
 * The R2b lock's order is gone (CR-1). Without this, the row simply loses its
 * Attribute… button and the admin is left to guess why one unattributed
 * fulfillment batch can be corrected and the one beside it cannot. The producer
 * decides the fact; this is the sentence for it.
 */
export const FULFILLMENT_TARGET_MISSING_COPY =
  "fulfillment target missing — the named order no longer exists";

/** The operator, or the word for "no human was in this loop". */
function actorLabel(row: Row): string {
  return row.actor ? row.actor.username : "pipeline";
}

function orderLabel(row: Row): string {
  if (row.order === null) return UNATTRIBUTED_COPY;
  if ("orderMissing" in row.order) return ORDER_MISSING_COPY;
  if ("orderRedacted" in row.order) return row.order.reason;
  return `#${row.order.orderNumber}`;
}

function when(row: Row): string {
  return new Date(row.at).toLocaleString();
}

function AttributeButton({
  row,
  onAttribute,
  testId,
}: {
  row: Row;
  onAttribute: (row: Row) => void;
  testId: string;
}) {
  if (!row.canAttribute) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      data-testid={testId}
      onClick={(event) => {
        event.stopPropagation();
        onAttribute(row);
      }}
    >
      Attribute…
    </Button>
  );
}

function FulfilledNote({ row }: { row: Row }) {
  if (row.fulfilledAgainst === null) return null;
  return (
    <p className="text-body-sm text-muted-foreground">{fulfilledAgainstCopy(row.fulfilledAgainst)}</p>
  );
}

function MissingTargetNote({ row }: { row: Row }) {
  if (!row.fulfillmentTargetMissing) return null;
  return (
    <p className="text-body-sm text-muted-foreground">{FULFILLMENT_TARGET_MISSING_COPY}</p>
  );
}

export function AttributionTableRow({
  row,
  onOpen,
  onAttribute,
}: {
  row: Row;
  onOpen: (row: Row) => void;
  onAttribute: (row: Row) => void;
}) {
  return (
    <TableRow
      data-testid={`row-${row.batchId}`}
      className="cursor-pointer"
      onClick={() => onOpen(row)}
    >
      <TableCell className="whitespace-nowrap">{when(row)}</TableCell>
      <TableCell>{actorLabel(row)}</TableCell>
      <TableCell>
        <p>{row.how.sentence}</p>
        <p className="text-body-sm text-muted-foreground">{row.how.classKey}</p>
      </TableCell>
      <TableCell className="tabular-nums">
        {row.logTypes.join(", ")} · {row.units} units
      </TableCell>
      <TableCell className="tabular-nums">{row.productCount}</TableCell>
      <TableCell>
        <p>{orderLabel(row)}</p>
        <FulfilledNote row={row} />
        <MissingTargetNote row={row} />
      </TableCell>
      <TableCell className="text-right">
        <AttributeButton row={row} onAttribute={onAttribute} testId={`attribute-${row.batchId}`} />
      </TableCell>
    </TableRow>
  );
}

export function AttributionMobileCard({
  row,
  onOpen,
  onAttribute,
}: {
  row: Row;
  onOpen: (row: Row) => void;
  onAttribute: (row: Row) => void;
}) {
  return (
    <div
      data-testid={`card-${row.batchId}`}
      className="rounded-lg border border-border bg-surface p-4"
    >
      <button
        type="button"
        className="w-full text-left"
        onClick={() => onOpen(row)}
        aria-label={`Open batch ${row.batchId}`}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="font-medium">{orderLabel(row)}</span>
          <span className="shrink-0 text-body-sm text-muted-foreground">{when(row)}</span>
        </div>
        <p className="mt-2 text-body-sm">{row.how.sentence}</p>
        <p className="text-body-sm text-muted-foreground">{row.how.classKey}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm">
          <div className="min-w-0">
            <dt className="text-muted-foreground">Who</dt>
            <dd>{actorLabel(row)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Rows</dt>
            <dd className="tabular-nums">
              {row.logTypes.join(", ")} · {row.units} units
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-muted-foreground">Products</dt>
            <dd className="tabular-nums">{row.productCount}</dd>
          </div>
        </dl>
        <FulfilledNote row={row} />
        <MissingTargetNote row={row} />
      </button>
      <div className="mt-3">
        <AttributeButton
          row={row}
          onAttribute={onAttribute}
          testId={`attribute-card-${row.batchId}`}
        />
      </div>
    </div>
  );
}
