/** @jest-environment jsdom */
//
// THE WORKBENCH'S ONE-TAP MOVE (reconciliation Part 2, pack CB2c.4; spec §2.6).
//
// Seconds after a cart goes out at the wrong location, the completion toast is
// where the operator still remembers what actually happened — so the toast is
// where the fix is offered. Four things are pinned here, and they are the four
// ways this control could go wrong:
//
//   1. THE DIALOG OUTLIVES THE TOAST. Sonner unmounts its node at 10 s. A dialog
//      rendered inside that node would vanish mid-decision, so it is mounted at
//      PAGE level and the toast only sets page state.
//   2. ONE POST, FOR THE MANUAL BATCH (PK-1). A mixed cart wrote two batches and
//      only the deduct-simple one is movable; the fulfilment half gets a
//      sentence and no request.
//   3. NO CONTROL WHOSE ONLY OUTCOME IS A DEAD DIALOG (OC-1). A WC-only cart
//      shows no button — it shows where that repair actually lives.
//   4. THE REFUSAL IS THE SERVER'S (F7). Verbatim, numbers and all.
//
// The harness reaches the toast the way the app does: the completion dialog's
// `onSuccess` raises it, and the toast's own button is clicked.

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

/** The location context, per test — `selectedLocationId` can be null. */
let locationContext: { selectedLocationId: number | null; selectedLocation: { name: string } | null };
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => locationContext,
}));
jest.mock("@/hooks/use-locations", () => ({
  useLocations: () => ({
    data: [
      { id: 1, name: "Main" },
      { id: 2, name: "Overflow" },
    ],
    isLoading: false,
  }),
}));
jest.mock("@/hooks/use-inventory-products", () => ({
  useInventoryProducts: () => ({ data: [], isLoading: false, refetch: jest.fn() }),
}));
jest.mock("@/hooks/use-low-stock-default", () => ({ useLowStockDefault: () => 10 }));

const mockToast = jest.fn();
const mockToastDismiss = jest.fn();
jest.mock("sonner", () => {
  const toast = (...args: unknown[]) => mockToast(...args);
  toast.error = jest.fn();
  toast.success = jest.fn();
  toast.info = jest.fn();
  toast.warning = jest.fn();
  toast.message = jest.fn();
  toast.dismiss = (...args: unknown[]) => mockToastDismiss(...args);
  return { toast };
});

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
jest.mock("@/components/workbench/wc-order-selector", () => ({ WCOrderSelector: () => null }));
jest.mock("@/components/workbench/order-queue", () => ({ OrderQueue: () => null }));

import WorkbenchPage from "@/app/(app)/workbench/page";
import { MOVE_ORDER_LEG_SENTENCE } from "@/components/workbench/move-batch-dialog";

const MANUAL_BATCH = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const FULFIL_BATCH = "9a1b7c22-1111-4d3d-8a0c-0305e82c3399";

/** One WC line (2) and one manual line (3) — the mixed cart the legs split. */
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
    batchIds: { deductSimpleBatchId: MANUAL_BATCH, fulfilBatchId: FULFIL_BATCH },
    fulfilledForUndo: [{ itemId: "fi-1", productId: 501, quantity: 2, locationId: 1 }],
    externalOrderId: "ord-1",
    ...over,
  } as unknown as CompletionArgs;
}

type Answer = { status: number; body: unknown };

let fetchMock: jest.Mock;
let moveAnswer: Answer;

function response(a: Answer): Response {
  return {
    ok: a.status >= 200 && a.status < 300,
    status: a.status,
    json: async () => a.body,
  } as unknown as Response;
}

/** Every request the page made to a fragment, in order. */
function callsTo(fragment: string): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls
    .map(
      (call) => [String(call[0]), call[1] as RequestInit | undefined] as [string, RequestInit | undefined],
    )
    .filter(([url]) => url.includes(fragment));
}

beforeEach(() => {
  mockToast.mockClear();
  mockToastDismiss.mockClear();
  completionProps = {};
  locationContext = { selectedLocationId: 1, selectedLocation: { name: "Main" } };
  moveAnswer = {
    status: 200,
    body: {
      movedBatchId: MANUAL_BATCH,
      batchId: "new-batch",
      orderRecordId: null,
      ledgerLocationId: 1,
      physicalLocationId: 2,
      pairs: [{ productId: 777, units: 3, transferId: "t-1" }],
      rows: [
        { productId: 777, locationId: 2, delta: -3 },
        { productId: 777, locationId: 1, delta: 3 },
      ],
      message: "moved 3 units from location 1 to 2",
    },
  };

  fetchMock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/move")) return response(moveAnswer);
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** Complete an order and render the toast the page raised for it. */
async function completeAndShowToast(args: CompletionArgs = completion()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <WorkbenchPage />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(completionProps.onSuccess).toBeDefined());
  await act(async () => {
    completionProps.onSuccess!(args);
  });
  await waitFor(() => expect(mockToast).toHaveBeenCalled());
  // The toast node is a React element the page built; sonner is mocked, so it is
  // rendered here — separately from the page, exactly as sonner would.
  const toastNode = mockToast.mock.calls[0][0] as React.ReactElement;
  return render(<>{toastNode}</>);
}

describe("the workbench toast — the Wrong location control", () => {
  it("renders beside Undo for a cart with a manual batch and a chosen location", async () => {
    await completeAndShowToast();
    expect(screen.getByTestId("wrong-location-ORD-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Undo/ })).toBeInTheDocument();
  });

  it("is ABSENT for a WC-only cart, which carries the order-leg sentence inline instead", async () => {
    await completeAndShowToast(
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
        batchIds: { deductSimpleBatchId: null, fulfilBatchId: FULFIL_BATCH },
      } as unknown as Partial<CompletionArgs>),
    );

    expect(screen.queryByTestId("wrong-location-ORD-1")).toBeNull();
    expect(screen.getByTestId("order-leg-only-ORD-1")).toHaveTextContent(
      MOVE_ORDER_LEG_SENTENCE,
    );
  });

  it("is ABSENT with no location selected — there is no ledger end to move FROM", async () => {
    locationContext = { selectedLocationId: null, selectedLocation: null };
    await completeAndShowToast();
    expect(screen.queryByTestId("wrong-location-ORD-1")).toBeNull();
  });

  it("dismisses the completion toast before opening the dialog (R7-16)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });

    expect(mockToastDismiss).toHaveBeenCalledWith("undo-ORD-1");
    expect(screen.getByTestId("move-dialog-location")).toBeInTheDocument();
  });

  it("the dialog is mounted at PAGE level — it survives the toast node unmounting", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const toastRender = await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    expect(screen.getByTestId("move-dialog-location")).toBeInTheDocument();

    // Sonner's 10-second unmount, simulated exactly: the node goes, the dialog
    // stays, because the dialog was never inside it.
    toastRender.unmount();
    expect(screen.getByTestId("move-dialog-location")).toBeInTheDocument();
  });
});

describe("the workbench move — ONE POST, for the manual batch (PK-1)", () => {
  async function openAndConfirm(args: CompletionArgs = completion()) {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast(args);
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    // The request settles inside `waitFor`'s act scope, never between two.
    await waitFor(() => expect(callsTo("/move")).toHaveLength(1));
    return user;
  }

  it("a MIXED cart posts once, to the DEDUCT-SIMPLE batch, and never to the fulfil one", async () => {
    await openAndConfirm();

    const moves = callsTo("/move");
    expect(moves).toHaveLength(1);
    expect(moves[0][0]).toBe(`/api/inventory/batches/${MANUAL_BATCH}/move`);
    expect(moves[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(moves[0][1]?.body))).toEqual({ physicalLocationId: 2 });
    expect(callsTo(FULFIL_BATCH)).toHaveLength(0);
  });

  it("the dialog carries the order-leg sentence for the fulfil half, with no request", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });

    expect(screen.getByTestId("move-result-order")).toHaveTextContent(MOVE_ORDER_LEG_SENTENCE);
    expect(callsTo("/move")).toHaveLength(0);
  });

  it("a MANUAL-ONLY cart posts once and shows no order-leg line", async () => {
    await openAndConfirm(
      completion({
        items: [{ productId: 777, productName: "Manual Widget", quantity: 3, locationId: 1 }],
        batchIds: { deductSimpleBatchId: MANUAL_BATCH, fulfilBatchId: null },
        fulfilledForUndo: [],
        externalOrderId: undefined,
      } as unknown as Partial<CompletionArgs>),
    );

    expect(callsTo("/move")).toHaveLength(1);
    expect(screen.queryByTestId("move-result-order")).toBeNull();
  });

  it("the result line prints the SERVER's units — the toast's own figure is the ASKED one", async () => {
    await openAndConfirm();

    // The manual leg ASKED for 3 (one line of 3); the server answered with 3 in
    // `pairs`, and it is the SERVER's number the line reads.
    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "Moves this batch's books (3 units asked) from Main to the chosen location",
    );
    await waitFor(() =>
      expect(screen.getByTestId("move-result-manual")).toHaveTextContent(
        "manual leg: moved 3 units",
      ),
    );
  });

  it("names the ledger location by NAME, falling back to its id when the context has none", async () => {
    locationContext = { selectedLocationId: 1, selectedLocation: null };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });

    expect(screen.getByTestId("move-consequence")).toHaveTextContent(
      "from Location 1 to the chosen location",
    );
  });

  it("a REFUSAL renders the server's own sentence, and nothing is claimed to have moved", async () => {
    moveAnswer = {
      status: 409,
      body: {
        error:
          "This batch has already been put back (3 units) — it can no longer be re-attributed or moved",
        code: "BATCH_RESTORED",
        restoredUnits: 3,
      },
    };
    await openAndConfirm();

    await waitFor(() =>
      expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(
        "This batch has already been put back (3 units)",
      ),
    );
    expect(screen.queryByTestId("move-result-manual")).toBeNull();
  });
});
