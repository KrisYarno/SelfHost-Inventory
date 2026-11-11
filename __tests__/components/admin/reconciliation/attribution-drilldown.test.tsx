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
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MATCH_DEFINITIONS,
  MATCH_UNAVAILABLE_COPY,
  MATCH_UNAVAILABLE_REASONS,
} from "@/lib/reconciliation/match-keys";
import type {
  AttributionRow,
  BatchDetail,
  WireOrderMatch,
} from "@/lib/reconciliation/attribution";
import { MATCH_NOT_COMPUTED_COPY } from "@/components/admin/reconciliation/attribution-row";

const useBatchDetailMock = jest.fn();
// B2b (pack CB2b.4): the inline `ReverseConfirm` owns its own mutation, exactly
// the way `AttributeConfirm` owns `useAttributeBatch` — so this wholesale mock
// has to answer for it too.
const reverseMutateAsync = jest.fn();
const useReverseBatchMock = jest.fn(() => ({
  mutateAsync: reverseMutateAsync,
  isPending: false,
}));

// B2c (pack CB2c.3): the Move's mutation is HOISTED to the component's top
// level (rules of hooks), so this mock answers on every render, gated or not.
const moveMutateAsync = jest.fn();
const useMoveBatchMock = jest.fn(() => ({ mutateAsync: moveMutateAsync, isPending: false }));

jest.mock("@/hooks/use-admin", () => ({
  useBatchDetail: (...args: unknown[]) => useBatchDetailMock(...args),
  useReverseBatch: (...args: unknown[]) => useReverseBatchMock(...(args as [])),
  useMoveBatch: (...args: unknown[]) => useMoveBatchMock(...(args as [])),
}));

// The shared move dialog reads the ONE locations hook.
jest.mock("@/hooks/use-locations", () => ({
  useLocations: () => ({
    data: [
      { id: 3, name: "Main" },
      { id: 7, name: "Overflow" },
    ],
    isLoading: false,
  }),
}));

const toastSuccess = jest.fn();
jest.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a) } }));

import {
  AttributionDrilldown,
  MOVE_MULTI_LOCATION_COPY,
  MOVE_NULL_LOCATION_COPY,
  REVERSE_USE_UNFULFILL_COPY,
} from "@/components/admin/reconciliation/attribution-drilldown";

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
    // B2b (pack CB2b.4): the fulfilment fact the reverse ladder refuses on.
    fulfilled: false,
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
        // Part 2 (pack CB2c.3): the location the drill-down's Move gates on.
        locationId: 3,
        locationName: "Main",
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
  useReverseBatchMock.mockReturnValue({ mutateAsync: reverseMutateAsync, isPending: false });
  reverseMutateAsync.mockResolvedValue({ message: "reversed 3 of 3 units" });
  useMoveBatchMock.mockReturnValue({ mutateAsync: moveMutateAsync, isPending: false });
  moveMutateAsync.mockResolvedValue({
    movedBatchId: "batch-1",
    batchId: "new-batch",
    orderRecordId: null,
    ledgerLocationId: 3,
    physicalLocationId: 7,
    pairs: [{ productId: 3, units: 2, transferId: "t-1" }],
    rows: [
      { productId: 3, locationId: 7, delta: -2 },
      { productId: 3, locationId: 3, delta: 2 },
    ],
    message: "moved 2 units from location 3 to 7",
  });
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

// B3-1 FR3 (Q/A B3-1-QA-2): the adjust route records HOW it stamped
// (`orderAttributionSource`) and never a picked id on its event (B3-1 FR1, F2),
// so a picked adjust batch must not read "order picked: none" above an attempt
// that says `attributed / selected`.
describe("the audit event's order lines", () => {
  type AuditEvent = NonNullable<BatchDetail["auditEvent"]>;
  const LABEL = "from the audit event (free text, admin-visible on /admin/logs)" as const;

  function renderAuditEvent(over: Partial<AuditEvent>) {
    setDetail(
      makeDetail({
        auditEvent: {
          id: 5,
          actionType: "INVENTORY_ADJUSTMENT",
          createdAt: "2026-08-20T10:00:00.000Z",
          intent: "order",
          label: LABEL,
          ...over,
        },
      }),
    );
    render(
      <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
    );
    return screen.getByTestId("drilldown-audit-event");
  }

  const lines = (block: HTMLElement) =>
    Array.from(block.querySelectorAll("p")).map((p) => p.textContent);

  it("an adjust event stamped from a PICK: the id is not recorded there, and it says how it stamped", () => {
    const block = renderAuditEvent({ orderAttributionSource: "selected" });

    expect(lines(block)).toContain("order picked: not recorded on this event");
    expect(lines(block)).toContain("stamped from: a picked order");
    expect(block).not.toHaveTextContent("order picked: none");
  });

  it("an adjust event stamped from a TYPED number says so", () => {
    const block = renderAuditEvent({ orderAttributionSource: "reference-resolved", orderReference: "1009" });

    expect(lines(block)).toContain("stamped from: a typed order number");
    expect(lines(block)).toContain("order picked: not recorded on this event");
  });

  it("a source this page has no words for shows as stored", () => {
    const block = renderAuditEvent({ orderAttributionSource: "some-future-source" });

    expect(lines(block)).toContain("stamped from: some-future-source");
  });

  it("an unstamped adjust event: no stamped-from line, and still no claim that nothing was picked", () => {
    const block = renderAuditEvent({});

    expect(lines(block)).toContain("order picked: not recorded on this event");
    expect(block).not.toHaveTextContent("stamped from:");
  });

  // Deduct-simple's event (`INVENTORY_BULK_UPDATE`) DOES record the picked id.
  it("any other event keeps today's line: the picked id, or none", () => {
    const withId = renderAuditEvent({ actionType: "INVENTORY_BULK_UPDATE", selectedExternalOrderId: "ord-1" });
    expect(lines(withId)).toContain("order picked: ord-1");
    expect(withId).not.toHaveTextContent("stamped from:");
  });

  it("any other event with no picked id reads none", () => {
    const block = renderAuditEvent({ actionType: "INVENTORY_BULK_UPDATE" });

    expect(lines(block)).toContain("order picked: none");
    expect(block).not.toHaveTextContent("stamped from:");
  });

  it("a picked id on the event wins, whatever the action type", () => {
    const block = renderAuditEvent({ selectedExternalOrderId: "ord-7", orderAttributionSource: "selected" });

    expect(lines(block)).toContain("order picked: ord-7");
    expect(lines(block)).toContain("stamped from: a picked order");
  });
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
function makeMatch(over: Partial<WireOrderMatch> = {}): WireOrderMatch {
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
      {
        productId: 4,
        productName: "Gadget",
        fromBundle: false,
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
        fromBundle: false,
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
    // NO `definitions` (OCa-10): the envelope carries the one copy, and the
    // panel reads its sentences from `match-keys.ts`.
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
            fromBundle: false,
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
    // Hand-typed lines plan, C9: the matcher counts a line with no store product
    // as unmapped, but the Unmapped tab lists only the MAPPABLE ones — so the
    // link says where it leads, and the sentence after it says what is not there.
    expect(screen.getByTestId("order-match-unmapped-link")).toHaveTextContent(
      /^See the mappable ones on the Unmapped tab$/,
    );
    expect(unmapped).toHaveTextContent(
      "See the mappable ones on the Unmapped tab. A line with no store product can't be mapped and is only counted there.",
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

  it("marks each product that came from a bundle on its OWN row (seam-check fix, pack REV-6)", () => {
    const base = makeMatch();
    renderPanel({
      orderMatch: makeMatch({
        bundleLines: 1,
        perProduct: [
          { ...base.perProduct[0], fromBundle: true },
          { ...base.perProduct[0], productId: 4, productName: "Gadget", fromBundle: false },
        ],
      }),
    });

    const mark = screen.getByTestId("order-match-from-bundle-3");
    expect(mark).toHaveTextContent("from bundle");
    expect(mark).toHaveAttribute("title", "from bundle — deduct via the adjust page's Order intent or fulfil");
    expect(screen.queryByTestId("order-match-from-bundle-4")).toBeNull();
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

  // G2-6: the pair is exactly-one-of by contract, so this branch is unreachable
  // from a real read — which is exactly why it must not render as an ABSENT
  // section. A missing "This order" panel reads as "nothing to see here"; the
  // row cell has said "not computed" since A3, and the panel now says the same.
  it("renders 'not computed' on the both-null pair, never an absent section", () => {
    renderPanel({ orderMatch: null, orderMatchUnavailable: null });

    expect(screen.getByTestId("order-match-not-computed")).toHaveTextContent(
      MATCH_NOT_COMPUTED_COPY,
    );
    expect(screen.queryByTestId("order-match-panel")).toBeNull();
    expect(screen.queryByTestId("order-match-unavailable")).toBeNull();
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

  // QA-2: a class-less match LISTS its deducted products without comparing
  // them; "no difference" about a product with ordered 0 / deducted 5 is a
  // positive false claim. And a tolerance-nulled row differs by the mass the
  // swap below explains.
  it("never says 'no difference' where nothing was compared, or where a swap explains the gap", () => {
    const base = makeMatch();
    renderPanel({
      orderMatch: makeMatch({
        class: null,
        reason: "unmatchable",
        flagged: false,
        kinds: [],
        perProduct: [
          { ...base.perProduct[0], ordered: 0, deducted: 5, corrected: 0, delta: 5, kind: null, units: 0 },
        ],
      }),
    });
    expect(screen.getByTestId("order-match-product-3")).toHaveTextContent("not compared");
    expect(screen.getByTestId("order-match-product-3")).not.toHaveTextContent("no difference");
  });

  it("a tolerance-nulled row says the swap explains it; a truly equal row says 'no difference'", () => {
    const base = makeMatch();
    renderPanel({
      orderMatch: makeMatch({
        class: "substitution-equivalent",
        flagged: false,
        kinds: [],
        perProduct: [
          { ...base.perProduct[0], ordered: 2, deducted: 0, corrected: 0, delta: -2, kind: null, units: 0 },
          { ...base.perProduct[0], productId: 4, productName: "Gadget", ordered: 1, deducted: 1, corrected: 0, delta: 0, kind: null, units: 0 },
        ],
      }),
    });
    expect(screen.getByTestId("order-match-product-3")).toHaveTextContent("balanced (see swap below)");
    expect(screen.getByTestId("order-match-product-4")).toHaveTextContent("no difference");
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

// ---------------------------------------------------------------------------
// THE REVERSE AFFORDANCE (Part 2, pack CB2b.4)
// ---------------------------------------------------------------------------

describe("the Reverse… control", () => {
  function renderRow(row: Partial<AttributionRow> = {}) {
    render(
      <AttributionDrilldown
        row={makeRow(row)}
        open
        onOpenChange={jest.fn()}
        onAttribute={jest.fn()}
      />,
    );
  }

  it("offers Reverse… on a plain attributable batch, beside Attribute…", () => {
    renderRow();
    expect(screen.getByTestId("reverse-drilldown-batch-1")).toBeInTheDocument();
    expect(screen.getByTestId("attribute-drilldown-batch-1")).toBeInTheDocument();
    expect(screen.queryByTestId("drilldown-reverse-unavailable")).not.toBeInTheDocument();
  });

  // OC-1: a control whose only outcome is a 409 is not an affordance. `fulfilled`
  // is the SAME predicate rung 6 of the reverse ladder refuses on.
  it("hides it on a FULFILLED batch and says where the repair lives", () => {
    renderRow({ fulfilled: true, canAttribute: false });
    expect(screen.queryByTestId("reverse-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("drilldown-reverse-unavailable")).toHaveTextContent(
      REVERSE_USE_UNFULFILL_COPY,
    );
  });

  // An R2b row is the case the two predicates DISAGREE about: it is attributable
  // (its own event's stamp may be completed) and it is fulfilled.
  it("an R2b row can be Attributed and can NOT be Reversed", () => {
    renderRow({
      fulfilled: true,
      canAttribute: true,
      attributeLock: { orderRecordId: "ord-7", reason: "r2b-completion" },
    });
    expect(screen.getByTestId("attribute-drilldown-batch-1")).toBeInTheDocument();
    expect(screen.queryByTestId("reverse-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("drilldown-reverse-unavailable")).toBeInTheDocument();
  });

  it("is HIDDEN while the detail is loading, and while it is in error", () => {
    useBatchDetailMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { unmount } = render(
      <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
    );
    expect(screen.queryByTestId("reverse-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drilldown-reverse-unavailable")).not.toBeInTheDocument();
    unmount();

    useBatchDetailMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(
      <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
    );
    expect(screen.queryByTestId("reverse-drilldown-batch-1")).not.toBeInTheDocument();
  });

  it("opens an INLINE panel naming the batch's own numbers, then POSTs and toasts", async () => {
    const user = userEvent.setup();
    renderRow({ units: 3, productCount: 2 });

    await user.click(screen.getByTestId("reverse-drilldown-batch-1"));
    expect(screen.getByTestId("reverse-scope")).toHaveTextContent(
      "Reverse this batch — restores up to 3 units across 2 product(s)",
    );
    expect(screen.getByTestId("reverse-remainder")).toHaveTextContent(
      "Restores only what has not been put back through this action",
    );

    await user.click(screen.getByTestId("reverse-confirm-submit"));
    expect(useReverseBatchMock).toHaveBeenCalledWith("batch-1");
    expect(reverseMutateAsync).toHaveBeenCalledTimes(1);
    // The SERVER's sentence, never a recomputed one.
    expect(toastSuccess).toHaveBeenCalledWith("reversed 3 of 3 units");
    expect(screen.queryByTestId("reverse-scope")).not.toBeInTheDocument();
  });

  // F5 (OC-5): `AttributeConfirm` leans on react-query's `isPending`, which is
  // set ASYNCHRONOUSLY — two clicks inside one tick both see `false` and both
  // POST. A reverse posted twice is a second restoration attempt on a ledger the
  // first one is still writing, so the latch is SYNCHRONOUS, exactly as
  // `MoveBatchDialog` does it.
  it("a DOUBLE CLICK issues exactly ONE request", async () => {
    const user = userEvent.setup();
    let release: (value: { message: string }) => void = () => undefined;
    reverseMutateAsync.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderRow();

    await user.click(screen.getByTestId("reverse-drilldown-batch-1"));
    const submit = screen.getByTestId("reverse-confirm-submit");
    await user.click(submit);
    await user.click(submit);

    expect(reverseMutateAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ message: "reversed 3 of 3 units" });
    });
  });

  // F16: the F5 latch was `useState`, which React sets on a LATER render — the
  // pin above only passed because awaiting each click flushed that render in
  // between. Two clicks dispatched inside ONE tick read the SAME closure, so the
  // latch has to be a ref, written before the await.
  it("two clicks in ONE tick still issue exactly ONE request", async () => {
    const user = userEvent.setup();
    let release: (value: { message: string }) => void = () => undefined;
    reverseMutateAsync.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    renderRow();

    await user.click(screen.getByTestId("reverse-drilldown-batch-1"));
    const submit = screen.getByTestId("reverse-confirm-submit");
    await act(async () => {
      submit.click();
      submit.click();
    });

    expect(reverseMutateAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ message: "reversed 3 of 3 units" });
    });
  });

  it("a SETTLED reverse cannot be run again from the same panel", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByTestId("reverse-drilldown-batch-1"));
    await user.click(screen.getByTestId("reverse-confirm-submit"));
    // `onDone` closed the panel on the 200 — there is nothing left to click.
    expect(screen.queryByTestId("reverse-confirm-submit")).not.toBeInTheDocument();
    expect(reverseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("CANCEL closes the panel and makes no request", async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByTestId("reverse-drilldown-batch-1"));
    expect(screen.getByTestId("reverse-scope")).toBeInTheDocument();

    await user.click(screen.getByTestId("reverse-confirm-cancel"));
    expect(screen.queryByTestId("reverse-scope")).not.toBeInTheDocument();
    expect(reverseMutateAsync).not.toHaveBeenCalled();
  });

  it("renders a refusal VERBATIM and keeps the panel open (the F7 rule)", async () => {
    const user = userEvent.setup();
    const refusal = Object.assign(
      new Error("This batch was already reversed — 4 of 10 units were put back"),
      { code: "ALREADY_REVERSED", status: 409 },
    );
    reverseMutateAsync.mockRejectedValue(refusal);
    renderRow();

    await user.click(screen.getByTestId("reverse-drilldown-batch-1"));
    await user.click(screen.getByTestId("reverse-confirm-submit"));

    expect(screen.getByTestId("reverse-refusal")).toHaveTextContent(
      "This batch was already reversed — 4 of 10 units were put back",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  // B2c CLOSES B2b's STATED EXCEPTION (pack CB2c.3). The detail now carries each
  // row's location, so the gate reads it instead of letting the server answer.
  it("is HIDDEN on a batch carrying a NULL-location row, with the sentence naming the repair", () => {
    setDetail(
      makeDetail({
        ledgerRows: [
          {
            id: 11,
            productId: 3,
            productName: "Widget",
            delta: -2,
            logType: "SALE",
            changeTime: "2026-08-20T10:00:00.000Z",
            orderRecordId: null,
            locationId: null,
            locationName: null,
          },
        ],
      }),
    );
    renderRow();

    expect(screen.queryByTestId("reverse-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("drilldown-move-null-location")).toHaveTextContent(
      MOVE_NULL_LOCATION_COPY([11]),
    );
  });
});

// ---------------------------------------------------------------------------
// THE MOVE AFFORDANCE (Part 2, pack CB2c.3)
// ---------------------------------------------------------------------------

describe("the Move… control", () => {
  function renderRow(row: Partial<AttributionRow> = {}) {
    render(
      <AttributionDrilldown
        row={makeRow(row)}
        open
        onOpenChange={jest.fn()}
        onAttribute={jest.fn()}
      />,
    );
  }

  /** N ledger rows, at the locations named. */
  function rowsAt(...locations: Array<number | null>): BatchDetail["ledgerRows"] {
    return locations.map((locationId, index) => ({
      id: 11 + index,
      productId: 3 + index,
      productName: "Widget",
      delta: -2,
      logType: "SALE",
      changeTime: "2026-08-20T10:00:00.000Z",
      orderRecordId: null,
      locationId,
      locationName: locationId === null ? null : `Location ${locationId}`,
    }));
  }

  it("offers Move… beside Reverse… on a plain single-location batch", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(3, 3) }));
    renderRow();

    expect(screen.getByTestId("move-drilldown-batch-1")).toBeInTheDocument();
    expect(screen.getByTestId("reverse-drilldown-batch-1")).toBeInTheDocument();
  });

  // OC-1 again: the move ladder's rung 7 refuses a fulfilment-evidenced batch
  // every time, so the control is not offered. CB2.5e.3: it is ONE sentence, not
  // two near-duplicates — a fulfilled batch used to be told twice, in two
  // spellings, that unfulfill is the repair. The reverse sentence is the one
  // that survives; the move side's own wording lives in the move dialog's
  // `MOVE_ORDER_LEG_SENTENCE`, which is what operators actually meet.
  it("is HIDDEN on a FULFILLED batch, and says it ONCE — no move-side duplicate", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(3) }));
    renderRow({ fulfilled: true, canAttribute: true });

    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drilldown-move-unavailable")).toBeNull();
    expect(screen.getByTestId("drilldown-reverse-unavailable")).toHaveTextContent(
      REVERSE_USE_UNFULFILL_COPY,
    );
    // ONE sentence: the fulfilled arm renders a single paragraph, and nothing
    // repeats "unfulfill" underneath it.
    expect(screen.queryAllByText(/unfulfill/i)).toHaveLength(1);
  });

  it("is HIDDEN on a MULTI-LOCATION batch, with the sentence saying why", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(3, 7) }));
    renderRow();

    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("drilldown-move-multi-location")).toHaveTextContent(
      MOVE_MULTI_LOCATION_COPY([3, 7]),
    );
    // The REVERSE is still offered: it restores per key and needs no one source.
    expect(screen.getByTestId("reverse-drilldown-batch-1")).toBeInTheDocument();
  });

  it("is HIDDEN on a NULL-location batch, with the row-repair sentence", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(3, null) }));
    renderRow();

    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("drilldown-move-null-location")).toHaveTextContent(
      MOVE_NULL_LOCATION_COPY([12]),
    );
  });

  // F2 (OC-2): a hidden control leaves the admin with only the sentence, so the
  // sentence has to name the thing to repair. Every offending row id, not "a
  // ledger row".
  it("the null-location sentence NAMES every row that has no location", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(3, null, null) }));
    renderRow();

    expect(screen.getByTestId("drilldown-move-null-location")).toHaveTextContent(
      "Ledger row 12, 13 names no location — this batch cannot be reversed or moved until it is repaired",
    );
  });

  it("the multi-location sentence NAMES the distinct locations, and counts them", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(7, 3, 3, 9) }));
    renderRow();

    expect(screen.getByTestId("drilldown-move-multi-location")).toHaveTextContent(
      "This batch's rows sit at 3 locations (3, 7, 9) — it cannot be moved as one",
    );
  });

  // F27: the click handler dereferences `ledgerRows[0]`. An EMPTY ledger passes
  // both the null-location and the multi-location gates vacuously, so without
  // its own clause the control renders and the first click throws. The detail
  // route 404s a batch with no rows, so this is unreachable today and carries no
  // sentence — the gate holds by its own property, not a neighbour's behaviour.
  it("is HIDDEN on an EMPTY ledger, and the panel renders without throwing", () => {
    setDetail(makeDetail({ ledgerRows: [] }));
    renderRow();

    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    // No sentence for this arm, and no crash: the rest of the panel is intact.
    expect(screen.getByTestId("reverse-drilldown-batch-1")).toBeInTheDocument();
    expect(screen.queryByTestId("drilldown-move-null-location")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drilldown-move-multi-location")).not.toBeInTheDocument();
  });

  it("is HIDDEN while the detail is loading, and while it is in error", () => {
    useBatchDetailMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { unmount } = render(
      <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
    );
    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    unmount();

    useBatchDetailMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(
      <AttributionDrilldown row={makeRow()} open onOpenChange={jest.fn()} onAttribute={jest.fn()} />,
    );
    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
  });

  // The hook is HOISTED (R6-2): it is called on EVERY render of this component,
  // including the ones where the gate hides the control — which is the whole
  // point, because a hook called conditionally is a hook order that changes.
  it("declares the mutation for this batch whatever the gate decides", () => {
    setDetail(makeDetail({ ledgerRows: rowsAt(3, 7) }));
    renderRow();

    expect(screen.queryByTestId("move-drilldown-batch-1")).not.toBeInTheDocument();
    expect(useMoveBatchMock).toHaveBeenCalled();
  });

  it("opens the SHARED dialog, excludes the ledger location, and moves through the hook", async () => {
    const user = userEvent.setup();
    setDetail(makeDetail({ ledgerRows: rowsAt(3) }));
    renderRow({ units: 5 });

    await user.click(screen.getByTestId("move-drilldown-batch-1"));

    // The batch's own location, named — and excluded from the choices.
    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "Moves this batch's books (5 units on the ledger) from Location 3 to the chosen location",
    );
    const options = Array.from(
      (screen.getByTestId("move-dialog-location") as HTMLSelectElement).options,
    ).map((option) => option.value);
    expect(options).toEqual(["", "7"]);

    await user.selectOptions(screen.getByTestId("move-dialog-location"), "7");
    await user.click(screen.getByTestId("move-dialog-confirm"));

    expect(moveMutateAsync).toHaveBeenCalledWith({ physicalLocationId: 7 });
    expect(screen.getByTestId("move-result-manual")).toHaveTextContent("manual leg: moved 2 units");
    // A drill-down batch has no order leg: there is no line to refulfil.
    expect(screen.queryByTestId("move-result-order")).not.toBeInTheDocument();
  });

  it("renders a refusal VERBATIM — the hook rejects with `{ error, code }`", async () => {
    const user = userEvent.setup();
    moveMutateAsync.mockRejectedValue({
      error: "Location 7 has 1 of product 3 on the books — 2 needed to move this batch",
      code: "INSUFFICIENT_AT_SOURCE",
    });
    setDetail(makeDetail({ ledgerRows: rowsAt(3) }));
    renderRow();

    await user.click(screen.getByTestId("move-drilldown-batch-1"));
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "7");
    await user.click(screen.getByTestId("move-dialog-confirm"));

    expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(
      "Location 7 has 1 of product 3 on the books — 2 needed to move this batch",
    );
    expect(screen.queryByTestId("move-result-manual")).not.toBeInTheDocument();
  });

  // F13 (GX-8): the drill-down falls back to the BATCH id when the row names no
  // order number — and a uuid introduced as `Order …` is a claim this surface
  // cannot support.
  it("heads the dialog with `Batch …` when the ref IS the batch id", async () => {
    const user = userEvent.setup();
    setDetail(makeDetail({ ledgerRows: rowsAt(3) }));
    renderRow({ order: null });

    await user.click(screen.getByTestId("move-drilldown-batch-1"));
    expect(
      screen.getByText("Batch batch-1 — where did this stock actually leave from?"),
    ).toBeInTheDocument();
  });

  it("heads it with `Order …` when the row names one", async () => {
    const user = userEvent.setup();
    setDetail(makeDetail({ ledgerRows: rowsAt(3) }));
    renderRow({
      order: {
        id: "ord-9",
        orderNumber: "#1009",
        internalStatus: "completed",
        platform: "woocommerce",
        externalCreatedAt: null,
      },
    });

    await user.click(screen.getByTestId("move-drilldown-batch-1"));
    expect(
      screen.getByText("Order #1009 — where did this stock actually leave from?"),
    ).toBeInTheDocument();
  });

  // F3 (OC-3): the drill-down's units come OFF THE LEDGER, not off a cart the
  // operator just filled — and the sentence says so.
  it("labels its units as the LEDGER's, never as `asked`", async () => {
    const user = userEvent.setup();
    setDetail(makeDetail({ ledgerRows: rowsAt(3) }));
    renderRow({ units: 5 });

    await user.click(screen.getByTestId("move-drilldown-batch-1"));
    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "Moves this batch's books (5 units on the ledger) from Location 3 to the chosen location",
    );
  });

  it("names the location by ID when the join gave no name", async () => {
    const user = userEvent.setup();
    setDetail(
      makeDetail({
        ledgerRows: [{ ...rowsAt(3)[0], locationName: null }],
      }),
    );
    renderRow({ units: 4 });

    await user.click(screen.getByTestId("move-drilldown-batch-1"));
    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "(4 units on the ledger) from Location 3 to the chosen location",
    );
  });
});
