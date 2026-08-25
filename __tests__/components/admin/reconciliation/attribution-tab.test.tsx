/** @jest-environment jsdom */
/**
 * THE ATTRIBUTION TAB (pack C4a.2; spec REV-7 §4.2).
 *
 * The tab renders a report that is mostly ABOUT ITS OWN LIMITS, so the pins here
 * are the places a plausible-looking table would say something the server did
 * not:
 *
 *   1. THE CHIPS ARE THE TOTALS. Each chip's number IS `totals.byClass[key]`
 *      (computed before the active class filter — D7), and the chip IS the
 *      filter. A chip that showed the FILTERED count would report its own
 *      selection back to the reader as if it were the window.
 *   2. THE EXCLUSIONS ARE SAID OUT LOUD. Non-attributable batches, R0 pre-lane
 *      mass updates, rows with no batch id, the derived share and the
 *      ledger-unstamped count ride with the table — including on the EMPTY
 *      window, which is exactly when "nothing here" needs its bounds most.
 *   3. THE ATTRIBUTE CONTROL RENDERS ONLY WHERE THE SERVER CAN ACCEPT IT
 *      (`canAttribute`), and a stamped fulfillment says who owns that change
 *      instead of offering a button that would 409.
 *   4. THE "NEEDS A LOOK" LINE IS A TRIPWIRE, not a permanent fixture: it
 *      renders only when the invariant actually tripped.
 *
 * The hook module is mocked wholesale — the idiom of the sibling admin suite
 * `__tests__/unit/components/lane3-admin-overview.test.tsx`.
 */

import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ATTRIBUTION_CLASS_KEYS } from "@/lib/reconciliation/attribution";
import type {
  AttributionClassKey,
  AttributionReport,
  AttributionRow,
} from "@/lib/reconciliation/attribution";

const useAttributionReportMock = jest.fn();
const useBatchDetailMock = jest.fn();
const useOrderSearchMock = jest.fn();
const useAttributeBatchMock = jest.fn();

jest.mock("@/hooks/use-admin", () => ({
  useAttributionReport: (...args: unknown[]) => useAttributionReportMock(...args),
  useBatchDetail: (...args: unknown[]) => useBatchDetailMock(...args),
  useOrderSearch: (...args: unknown[]) => useOrderSearchMock(...args),
  useAttributeBatch: (...args: unknown[]) => useAttributeBatchMock(...args),
}));

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import { AttributionTab } from "@/components/admin/reconciliation/attribution-tab";

function zeroByClass(): Record<AttributionClassKey, number> {
  return Object.fromEntries(ATTRIBUTION_CLASS_KEYS.map((k) => [k, 0])) as Record<
    AttributionClassKey,
    number
  >;
}

function makeRow(over: Partial<AttributionRow> = {}): AttributionRow {
  return {
    batchId: "batch-1",
    at: "2026-08-20T10:00:00.000Z",
    source: "live-deduct",
    actor: { id: 7, username: "kris" },
    how: {
      classKey: "attributed·selected",
      sentence: "the operator picked this order at the deduction",
    },
    logTypes: ["SALE"],
    units: 3,
    productCount: 2,
    order: {
      id: "ord-1",
      orderNumber: "1009",
      internalStatus: "PROCESSING",
      platform: "woocommerce",
      externalCreatedAt: "2026-08-19T09:00:00.000Z",
    },
    canAttribute: true,
    attributeLock: null,
    fulfilledAgainst: null,
    ...over,
  };
}

function makeReport(over: Partial<AttributionReport> = {}): AttributionReport {
  return {
    window: { from: "2026-08-11", to: "2026-08-24" },
    rows: [makeRow()],
    totals: {
      attributable: 4,
      byClass: { ...zeroByClass(), "attributed·selected": 3, "attributed·manual": 1 },
      exclusions: { nonAttributable: 5, historicalMassUpdate: 2, noBatchRows: 9 },
    },
    coverage: {
      batchesInWindow: 11,
      rowsReturned: 1,
      derivedShare: 0.25,
      ledgerUnstamped: 2,
      needsALook: { stampDisagreesWithLatestAttempt: 0, mixedStamps: 0 },
      recordingSince: "2026-08-19T00:00:00.000Z",
      orderFilterScope: "all orders",
      notes: ["a pre-0b-1 mass update whose summary event was never written is invisible to R0"],
    },
    count: 4,
    moreCount: 0,
    nextCursor: null,
    definitions: {
      attributable: "batches in the window that passed R0",
      nonAttributable: "batches with at least one ledger row in the window and no population row",
      historicalMassUpdate: "population batches excluded by R0",
      noBatchRows: "outbound rows in the window carrying no batch id",
      derivedShare: "the share of the attributable batches whose class was derived",
      moreCount: "rows this window still holds beyond the ones consumed through this page",
      needsALook: "invariant tripwires",
      recordingSince: "the first attempt row's attemptedAt",
    },
    ...over,
  };
}

function setReport(report: AttributionReport | undefined, extra: Record<string, unknown> = {}) {
  useAttributionReportMock.mockReturnValue({
    data: report,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    ...extra,
  });
}

/** The input the tab last asked the server for. */
function lastInput(): Record<string, unknown> {
  const calls = useAttributionReportMock.mock.calls;
  return calls[calls.length - 1][0] as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  useBatchDetailMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useOrderSearchMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useAttributeBatchMock.mockReturnValue({ mutateAsync: jest.fn(), isPending: false });
  setReport(makeReport());
});

describe("chips", () => {
  it("every class in the closed vocabulary is a chip, and its number IS totals.byClass", () => {
    const report = makeReport();
    setReport(report);
    render(<AttributionTab />);

    for (const key of ATTRIBUTION_CLASS_KEYS) {
      const chip = screen.getByTestId(`class-chip-${key}`);
      expect(chip.textContent).toBe(`${key} · ${report.totals.byClass[key]}`);
    }
  });

  it("the active chip IS the class filter, and clicking it again clears it", async () => {
    const user = userEvent.setup();
    render(<AttributionTab />);

    await user.click(screen.getByTestId("class-chip-attributed·manual"));
    await waitFor(() => expect(lastInput().classKey).toBe("attributed·manual"));
    expect(screen.getByTestId("class-chip-attributed·manual")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByTestId("class-chip-attributed·manual"));
    await waitFor(() => expect(lastInput().classKey).toBeUndefined());
  });
});

describe("coverage", () => {
  it("names every exclusion, the derived share and the ledger-unstamped count", () => {
    render(<AttributionTab />);

    const coverage = screen.getByTestId("coverage");
    expect(coverage).toHaveTextContent(
      "5 non-attributable batches, 2 R0 pre-lane mass updates and 9 rows without a batch id are outside this report.",
    );
    expect(coverage).toHaveTextContent("Derived share 25%.");
    expect(coverage).toHaveTextContent(
      "2 fulfillment-derived batches whose ledger was never stamped.",
    );
    // Definitions ride with the rates (R-2).
    expect(coverage).toHaveTextContent(
      "the share of the attributable batches whose class was derived",
    );
  });

  it("says the derived share is UNAVAILABLE rather than 0% when there is no denominator", () => {
    setReport(
      makeReport({
        rows: [],
        totals: {
          attributable: 0,
          byClass: zeroByClass(),
          exclusions: { nonAttributable: 0, historicalMassUpdate: 0, noBatchRows: 0 },
        },
        coverage: {
          ...makeReport().coverage,
          derivedShare: null,
          rowsReturned: 0,
          notes: ["no attributable batch in this window, so the derived share has no denominator"],
        },
        count: 0,
      }),
    );
    render(<AttributionTab />);

    const coverage = screen.getByTestId("coverage");
    expect(coverage).toHaveTextContent("Derived share unavailable");
    expect(coverage).toHaveTextContent(
      "no attributable batch in this window, so the derived share has no denominator",
    );
    expect(coverage.textContent).not.toContain("Derived share 0%");
  });

  it("the needs-a-look line is a TRIPWIRE — absent at zero, present with its figure otherwise", () => {
    render(<AttributionTab />);
    expect(screen.queryByTestId("needs-a-look")).toBeNull();

    setReport(
      makeReport({
        coverage: {
          ...makeReport().coverage,
          needsALook: { stampDisagreesWithLatestAttempt: 1, mixedStamps: 2 },
        },
      }),
    );
    render(<AttributionTab />);
    expect(screen.getByTestId("needs-a-look")).toHaveTextContent("3 batches need a look");
  });

  it("renders the empty state AND the coverage that bounds it", () => {
    setReport(
      makeReport({
        rows: [],
        coverage: { ...makeReport().coverage, rowsReturned: 0 },
        count: 0,
      }),
    );
    render(<AttributionTab />);

    expect(screen.getByTestId("attribution-empty")).toHaveTextContent(
      "No attributable outbound batches in this window.",
    );
    expect(screen.getByTestId("coverage")).toHaveTextContent(
      "5 non-attributable batches, 2 R0 pre-lane mass updates and 9 rows without a batch id are outside this report.",
    );
  });
});

describe("rows", () => {
  it("renders the how sentence, the actor, the units and the order number", () => {
    render(<AttributionTab />);

    const row = screen.getByTestId("row-batch-1");
    expect(row).toHaveTextContent("the operator picked this order at the deduction");
    expect(row).toHaveTextContent("kris");
    expect(row).toHaveTextContent("1009");
  });

  it("a batch nobody recorded reads 'pipeline' where the actor would be", () => {
    setReport(makeReport({ rows: [makeRow({ actor: null, source: "derived" })] }));
    render(<AttributionTab />);

    expect(screen.getByTestId("row-batch-1")).toHaveTextContent("pipeline");
  });

  it("the Attribute control renders ONLY on a row the server can accept", () => {
    setReport(
      makeReport({
        rows: [makeRow(), makeRow({ batchId: "batch-2", canAttribute: false })],
      }),
    );
    render(<AttributionTab />);

    expect(screen.getByTestId("attribute-batch-1")).toBeInTheDocument();
    expect(screen.queryByTestId("attribute-batch-2")).toBeNull();
  });

  it("a stamped fulfillment says who owns the change instead of offering a button", () => {
    setReport(
      makeReport({
        rows: [
          makeRow({
            canAttribute: false,
            fulfilledAgainst: { orderRecordId: "ord-1", orderNumber: "1009" },
          }),
        ],
      }),
    );
    render(<AttributionTab />);

    expect(screen.getByTestId("row-batch-1")).toHaveTextContent(
      "fulfilled against #1009 — change via unfulfill/refulfill",
    );
    expect(screen.queryByTestId("attribute-batch-1")).toBeNull();
  });

  it("an order the report could not read says so, and never renders an empty cell", () => {
    setReport(makeReport({ rows: [makeRow({ order: { orderMissing: true } })] }));
    render(<AttributionTab />);

    expect(screen.getByTestId("row-batch-1")).toHaveTextContent("order missing");
  });

  it("renders the mobile cards beside the table (the md: breakpoint pair)", () => {
    setReport(makeReport({ rows: [makeRow(), makeRow({ batchId: "batch-2" })] }));
    render(<AttributionTab />);

    const cards = screen.getByTestId("attribution-cards");
    expect(within(cards).getByTestId("card-batch-1")).toBeInTheDocument();
    expect(within(cards).getByTestId("card-batch-2")).toBeInTheDocument();
    expect(cards.className).toContain("md:hidden");
    expect(screen.getByTestId("attribution-table-wrap").className).toContain("hidden md:block");
  });
});

describe("bounds", () => {
  it("says how many rows the window still holds and pages with the server's cursor", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ moreCount: 3, nextCursor: "cursor-2" }));
    render(<AttributionTab />);

    expect(screen.getByTestId("more-count")).toHaveTextContent("3 more in this window");

    await user.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(lastInput().cursor).toBe("cursor-2"));
  });

  it("a filter change drops the cursor — a page 2 of the OLD filter is not page 2 of the new one", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ moreCount: 3, nextCursor: "cursor-2" }));
    render(<AttributionTab />);

    await user.click(screen.getByRole("button", { name: /next page/i }));
    await waitFor(() => expect(lastInput().cursor).toBe("cursor-2"));

    await user.click(screen.getByTestId("class-chip-attributed·manual"));
    await waitFor(() => expect(lastInput().cursor).toBeUndefined());
  });
});
