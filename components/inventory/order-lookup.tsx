"use client";

/**
 * components/inventory/order-lookup.tsx — find the order a removal was for
 * (reconciliation Part 2, pack CB3b-ii.1b + § P2-B3-1, B3-1b; SETTLED 16).
 *
 * A type-ahead over the order search: the operator types the START of an
 * order number, picks the row, and the picked order's id rides the adjust
 * request as `selectedExternalOrderId`. The search is the SAME hook the
 * Attribute… picker uses — one key, one `enabled` rule — imported from its leaf
 * module so the inventory page never pulls the admin hooks. An admin searches
 * every order; anyone else searches their own companies' orders (the route
 * decides, not this component).
 *
 * Three answers are kept apart, because they mean different things:
 *   - rows                → pick one;
 *   - an EMPTY answer     → the route's own `note` when it sent one (a member:
 *                           "none in your companies" is not "none anywhere"),
 *                           else the picker's sentence;
 *   - a FAILED search     → said as a failure, never rendered as an empty list
 *                           that reads like "no such order" — and a 429 says
 *                           it was too many searches, with the way round it.
 *
 * Before any of that (B3-1 FR1): a query that is not an order number at all
 * (`#4521`) gets the reference field's hint and is NEVER searched — "no order
 * matching that number" would be a false answer to a malformed question. While
 * the first answer for a query is in flight, the lookup says it is searching.
 *
 * Order numbers render as stored, WITHOUT a `#` — the reference field beside
 * this lookup refuses `#`, and the two must not teach the operator opposite
 * spellings.
 */

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebounce } from "@/hooks/use-debounce";
import { useOrderSearch } from "@/hooks/use-order-search";
import { ORDER_REFERENCE_HINT, ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";

/** The picker's debounce; the hook owns the `enabled` rule. */
const SEARCH_DEBOUNCE_MS = 250;

/** Typed, and not an order number: the bar the resolver applies, applied here first. */
function failsShape(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && !ORDER_REFERENCE_SHAPE.test(trimmed);
}

/** The empty answer when the route sent no `note` — the picker's own sentence. */
export const ORDER_LOOKUP_EMPTY_SENTENCE = "No order number starts with what you typed.";

/** The failure, stated as one — never an empty list. */
export const ORDER_LOOKUP_ERROR_SENTENCE = "Could not search orders — try again.";

/** The rate limit, said as one — the search is not retried, and the field beside it still works. */
export const ORDER_LOOKUP_RATE_LIMITED_SENTENCE =
  "Too many searches just now — wait a minute, or type the order number instead.";

/** The first answer for this query is still on its way. */
export const ORDER_LOOKUP_SEARCHING_SENTENCE = "Searching…";

/** What a pick carries back to the host: the id it sends, the number it shows. */
export interface PickedOrder {
  id: string;
  orderNumber: string;
}

interface OrderLookupProps {
  value: PickedOrder | null;
  onChange: (next: PickedOrder | null) => void;
  disabled?: boolean;
}

export function OrderLookup({ value, onChange, disabled }: OrderLookupProps) {
  const inputId = React.useId();
  const hintId = `${inputId}-hint`;
  const [query, setQuery] = React.useState("");
  const debounced = useDebounce(query, SEARCH_DEBOUNCE_MS);
  // The hint follows the keystrokes; the search never asks with a malformed
  // query — neither the one on screen nor a debounced one not yet caught up.
  const shapeInvalid = failsShape(query);
  // A chosen order is not searched for: "" is the hook's disabled state.
  const search = useOrderSearch(
    value === null && !shapeInvalid && !failsShape(debounced) ? debounced : "",
  );

  if (value !== null) {
    return (
      <div className="space-y-2">
        <Label className="text-xs font-medium text-muted-foreground">Order</Label>
        <div
          data-testid="order-lookup-picked"
          className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface p-3"
        >
          <span className="min-w-0 break-words text-sm font-medium">
            Order {value.orderNumber}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Clear order ${value.orderNumber}`}
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            Clear
          </Button>
        </div>
      </div>
    );
  }

  const data = search.data;

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Find the order</Label>
      <Input
        id={inputId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Type the start of the order number"
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={shapeInvalid}
        aria-describedby={shapeInvalid ? hintId : undefined}
        disabled={disabled}
      />

      {shapeInvalid ? (
        <p id={hintId} className="text-[11px] text-destructive">
          {ORDER_REFERENCE_HINT}
        </p>
      ) : search.isError ? (
        <p role="alert" data-testid="order-lookup-error" className="text-body-sm text-destructive">
          {search.error?.status === 429
            ? ORDER_LOOKUP_RATE_LIMITED_SENTENCE
            : ORDER_LOOKUP_ERROR_SENTENCE}
        </p>
      ) : search.isLoading ? (
        // `isLoading` = the FIRST fetch for this query, with no data yet — a
        // background refetch of an answer already on screen never flashes it.
        <p data-testid="order-lookup-searching" className="text-body-sm text-muted-foreground">
          {ORDER_LOOKUP_SEARCHING_SENTENCE}
        </p>
      ) : data ? (
        <div className="space-y-2">
          {data.orders.map((order) => (
            <button
              key={order.id}
              type="button"
              data-testid={`order-lookup-result-${order.id}`}
              className="w-full break-words rounded-md border border-border bg-surface p-3 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => onChange({ id: order.id, orderNumber: order.orderNumber })}
              disabled={disabled}
            >
              <span className="font-medium">{order.orderNumber}</span>
              <span className="text-body-sm text-muted-foreground">
                {" "}
                · {order.platform} · {order.internalStatus} · {order.itemCount} items
              </span>
            </button>
          ))}
          {data.moreCount > 0 && (
            <p data-testid="order-lookup-more" className="text-body-sm text-muted-foreground">
              and {data.moreCount} more — narrow the search
            </p>
          )}
          {data.orders.length === 0 && (
            <p data-testid="order-lookup-empty" className="text-body-sm text-muted-foreground">
              {data.note ?? ORDER_LOOKUP_EMPTY_SENTENCE}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
