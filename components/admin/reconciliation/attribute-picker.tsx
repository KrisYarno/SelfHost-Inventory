"use client";

/**
 * components/admin/reconciliation/attribute-picker.tsx — choosing the order a
 * batch belongs to (pack C4a.2; spec REV-7 §4.2).
 *
 * Two modes, and the difference between them is the whole point:
 *
 *   - FREE: the admin types an order NUMBER — any part of it (§ P2-B3-1R) — and
 *     the server answers with at most twenty matches, ranked exact first, and an
 *     exact count of what it left off. The field is PRE-SEEDED with the
 *     reference the operator typed at the deduction when that reference looks
 *     like an order number and the field is still empty — the commonest
 *     correction on this surface is "the number they typed was right, the
 *     resolver just could not use it". A leading `#` is stripped as typed, in
 *     view: order numbers are stored and shown without one.
 *   - LOCKED (R2b): the batch's own fulfillment already named an order. A
 *     manual attribution may COMPLETE that stamp, never redirect it (SETTLED
 *     11), so the field is read-only and the target is the event's order.
 *
 * The lock names an order by ID and the search reads order NUMBERS, so a locked
 * target arrives here with no number, status or item count — and the confirm
 * panel says so rather than printing figures this page never read.
 */

import * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatOrderDate, formatOrderStatus } from "@/components/inventory/order-number-field";
import { useDebounce } from "@/hooks/use-debounce";
import { useBatchDetail, useOrderSearch, type ApiError } from "@/hooks/use-admin";
import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";
import type { AttributionRow, BatchDetail } from "@/lib/reconciliation/attribution";
import { AttributeConfirm, type AttributeTarget } from "./attribute-confirm";

/** The picker's own debounce; the hook owns the `enabled` rule. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * MIRRORED from `normalizeOrderReference` in `lib/orders/resolve-order-reference.ts`
 * (which imports Prisma at module scope and so cannot be pulled into a client
 * bundle). Same bar, same 20-digit ceiling: a free-text reference is only
 * pre-seeded when it actually looks like an order number.
 */
function normalizeOrderReference(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return ORDER_REFERENCE_SHAPE.test(trimmed) ? trimmed : null;
}

/**
 * The id the ROW DISPLAYED. The row's own order is what the admin was looking
 * at; when the stamp names an order this surface could not read (`orderMissing`),
 * the drill-down's ledger rows carry the id it displayed instead. Anything else
 * — no stamp, or rows that disagree — is `null`, which is a STATEMENT the
 * server checks, not a default.
 */
export function displayedPreviousOrderRecordId(
  row: AttributionRow,
  detail: BatchDetail | undefined,
): string | null {
  if (row.order !== null && "id" in row.order) return row.order.id;
  const stamps = new Set(
    (detail?.ledgerRows ?? [])
      .map((ledgerRow) => ledgerRow.orderRecordId)
      .filter((id): id is string => id !== null),
  );
  return stamps.size === 1 ? Array.from(stamps)[0] : null;
}

/**
 * What a failed search says: a 4xx in the server's own sentence; a 5xx in this
 * surface's generic one (FR-R2 (12), QA-10d) — its prose is for a log, and
 * silence read as "no answer yet"; anything else, nothing.
 */
function searchErrorSentence(error: ApiError | null | undefined): string | null {
  if (!error || typeof error.status !== "number") return null;
  if (error.status >= 500) return "Couldn't search orders right now — try again.";
  if (error.status < 400) return null;
  return error.serverMessage ?? null;
}

export function AttributePicker({
  row,
  open,
  onOpenChange,
}: {
  row: AttributionRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useBatchDetail(open ? row.batchId : null);
  const lock = row.attributeLock;

  const [query, setQuery] = React.useState("");
  const [target, setTarget] = React.useState<AttributeTarget | null>(null);
  const seeded = React.useRef(false);

  const seed = normalizeOrderReference(detail.data?.auditEvent?.orderReference);
  React.useEffect(() => {
    if (seeded.current || seed === null) return;
    seeded.current = true;
    // Only into an EMPTY field: the drill-down can answer after the admin has
    // started typing, and what they typed wins.
    setQuery((current) => (current === "" ? seed : current));
  }, [seed]);

  const debounced = useDebounce(query, SEARCH_DEBOUNCE_MS);
  const search = useOrderSearch(lock ? "" : debounced);
  // An answer renders only once it is the answer for the CURRENT text (FR-R1
  // (9), CR-G1-8): in the debounce gap the key is still the previous text's,
  // and its rows are not an answer to what is in the field now.
  const answered = debounced === query;
  const results = answered ? search.data : undefined;
  // A refused search says why in the server's own words — a 4xx is the server
  // telling the admin what is wrong with what they typed (`search text is at
  // most 40 characters`); the error card's rule (QA-5). A failed one (5xx) says
  // so, in this surface's words.
  const searchError = answered ? searchErrorSentence(search.error) : null;

  const rowCount = detail.data ? detail.data.ledgerRows.length : null;
  const previous = displayedPreviousOrderRecordId(row, detail.data);
  const chosen: AttributeTarget | null = lock
    ? { id: lock.orderRecordId, orderNumber: null, internalStatus: null, itemCount: null }
    : target;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attribute this batch to an order</DialogTitle>
          <DialogDescription>
            {row.logTypes.join(", ")} · {row.units} units across {row.productCount} products.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="attribute-order-number">Order number</Label>
          <Input
            id="attribute-order-number"
            value={lock ? lock.orderRecordId : query}
            readOnly={lock !== null}
            onChange={(event) => setQuery(event.target.value.replace(/^#/, ""))}
            placeholder="Type an order number"
            inputMode="numeric"
          />
          {lock !== null ? (
            <p className="text-body-sm text-muted-foreground" data-testid="attribute-lock-copy">
              this batch was fulfilled against #{lock.orderRecordId} — you can complete that stamp,
              not change it
            </p>
          ) : null}
        </div>

        {lock === null && (
          <div className="space-y-2">
            {searchError !== null && (
              <p role="alert" className="text-body-sm text-destructive" data-testid="order-search-error">
                {searchError}
              </p>
            )}
            {results && results.moreCount > 0 && (
              <p className="text-body-sm text-muted-foreground" data-testid="order-search-more">
                ≤ 20 results — narrow the number ({results.moreCount} more match)
              </p>
            )}
            {results?.orders.map((order) => (
              <button
                key={order.id}
                type="button"
                data-testid={`order-result-${order.id}`}
                className="w-full rounded-md border border-border bg-surface p-3 text-left hover:bg-surface-hover"
                onClick={() =>
                  setTarget({
                    id: order.id,
                    orderNumber: order.orderNumber,
                    internalStatus: order.internalStatus,
                    itemCount: order.itemCount,
                  })
                }
              >
                <span className="font-medium">{order.orderNumber}</span>
                <span className="text-body-sm text-muted-foreground">
                  {" "}
                  · {order.store} · placed {formatOrderDate(order.externalCreatedAt)} ·{" "}
                  {formatOrderStatus(order.internalStatus)}
                </span>
              </button>
            ))}
            {results && results.orders.length === 0 && (
              <p className="text-body-sm text-muted-foreground">
                No order number contains what you typed.
              </p>
            )}
          </div>
        )}

        {chosen !== null && (
          <AttributeConfirm
            key={chosen.id}
            batchId={row.batchId}
            target={chosen}
            rowCount={rowCount}
            previousOrderRecordId={previous}
            onDone={() => onOpenChange(false)}
            onBatchMoved={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
