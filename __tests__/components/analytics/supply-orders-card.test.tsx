/** @jest-environment jsdom */
/**
 * THE "SUPPLY ORDERS" CARD (contract pack C4b.5, spec §8, seam S18).
 *
 * Four numbers about money that left the building: fees, what suppliers failed
 * to deliver, what the labeling bench lost, and what arrived above the order.
 * The whole reason this card is pinned is the difference between two zeros:
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

function payload(over: Record<string, unknown> = {}) {
  return {
    window: { from: "2026-08-01", to: "2026-08-31" },
    orders: { count: 4, byStatus: { RECEIVING: 3, CLOSED: 1 } },
    metrics: {
      fees: metric(),
      supplierShortageCost: metric({
        valueCents: 0,
        definition: "Gross supplier shortage; credits and reshipments are NOT subtracted.",
        coverage: "2 of 2 shortage rows carry money.",
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

describe("the four tiles", () => {
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
