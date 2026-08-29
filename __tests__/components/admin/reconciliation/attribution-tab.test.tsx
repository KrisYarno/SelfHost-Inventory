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
import {
  FLAGGED_MATCH_CLASSES,
  MATCH_CLASS_KEYS,
  MATCH_CLASS_LABELS,
  MATCH_DEFINITIONS,
  MATCH_UNAVAILABLE_COPY,
  MATCH_UNAVAILABLE_REASONS,
  type MatchClassKey,
} from "@/lib/reconciliation/match-keys";
import type { OrderMatch } from "@/lib/reconciliation/match";
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

/** The Part 2 match vocabulary, all zero (pack CA2.2) — fixture support only. */
function zeroMatchByClass(): Record<MatchClassKey, number> {
  return Object.fromEntries(MATCH_CLASS_KEYS.map((k) => [k, 0])) as Record<
    MatchClassKey,
    number
  >;
}

/** One order's match, as the producer ships it (pack CA1.2 / CA3). */
function makeMatch(over: Partial<OrderMatch> = {}): OrderMatch {
  return {
    class: "short",
    flagged: true,
    kinds: ["short"],
    perProduct: [
      {
        productId: 3,
        productName: "Widget",
        fromBundle: false,
        ordered: 3,
        deducted: 1,
        corrected: 0,
        delta: -2,
        kind: "short",
        units: 2,
      },
    ],
    unmappedLines: 0,
    unmappedUnits: 0,
    bundleLines: 0,
    unresolvableBundleLines: 0,
    deductedUnits: 1,
    tolerance: null,
    definitions: MATCH_DEFINITIONS,
    ...over,
  };
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
    fulfillmentTargetMissing: false,
    // Part 2 (pack CA2.2): the row carries its order's match, or the named
    // reason it has none. A2 adds the FIXTURE keys only — the Match cell that
    // renders them is A3's.
    match: null,
    matchUnavailable: null,
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
    // Part 2 (pack CA2.2): the page's matches. A2 adds the FIXTURE keys only —
    // the chip row that reads them is A3's.
    matches: {
      scope: "this page",
      orders: 0,
      byClass: zeroMatchByClass(),
      unavailable: {
        unstamped: 0,
        "mixed-stamps": 0,
        "order-missing": 0,
        "order-redacted": 0,
      },
    },
    coverage: {
      batchesInWindow: 11,
      rowsReturned: 1,
      derivedShare: 0.25,
      ledgerUnstamped: 2,
      needsALook: { stampDisagreesWithLatestAttempt: 0, mixedStamps: 0 },
      recordingSince: "2026-08-19T00:00:00.000Z",
      orderFilterScope: "all orders",
      matchedOrders: 0,
      matchUnavailableRows: 0,
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
  // OC-7: `count` is the SELECTED class's total, `totals.attributable` is the
  // window's. Reading the first as the second made every class filter look like a
  // window that had shrunk to fit it.
  it("the Showing line bounds the WINDOW; the class total is its own line", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ count: 1 }));
    render(<AttributionTab />);

    expect(screen.getByTestId("coverage")).toHaveTextContent(
      "Showing 1 of 4 attributable batches in this window",
    );
    // No chip selected: there is no "selected class" to bound.
    expect(screen.queryByTestId("class-count")).toBeNull();

    await user.click(screen.getByTestId("class-chip-attributed·manual"));
    await waitFor(() => expect(lastInput().classKey).toBe("attributed·manual"));

    expect(screen.getByTestId("class-count")).toHaveTextContent("1 in the selected class.");
    expect(screen.getByTestId("coverage")).toHaveTextContent(
      "Showing 1 of 4 attributable batches in this window",
    );
  });

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

  // CR-1: a historical fulfillment event naming an order a sync later removed.
  // The row used to offer "Attribute…", lock the admin to that id, and 404 on
  // every submission. It says what happened instead — in BOTH presentations, so
  // the mobile card is not the one that keeps offering it.
  it("a fulfillment whose target order is gone says so instead of offering a button", () => {
    setReport(
      makeReport({
        rows: [
          makeRow({
            canAttribute: false,
            attributeLock: null,
            fulfillmentTargetMissing: true,
          }),
        ],
      }),
    );
    render(<AttributionTab />);

    expect(screen.getByTestId("row-batch-1")).toHaveTextContent(
      "fulfillment target missing — the named order no longer exists",
    );
    expect(screen.queryByTestId("attribute-batch-1")).toBeNull();

    const cards = screen.getByTestId("attribution-cards");
    expect(within(cards).getByTestId("card-batch-1")).toHaveTextContent(
      "fulfillment target missing — the named order no longer exists",
    );
    expect(screen.queryByTestId("attribute-card-batch-1")).toBeNull();
  });

  it("says nothing about a missing target on an ordinary row", () => {
    render(<AttributionTab />);

    expect(screen.getByTestId("row-batch-1").textContent).not.toContain(
      "fulfillment target missing",
    );
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

// ---------------------------------------------------------------------------
// QA-5 — what the error card is allowed to say
// ---------------------------------------------------------------------------

/**
 * A 4xx is the SERVER telling the operator what is wrong with the request they
 * made — a window over the span cap, a cursor from another filter. That sentence
 * is the whole repair, and "Could not load the attribution report." throws it
 * away and leaves a Retry button that will fail identically. A 5xx says nothing
 * an operator can act on, so it keeps the generic copy.
 */
describe("the error card (QA-5)", () => {
  function fail(status: number, serverMessage?: string) {
    const error = Object.assign(new Error(`Request failed (${status})`), {
      status,
      ...(serverMessage === undefined ? {} : { serverMessage }),
    });
    setReport(undefined, { isError: true, error });
  }

  it("renders the server's 4xx sentence VERBATIM", () => {
    fail(400, "the window may span at most 366 days");
    render(<AttributionTab />);

    expect(screen.getByTestId("reconciliation-error")).toHaveTextContent(
      "the window may span at most 366 days",
    );
  });

  it("keeps the generic copy for a 5xx", () => {
    fail(500);
    render(<AttributionTab />);

    expect(screen.getByTestId("reconciliation-error")).toHaveTextContent(
      "Could not load the attribution report.",
    );
  });

  it("keeps the generic copy when the network failed and there is no status at all", () => {
    setReport(undefined, { isError: true, error: new Error("Failed to fetch") });
    render(<AttributionTab />);

    expect(screen.getByTestId("reconciliation-error")).toHaveTextContent(
      "Could not load the attribution report.",
    );
    expect(screen.getByTestId("reconciliation-error").textContent).not.toContain(
      "Failed to fetch",
    );
  });
});

// ---------------------------------------------------------------------------
// A3 — the Matches chip row and the Match cell (pack CA3)
// ---------------------------------------------------------------------------

/**
 * THE MATCH CHIPS ARE THE ENVELOPE'S COUNTS, and the pins say so from both
 * sides:
 *
 *   1. THE NUMBERS ARE `matches.byClass` / `Σ matches.unavailable`. A chip that
 *      counted the rows it can see would report BATCHES where the producer
 *      counted ORDERS (two batches stamped with one order are one order), and
 *      would silently disagree with the coverage block beside it.
 *   2. THE CHIP IS A CLIENT-SIDE VIEW OF THE PAGE, not a query. Nothing new is
 *      asked of the server, so the page's own counts stay true while it is on —
 *      which is exactly why the window bound says "(unfiltered)" beside it.
 *   3. THE SELECTION DOES NOT SURVIVE A NEW REPORT. Page 2's rows are not
 *      page 1's, so a chip left pressed across a cursor step would filter the
 *      new page by a selection made about the old one.
 *   4. `matches.orders === 0` IS SAID OUT LOUD. The absence is information.
 */
function matchesOf(
  over: Partial<AttributionReport["matches"]> = {},
): AttributionReport["matches"] {
  return {
    scope: "this page",
    orders: 8,
    byClass: { ...zeroMatchByClass(), exact: 5, short: 2 },
    unavailable: { unstamped: 1, "mixed-stamps": 2, "order-missing": 0, "order-redacted": 0 },
    ...over,
  };
}

/** One row per bucket the chips can select: a class, another class, a reason. */
function matchedRows(): AttributionRow[] {
  return [
    makeRow({ batchId: "batch-1", match: makeMatch({ class: "exact", flagged: false, kinds: [] }) }),
    makeRow({ batchId: "batch-2", match: makeMatch() }),
    makeRow({ batchId: "batch-3", match: null, matchUnavailable: "unstamped" }),
  ];
}

describe("the Matches chips (pack CA3)", () => {
  it("each chip's number IS matches.byClass / Σ unavailable — never a recount of the rows", () => {
    // Three rows on the page, eight orders behind them: the chips report the
    // producer's counts, not the three rows they can see.
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    render(<AttributionTab />);

    expect(screen.getByTestId("match-chip-exact").textContent).toBe("Exact (5)");
    expect(screen.getByTestId("match-chip-short").textContent).toBe("Short (2)");
    expect(screen.getByTestId("match-chip-unavailable").textContent).toBe("Unavailable (3)");
    // A class no order on this page landed in is not a chip.
    expect(screen.queryByTestId("match-chip-mixed")).toBeNull();
  });

  it("is labelled 'Matches (this page)', and the label is the row's FIRST element", () => {
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    render(<AttributionTab />);

    const chips = screen.getByTestId("match-chips");
    expect(chips.firstElementChild?.textContent).toBe("Matches (this page)");
  });

  it("tapping a chip filters the RENDERED rows and never re-issues the report query", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    render(<AttributionTab />);
    const before = lastInput();

    await user.click(screen.getByTestId("match-chip-exact"));

    expect(screen.getByTestId("row-batch-1")).toBeInTheDocument();
    expect(screen.queryByTestId("row-batch-2")).toBeNull();
    expect(screen.queryByTestId("row-batch-3")).toBeNull();
    expect(screen.getByTestId("match-chip-exact")).toHaveAttribute("aria-pressed", "true");
    // The server was never asked a new question.
    expect(lastInput()).toEqual(before);
    expect(Object.keys(lastInput()).some((k) => k.toLowerCase().includes("match"))).toBe(false);
  });

  it("a second tap clears the filter", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    render(<AttributionTab />);

    await user.click(screen.getByTestId("match-chip-exact"));
    expect(screen.queryByTestId("row-batch-2")).toBeNull();

    await user.click(screen.getByTestId("match-chip-exact"));
    expect(screen.getByTestId("row-batch-2")).toBeInTheDocument();
    expect(screen.getByTestId("match-chip-exact")).toHaveAttribute("aria-pressed", "false");
  });

  it("the Unavailable chip selects the rows that carry a REASON, not a class", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    render(<AttributionTab />);

    await user.click(screen.getByTestId("match-chip-unavailable"));

    expect(screen.getByTestId("row-batch-3")).toBeInTheDocument();
    expect(screen.queryByTestId("row-batch-1")).toBeNull();
    expect(screen.queryByTestId("row-batch-2")).toBeNull();
  });

  it("the active chip is CLEARED when the report identity changes (a cursor step)", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    const { rerender } = render(<AttributionTab />);

    await user.click(screen.getByTestId("match-chip-exact"));
    expect(screen.queryByTestId("row-batch-2")).toBeNull();

    // The next page: a NEW report object for the same component.
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf() }));
    rerender(<AttributionTab />);

    expect(screen.getByTestId("match-chip-exact")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("row-batch-2")).toBeInTheDocument();
  });

  it("says the window bound is UNFILTERED while a match chip is active", async () => {
    const user = userEvent.setup();
    setReport(makeReport({ rows: matchedRows(), matches: matchesOf(), moreCount: 3 }));
    render(<AttributionTab />);

    expect(screen.getByTestId("more-count")).toHaveTextContent("3 more in this window.");
    expect(screen.getByTestId("more-count").textContent).not.toContain("(unfiltered)");

    await user.click(screen.getByTestId("match-chip-exact"));

    expect(screen.getByTestId("more-count")).toHaveTextContent(
      "3 more in this window (unfiltered).",
    );
  });

  it("a page with no matched order says so rather than hiding the row", () => {
    setReport(makeReport()); // matches.orders === 0
    render(<AttributionTab />);

    expect(screen.getByTestId("match-chips-none")).toHaveTextContent(
      "Matches: none on this page",
    );
    expect(screen.queryByTestId("match-chip-exact")).toBeNull();
    expect(screen.queryByTestId("match-chip-unavailable")).toBeNull();
  });
});

/**
 * THE MATCH CELL — one row's answer to "did this order's movement match what it
 * asked for". Three shapes, and the third is the one a plausible implementation
 * gets wrong: a match whose CLASS is null is still a match (pack REV 4), and
 * rendering it from the unavailable copy would tell the admin the row could not
 * be read when in fact it was read and had nothing to compare.
 */
describe("the Match cell (pack CA3)", () => {
  it("names the class in the vocabulary's words, flags exactly the flagged ones, and carries its definition", () => {
    for (const key of MATCH_CLASS_KEYS) {
      setReport(
        makeReport({
          rows: [makeRow({ match: makeMatch({ class: key, flagged: FLAGGED_MATCH_CLASSES.has(key) }) })],
        }),
      );
      const view = render(<AttributionTab />);

      const cell = screen.getByTestId("match-batch-1");
      expect(cell.textContent).toBe(MATCH_CLASS_LABELS[key]);
      expect(cell).toHaveAttribute("title", MATCH_DEFINITIONS[key]);
      if (FLAGGED_MATCH_CLASSES.has(key)) {
        expect(cell.className).toContain("text-warning");
        expect(cell.className).toContain("font-medium");
      } else {
        expect(cell.className).toContain("text-muted-foreground");
        expect(cell.className).not.toContain("text-warning");
      }

      view.unmount();
    }
  });

  it("renders each unavailable reason's copy FROM THE MAP, never a blank cell", () => {
    for (const reason of MATCH_UNAVAILABLE_REASONS) {
      setReport(makeReport({ rows: [makeRow({ match: null, matchUnavailable: reason })] }));
      const view = render(<AttributionTab />);

      expect(screen.getByTestId("match-batch-1").textContent).toBe(
        MATCH_UNAVAILABLE_COPY[reason],
      );

      view.unmount();
    }
  });

  it("a class-less match is a MATCH, not an unavailable row (pack REV 4)", () => {
    setReport(
      makeReport({
        rows: [
          makeRow({
            match: makeMatch({ class: null, reason: "unmatchable", flagged: false, kinds: [] }),
          }),
        ],
      }),
    );
    render(<AttributionTab />);

    const cell = screen.getByTestId("match-batch-1");
    expect(cell.textContent).toBe("not comparable");
    expect(cell).toHaveAttribute("title", MATCH_DEFINITIONS.unmatchable);
    expect(Object.values(MATCH_UNAVAILABLE_COPY)).not.toContain(cell.textContent);
  });

  it("the mobile card carries the same cell (the md: breakpoint pair)", () => {
    setReport(makeReport({ rows: [makeRow({ match: makeMatch() })] }));
    render(<AttributionTab />);

    const cards = screen.getByTestId("attribution-cards");
    expect(within(cards).getByTestId("match-card-batch-1").textContent).toBe("Short");
  });
});
