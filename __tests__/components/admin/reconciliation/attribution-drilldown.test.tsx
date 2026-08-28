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
