/** @jest-environment jsdom */
/**
 * THE DRILL-DOWN (pack C4a.2; spec REV-7 §4.2).
 *
 * Four sources of truth about one batch, and the pins are the two places they
 * would blur into one story:
 *
 *   1. THE OPERATOR'S FREE TEXT IS LABELLED AS SUCH. `orderReference`,
 *      `intent` and `selectedExternalOrderId` come from the audit event the
 *      deduction wrote — they are what somebody TYPED or PICKED, not what the
 *      system concluded, and the producer's own label says so.
 *   2. A DERIVED CLASS SAYS IT IS DERIVED. When no attempt was recorded, the
 *      class was computed at read time; the sentence rides with its rule id so
 *      nobody reads a read-time computation as a live recording.
 *
 * The hook module is mocked wholesale — the idiom of the sibling admin suite
 * `__tests__/unit/components/lane3-admin-overview.test.tsx`.
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MATCH_DEFINITIONS,
  MATCH_UNAVAILABLE_COPY,
  MATCH_UNAVAILABLE_REASONS,
} from "@/lib/reconciliation/match-keys";
import type { OrderMatch } from "@/lib/reconciliation/match";
import type { AttributionRow, BatchDetail } from "@/lib/reconciliation/attribution";

const useBatchDetailMock = jest.fn();

jest.mock("@/hooks/use-admin", () => ({
  useBatchDetail: (...args: unknown[]) => useBatchDetailMock(...args),
}));

import { AttributionDrilldown } from "@/components/admin/reconciliation/attribution-drilldown";

function makeRow(over: Partial<AttributionRow> = {}): AttributionRow {
  return {
    batchId: "batch-1",
    at: "2026-08-20T10:00:00.000Z",
    source: "derived",
    actor: null,
    how: {
      classKey: "attributed·derived",
      sentence: "fulfillment (inferred — the ledger was never stamped)",
      ruleId: "R2b",
    },
    logTypes: ["SALE"],
    units: 3,
    productCount: 2,
    order: null,
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

function makeDetail(over: Partial<BatchDetail> = {}): BatchDetail {
  return {
    batch: makeRow(),
    ledgerRows: [
      {
        id: 11,
        productId: 3,
        productName: "Widget",
        delta: -2,
        logType: "SALE",
        changeTime: "2026-08-20T10:00:00.000Z",
        orderRecordId: null,
      },
    ],
    auditEvent: null,
    attempts: [],
    attemptsTruncated: false,
    attemptsCount: 0,
    attributionEvents: [],
    attributionEventsTruncated: false,
    attributionEventsCount: 0,
    derived: null,
    ledgerRowsTruncated: false,
    // Part 2 (pack CA2.2): the "This order" panel's pair, fixture-only here.
    orderMatch: null,
    orderMatchUnavailable: null,
    ...over,
  };
}

function attemptRow(id: number): BatchDetail["attempts"][number] {
  return {
    id,
    attemptedAt: "2026-08-20T10:00:00.000Z",
    outcome: "declined",
    evidence: null,
    reason: "unmatched",
    source: "live-deduct",
    actor: null,
    orderRecordId: null,
    previousOrderRecordId: null,
    details: null,
  };
}

function attributionRow(id: number): BatchDetail["attributionEvents"][number] {
  return {
    id,
    createdAt: "2026-08-20T10:00:00.000Z",
    actor: null,
    details: { orderRecordId: "ord-1", previousOrderRecordId: null, reason: null, rowCount: 1 },
  };
}

function setDetail(detail: BatchDetail) {
  useBatchDetailMock.mockReturnValue({ data: detail, isLoading: false, isError: false });
}

beforeEach(() => {
  jest.clearAllMocks();
  setDetail(makeDetail());
});

it("labels the operator's free text as the audit event's, and shows all three fields", () => {
  setDetail(
    makeDetail({
      auditEvent: {
        id: 5,
        actionType: "INVENTORY_DEDUCT",
        createdAt: "2026-08-20T10:00:00.000Z",
        orderReference: "1009",
        intent: "order",
        selectedExternalOrderId: "ord-1",
        label: "from the audit event (free text, admin-visible on /admin/logs)",
      },
    }),
  );

  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  const block = screen.getByTestId("drilldown-audit-event");
  expect(block).toHaveTextContent("from the audit event (free text, admin-visible on /admin/logs)");
  expect(block).toHaveTextContent("reference typed: 1009");
  expect(block).toHaveTextContent("intent: order");
  expect(block).toHaveTextContent("order picked: ord-1");
});

it("says nothing was recorded rather than leaving the attempt list blank", () => {
  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  expect(screen.getByText("No attempt was recorded for this batch.")).toBeInTheDocument();
  expect(screen.getByText("This batch has never been attributed by hand.")).toBeInTheDocument();
});

it("renders the derived sentence WITH its rule id when the class was computed at read time", () => {
  setDetail(
    makeDetail({
      derived: {
        outcome: "attributed",
        evidence: "derived",
        ruleId: "R2b",
        ledgerUnstamped: true,
        sentence: "fulfillment (inferred — the ledger was never stamped)",
      },
    }),
  );

  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  expect(screen.getByTestId("drilldown-derived")).toHaveTextContent(
    "fulfillment (inferred — the ledger was never stamped) (R2b)",
  );
});

// OC-8: the producer bounds the ledger read, so the list this renders can be a
// PAGE of the batch rather than the batch. Saying so is the difference between a
// short list and a wrong one.
it("says when the ledger list is only the first page of the batch's rows", () => {
  setDetail(makeDetail({ ledgerRowsTruncated: true }));

  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  expect(screen.getByTestId("drilldown-ledger-truncated")).toHaveTextContent(
    "showing the first 1 of this batch's rows",
  );
});

it("says nothing about truncation when the whole batch is on screen", () => {
  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  expect(screen.queryByTestId("drilldown-ledger-truncated")).toBeNull();
  expect(screen.queryByTestId("drilldown-attempts-truncated")).toBeNull();
  expect(screen.queryByTestId("drilldown-attribution-events-truncated")).toBeNull();
});

// CR-4: attempts are append-only and manual attributions accumulate, so both
// lists are now the NEWEST page of a history that can be longer. A short list
// read as a complete one is the same class of untruth the ledger bound closed.
it("says when the attempt list is only the newest page, and of how many", () => {
  setDetail(
    makeDetail({
      attempts: [attemptRow(3), attemptRow(2)],
      attemptsTruncated: true,
      attemptsCount: 137,
    }),
  );

  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  expect(screen.getByTestId("drilldown-attempts-truncated")).toHaveTextContent(
    "showing the 2 most recent of 137 attempts",
  );
});

it("says the same about the manual-attribution list", () => {
  setDetail(
    makeDetail({
      attributionEvents: [attributionRow(9)],
      attributionEventsTruncated: true,
      attributionEventsCount: 44,
    }),
  );

  render(
    <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
  );

  expect(screen.getByTestId("drilldown-attribution-events-truncated")).toHaveTextContent(
    "showing the 1 most recent of 44 manual attributions",
  );
});

// CR-1: this sheet is what an admin reads BEFORE deciding, so a control that
// vanished without a word is exactly the wrong place for the silence.
it("says the fulfillment target is gone rather than dropping the control silently", () => {
  render(
    <AttributionDrilldown
      row={makeRow({ canAttribute: false, fulfillmentTargetMissing: true })}
      open
      onOpenChange={jest.fn()}
      onAttribute={jest.fn()}
    />,
  );

  expect(screen.getByTestId("drilldown-target-missing")).toHaveTextContent(
    "fulfillment target missing — the named order no longer exists",
  );
  expect(screen.queryByTestId("attribute-drilldown-batch-1")).toBeNull();
});

it("offers the correction only where the server would accept it", async () => {
  const user = userEvent.setup();
  const onAttribute = jest.fn();
  const row = makeRow();

  render(<AttributionDrilldown row={row} open onOpenChange={jest.fn()} onAttribute={onAttribute} />);
  await user.click(screen.getByTestId("attribute-drilldown-batch-1"));
  expect(onAttribute).toHaveBeenCalledWith(row);

  render(
    <AttributionDrilldown
      row={makeRow({ batchId: "batch-2", canAttribute: false })}
      open
      onOpenChange={jest.fn()}
      onAttribute={onAttribute}
    />,
  );
  expect(screen.queryByTestId("attribute-drilldown-batch-2")).toBeNull();
});

// ---------------------------------------------------------------------------
// A3 — the "This order" panel (pack CA3)
// ---------------------------------------------------------------------------

/**
 * THE PANEL IS THE ONLY PLACE THE TWO SIDES MEET, so the pins are the ways it
 * would flatter what the matcher actually knows:
 *
 *   1. EVERY PRODUCT ON EITHER SIDE IS LISTED. A panel that showed only the
 *      products with a difference would read as "these are the order's lines".
 *   2. A TOLERANCE THAT FIRED IS SHOWN, WITH ITS MASS. `substitution-equivalent`
 *      is the matcher deciding a swap balanced; an admin cannot audit that from
 *      the class name alone.
 *   3. THE COUNTS THAT ARE NOT COMPARED ARE SAID: unmapped lines, bundle lines
 *      that would not expand, products excluded from the mass balance. Each of
 *      them is a piece of the order the class had NO opinion about.
 *   4. NO NAME RIDES THE MATCHER (pack rule 5). The only string naming anything
 *      inside this panel is `perProduct[].productName`.
 */
function makeMatch(over: Partial<OrderMatch> = {}): OrderMatch {
  return {
    class: "short",
    flagged: true,
    kinds: ["short"],
    perProduct: [
      {
        productId: 3,
        productName: "Widget",
        ordered: 3,
        deducted: 1,
        corrected: 0,
        delta: -2,
        kind: "short",
        units: 2,
      },
      {
        productId: 4,
        productName: "Gadget",
        ordered: 0,
        deducted: 1,
        corrected: 0,
        delta: 1,
        kind: "extra",
        units: 1,
      },
      {
        productId: 5,
        productName: "Doohickey",
        ordered: 2,
        deducted: 2,
        corrected: 1,
        delta: 0,
        kind: null,
        units: 0,
      },
    ],
    unmappedLines: 0,
    unmappedUnits: 0,
    bundleLines: 0,
    unresolvableBundleLines: 0,
    deductedUnits: 4,
    tolerance: null,
    definitions: MATCH_DEFINITIONS,
    ...over,
  };
}

function renderPanel(detail: Partial<BatchDetail>, row: Partial<AttributionRow> = {}) {
  setDetail(makeDetail(detail));
  return render(
    <AttributionDrilldown
      row={makeRow(row)}
      open
      onOpenChange={jest.fn()}
      onAttribute={jest.fn()}
    />,
  );
}

describe("the This order panel (pack CA3)", () => {
  it("lists EVERY per-product row, both sides, the corrections and the kind", () => {
    renderPanel({ orderMatch: makeMatch() });

    const panel = screen.getByTestId("order-match-panel");
    expect(panel).toHaveTextContent("Short");

    const shortRow = screen.getByTestId("order-match-product-3");
    expect(shortRow).toHaveTextContent("Widget");
    expect(shortRow).toHaveTextContent("short by 2");

    expect(screen.getByTestId("order-match-product-4")).toHaveTextContent("extra 1");
    // The product with no difference is listed too — a panel that dropped it
    // would read as an order with two lines.
    expect(screen.getByTestId("order-match-product-5")).toHaveTextContent("Doohickey");
  });

  it("says an overrun in the words for it — corrections gave back more than ever left", () => {
    renderPanel({
      orderMatch: makeMatch({
        class: "correction-overrun",
        kinds: ["overrun"],
        perProduct: [
          {
            productId: 3,
            productName: "Widget",
            ordered: 2,
            deducted: -3,
            corrected: 5,
            delta: -5,
            kind: "overrun",
            units: 3,
          },
        ],
      }),
    });

    expect(screen.getByTestId("order-match-product-3")).toHaveTextContent(
      "corrections exceed outbound by 3",
    );
  });

  it("shows a balanced swap with its mass, in the unit's own scale (1000 -> 10 mg)", () => {
    renderPanel({
      orderMatch: makeMatch({
        class: "substitution-equivalent",
        flagged: false,
        kinds: [],
        tolerance: {
          equivalentGroups: [
            {
              familyKey: "vitamin c",
              unit: "mg",
              massHundredths: 1000,
              shortfall: [{ productId: 3, units: 2, hundredths: 500 }],
              extra: [{ productId: 4, units: 1, hundredths: 1000 }],
            },
          ],
          declaredPairs: [],
          excludedProducts: [],
        },
      }),
    });

    const tolerance = screen.getByTestId("order-match-tolerance");
    expect(tolerance).toHaveTextContent("Swap within vitamin c (mg)");
    expect(tolerance).toHaveTextContent("balanced at 10 mg");
    expect(tolerance).toHaveTextContent("⇄");
  });

  it("names the products the mass balance could NOT compare, and why", () => {
    renderPanel({
      orderMatch: makeMatch({
        tolerance: {
          equivalentGroups: [],
          declaredPairs: [],
          excludedProducts: [
            { productId: 3, reason: "undecomposable", unit: null },
            { productId: 4, reason: "unit-refused", unit: "capsule" },
          ],
        },
      }),
    });

    const excluded = screen.getByTestId("order-match-excluded");
    expect(excluded).toHaveTextContent("Widget — not compared (cannot be decomposed)");
    expect(excluded).toHaveTextContent("Gadget — not compared (unit not comparable)");
  });

  it("says how much of the order was never mapped, and links to where it is fixed", () => {
    renderPanel({ orderMatch: makeMatch({ unmappedLines: 2, unmappedUnits: 5 }) });

    const unmapped = screen.getByTestId("order-match-unmapped");
    expect(unmapped).toHaveTextContent("2 unmapped line(s), 5 units");
    expect(screen.getByTestId("order-match-unmapped-link")).toHaveAttribute(
      "href",
      "/admin/reconciliation?tab=unmapped",
    );
  });

  it("says nothing about unmapped lines when there are none", () => {
    renderPanel({ orderMatch: makeMatch() });

    expect(screen.queryByTestId("order-match-unmapped")).toBeNull();
    expect(screen.queryByTestId("order-match-unresolvable-bundles")).toBeNull();
  });

  it("says when a bundle line could not be expanded — the class had no opinion about it", () => {
    renderPanel({ orderMatch: makeMatch({ unresolvableBundleLines: 1 }) });

    expect(screen.getByTestId("order-match-unresolvable-bundles")).toHaveTextContent(
      "1 bundle line(s) could not be expanded",
    );
  });

  it("marks the components that came from a bundle with where they are deducted", () => {
    renderPanel({ orderMatch: makeMatch({ bundleLines: 2 }) });

    expect(screen.getByTestId("order-match-bundle-lines")).toHaveTextContent(
      "from bundle — deduct via the adjust page's Order intent or fulfil",
    );
  });

  it("offers the exceptions finder on a FLAGGED class only", () => {
    const view = renderPanel({ orderMatch: makeMatch() });

    expect(screen.getByTestId("order-match-exceptions-link")).toHaveAttribute(
      "href",
      "/admin/reconciliation?tab=exceptions",
    );
    expect(screen.getByTestId("order-match-exceptions-link")).toHaveTextContent(
      "Find this order's exceptions",
    );
    view.unmount();

    renderPanel({ orderMatch: makeMatch({ class: "exact", flagged: false, kinds: [] }) });
    expect(screen.queryByTestId("order-match-exceptions-link")).toBeNull();
  });

  it("renders the reason there is no match, from the map, for every reason", () => {
    for (const reason of MATCH_UNAVAILABLE_REASONS) {
      const view = renderPanel({ orderMatch: null, orderMatchUnavailable: reason });

      expect(screen.getByTestId("order-match-unavailable")).toHaveTextContent(
        MATCH_UNAVAILABLE_COPY[reason],
      );
      expect(screen.queryByTestId("order-match-panel")).toBeNull();

      view.unmount();
    }
  });

  it("a class-less match renders its DEFINITION, not an unavailable reason (pack REV 4)", () => {
    renderPanel({
      orderMatch: makeMatch({ class: null, reason: "unmatchable", flagged: false, kinds: [] }),
    });

    const panel = screen.getByTestId("order-match-panel");
    expect(panel).toHaveTextContent("not comparable");
    expect(panel).toHaveTextContent(MATCH_DEFINITIONS.unmatchable);
    expect(screen.queryByTestId("order-match-unavailable")).toBeNull();
  });

  // Pack rule 5: `perProduct[].productName` is the only string inside the match
  // that names anything. The row beside it carries an actor and an order number;
  // neither belongs in this panel.
  it("prints no name inside the panel other than the products' own", () => {
    renderPanel(
      { orderMatch: makeMatch() },
      {
        actor: { id: 7, username: "kris" },
        order: {
          id: "ord-1",
          orderNumber: "9911",
          internalStatus: "PROCESSING",
          platform: "woocommerce",
          externalCreatedAt: "2026-08-19T09:00:00.000Z",
        },
      },
    );

    const panel = screen.getByTestId("order-match-panel");
    expect(panel).toHaveTextContent("Widget");
    expect(panel.textContent).not.toContain("kris");
    expect(panel.textContent).not.toContain("9911");
    expect(panel.textContent).not.toContain("ord-1");
  });

  it("stacks the per-product table as cards on mobile (the md: breakpoint pair)", () => {
    renderPanel({ orderMatch: makeMatch() });

    const cards = screen.getByTestId("order-match-product-cards");
    expect(cards.className).toContain("md:hidden");
    expect(screen.getByTestId("order-match-products").className).toContain("hidden md:block");
    expect(screen.getByTestId("order-match-product-card-3").className).toContain("bg-surface");
  });
});
