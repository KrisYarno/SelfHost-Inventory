/** @jest-environment jsdom */
/**
 * The POLYMORPHIC orders list (contract pack C4a.2, spec §9).
 *
 * ONE list over ONE dataset: a supply order and a legacy W1 receipt are two
 * shapes of the same row family, discriminated by `model`. What this file holds
 * still is the part that lies most easily — the discrepancy cell:
 *
 *   - a SHORT line is short whether or not it is priced. "3 short · $0.00 loss"
 *     is the truth on an unpriced line; suppressing the row because the money
 *     came out zero is how a shortage disappears (OCs-6);
 *   - an UNORDERED arrival is neither over nor short — it is a line with no
 *     order to be measured against, and it is counted on its own;
 *   - "Matches" is sayable ONLY when short, over and unordered are all zero;
 *   - a LEGACY row renders its W1 rollup verbatim — over and under never cancel,
 *     and an uncounted line is unknown, not zero.
 */

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  ShipmentList,
  DEFAULT_ORDERS_FILTER,
  matchesOrdersFilter,
  supplyOrdersRequests,
  type OrdersFilter,
} from "@/components/receiving/shipment-list";
import type { SupplyOrderSummary } from "@/hooks/use-supply-orders";

const DAY = 24 * 60 * 60 * 1000;

function supplyOrder(over: Record<string, unknown> = {}): SupplyOrderSummary {
  return {
    model: "supply-order",
    id: "cksupply000000000000000001",
    status: "RECEIVING",
    supplier: "Acme Peptides",
    supplierRef: "PO-2026-0142",
    orderedAt: "2026-08-14T00:00:00.000Z",
    feesCents: 0,
    feesNote: null,
    createdBy: 7,
    creator: { id: 7, username: "kris" },
    closedBy: null,
    closedAt: null,
    createdAt: "2026-08-14T09:00:00.000Z",
    updatedAt: "2026-08-15T09:00:00.000Z",
    notes: null,
    lineCounts: { ordered: 1, verified: 1, labeling: 0, complete: 0, discarded: 0 },
    units: { verified: 7, stocked: 0, disposed: 0 },
    discrepancy: {
      linesWithDiscrepancy: 0,
      shortUnits: 0,
      overUnits: 0,
      lossCents: 0,
      surplusValueCents: 0,
      unorderedLines: 0,
    },
    ...over,
  } as unknown as SupplyOrderSummary;
}

function legacy(over: Record<string, unknown> = {}): SupplyOrderSummary {
  return {
    model: "legacy",
    legacy: {
      id: "cklegacy00000000000000001",
      supplierRef: "LEG-77",
      status: "OPEN",
      notes: null,
      createdBy: 7,
      closedBy: null,
      createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
      updatedAt: new Date().toISOString(),
      closedAt: null,
      creator: { id: 7, username: "kris" },
      itemCount: 3,
      receivedItemCount: 3,
      graduatedItemCount: 0,
      uncountedReceivedItemCount: 0,
      discrepancy: {
        itemCount: 3,
        countedItemCount: 3,
        uncountedItemCount: 0,
        discrepancyItemCount: 0,
        totalOver: 0,
        totalUnder: 0,
      },
      ...over,
    },
  } as unknown as SupplyOrderSummary;
}

function renderList(
  orders: SupplyOrderSummary[],
  filter: OrdersFilter = DEFAULT_ORDERS_FILTER,
  handlers: {
    onFilterChange?: jest.Mock;
    onNew?: jest.Mock;
    truncated?: { newFlow: boolean; legacy: boolean };
  } = {},
) {
  const onFilterChange = handlers.onFilterChange ?? jest.fn();
  const onNew = handlers.onNew ?? jest.fn();
  render(
    <ShipmentList
      orders={orders}
      filter={filter}
      truncated={handlers.truncated ?? { newFlow: false, legacy: false }}
      onFilterChange={onFilterChange}
      onNew={onNew}
    />,
  );
  return { onFilterChange, onNew };
}

// ---------------------------------------------------------------------------
// The discrepancy cell — the truth pins (PK3-7)
// ---------------------------------------------------------------------------

describe("the discrepancy cell (supply orders)", () => {
  it("reports a shortage EVEN WHEN THE LOSS IS $0.00", () => {
    renderList([
      supplyOrder({
        discrepancy: {
          linesWithDiscrepancy: 1,
          shortUnits: 3,
          overUnits: 0,
          lossCents: 0,
          surplusValueCents: 0,
          unorderedLines: 0,
        },
      }),
    ]);

    const cell = screen.getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent("3 short");
    expect(cell).toHaveTextContent("$0.00 loss");
    expect(cell).not.toHaveTextContent(/matches/i);
  });

  it("reports over units and their surplus value", () => {
    renderList([
      supplyOrder({
        discrepancy: {
          linesWithDiscrepancy: 1,
          shortUnits: 0,
          overUnits: 2,
          lossCents: 0,
          surplusValueCents: 2500,
          unorderedLines: 0,
        },
      }),
    ]);

    const cell = screen.getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent("2 over");
    expect(cell).toHaveTextContent("$25.00 surplus");
    expect(cell).not.toHaveTextContent(/matches/i);
  });

  it("counts unordered arrivals on their OWN, never as over", () => {
    renderList([
      supplyOrder({
        discrepancy: {
          linesWithDiscrepancy: 1,
          shortUnits: 0,
          overUnits: 0,
          lossCents: 0,
          surplusValueCents: 0,
          unorderedLines: 2,
        },
      }),
    ]);

    const cell = screen.getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent("2 unordered");
    expect(cell).not.toHaveTextContent(/over/i);
    expect(cell).not.toHaveTextContent(/matches/i);
  });

  it("says 'Matches' ONLY when short, over and unordered are all zero", () => {
    renderList([supplyOrder()]);
    expect(screen.getByTestId("discrepancy-cell")).toHaveTextContent("Matches");
  });

  it("reports short AND over together — they never cancel", () => {
    renderList([
      supplyOrder({
        discrepancy: {
          linesWithDiscrepancy: 2,
          shortUnits: 3,
          overUnits: 5,
          lossCents: 900,
          surplusValueCents: 1500,
          unorderedLines: 0,
        },
      }),
    ]);

    const cell = screen.getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent("3 short");
    expect(cell).toHaveTextContent("5 over");
    expect(cell).not.toHaveTextContent("2 ");
  });
});

// ---------------------------------------------------------------------------
// Legacy rows — the W1 cell verbatim
// ---------------------------------------------------------------------------

describe("legacy rows", () => {
  it("renders the W1 discrepancy object verbatim — over, under and uncounted", () => {
    renderList(
      [
        legacy({
          discrepancy: {
            itemCount: 4,
            countedItemCount: 2,
            uncountedItemCount: 2,
            discrepancyItemCount: 2,
            totalOver: 5,
            totalUnder: 3,
          },
        }),
      ],
      { chips: ["LEGACY"] },
    );

    const cell = screen.getByTestId("discrepancy-cell");
    expect(cell).toHaveTextContent("5 over");
    expect(cell).toHaveTextContent("3 under");
    expect(cell).toHaveTextContent("2 uncounted");
  });

  it("marks the row as a legacy receipt rather than inventing an ordered date", () => {
    renderList([legacy()], { chips: ["LEGACY"] });
    const row = screen.getByTestId("shipment-row-cklegacy00000000000000001");
    expect(within(row).getByText(/legacy receipt/i)).toBeInTheDocument();
  });

  it("links to the same detail route as a supply order", () => {
    renderList([legacy()], { chips: ["LEGACY"] });
    expect(screen.getByRole("link", { name: /LEG-77/ })).toHaveAttribute(
      "href",
      "/receiving/cklegacy00000000000000001",
    );
  });
});

// ---------------------------------------------------------------------------
// Chips + the filter contract
// ---------------------------------------------------------------------------

describe("status chips", () => {
  it("opens on Ordered + Receiving", () => {
    renderList([supplyOrder()]);
    expect(screen.getByRole("button", { name: "Ordered" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Receiving" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const label of ["Closed", "Cancelled", "Legacy receipts"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    }
  });

  it("toggling a chip reports the NEW chip set to the owner", async () => {
    const user = userEvent.setup();
    const { onFilterChange } = renderList([supplyOrder()]);

    await user.click(screen.getByRole("button", { name: "Closed" }));
    expect(onFilterChange).toHaveBeenCalledWith({
      chips: ["ORDERED", "RECEIVING", "CLOSED"],
    });

    await user.click(screen.getByRole("button", { name: "Ordered" }));
    expect(onFilterChange).toHaveBeenLastCalledWith({ chips: ["RECEIVING"] });
  });

  it("the requests the chips ask for: ONE PER FAMILY, each with its own model", () => {
    expect(supplyOrdersRequests({ chips: ["ORDERED", "RECEIVING"] })).toEqual({
      newFlow: { statuses: ["ORDERED", "RECEIVING"], model: "supply-order" },
      legacy: null,
    });
    // REV-10 clause 6: "Legacy receipts" is the WHOLE legacy family — the
    // OPEN-only chip was dead the moment the drain finished.
    expect(supplyOrdersRequests({ chips: ["LEGACY"] })).toEqual({
      newFlow: null,
      legacy: { statuses: ["OPEN", "CLOSED", "CANCELLED"], model: "legacy" },
    });
    // QA-3: both families at once is TWO requests, not one unioned request with
    // no model. `?model=` is single-valued, so the union asked the server for
    // every status in BOTH families and let the 100-row bound decide what came
    // back — and because legacy headers have no `orderedAt` they sort last under
    // `orderedAt DESC`, so the archive the operator ticked vanished entirely the
    // moment 100 new-flow orders matched.
    expect(supplyOrdersRequests({ chips: ["CLOSED", "LEGACY"] })).toEqual({
      newFlow: { statuses: ["CLOSED"], model: "supply-order" },
      legacy: { statuses: ["OPEN", "CLOSED", "CANCELLED"], model: "legacy" },
    });
    // No chip is no question — and therefore no request.
    expect(supplyOrdersRequests({ chips: [] })).toEqual({ newFlow: null, legacy: null });
  });

  it("QA-3/FD2-2: says which FAMILY was bounded — the supply orders", () => {
    renderList([supplyOrder()], DEFAULT_ORDERS_FILTER, {
      truncated: { newFlow: true, legacy: false },
    });
    expect(screen.getByTestId("shipment-list-truncated-new-flow")).toHaveTextContent(
      "Showing the newest 100 supply orders — refine the chips.",
    );
    // The legacy half never hit its own bound, and saying so about it would be
    // a claim about rows nobody cut.
    expect(screen.queryByTestId("shipment-list-truncated-legacy")).not.toBeInTheDocument();
  });

  it("FD2-2: says which FAMILY was bounded — the legacy receipts", () => {
    renderList([supplyOrder()], { chips: ["RECEIVING", "LEGACY"] }, {
      truncated: { newFlow: false, legacy: true },
    });
    expect(screen.getByTestId("shipment-list-truncated-legacy")).toHaveTextContent(
      "Showing the newest 100 legacy receipts — refine the chips.",
    );
    expect(screen.queryByTestId("shipment-list-truncated-new-flow")).not.toBeInTheDocument();
  });

  it("FD2-2: BOTH bounds are stated when both families were cut", () => {
    renderList([supplyOrder()], { chips: ["RECEIVING", "LEGACY"] }, {
      truncated: { newFlow: true, legacy: true },
    });
    expect(screen.getByTestId("shipment-list-truncated-new-flow")).toBeInTheDocument();
    expect(screen.getByTestId("shipment-list-truncated-legacy")).toBeInTheDocument();
  });

  it("says nothing about the bound when neither family reached it", () => {
    renderList([supplyOrder()]);
    expect(screen.queryByTestId("shipment-list-truncated-new-flow")).not.toBeInTheDocument();
    expect(screen.queryByTestId("shipment-list-truncated-legacy")).not.toBeInTheDocument();
  });

  it("Legacy receipts means model 'legacy', ANY status (REV-10 clause 6)", () => {
    const openLegacy = legacy();
    const closedLegacy = legacy({ status: "CLOSED" });
    const cancelledLegacy = legacy({ status: "CANCELLED" });

    expect(matchesOrdersFilter(openLegacy, { chips: ["LEGACY"] })).toBe(true);
    expect(matchesOrdersFilter(closedLegacy, { chips: ["LEGACY"] })).toBe(true);
    expect(matchesOrdersFilter(cancelledLegacy, { chips: ["LEGACY"] })).toBe(true);
    expect(matchesOrdersFilter(closedLegacy, { chips: ["ORDERED"] })).toBe(false);
    // A legacy CLOSED receipt is NOT what the "Closed" chip is about.
    expect(matchesOrdersFilter(closedLegacy, { chips: ["CLOSED"] })).toBe(false);
    expect(
      matchesOrdersFilter(supplyOrder({ status: "CLOSED" }), { chips: ["CLOSED"] }),
    ).toBe(true);
    expect(
      matchesOrdersFilter(supplyOrder({ status: "CLOSED" }), { chips: ["ORDERED"] }),
    ).toBe(false);
  });

  it("renders only the rows the chips asked for", () => {
    renderList([supplyOrder(), legacy()], { chips: ["ORDERED", "RECEIVING"] });
    expect(screen.getByTestId("shipment-row-cksupply000000000000000001")).toBeInTheDocument();
    expect(screen.queryByTestId("shipment-row-cklegacy00000000000000001")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rows, the empty state, the new-order affordance
// ---------------------------------------------------------------------------

describe("rows and copy", () => {
  it("shows supplier, reference, the ORDERED CALENDAR DAY and the line counts", () => {
    renderList([supplyOrder()]);
    const row = screen.getByTestId("shipment-row-cksupply000000000000000001");
    expect(within(row).getByText(/Acme Peptides/)).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /PO-2026-0142/ })).toHaveAttribute(
      "href",
      "/receiving/cksupply000000000000000001",
    );
    // UTC midnight is the day the operator typed — never shifted into local time.
    expect(within(row).getByText(/2026-08-14/)).toBeInTheDocument();
    expect(row).toHaveTextContent("RECEIVING");
  });

  it("the empty state is truthful and offers the next move", () => {
    const { onNew } = renderList([]);
    expect(screen.getByTestId("shipment-list-empty")).toHaveTextContent(
      "No supply orders yet — the queue fills when an order is placed with a supplier.",
    );
    expect(onNew).not.toHaveBeenCalled();
  });

  it("'New supply order' asks the owner to open the dialog", async () => {
    const user = userEvent.setup();
    const { onNew } = renderList([supplyOrder()]);
    await user.click(screen.getByRole("button", { name: /new supply order/i }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("uses bg-surface for the card fills (bg-card is unregistered in this repo)", () => {
    const { container } = render(
      <ShipmentList
        orders={[supplyOrder()]}
        filter={DEFAULT_ORDERS_FILTER}
        onFilterChange={jest.fn()}
        onNew={jest.fn()}
      />,
    );
    expect(container.querySelectorAll(".bg-card")).toHaveLength(0);
    expect(container.querySelectorAll(".bg-surface").length).toBeGreaterThan(0);
  });
});
