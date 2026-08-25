"use client";

/**
 * components/admin/reconciliation/attribute-picker.tsx — choosing the order a
 * batch belongs to (pack C4a.2; spec REV-7 §4.2).
 *
 * Two modes, and the difference between them is the whole point:
 *
 *   - FREE: the admin types an order NUMBER and the server answers with at most
 *     twenty matches and an exact count of what it left off. The field is
 *     PRE-SEEDED with the reference the operator typed at the deduction when
 *     that reference looks like an order number — the commonest correction on
 *     this surface is "the number they typed was right, the resolver just could
 *     not use it".
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
import { useDebounce } from "@/hooks/use-debounce";
import { useBatchDetail, useOrderSearch } from "@/hooks/use-admin";
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
const ORDER_REFERENCE_SHAPE = /^[0-9]{1,20}$/;

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
    setQuery(seed);
  }, [seed]);

  const debounced = useDebounce(query, SEARCH_DEBOUNCE_MS);
  const search = useOrderSearch(lock ? "" : debounced);

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
            onChange={(event) => setQuery(event.target.value)}
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
            {search.data && search.data.moreCount > 0 && (
              <p className="text-body-sm text-muted-foreground" data-testid="order-search-more">
                ≤ 20 results — narrow the number ({search.data.moreCount} more match)
              </p>
            )}
            {search.data?.orders.map((order) => (
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
                <span className="font-medium">#{order.orderNumber}</span>{" "}
                <span className="text-body-sm text-muted-foreground">
                  {order.platform} · {order.internalStatus} · {order.itemCount} items
                </span>
              </button>
            ))}
            {search.data && search.data.orders.length === 0 && (
              <p className="text-body-sm text-muted-foreground">
                No order number starts with what you typed.
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
