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
 *
 * THE MATCH CELL (Part 2, pack CA3) is the same kind of dumb: the class, the
 * reason there is none, or the words for a match that had nothing to compare —
 * all three from `match-keys.ts`, which is the ONE home for them (seam S-A11).
 * The only judgment is the tone, and it has exactly two registered tokens.
 */

import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  FLAGGED_MATCH_CLASSES,
  MATCH_CLASS_LABELS,
  MATCH_DEFINITIONS,
  MATCH_UNAVAILABLE_COPY,
  UNMATCHABLE,
} from "@/lib/reconciliation/match-keys";
import type { OrderMatch } from "@/lib/reconciliation/match";
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

/**
 * A MATCH WHOSE CLASS IS NULL IS STILL A MATCH (pack REV 4). The matcher read
 * both sides and found nothing on the ordered side to compare against — which
 * is a different fact from "this row has no order", and rendering it from
 * `MATCH_UNAVAILABLE_COPY` would tell an admin the row could not be read.
 */
export const NOT_COMPARABLE_COPY = "not comparable";

/**
 * The pair `match` / `matchUnavailable` is EXACTLY-ONE-OF by contract
 * (`attribution.ts`), so both being null cannot happen on a real read. It is
 * said rather than left blank anyway: an empty cell in this column reads as
 * "nothing wrong here", which is the one thing it must never mean.
 */
export const MATCH_NOT_COMPUTED_COPY = "not computed";

/** The class in the vocabulary's words — S-A11's map, never re-spelled here. */
export function matchClassLabel(match: OrderMatch): string {
  return match.class === null ? NOT_COMPARABLE_COPY : MATCH_CLASS_LABELS[match.class];
}

/** The sentence that rides with the class (truthful-data: a class alone is a rumour). */
export function matchDefinition(match: OrderMatch): string {
  return MATCH_DEFINITIONS[match.class === null ? UNMATCHABLE : match.class];
}

/**
 * The two REGISTERED tokens, and only those (pack CA3): the classes an admin
 * should look at carry `warning`, the rest are muted. There is no third colour
 * on this surface to invent.
 */
export function matchToneClass(match: OrderMatch): string {
  return match.class !== null && FLAGGED_MATCH_CLASSES.has(match.class)
    ? "text-warning font-medium"
    : "text-muted-foreground";
}

/** One row's match, in the one presentation both breakpoints share. */
export function MatchCell({ row, testId }: { row: Row; testId: string }) {
  if (row.matchUnavailable !== null) {
    return (
      <span
        data-testid={testId}
        className="text-muted-foreground"
        title={MATCH_DEFINITIONS[row.matchUnavailable]}
      >
        {MATCH_UNAVAILABLE_COPY[row.matchUnavailable]}
      </span>
    );
  }
  if (row.match === null) {
    return (
      <span data-testid={testId} className="text-muted-foreground">
        {MATCH_NOT_COMPUTED_COPY}
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      className={matchToneClass(row.match)}
      title={matchDefinition(row.match)}
    >
      {matchClassLabel(row.match)}
    </span>
  );
}

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
      <TableCell>
        <MatchCell row={row} testId={`match-${row.batchId}`} />
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
          <div className="min-w-0">
            <dt className="text-muted-foreground">Match</dt>
            <dd>
              <MatchCell row={row} testId={`match-card-${row.batchId}`} />
            </dd>
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
