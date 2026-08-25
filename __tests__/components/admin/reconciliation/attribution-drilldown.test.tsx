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
    attributionEvents: [],
    derived: null,
    ...over,
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
