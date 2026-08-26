/** @jest-environment jsdom */
/**
 * THE "SUPPLY ORDERS" CARD (contract pack C4b.5 + C5.4, spec §8 + D10, seam S18).
 *
 * The money that left the building: fees, what suppliers failed to deliver
 * (gross AND net of what they made good), what the labeling bench lost, what
 * arrived above the order — and, on the ledger's own clock, what the dock
 * actually stocked. The whole reason this card is pinned is the difference
 * between two zeros:
 *
 *   - "nobody lost anything in this window" is a KNOWN ZERO and renders $0.00;
 *   - "no rows contributed" is UNKNOWN and renders "—" with the server's reason.
 *
 * A card that rendered both as $0.00 would tell the reader the second is the
 * first. Every tile also carries its DEFINITION and its COVERAGE string, because
 * a number nobody can trace is a number nobody can act on (SURVIVE-3).
 */

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SupplyOrdersCard } from "@/components/analytics/supply-orders-card";

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
});

function metric(over: Record<string, unknown> = {}) {
  return {
    valueCents: 12500,
    definition: "Fees on non-cancelled orders whose ordered date falls in the window.",
    coverage: "3 of 4 orders carry a recorded fee; legacy receipts have no ordered date.",
    contributingRows: 3,
    reason: null,
    ...over,
  };
}

/** The receipts roll-up (D10): the LEDGER-basis block beside the money tiles. */
function receipts(over: Record<string, unknown> = {}) {
  return {
    orders: 2,
    linesVerified: 3,
    batches: 5,
    unitsStocked: 120,
    receiptCostCents: metric({
      valueCents: 250000,
      definition: "The dollars booked with each stock-in batch.",
      coverage: "5 of 5 receipt events record a receipt cost.",
      contributingRows: 5,
    }),
    definition:
      "a receipt event = one stock-in batch; a five-batch delivery is five events (D12)",
    ...over,
  };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    window: { from: "2026-08-01", to: "2026-08-31" },
    orders: { count: 4, byStatus: { RECEIVING: 3, CLOSED: 1 } },
    receipts: receipts(),
    metrics: {
      fees: metric(),
      supplierShortageCost: metric({
        valueCents: 0,
        definition: "Gross supplier shortage; credits and reshipments are NOT subtracted.",
        coverage: "2 of 2 shortage rows carry money.",
        contributingRows: 2,
      }),
      supplierShortageCostNet: metric({
        valueCents: 7500,
        definition: "Gross minus what the supplier made good; AS OF NOW.",
        coverage: "2 of 2 shortage rows carry money, 1 of them settled.",
        contributingRows: 2,
      }),
      labelingLossCost: metric({
        valueCents: null,
        definition: "Units verified but lost before stocking.",
        coverage: "0 of 0 labeling-loss rows in the window.",
        contributingRows: 0,
        reason: "No labeling-loss rows were seen in this window",
      }),
      surplusValue: metric({
        valueCents: 4200,
        definition: "Value of units delivered above the order.",
        coverage: "1 of 1 over-delivery rows carry money.",
        contributingRows: 1,
      }),
    },
    ...over,
  };
}

function renderCard(body: unknown = payload(), ok = true) {
  mockFetch.mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as unknown as Response);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SupplyOrdersCard from="2026-08-01" to="2026-08-31" />
    </QueryClientProvider>,
  );
}

const tile = async (name: string) => screen.findByTestId(`supply-orders-tile-${name}`);

describe("the metric tiles", () => {
  it("renders a known value as money, with its coverage and row count", async () => {
    renderCard();
    const fees = await tile("fees");
    expect(within(fees).getByTestId("tile-value")).toHaveTextContent("$125.00");
    expect(
      within(fees).getByText(
        "3 of 4 orders carry a recorded fee; legacy receipts have no ordered date.",
      ),
    ).toBeInTheDocument();
    expect(within(fees).getByText(/3 rows/i)).toBeInTheDocument();
  });

  it("renders a KNOWN ZERO as $0.00 — nobody lost anything is a fact", async () => {
    renderCard();
    const shortage = await tile("supplierShortageCost");
    expect(within(shortage).getByTestId("tile-value")).toHaveTextContent("$0.00");
    expect(within(shortage).queryByText(/—/)).not.toBeInTheDocument();
  });

  it("renders NO ROWS as an em dash plus the server's reason", async () => {
    renderCard();
    const loss = await tile("labelingLossCost");
    expect(within(loss).getByTestId("tile-value")).toHaveTextContent("—");
    expect(
      within(loss).getByText("No labeling-loss rows were seen in this window"),
    ).toBeInTheDocument();
  });

  it("carries a definition on every tile", async () => {
    renderCard();
    for (const [name, definition] of [
      ["fees", "Fees on non-cancelled orders whose ordered date falls in the window."],
      [
        "supplierShortageCost",
        "Gross supplier shortage; credits and reshipments are NOT subtracted.",
      ],
      ["labelingLossCost", "Units verified but lost before stocking."],
      ["surplusValue", "Value of units delivered above the order."],
    ] as const) {
      const card = await tile(name);
      expect(within(card).getByText(definition)).toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------
// D10 — the NET shortage tile and the RECEIPTS row
// ---------------------------------------------------------------------------

describe("the net shortage tile (D10)", () => {
  it("renders beside the gross one, labelled as of now", async () => {
    renderCard();
    const net = await tile("supplierShortageCostNet");
    expect(within(net).getByTestId("tile-value")).toHaveTextContent("$75.00");
    // Two numbers about the same rows: the label must say WHICH one this is, or
    // a reader takes the smaller figure for the whole shortage.
    expect(screen.getByText("Supplier shortage (net, as of now)")).toBeInTheDocument();
    expect(screen.getByText("Supplier shortage (gross)")).toBeInTheDocument();
    expect(
      within(net).getByText("Gross minus what the supplier made good; AS OF NOW."),
    ).toBeInTheDocument();
  });

  it("renders an unknown net as an em dash plus the reason, never $0.00", async () => {
    renderCard(
      payload({
        metrics: {
          ...payload().metrics,
          supplierShortageCostNet: metric({
            valueCents: null,
            contributingRows: 0,
            reason: "no receiving-discrepancy row was seen in this window",
          }),
        },
      }),
    );
    const net = await tile("supplierShortageCostNet");
    expect(within(net).getByTestId("tile-value")).toHaveTextContent("—");
    expect(
      within(net).getByText("no receiving-discrepancy row was seen in this window"),
    ).toBeInTheDocument();
  });
});

describe("the receipts row (D10)", () => {
  it("states orders, lines, batches, units and the receipt cost", async () => {
    renderCard();
    const row = await screen.findByTestId("supply-orders-receipts");
    expect(within(row).getByText("2 orders")).toBeInTheDocument();
    expect(within(row).getByText("3 lines")).toBeInTheDocument();
    expect(within(row).getByText("5 batches")).toBeInTheDocument();
    expect(within(row).getByText("120 units")).toBeInTheDocument();
    expect(within(row).getByText("receipt cost $2,500.00")).toBeInTheDocument();
    expect(
      within(row).getByText("5 of 5 receipt events record a receipt cost."),
    ).toBeInTheDocument();
  });

  // QA-8: the grain rides with the figures — five batches off one delivery is
  // five events, and a reader who does not know that reads "5 batches" as five
  // deliveries. A `title=` is a tooltip nobody hovers and no touch device shows,
  // so the definition is VISIBLE text under the row (the attribution tab's idiom).
  it("renders the receipt-event definition as VISIBLE text under the row (QA-8)", async () => {
    renderCard();
    const row = await screen.findByTestId("supply-orders-receipts");
    expect(
      within(row).getByText(
        "a receipt event = one stock-in batch; a five-batch delivery is five events (D12)",
      ),
    ).toBeInTheDocument();
  });

  it("renders an unpriced receipt cost as an em dash plus the reason", async () => {
    renderCard(
      payload({
        receipts: receipts({
          receiptCostCents: metric({
            valueCents: null,
            contributingRows: 0,
            coverage: "0 of 5 receipt events record a receipt cost.",
            reason: "5 stock-in batches were stocked in this window; none records a receipt cost",
          }),
        }),
      }),
    );
    const row = await screen.findByTestId("supply-orders-receipts");
    expect(within(row).getByText("receipt cost —")).toBeInTheDocument();
    expect(
      within(row).getByText(
        "5 stock-in batches were stocked in this window; none records a receipt cost",
      ),
    ).toBeInTheDocument();
  });

  it("says ONE order and ONE batch in the singular", async () => {
    renderCard(payload({ receipts: receipts({ orders: 1, linesVerified: 1, batches: 1, unitsStocked: 1 }) }));
    const row = await screen.findByTestId("supply-orders-receipts");
    expect(within(row).getByText("1 order")).toBeInTheDocument();
    expect(within(row).getByText("1 line")).toBeInTheDocument();
    expect(within(row).getByText("1 batch")).toBeInTheDocument();
    expect(within(row).getByText("1 unit")).toBeInTheDocument();
  });

  it("a body carrying NO receipts block is not data — the card says so", async () => {
    // The same rule the metric set has lived under since C4b.5: rendering a row
    // off a body that never sent one would invent receiving work.
    renderCard(payload({ receipts: undefined }));
    expect(await screen.findByTestId("supply-orders-error")).toBeInTheDocument();
    expect(screen.queryByTestId("supply-orders-receipts")).not.toBeInTheDocument();
  });
});

describe("the order window", () => {
  it("names the window, the order count and the status mix", async () => {
    renderCard();
    expect(await screen.findByText("4 orders in the window")).toBeInTheDocument();
    expect(screen.getByText("RECEIVING 3")).toBeInTheDocument();
    expect(screen.getByText("CLOSED 1")).toBeInTheDocument();
  });

  it("says nothing about statuses when the window holds no orders", async () => {
    renderCard(payload({ orders: { count: 0, byStatus: {} } }));
    expect(await screen.findByText("0 orders in the window")).toBeInTheDocument();
    expect(screen.getByText(/no orders were placed in this window/i)).toBeInTheDocument();
  });

  it("requests BOTH window params", async () => {
    renderCard();
    await screen.findByTestId("supply-orders-tile-fees");
    expect(String(mockFetch.mock.calls[0][0])).toContain("from=2026-08-01");
    expect(String(mockFetch.mock.calls[0][0])).toContain("to=2026-08-31");
  });
});

describe("a failed read", () => {
  it("says so instead of rendering zeros", async () => {
    renderCard({ error: "boom" }, false);
    expect(await screen.findByTestId("supply-orders-error")).toBeInTheDocument();
    expect(screen.queryByTestId("supply-orders-tile-fees")).not.toBeInTheDocument();
  });
});
