"use client";

/**
 * components/inventory/order-number-field.tsx — the ONE field a removal names
 * its order in (reconciliation Part 2, pack § P2-B3-1R, R-b.1; replaces
 * `OrderLookup` and the typed reference box beside it).
 *
 * The operator types the order number. While they type, the field asks the
 * order search (debounced, five rows, this product's lines) and says what it
 * found in ONE status line: the order, its store and date, and whether this
 * product is on it. Whatever it shows, the field never picks for them:
 *
 *   - a TAP (or Enter/Space on a focused row, or `Use this order`) picks the
 *     order, and the removal carries its id;
 *   - anything else leaves the TEXT, which the removal carries as the number to
 *     resolve or to save for an admin. An exact match on screen and untapped is
 *     resolved by the server the same way (R-a.5) — seeing is not picking.
 *
 * Nothing renders as an answer until the answer is for the CURRENT text
 * ("settled"): a debounced key catching up, or a first fetch in flight, reads
 * `Checking…`, never the previous number's rows. The hook has no
 * `placeholderData` for the same reason.
 *
 * The text is normalised AS TYPED, visibly: a leading `#` and every space go,
 * so what the operator sees is what is sent. Text that is still not an order
 * number (1–20 digits) is never searched; it says so, with a one-tap `Clear`,
 * and the dialog blocks the save on it (the pack's one named exception).
 *
 * There is NO Escape handling here: Radix's Escape listener runs on the
 * document in the capture phase, and the dialog's non-empty-draft rule already
 * keeps it open.
 */

import * as React from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDebounce } from "@/hooks/use-debounce";
import { useOrderSearch, type OrderSearchResult } from "@/hooks/use-order-search";
import { NO_COMPANY_MEMBERSHIP_NOTE } from "@/lib/orders/order-capture-sentences";
import { ORDER_REFERENCE_SHAPE } from "@/lib/orders/order-reference-shape";
import { cn } from "@/lib/utils";

/** The search's debounce, the picker's idiom. */
const SEARCH_DEBOUNCE_MS = 250;

/** The rows this field asks for and shows. */
const PAGE_LIMIT = 5;

/** A picked order is a search row, carried whole: the summary reads it. */
export type PickedOrder = OrderSearchResult;

/** What the field edits: the text in the box, and the order explicitly picked. */
export interface OrderCapture {
  text: string;
  picked: PickedOrder | null;
}

interface OrderNumberFieldProps {
  productId: number;
  /** The units being removed; `null` while the quantity field is empty. */
  quantity: number | null;
  value: OrderCapture;
  onChange: (next: OrderCapture) => void;
  disabled: boolean;
  /** True only right after the chip was changed to `order`. */
  focusOnMount: boolean;
}

/** As typed: a leading `#` and all whitespace removed. */
function normalizeTyped(raw: string): string {
  return raw.replace(/\s+/g, "").replace(/^#/, "");
}

/** `MMM d` in the current local year, else `MMM d, yyyy`; `date unknown` without one. */
export function formatOrderDate(iso: string | null): string {
  if (iso === null) return "date unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "date unknown";
  return date.getFullYear() === new Date().getFullYear()
    ? format(date, "MMM d")
    : format(date, "MMM d, yyyy");
}

/** The order's internal status as a word in a sentence. */
export function formatOrderStatus(internalStatus: string): string {
  return internalStatus.toLowerCase();
}

interface ProductLine {
  text: string;
  /** A warning (amber); it never blocks and never changes what is sent. */
  warn: boolean;
}

/**
 * What the order's lines say about this product (`u` = ordered units, `c` =
 * lines that cannot be checked), and the quantity warning when the removal is
 * larger than a fully-checked order lists. Unknown line mappings say "can't
 * tell", never 0.
 */
function productLines(order: PickedOrder, orderNumber: string, quantity: number | null): ProductLine[] {
  const facts = order.thisProduct;
  if (facts === undefined) return [];
  if (order.itemCount === 0) {
    return [
      {
        text: "Can't tell if this product is on this order — none of its lines are recorded yet.",
        warn: false,
      },
    ];
  }
  const u = facts.orderedUnits;
  const c = facts.uncheckedLines;
  const lines: ProductLine[] = [];
  if (u > 0 && c === 0) {
    lines.push({ text: `This product: ${u} ordered.`, warn: false });
  } else if (u > 0) {
    lines.push({
      text: `This product: at least ${u} ordered — some lines aren't linked to products.`,
      warn: false,
    });
  } else if (c === 0) {
    lines.push({
      text: `This product isn't on order ${orderNumber}. Check the number — you can still remove it.`,
      warn: true,
    });
  } else {
    lines.push({
      text: "Can't tell if this product is on this order — some of its lines aren't linked to products.",
      warn: false,
    });
  }
  if (c === 0 && u > 0 && quantity !== null && quantity > u) {
    lines.push({
      text: `You're removing ${quantity}; order ${orderNumber} lists ${u}. Check the quantity — you can still save.`,
      warn: true,
    });
  }
  return lines;
}

/** A row's short form of the product line. */
function shortProductLine(order: PickedOrder): string | null {
  const facts = order.thisProduct;
  if (facts === undefined) return null;
  if (order.itemCount === 0) return "can't tell";
  const u = facts.orderedUnits;
  const c = facts.uncheckedLines;
  if (u > 0 && c === 0) return `this product: ${u} ordered`;
  if (u > 0) return `at least ${u}`;
  if (c === 0) return "not on the order";
  return "can't tell";
}

function ProductLines({ lines }: { lines: ProductLine[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <p
          key={line.text}
          data-testid="order-number-product-line"
          className={cn("text-[11px] break-words", line.warn ? "text-warning" : "text-muted-foreground")}
        >
          {line.text}
        </p>
      ))}
    </>
  );
}

export function OrderNumberField({
  productId,
  quantity,
  value,
  onChange,
  disabled,
  focusOnMount,
}: OrderNumberFieldProps) {
  const inputId = React.useId();
  const shapeId = `${inputId}-shape`;
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Set by `Change`: the input is not mounted while an order is picked, so it
  // is focused after the render that brings it back.
  const focusAfterChange = React.useRef(false);

  const { text, picked } = value;
  const shapeOk = ORDER_REFERENCE_SHAPE.test(text);
  const illShaped = picked === null && text !== "" && !shapeOk;
  // The search is ENABLED only for non-empty, well-shaped, unpicked text; the
  // status line and the rows exist only while it is.
  const searchEnabled = picked === null && text !== "" && shapeOk;
  const debounced = useDebounce(text, SEARCH_DEBOUNCE_MS);
  // Never a malformed query either: the debounced text may still be catching up.
  const query = searchEnabled && ORDER_REFERENCE_SHAPE.test(debounced) ? debounced : "";
  const search = useOrderSearch(query, { productId, limit: PAGE_LIMIT });
  // Settled: an answer (or a failure) for the CURRENT text. A background
  // refetch of the same key keeps its status, so it does not demote this.
  const settled =
    searchEnabled && debounced === text && (search.status === "success" || search.status === "error");

  React.useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
    // Mount only: the flag is true for the render right after the chip change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (focusAfterChange.current && picked === null) {
      focusAfterChange.current = false;
      inputRef.current?.focus();
    }
  }, [picked]);

  const pick = (order: PickedOrder) => onChange({ text: order.orderNumber, picked: order });

  if (picked !== null) {
    return (
      <div className="space-y-2" data-testid="order-number-picked">
        <Label className="text-xs font-medium text-muted-foreground">Order number</Label>
        <div className="flex items-start justify-between gap-2 rounded-md border border-border bg-surface p-3">
          <div className="min-w-0 space-y-1">
            <p className="break-words text-sm font-medium">
              Order {picked.orderNumber} · {picked.store}
            </p>
            <p className="break-words text-[11px] text-muted-foreground">
              placed {formatOrderDate(picked.externalCreatedAt)} · {formatOrderStatus(picked.internalStatus)}
            </p>
            <ProductLines lines={productLines(picked, picked.orderNumber, quantity)} />
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            onClick={() => {
              focusAfterChange.current = true;
              onChange({
                text: ORDER_REFERENCE_SHAPE.test(picked.orderNumber) ? picked.orderNumber : "",
                picked: null,
              });
            }}
            disabled={disabled}
          >
            Change
          </Button>
        </div>
      </div>
    );
  }

  const data = settled && search.status === "success" ? search.data : undefined;
  // The rows on the page whose number is BYTE-EQUAL to the text — what the save
  // resolves the number against. `exactCount` is the route's count, which can
  // include collation variants of the number; the status line speaks about
  // what the save will do, so it reads THESE rows (FR-R1 (6), CR-G1-3;
  // R108-OC-7): one is found, two or more are the `≥2` choice, none is not
  // found.
  const byteEqual = data?.orders.filter((order) => order.orderNumber === text) ?? [];
  const found = byteEqual.length === 1 ? byteEqual[0] : undefined;
  const showFound = data !== undefined && found !== undefined;
  const noCompany = data?.note === NO_COMPANY_MEMBERSHIP_NOTE;

  let statusLine: React.ReactNode = null;
  if (searchEnabled) {
    if (!settled) {
      statusLine = "Checking…";
    } else if (search.status === "error") {
      statusLine =
        search.error?.status === 429
          ? "Too many lookups just now — the number will still be saved with this removal."
          : "Couldn't look up orders right now — the number will still be saved with this removal.";
    } else if (noCompany) {
      statusLine =
        "You're not in any company yet, so orders can't be looked up — the number will still be saved with this removal.";
    } else if (showFound && found !== undefined) {
      statusLine = `Order ${text} found — ${found.store}, placed ${formatOrderDate(found.externalCreatedAt)}, ${formatOrderStatus(found.internalStatus)}.`;
    } else if (data !== undefined && byteEqual.length >= 2) {
      statusLine = `${data.exactCount} orders have this number — tap the right one, or save the number without linking.`;
    } else {
      // No row byte-equal to the text, whatever `exactCount` says — which is
      // what the save will do with it (R108-OC-7).
      statusLine = `No order ${text} found. If the number is right, it's saved with this removal so an admin can link it later.`;
    }
  }

  // The rows: only for an answer, and never the found order a second time.
  const rows =
    data !== undefined && !noCompany
      ? data.orders.filter((order) => !(showFound && order === found))
      : [];

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Order number</Label>
      <Input
        ref={inputRef}
        id={inputId}
        value={text}
        onChange={(event) => onChange({ text: normalizeTyped(event.target.value), picked: null })}
        onKeyDown={(event) => {
          // Enter neither submits nor picks.
          if (event.key === "Enter") event.preventDefault();
        }}
        onFocus={(event) => {
          const element = event.currentTarget;
          if (typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
        }}
        placeholder="e.g. 20105"
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        maxLength={40}
        aria-invalid={illShaped}
        aria-describedby={illShaped ? shapeId : undefined}
        disabled={disabled}
      />

      {text === "" && (
        <p data-testid="order-number-helper" className="text-[11px] text-muted-foreground">
          If the order isn&apos;t in the app yet, type its number anyway — it&apos;s saved so an admin can link it later.
        </p>
      )}

      {illShaped && (
        <div className="flex items-center justify-between gap-2">
          <p id={shapeId} data-testid="order-number-shape" className="text-[11px] text-destructive">
            Order numbers are 1–20 digits.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            onClick={() => {
              onChange({ text: "", picked: null });
              inputRef.current?.focus();
            }}
            disabled={disabled}
          >
            Clear
          </Button>
        </div>
      )}

      {searchEnabled && (
        <div className="space-y-2">
          <div data-testid="order-number-status" role="status" aria-live="polite" className="space-y-1">
            <p className="break-words text-body-sm">{statusLine}</p>
            {showFound && found !== undefined && (
              <>
                <ProductLines lines={productLines(found, text, quantity)} />
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px]"
                  onClick={() => pick(found)}
                  disabled={disabled}
                >
                  Use this order
                </Button>
              </>
            )}
          </div>

          {rows.map((order) => {
            const short = shortProductLine(order);
            return (
              <button
                key={order.id}
                type="button"
                data-testid={`order-number-row-${order.id}`}
                className="min-h-[44px] w-full break-words rounded-md border border-border bg-surface px-3 py-2 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => pick(order)}
                disabled={disabled}
              >
                <span className="block text-sm font-medium">
                  {order.orderNumber} · {order.store}
                </span>
                <span className="block text-[11px] text-muted-foreground">
                  placed {formatOrderDate(order.externalCreatedAt)} · {formatOrderStatus(order.internalStatus)}
                  {short !== null ? ` · ${short}` : ""}
                </span>
              </button>
            );
          })}
          {data !== undefined && !noCompany && data.moreCount > 0 && (
            <p data-testid="order-number-more" className="text-[11px] text-muted-foreground">
              and {data.moreCount} more — keep typing
            </p>
          )}
        </div>
      )}
    </div>
  );
}
