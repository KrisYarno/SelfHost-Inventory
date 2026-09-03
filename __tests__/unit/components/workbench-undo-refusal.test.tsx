/** @jest-environment jsdom */
//
// THE WORKBENCH UNDO (reconciliation Part 2, pack CB2b.3; spec §2.5).
//
// Two things are pinned here, and they are the two ways this toast could lie.
//
//   1. THE MANUAL LEG IS ONE REVERSE. It used to be N positive `/api/inventory/adjust`
//      calls that named nothing they were undoing — no link to the batch, no
//      bound on restoring the same units twice, and a report that read them as
//      fresh corrections. From B2b it is ONE POST to the batch's own reverse
//      route, and the adjust writer is GONE (pinned by its absence).
//
//   2. THE WC BODY COMES FROM THE FULFIL ENVELOPE. `fulfilledForUndo` is built
//      from `results.fulfilled` and from nothing else, so a clamped line is
//      restored at the number the SERVER moved, and a line the envelope never
//      named is left out of the body and NAMED in the toast — never completed
//      from the cart, which would restore units out of another fulfilment.
//
// Plus the F7 rule the file was originally written for: a refusal is rendered
// with the server's own sentence, per leg, never "check inventory manually".
//
// The harness reaches the undo the way the app does: the completion dialog's
// `onSuccess` raises the Undo toast, and the toast's own button is clicked.

import * as React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 1, locations: [{ id: 1, name: "Main" }] }),
}));
jest.mock("@/hooks/use-inventory-products", () => ({
  useInventoryProducts: () => ({ data: [], isLoading: false, refetch: jest.fn() }),
}));
jest.mock("@/hooks/use-low-stock-default", () => ({ useLowStockDefault: () => 10 }));

// F14 (GX-9): the Undo moves stock through a RAW FETCH, so nothing in
// react-query knows the books changed unless this page says so.
const invalidateInventoryCachesMock = jest.fn();
jest.mock("@/hooks/use-inventory-mutations", () => ({
  ...jest.requireActual("@/hooks/use-inventory-mutations"),
  invalidateInventoryCaches: (...args: unknown[]) => invalidateInventoryCachesMock(...args),
}));

const mockToast = jest.fn();
const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastWarning = jest.fn();
jest.mock("sonner", () => {
  const toast = (...args: unknown[]) => mockToast(...args);
  toast.error = (...args: unknown[]) => mockToastError(...args);
  toast.success = (...args: unknown[]) => mockToastSuccess(...args);
  toast.info = jest.fn();
  toast.warning = (...args: unknown[]) => mockToastWarning(...args);
  toast.message = jest.fn();
  toast.dismiss = jest.fn();
  return { toast };
});

// The completion dialog is the seam this test enters through: capture its props
// so `onSuccess` can be fired with a completion the page then offers to undo.
type CompletionArgs = Parameters<
  NonNullable<React.ComponentProps<typeof import("@/components/workbench/complete-order-dialog").CompleteOrderDialog>["onSuccess"]>
>[0];
let completionProps: { onSuccess?: (args: CompletionArgs) => void } = {};
jest.mock("@/components/workbench/complete-order-dialog", () => ({
  CompleteOrderDialog: (props: { onSuccess?: (args: unknown) => void }) => {
    completionProps = props as { onSuccess?: (args: CompletionArgs) => void };
    return null;
  },
}));
jest.mock("@/components/workbench/wc-order-selector", () => ({
  WCOrderSelector: () => null,
}));
jest.mock("@/components/workbench/order-queue", () => ({ OrderQueue: () => null }));

import WorkbenchPage from "@/app/(app)/workbench/page";

const MANUAL_BATCH = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** One WC line and one manual line — the mixed cart the two legs split. */
function completion(over: Partial<CompletionArgs> = {}): CompletionArgs {
  return {
    orderReference: "ORD-1",
    items: [
      {
        productId: 501,
        productName: "Widget In Stock",
        quantity: 2,
        locationId: 1,
        fulfillmentItemId: "fi-1",
      },
      { productId: 777, productName: "Manual Widget", quantity: 3, locationId: 1 },
    ],
    batchIds: { deductSimpleBatchId: MANUAL_BATCH, fulfilBatchId: "fulfil-1" },
    fulfilledForUndo: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
    externalOrderId: "ord-1",
    ...over,
  } as unknown as CompletionArgs;
}

type Answer = { status: number; body: unknown };

let fetchMock: jest.Mock;
let reverseAnswer: Answer;
let unfulfillAnswer: Answer;

function answer(a: Answer): Response {
  return {
    ok: a.status >= 200 && a.status < 300,
    status: a.status,
    json: async () => a.body,
  } as unknown as Response;
}

/** Every request the undo made, in order. */
function callsTo(fragment: string): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls
    .map((call) => [String(call[0]), call[1] as RequestInit | undefined] as [string, RequestInit | undefined])
    .filter(([url]) => url.includes(fragment));
}

function bodyOf(call: [string, RequestInit | undefined]): Record<string, unknown> {
  return JSON.parse(String(call[1]?.body ?? "{}")) as Record<string, unknown>;
}

beforeEach(() => {
  invalidateInventoryCachesMock.mockClear();
  mockToast.mockClear();
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
  mockToastWarning.mockClear();
  completionProps = {};
  reverseAnswer = {
    status: 200,
    body: {
      reversedBatchId: MANUAL_BATCH,
      batchId: "new-batch",
      restoredUnits: 3,
      previouslyRestored: 0,
      totalUnits: 3,
      message: "reversed 3 of 3 units",
    },
  };
  // The REAL unfulfill answers with the restored[] array (QB-4: the toast counts
  // it instead of trusting the request size).
  unfulfillAnswer = { status: 200, body: { success: true, restored: [{ itemId: "fi-1" }] } };

  fetchMock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/reverse")) return answer(reverseAnswer);
    if (href.includes("/unfulfill")) return answer(unfulfillAnswer);
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderWorkbench() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkbenchPage />
    </QueryClientProvider>
  );
}

/** Complete an order, then press the Undo the page offers for it. */
async function completeThenUndo(
  user: ReturnType<typeof userEvent.setup>,
  args: CompletionArgs = completion()
) {
  renderWorkbench();
  await waitFor(() => expect(completionProps.onSuccess).toBeDefined());
  await act(async () => {
    completionProps.onSuccess!(args);
  });

  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  const undoToast = mockToast.mock.calls[0][0] as React.ReactElement;
  render(<>{undoToast}</>);
  await act(async () => {
    await user.click(screen.getByRole("button", { name: /Undo/ }));
  });
}

// ---------------------------------------------------------------------------
// THE ONE-REVERSE WRITER
// ---------------------------------------------------------------------------

describe("workbench undo — the manual leg is ONE reverse", () => {
  it("a MIXED cart makes exactly one reverse POST and one unfulfill POST, and ZERO adjusts", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(user);

    const reverses = callsTo("/reverse");
    expect(reverses).toHaveLength(1);
    expect(reverses[0][0]).toBe(`/api/inventory/batches/${MANUAL_BATCH}/reverse`);
    expect(reverses[0][1]?.method).toBe("POST");
    expect(callsTo("/unfulfill")).toHaveLength(1);
    // The N-adjust writer is GONE, not kept as a fallback.
    expect(callsTo("/api/inventory/adjust")).toHaveLength(0);
  });

  it("a MANUAL-ONLY cart makes one reverse and no unfulfill", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(
      user,
      completion({
        items: [{ productId: 777, productName: "Manual Widget", quantity: 3, locationId: 1 }],
        batchIds: { deductSimpleBatchId: MANUAL_BATCH, fulfilBatchId: null },
        fulfilledForUndo: [],
        externalOrderId: undefined,
      } as unknown as Partial<CompletionArgs>)
    );

    expect(callsTo("/reverse")).toHaveLength(1);
    expect(callsTo("/unfulfill")).toHaveLength(0);
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Undone for order ORD-1: 3 units restored",
      expect.objectContaining({ id: "undo-manual-ORD-1" })
    );
  });

  it("a WC-ONLY cart makes one unfulfill and no reverse", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(
      user,
      completion({
        items: [
          {
            productId: 501,
            productName: "Widget In Stock",
            quantity: 2,
            locationId: 1,
            fulfillmentItemId: "fi-1",
          },
        ],
        batchIds: { deductSimpleBatchId: null, fulfilBatchId: "fulfil-1" },
      } as unknown as Partial<CompletionArgs>)
    );

    expect(callsTo("/reverse")).toHaveLength(0);
    expect(callsTo("/unfulfill")).toHaveLength(1);
  });

  it("TWO toasts, never one joined sentence — units for the manual leg, lines for the WC one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(user);

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(2));
    const said = mockToastSuccess.mock.calls.map((call) => call[0]);
    expect(said).toContain("Undone for order ORD-1: 3 units restored");
    expect(said).toContain("Order ORD-1: 1 order line put back.");
    const ids = mockToastSuccess.mock.calls.map((call) => call[1]?.id);
    expect(ids.sort()).toEqual(["undo-manual-ORD-1", "undo-wc-ORD-1"]);
  });

  it("an impossible null batch id with manual lines gets its OWN sentence, not the QB-4 one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await completeThenUndo(
      user,
      completion({
        batchIds: { deductSimpleBatchId: null, fulfilBatchId: "fulfil-1" },
      } as unknown as Partial<CompletionArgs>)
    );

    expect(callsTo("/reverse")).toHaveLength(0);
    expect(mockToastError).toHaveBeenCalledWith(
      "Order ORD-1 could not be undone: the completion did not name the batch it wrote. Adjust inventory manually.",
      expect.objectContaining({ id: "undo-manual-ORD-1" })
    );
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// THE WC BODY
// ---------------------------------------------------------------------------

describe("workbench undo — the WC body is the fulfil envelope's", () => {
  it("posts `fulfilledForUndo` item for item — the REQUEST BODY, not a type token", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(user);

    expect(bodyOf(callsTo("/unfulfill")[0])).toEqual({
      items: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
    });
  });

  it("a CLAMPED line is restored at the SERVER's number, never the cart's", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(
      user,
      completion({
        items: [
          {
            productId: 501,
            productName: "Widget",
            quantity: 5, // the cart ASKED for five
            locationId: 1,
            fulfillmentItemId: "fi-1",
          },
        ],
        // the server MOVED two
        fulfilledForUndo: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
        batchIds: { deductSimpleBatchId: null, fulfilBatchId: "fulfil-1" },
      } as unknown as Partial<CompletionArgs>)
    );

    expect(bodyOf(callsTo("/unfulfill")[0])).toEqual({
      items: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
    });
  });

  it("a line with NO entry is ABSENT from the body and NAMED in the toast", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(
      user,
      completion({
        items: [
          {
            productId: 501,
            productName: "Widget",
            quantity: 2,
            locationId: 1,
            fulfillmentItemId: "fi-1",
          },
          {
            productId: 502,
            productName: "Unnamed",
            quantity: 4,
            locationId: 1,
            fulfillmentItemId: "fi-2",
          },
        ],
        fulfilledForUndo: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
        batchIds: { deductSimpleBatchId: null, fulfilBatchId: "fulfil-1" },
      } as unknown as Partial<CompletionArgs>)
    );

    const body = bodyOf(callsTo("/unfulfill")[0]);
    expect(body).toEqual({
      items: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
    });
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Order ORD-1: 1 order line put back. 1 line(s) were not restored — the fulfil response never named them.",
      expect.objectContaining({ id: "undo-wc-ORD-1" })
    );
  });

  it("an EMPTY fulfilledForUndo with WC lines makes NO request and says the reason", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    await completeThenUndo(
      user,
      completion({
        fulfilledForUndo: [],
        batchIds: { deductSimpleBatchId: null, fulfilBatchId: "fulfil-1" },
      } as unknown as Partial<CompletionArgs>)
    );

    expect(callsTo("/unfulfill")).toHaveLength(0);
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Nothing was restored for order ORD-1 — the fulfil response never named the lines it deducted.",
      expect.objectContaining({ id: "undo-wc-ORD-1" })
    );
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// THE REFUSALS (pack REV-22 F7)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F14 (GX-9): THE CACHES ARE TOLD WHEN, AND ONLY WHEN, STOCK MOVED
// ---------------------------------------------------------------------------

describe("workbench undo — the react-query caches after a moved-stock undo", () => {
  it("invalidates the inventory caches once stock has actually gone back", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(user);

    await waitFor(() => expect(invalidateInventoryCachesMock).toHaveBeenCalledTimes(1));
  });

  it("does NOT invalidate when BOTH legs refused — nothing moved", async () => {
    reverseAnswer = {
      status: 409,
      body: { error: "This batch was already reversed", code: "ALREADY_REVERSED" },
    };
    unfulfillAnswer = { status: 409, body: { error: "already restored" } };

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeThenUndo(user);

    await waitFor(() => expect(callsTo("/reverse")).toHaveLength(1));
    expect(invalidateInventoryCachesMock).not.toHaveBeenCalled();
  });
});

describe("workbench undo — a failed restore says what the server said", () => {
  it("surfaces the ORDER_GONE copy instead of 'check inventory manually'", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    unfulfillAnswer = {
      status: 409,
      // Flat, straight out of `apiHandler`.
      body: { error: "order ord-1 no longer exists", code: "ORDER_GONE" },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored: this order no longer exists — refresh and re-check",
      expect.objectContaining({ id: "undo-wc-ORD-1" })
    );
  });

  it("passes the TOO_MANY_KEYS split-it sentence through verbatim", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    unfulfillAnswer = {
      status: 400,
      body: { error: "too many restorations in one request — split it", code: "TOO_MANY_KEYS" },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored: too many restorations in one request — split it",
      expect.objectContaining({ id: "undo-wc-ORD-1" })
    );
  });

  it("keeps the old sentence when the body explains nothing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    unfulfillAnswer = { status: 500, body: {} };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored. Check inventory manually.",
      expect.objectContaining({ id: "undo-wc-ORD-1" })
    );
  });

  it("the reverse's TOO_MANY_ROWS rides through verbatim, on the MANUAL toast", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    reverseAnswer = {
      status: 409,
      body: {
        error:
          "This batch has 5100 rows across 12 products — above the 50-row limit for a reverse",
        code: "TOO_MANY_ROWS",
        rowCount: 5100,
        productCount: 12,
        limit: 50,
      },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored: This batch has 5100 rows across 12 products — above the 50-row limit for a reverse",
      expect.objectContaining({ id: "undo-manual-ORD-1" })
    );
    // The WC leg answered anyway — the two are independent.
    expect(callsTo("/unfulfill")).toHaveLength(1);
  });

  it("ALREADY_REVERSED warns with the SERVER's numbers, never a success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    reverseAnswer = {
      status: 409,
      body: {
        error: "This batch was already reversed — 4 of 10 units were put back",
        code: "ALREADY_REVERSED",
        previouslyRestored: 4,
        totalUnits: 10,
      },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Order ORD-1 was already reversed — 4 of 10 units were put back earlier.",
      expect.objectContaining({ id: "undo-manual-ORD-1" })
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("QB-4: a WC 200 that restored NOTHING warns instead of claiming success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    unfulfillAnswer = {
      status: 200,
      body: { success: true, restored: [], skipped: [{ itemId: "fi-1" }] },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Nothing was restored for order ORD-1 — the items were already reversed or changed by someone else.",
      expect.objectContaining({ id: "undo-wc-ORD-1" })
    );
  });

  it("still reports a clean undo as a success on both legs", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(2));
    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });
});
