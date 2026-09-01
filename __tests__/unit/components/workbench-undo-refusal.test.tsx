/** @jest-environment jsdom */
//
// THE WORKBENCH UNDO'S REFUSAL COPY (reconciliation Part 2, pack REV-22 F7).
//
// The Undo toast fires N restore calls (unfulfill for the WC lines, adjust for
// the manual ones) and, until now, said exactly one thing when any of them
// failed: "Some items could not be restored. Check inventory manually." — with
// the response body read by nobody.
//
// B1 gave those routes named refusals: `ORDER_GONE` when the order vanished
// under the operator, `TOO_MANY_KEYS` when the restoration set is too wide to
// lock in one request, `INSUFFICIENT_STOCK` when the stock has moved. The
// operator can act on each of those. They can act on "check inventory
// manually" only by hand.
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

const COMPLETION = {
  orderReference: "ORD-1",
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
  externalOrderId: "ord-1",
} as unknown as CompletionArgs;

let fetchMock: jest.Mock;
let undoResponse: { status: number; body: unknown };

beforeEach(() => {
  mockToast.mockClear();
  mockToastError.mockClear();
  mockToastSuccess.mockClear();
  mockToastWarning.mockClear();
  completionProps = {};
  // The REAL unfulfill answers with the restored[] array (QB-4: the success
  // toast now counts it instead of trusting the request size).
  undoResponse = { status: 200, body: { success: true, restored: [{ itemId: "fi-1" }] } };

  fetchMock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/unfulfill") || href.includes("/api/inventory/adjust")) {
      return {
        ok: undoResponse.status >= 200 && undoResponse.status < 300,
        status: undoResponse.status,
        json: async () => undoResponse.body,
      } as unknown as Response;
    }
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
async function completeThenUndo(user: ReturnType<typeof userEvent.setup>) {
  renderWorkbench();
  await waitFor(() => expect(completionProps.onSuccess).toBeDefined());
  await act(async () => {
    completionProps.onSuccess!(COMPLETION);
  });

  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  const undoToast = mockToast.mock.calls[0][0] as React.ReactElement;
  render(<>{undoToast}</>);
  await act(async () => {
    await user.click(screen.getByRole("button", { name: /Undo/ }));
  });
}

describe("workbench undo — a failed restore says what the server said", () => {
  it("surfaces the ORDER_GONE copy instead of 'check inventory manually'", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    undoResponse = {
      status: 409,
      // Flat, straight out of `apiHandler`.
      body: { error: "order ord-1 no longer exists", code: "ORDER_GONE" },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored: this order no longer exists — refresh and re-check"
    );
  });

  it("passes the TOO_MANY_KEYS split-it sentence through verbatim", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    undoResponse = {
      status: 400,
      body: { error: "too many restorations in one request — split it", code: "TOO_MANY_KEYS" },
    };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored: too many restorations in one request — split it"
    );
  });

  it("keeps the old sentence when the body explains nothing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    undoResponse = { status: 500, body: {} };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError).toHaveBeenCalledWith(
      "Some items could not be restored. Check inventory manually."
    );
  });

  it("still reports a clean undo as a success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Undone: 1 item restored for order ORD-1"
    );
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("QB-4: a 200 that restored NOTHING warns instead of claiming success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    undoResponse = { status: 200, body: { success: true, restored: [], skipped: [{ itemId: "fi-1" }] } };

    await completeThenUndo(user);

    await waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
    expect(String(mockToastWarning.mock.calls[0][0])).toContain("Nothing was restored");
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });
});
