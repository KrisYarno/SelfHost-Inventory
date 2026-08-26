/** @jest-environment jsdom */
/**
 * THE ATTRIBUTE… FLOW — picker + confirm (pack C4a.2; spec REV-7 §4.2 / D4).
 *
 * This is the one place on the reconciliation surface that WRITES, so the pins
 * are the four ways a confirm panel can talk somebody into a change they did not
 * mean to make:
 *
 *   1. IT OVERSTATES WHAT IT KNOWS. The overlap between the order's items and
 *      the batch's products is NOT readable on this surface, so the panel says
 *      that in words rather than rendering an empty overlap that reads as
 *      "nothing in common" (spec §4.2's "never an empty overlap that reads as
 *      none").
 *   2. IT SILENTLY REDIRECTS AN R2b BATCH. A fulfillment already answered the
 *      question; the picker may complete that stamp, never move it.
 *   3. IT OVERWRITES A DECISION WITHOUT A REASON. Re-attributing a stamped
 *      batch is a correction of somebody's earlier call — reason or nothing.
 *   4. IT SENDS WHAT IT FOUND INSTEAD OF WHAT IT SHOWED. The stale-client guard
 *      only works if `expectPreviousOrderRecordId` is the id the ROW DISPLAYED.
 *
 * Plus: every 409 the server can raise renders VERBATIM, and `BATCH_MOVED`
 * additionally closes the picker (the refetch itself is the hook's `onSettled`,
 * pinned in `__tests__/unit/hooks/use-admin-reconciliation.test.tsx`).
 *
 * The hook module is mocked wholesale — the idiom of the sibling admin suite
 * `__tests__/unit/components/lane3-admin-overview.test.tsx`.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttributionRow, BatchDetail } from "@/lib/reconciliation/attribution";

const useBatchDetailMock = jest.fn();
const useOrderSearchMock = jest.fn();
const mutateAsync = jest.fn();

jest.mock("@/hooks/use-admin", () => ({
  useAttributionReport: jest.fn(),
  useBatchDetail: (...args: unknown[]) => useBatchDetailMock(...args),
  useOrderSearch: (...args: unknown[]) => useOrderSearchMock(...args),
  useAttributeBatch: () => ({ mutateAsync, isPending: false }),
}));

const toastSuccess = jest.fn();
const toastInfo = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    error: jest.fn(),
  },
}));

import { AttributePicker } from "@/components/admin/reconciliation/attribute-picker";
import { ATTRIBUTION_ONLY_SENTENCE } from "@/components/admin/reconciliation/attribute-confirm";

function makeRow(over: Partial<AttributionRow> = {}): AttributionRow {
  return {
    batchId: "batch-1",
    at: "2026-08-20T10:00:00.000Z",
    source: "live-deduct",
    actor: { id: 7, username: "kris" },
    how: { classKey: "attributed·selected", sentence: "the operator picked this order" },
    logTypes: ["SALE"],
    units: 3,
    productCount: 2,
    order: null,
    canAttribute: true,
    attributeLock: null,
    fulfilledAgainst: null,
    fulfillmentTargetMissing: false,
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
      {
        id: 12,
        productId: 4,
        productName: "Gadget",
        delta: -1,
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
    ...over,
  };
}

function setDetail(detail: BatchDetail | undefined) {
  useBatchDetailMock.mockReturnValue({ data: detail, isLoading: false, isError: false });
}

function setSearch(
  orders: Array<{
    id: string;
    orderNumber: string;
    platform: string;
    internalStatus: string;
    externalCreatedAt: string | null;
    itemCount: number;
  }>,
  moreCount = 0,
) {
  useOrderSearchMock.mockReturnValue({
    data: { orders, moreCount },
    isLoading: false,
    isError: false,
  });
}

const ORDER_1009 = {
  id: "ord-2",
  orderNumber: "1009",
  platform: "woocommerce",
  internalStatus: "PROCESSING",
  externalCreatedAt: "2026-08-19T09:00:00.000Z",
  itemCount: 4,
};

function renderPicker(row: AttributionRow, onOpenChange = jest.fn()) {
  render(<AttributePicker row={row} open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

/** Type a number, then pick the order it finds. */
async function pickOrder(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/order number/i), "1009");
  await waitFor(() => expect(screen.getByTestId("order-result-ord-2")).toBeInTheDocument());
  await user.click(screen.getByTestId("order-result-ord-2"));
}

beforeEach(() => {
  jest.clearAllMocks();
  setDetail(makeDetail());
  setSearch([ORDER_1009]);
  mutateAsync.mockResolvedValue({
    changed: true,
    orderRecordId: "ord-2",
    previousOrderRecordId: null,
    rowCount: 2,
    completedFulfillment: false,
  });
});

describe("the picker", () => {
  it("pre-seeds the reference the operator typed at the deduction", async () => {
    setDetail(
      makeDetail({
        auditEvent: {
          id: 5,
          actionType: "INVENTORY_DEDUCT",
          createdAt: "2026-08-20T10:00:00.000Z",
          orderReference: " 1009 ",
          label: "from the audit event (free text, admin-visible on /admin/logs)",
        },
      }),
    );

    renderPicker(makeRow());

    expect(screen.getByLabelText(/order number/i)).toHaveValue("1009");
    await waitFor(() => expect(useOrderSearchMock).toHaveBeenCalledWith("1009"));
  });

  it("does not pre-seed free text that is not an order number", () => {
    setDetail(
      makeDetail({
        auditEvent: {
          id: 5,
          actionType: "INVENTORY_DEDUCT",
          createdAt: "2026-08-20T10:00:00.000Z",
          orderReference: "the blue box on the shelf",
          label: "from the audit event (free text, admin-visible on /admin/logs)",
        },
      }),
    );

    renderPicker(makeRow());

    expect(screen.getByLabelText(/order number/i)).toHaveValue("");
  });

  it("says the bound out loud when the search hit its ceiling", async () => {
    const user = userEvent.setup();
    setSearch([ORDER_1009], 7);
    renderPicker(makeRow());

    await user.type(screen.getByLabelText(/order number/i), "10");
    await waitFor(() =>
      expect(screen.getByTestId("order-search-more")).toHaveTextContent(
        "≤ 20 results — narrow the number",
      ),
    );
  });

  it("an R2b batch is LOCKED to the order its fulfillment already named", () => {
    renderPicker(
      makeRow({ attributeLock: { orderRecordId: "ord-9", reason: "r2b-completion" } }),
    );

    const input = screen.getByLabelText(/order number/i);
    expect(input).toHaveAttribute("readonly");
    expect(input).toHaveValue("ord-9");
    expect(screen.getByTestId("attribute-lock-copy")).toHaveTextContent(
      "this batch was fulfilled against #ord-9 — you can complete that stamp, not change it",
    );
    // A locked target is not searched for: the lock names an id, and the search
    // reads order NUMBERS.
    expect(useOrderSearchMock).toHaveBeenCalledWith("");
  });
});

describe("the confirm", () => {
  it("says what it cannot compute instead of showing an empty overlap", async () => {
    const user = userEvent.setup();
    renderPicker(makeRow());
    await pickOrder(user);

    expect(screen.getByTestId("confirm-overlap")).toHaveTextContent(
      "overlap cannot be computed — this page reads this order's item count (4), not its line items",
    );
  });

  it("names the row count and the target's internal status, and the attribution-only sentence", async () => {
    const user = userEvent.setup();
    renderPicker(makeRow());
    await pickOrder(user);

    expect(screen.getByTestId("confirm-scope")).toHaveTextContent(
      "Attributing 2 ledger rows to #1009 (internal status: PROCESSING).",
    );
    expect(screen.getByTestId("confirm-attribution-only")).toHaveTextContent(
      ATTRIBUTION_ONLY_SENTENCE,
    );
    expect(ATTRIBUTION_ONLY_SENTENCE).toBe(
      "This records attribution only — it does not stock out or fulfil the order.",
    );
  });

  it("sends the id the ROW DISPLAYED as expectPreviousOrderRecordId — null when unattributed", async () => {
    const user = userEvent.setup();
    renderPicker(makeRow());
    await pickOrder(user);

    await user.click(screen.getByRole("button", { name: /attribute this batch/i }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        orderRecordId: "ord-2",
        expectPreviousOrderRecordId: null,
      }),
    );
  });

  it("demands a reason iff the batch is already stamped, and sends it", async () => {
    const user = userEvent.setup();
    renderPicker(
      makeRow({
        order: {
          id: "ord-1",
          orderNumber: "1001",
          internalStatus: "PROCESSING",
          platform: "woocommerce",
          externalCreatedAt: null,
        },
      }),
    );
    await pickOrder(user);

    const submit = screen.getByRole("button", { name: /attribute this batch/i });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText(/reason/i), "the packer picked the wrong order");
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        orderRecordId: "ord-2",
        expectPreviousOrderRecordId: "ord-1",
        reason: "the packer picked the wrong order",
      }),
    );
  });

  it("asks for no reason on an unattributed batch", async () => {
    const user = userEvent.setup();
    renderPicker(makeRow());
    await pickOrder(user);

    expect(screen.queryByLabelText(/reason/i)).toBeNull();
    expect(screen.getByRole("button", { name: /attribute this batch/i })).toBeEnabled();
  });
});

describe("the refusals", () => {
  const REFUSALS: Array<{ code: string; message: string }> = [
    {
      code: "NOT_ATTRIBUTABLE",
      message:
        "This batch is not an attributable outbound batch (transfer, count, correction, positive adjust or a pre-lane mass update)",
    },
    {
      code: "TOO_MANY_ROWS",
      message:
        "This batch has 51 outbound rows across 12 products — above the 50-row manual attribution limit",
    },
    {
      code: "MIXED_STAMPS",
      message:
        "This batch's rows carry different order ids (2) — reported, never averaged; repair the ledger first",
    },
    {
      code: "FULFILLED_BATCH",
      message: "Fulfilled against #1009 — change it via unfulfill/refulfill, not here",
    },
    {
      code: "R2B_OTHER_TARGET",
      message:
        "This batch was fulfilled against another order (ord-9); a manual attribution may only complete that stamp",
    },
    { code: "CONFLICT", message: "the batch moved (updated 1 of 2 rows)" },
  ];

  it.each(REFUSALS)("renders the $code refusal verbatim", async ({ code, message }) => {
    const user = userEvent.setup();
    const err = Object.assign(new Error(message), { code, status: 409 });
    mutateAsync.mockRejectedValue(err);

    renderPicker(makeRow());
    await pickOrder(user);
    await user.click(screen.getByRole("button", { name: /attribute this batch/i }));

    await waitFor(() =>
      expect(screen.getByTestId("attribute-refusal")).toHaveTextContent(message),
    );
  });

  it("BATCH_MOVED closes the picker and says who moved it", async () => {
    const user = userEvent.setup();
    const err = Object.assign(
      new Error("Someone attributed this batch while you were looking (now ord-7) — refresh and try again"),
      { code: "BATCH_MOVED", status: 409, currentOrderRecordId: "ord-7" },
    );
    mutateAsync.mockRejectedValue(err);

    const onOpenChange = renderPicker(makeRow());
    await pickOrder(user);
    await user.click(screen.getByRole("button", { name: /attribute this batch/i }));

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "someone attributed this batch to #ord-7 while you were looking — refreshed",
      ),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
