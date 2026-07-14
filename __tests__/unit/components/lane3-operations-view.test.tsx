/** @jest-environment jsdom */
// Lane 3 (Task 5, W2-C): Operations view + toggle. Covers the designed accrual
// panel (D-L4), the per-cell honesty copy (D-L6), the decision table + expandable
// detail, and the hub toggle seam (D-L3).

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewToggle } from "@/components/analytics/view-toggle";
import { OperationsView } from "@/components/analytics/operations-view";

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const emptyShrinkage = {
  byReason: {
    DAMAGE: { units: 0, valueAtCurrentCostCents: null },
    THEFT: { units: 0, valueAtCurrentCostCents: null },
    EXPIRY: { units: 0, valueAtCurrentCostCents: null },
    COUNT: { units: 0, valueAtCurrentCostCents: null },
  },
  totalUnits: 0,
  totalValueAtCurrentCostCents: null,
  coverage: { unclassifiedOutboundUnits: 0, reasonTrackingStartedAt: null },
  dataStart: null,
};

const baseValuation = {
  atCurrentCostCents: 350000,
  costCoverage: { valued: 2, of: 2 },
  atReceiptCostCents: 180000,
  receiptCoverage: { have: 1, of: 2 },
};

function makeRow(over: Partial<any> = {}) {
  return {
    productId: 1,
    name: "Widget Alpha",
    currentStock: 50,
    unitsOut30: 20,
    unitsOut90: 60,
    avgDaily30: 2,
    daysOfSupply: 25,
    turns90: 1.5,
    turnsCoverage: { days: 85, windowDays: 90 },
    lastInboundAt: "2026-06-01T00:00:00.000Z",
    lastOutboundAt: "2026-07-05T00:00:00.000Z",
    shrinkage90: { units: 3, valueAtCurrentCostCents: 750 },
    correctionsIn90: 2,
    lastReceiptCostCents: 180,
    attention: "ok",
    ...over,
  };
}

function payload(over: Partial<any> = {}) {
  return {
    scope: "global",
    windowDays: 90,
    rows: [makeRow()],
    dataStarts: { sale: "2026-06-01T00:00:00.000Z", outbound: "2026-06-01T00:00:00.000Z", adjustment: "2026-06-01T00:00:00.000Z", receipt: "2026-06-01T00:00:00.000Z", snapshot: "2026-05-01" },
    shrinkage90: emptyShrinkage,
    valuation: baseValuation,
    ...over,
  };
}

function mockFetch(body: any, ok = true) {
  global.fetch = jest.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as typeof fetch;
}

afterEach(() => jest.restoreAllMocks());

describe("ViewToggle", () => {
  test("fires onChange with the selected view; labels are locked", () => {
    const onChange = jest.fn();
    render(<ViewToggle value="sales" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Sales by company/i })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: /Inventory operations/i }));
    expect(onChange).toHaveBeenCalledWith("operations");
  });
});

describe("OperationsView", () => {
  test("renders the persistent global scope label", async () => {
    mockFetch(payload());
    renderWithClient(<OperationsView />);
    expect(await screen.findByText("Global inventory — all companies")).toBeInTheDocument();
  });

  test("shows the designed accrual panel (not a 0 wall) when no SALE data exists", async () => {
    mockFetch(
      payload({
        rows: [makeRow({ unitsOut30: null, unitsOut90: null, avgDaily30: null, daysOfSupply: null })],
        dataStarts: { sale: null, outbound: null, adjustment: null, receipt: null, snapshot: null },
      })
    );
    renderWithClient(<OperationsView />);
    expect(await screen.findByText(/No fulfilled-order history yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Metrics appear as fulfilled orders and stock movements record/i)
    ).toBeInTheDocument();
  });

  test("renders the tiles + decision table with data", async () => {
    mockFetch(payload());
    renderWithClient(<OperationsView />);
    expect(await screen.findByText("Inventory value")).toBeInTheDocument();
    expect(screen.getByText("Blended turns (90 days)")).toBeInTheDocument();
    // product name renders in both table + mobile list under jsdom.
    expect(screen.getAllByText("Widget Alpha").length).toBeGreaterThan(0);
  });

  test("turns cell carries the D-L6 coverage tooltip when turns are unavailable", async () => {
    mockFetch(payload({ rows: [makeRow({ turns90: null, turnsCoverage: { days: 10, windowDays: 90 } })] }));
    renderWithClient(<OperationsView />);
    await screen.findByText("Inventory value");
    expect(
      document.querySelector('[title="Turns unavailable — stock snapshots cover 10 of 90 days"]')
    ).not.toBeNull();
  });

  test("Units out header carries the un-fulfillment honesty tooltip", async () => {
    mockFetch(payload());
    renderWithClient(<OperationsView />);
    await screen.findByText("Inventory value");
    expect(
      document.querySelector('[title="Later un-fulfillments are not subtracted"]')
    ).not.toBeNull();
  });

  test("expanding a row reveals the detail grid (aging / receipt / corrections)", async () => {
    mockFetch(payload());
    renderWithClient(<OperationsView />);
    await screen.findByText("Inventory value");
    // The first expander button (desktop table row).
    const expander = screen.getAllByRole("button", { name: /Expand details for Widget Alpha/i })[0];
    fireEvent.click(expander);
    await waitFor(() =>
      expect(screen.getAllByText("Last inbound movement").length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText("Corrections (90 days)").length).toBeGreaterThan(0);
  });

  test("error state shows a Retry affordance", async () => {
    mockFetch({}, false);
    renderWithClient(<OperationsView />);
    expect(await screen.findByText(/Could not load operations analytics/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });
});
