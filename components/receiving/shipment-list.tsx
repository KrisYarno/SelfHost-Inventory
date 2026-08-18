"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SUPPLY_ORDER_LIST_LIMIT,
  type SupplyOrderSummary,
} from "@/hooks/use-supply-orders";

/**
 * THE ORDERS LIST — one list over one dataset (contract pack C4a.2, spec §9).
 *
 * A supply order and a legacy W1 receipt are two shapes of the same row family,
 * discriminated by `model`, and this component renders each in its own terms
 * rather than flattening them into a lowest common denominator that is true of
 * neither.
 *
 * The DISCREPANCY CELL is the part that lies most easily, so it carries four
 * rules (PK3-7):
 *
 *   1. A SHORT LINE IS SHORT WHETHER OR NOT IT IS PRICED. "3 short · $0.00 loss"
 *      is the honest reading of an unpriced shortage; hiding the row because the
 *      money came out zero is exactly how a shortage disappears (OCs-6).
 *   2. AN UNORDERED ARRIVAL IS NEITHER OVER NOR SHORT. It is a line with no
 *      order to be measured against, so it is counted on its own.
 *   3. "MATCHES" IS SAYABLE ONLY when short, over and unordered are all zero.
 *   4. NEVER INFER A DISCREPANCY FROM MONEY. The units are the fact; the money
 *      is derived from them, and a $0 loss is not the absence of a shortage.
 *
 * The component computes NO rollups: `lib/shipments/rollup.ts` is the one
 * implementation of that arithmetic, and a second one on the client is how a UI
 * starts disagreeing with its own database.
 *
 * It also owns no server state. The page fetches (so a failed read renders as a
 * failure and never as "no orders exist" — W25-3) and hands the rows down.
 */

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

export type OrdersFilterChip =
  | "ORDERED"
  | "RECEIVING"
  | "CLOSED"
  | "CANCELLED"
  | "LEGACY";

export interface OrdersFilter {
  chips: OrdersFilterChip[];
}

/** The working surface opens on the orders that still need something done. */
export const DEFAULT_ORDERS_FILTER: OrdersFilter = { chips: ["ORDERED", "RECEIVING"] };

const CHIPS: { value: OrdersFilterChip; label: string }[] = [
  { value: "ORDERED", label: "Ordered" },
  { value: "RECEIVING", label: "Receiving" },
  { value: "CLOSED", label: "Closed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "LEGACY", label: "Legacy receipts" },
];

const NEW_FLOW_CHIPS: OrdersFilterChip[] = ["ORDERED", "RECEIVING", "CLOSED", "CANCELLED"];

/**
 * Every status a LEGACY (W1) header can be in. All three, not just OPEN: after
 * the drain there is no open legacy receipt left, so an OPEN-only chip is a
 * control that can only ever come back empty (spec REV-10 clause 6).
 */
const LEGACY_STATUSES = ["OPEN", "CLOSED", "CANCELLED"];

/** One server request: a status set, and the family it belongs to. */
export interface OrdersRequest {
  statuses: string[];
  model: "legacy" | "supply-order";
}

/**
 * The requests the chips ask for — ONE PER FAMILY (QA-3).
 *
 * `?model=` is single-valued, so a selection spanning both families cannot be
 * expressed in one request. The first reading of that asked for the UNION of the
 * statuses with NO model and narrowed on the client, which is a superset of what
 * is rendered — but a superset the server BOUNDS at 100 rows ordered by
 * `orderedAt DESC`, and a legacy header has no `orderedAt`, so it sorts last.
 * Past a hundred matching supply orders the legacy receipts the operator ticked
 * were simply not in the answer, and the screen said "no orders" about an
 * archive that was never queried.
 *
 * Two requests, merged on the client. Either half may be `null` — a family with
 * no chip is a question nobody asked.
 */
export function supplyOrdersRequests(filter: OrdersFilter): {
  newFlow: OrdersRequest | null;
  legacy: OrdersRequest | null;
} {
  const newFlow = NEW_FLOW_CHIPS.filter((chip) => filter.chips.includes(chip));
  return {
    newFlow: newFlow.length > 0 ? { statuses: [...newFlow], model: "supply-order" } : null,
    legacy: filter.chips.includes("LEGACY")
      ? { statuses: [...LEGACY_STATUSES], model: "legacy" }
      : null,
  };
}

/**
 * "Legacy receipts" means `model: 'legacy'`, ANY status (REV-10 clause 6): the
 * pre-overhaul receipts are one archive, and a closed one is exactly the kind
 * somebody comes back to ask about. The new-flow chips still say nothing about
 * them — a legacy CLOSED receipt is not what the Closed chip is about.
 */
export function matchesOrdersFilter(order: SupplyOrderSummary, filter: OrdersFilter): boolean {
  if (order.model === "legacy") {
    return filter.chips.includes("LEGACY");
  }
  return filter.chips.includes(order.status as OrdersFilterChip);
}

function toggleChip(filter: OrdersFilter, chip: OrdersFilterChip): OrdersFilter {
  const next = filter.chips.includes(chip)
    ? filter.chips.filter((value) => value !== chip)
    : [...filter.chips, chip];
  // Canonical order, so two paths to the same selection produce the same value.
  return { chips: CHIPS.map((entry) => entry.value).filter((value) => next.includes(value)) };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** "$1,250.00" — display only; every derived figure arrives pre-computed. */
function formatCents(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${String(remainder).padStart(2, "0")}`;
}

/**
 * The ORDERED DAY, read back in UTC.
 *
 * `orderedAt` is the UTC midnight of a calendar day somebody typed; formatting
 * it with local getters would show the previous day to anybody west of
 * Greenwich, which is a different order date than the one on the record.
 */
function formatOrderedDay(value: Date | string): string {
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().slice(0, 10);
}

/** A legacy receipt's creation INSTANT — a real moment, shown in local time. */
function formatInstant(value: Date | string): string {
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "ORDERED" || status === "RECEIVING" || status === "OPEN") return "default";
  if (status === "CLOSED") return "secondary";
  return "outline";
}

function orderId(order: SupplyOrderSummary): string {
  return order.model === "legacy" ? order.legacy.id : order.id;
}

// ---------------------------------------------------------------------------
// The discrepancy cell
// ---------------------------------------------------------------------------

function DiscrepancyCell({ order }: { order: SupplyOrderSummary }) {
  if (order.model === "legacy") {
    // The W1 cell, verbatim: over and under NEVER cancel, and an uncounted line
    // is UNKNOWN — reported on its own, never folded into the totals.
    const { totalOver, totalUnder, uncountedItemCount, itemCount } = order.legacy.discrepancy;
    const parts: string[] = [];
    if (totalOver > 0) parts.push(`${totalOver} over`);
    if (totalUnder > 0) parts.push(`${totalUnder} under`);

    return (
      <div data-testid="discrepancy-cell" className="text-sm">
        {parts.length > 0 ? (
          <span className="font-medium text-amber-700 dark:text-amber-400">
            {parts.join(" · ")}
          </span>
        ) : uncountedItemCount === 0 && itemCount > 0 ? (
          <span className="text-muted-foreground">No discrepancies</span>
        ) : itemCount === 0 ? (
          <span className="text-muted-foreground">No lines yet</span>
        ) : null}
        {uncountedItemCount > 0 && (
          <span className="block text-xs text-muted-foreground">
            {`${uncountedItemCount} uncounted`}
          </span>
        )}
      </div>
    );
  }

  const { shortUnits, overUnits, lossCents, surplusValueCents, unorderedLines } =
    order.discrepancy;
  const parts: string[] = [];
  // The UNITS decide what is said; the money only rides along with it.
  if (shortUnits > 0) parts.push(`${shortUnits} short · ${formatCents(lossCents)} loss`);
  if (overUnits > 0) parts.push(`${overUnits} over · ${formatCents(surplusValueCents)} surplus`);
  if (unorderedLines > 0) parts.push(`${unorderedLines} unordered`);

  return (
    <div data-testid="discrepancy-cell" className="text-sm">
      {parts.length > 0 ? (
        <span className="font-medium text-amber-700 dark:text-amber-400">
          {parts.join(" · ")}
        </span>
      ) : (
        <span className="text-muted-foreground">Matches</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The shared row chrome — the two models differ in their FACTS, not their box. */
function RowShell({
  id,
  title,
  order,
  children,
}: {
  id: string;
  title: string;
  order: SupplyOrderSummary;
  children: React.ReactNode;
}) {
  return (
    <li
      data-testid={`shipment-row-${id}`}
      className="rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <Link href={`/receiving/${id}`} className="block truncate font-medium hover:underline">
            {title}
          </Link>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {children}
          </div>
        </div>
        <DiscrepancyCell order={order} />
      </div>
    </li>
  );
}

function OrderRow({ order }: { order: SupplyOrderSummary }) {
  if (order.model === "legacy") {
    const legacy = order.legacy;
    return (
      <RowShell id={legacy.id} title={legacy.supplierRef ?? legacy.id} order={order}>
        <Badge variant={statusVariant(legacy.status)}>{legacy.status}</Badge>
        {/* No ordered date exists for a W1 receipt — it is named, not invented. */}
        <span>{`Legacy receipt · logged ${formatInstant(legacy.createdAt)}`}</span>
        <span>{`${legacy.itemCount} line(s)`}</span>
        {legacy.creator && <span>by {legacy.creator.username}</span>}
      </RowShell>
    );
  }

  const lineCount =
    order.lineCounts.ordered +
    order.lineCounts.verified +
    order.lineCounts.labeling +
    order.lineCounts.complete +
    order.lineCounts.discarded;

  return (
    <RowShell id={order.id} title={order.supplierRef ?? order.id} order={order}>
      <Badge variant={statusVariant(order.status)}>{order.status}</Badge>
      {order.supplier && <span className="truncate">{order.supplier}</span>}
      <span>{`Ordered ${formatOrderedDay(order.orderedAt)}`}</span>
      <span>{`${lineCount} line(s)`}</span>
      {order.units.stocked > 0 && <span>{`${order.units.stocked} stocked`}</span>}
      {order.creator && <span>by {order.creator.username}</span>}
    </RowShell>
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Which FAMILY's request came back FULL — one bound per request (FD2-2). */
export interface OrdersTruncation {
  newFlow: boolean;
  legacy: boolean;
}

const NOTHING_TRUNCATED: OrdersTruncation = { newFlow: false, legacy: false };

export interface ShipmentListProps {
  orders: SupplyOrderSummary[];
  filter: OrdersFilter;
  /**
   * A request came back FULL, so the server cut the page (QA-3). The page owns
   * this because it owns the reads: after the client narrowing below, the number
   * of rows here says nothing about what the bound left out.
   *
   * PER FAMILY (FD2-2), because the two families are two requests and each is
   * bounded on its own. Collapsed into one boolean, a full page of supply orders
   * plus a single legacy receipt rendered 101 rows under a claim that the
   * newest 100 were being shown — and said nothing about WHICH list to refine.
   */
  truncated?: OrdersTruncation;
  onFilterChange: (filter: OrdersFilter) => void;
  onNew: () => void;
}

export function ShipmentList({
  orders,
  filter,
  truncated = NOTHING_TRUNCATED,
  onFilterChange,
  onNew,
}: ShipmentListProps) {
  const visible = orders.filter((order) => matchesOrdersFilter(order, filter));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {CHIPS.map((chip) => {
            const selected = filter.chips.includes(chip.value);
            return (
              <Button
                key={chip.value}
                size="sm"
                variant={selected ? "default" : "outline"}
                aria-pressed={selected}
                onClick={() => onFilterChange(toggleChip(filter, chip.value))}
              >
                {chip.label}
              </Button>
            );
          })}
        </div>
        <Button size="sm" onClick={onNew}>
          <Plus className="mr-2 h-4 w-4" />
          New supply order
        </Button>
      </div>

      {visible.length === 0 && (
        <div
          data-testid="shipment-list-empty"
          className="space-y-3 rounded-lg border border-border bg-surface p-8 text-center"
        >
          <p className="text-sm text-muted-foreground">
            {filter.chips.length === 0
              ? "No status selected — pick at least one chip to see orders."
              : "No supply orders yet — the queue fills when an order is placed with a supplier."}
          </p>
          <Button size="sm" onClick={onNew}>
            <Plus className="mr-2 h-4 w-4" />
            New supply order
          </Button>
        </div>
      )}

      {truncated.newFlow && (
        <p
          data-testid="shipment-list-truncated-new-flow"
          className="text-xs text-muted-foreground"
        >
          {`Showing the newest ${SUPPLY_ORDER_LIST_LIMIT} supply orders — refine the chips.`}
        </p>
      )}

      {truncated.legacy && (
        <p data-testid="shipment-list-truncated-legacy" className="text-xs text-muted-foreground">
          {`Showing the newest ${SUPPLY_ORDER_LIST_LIMIT} legacy receipts — refine the chips.`}
        </p>
      )}

      {visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((order) => (
            <OrderRow key={orderId(order)} order={order} />
          ))}
        </ul>
      )}
    </div>
  );
}
