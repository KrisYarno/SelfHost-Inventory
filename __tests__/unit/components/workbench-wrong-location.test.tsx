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
const mockToastWarning = jest.fn();
jest.mock("sonner", () => {
  const toast = (...args: unknown[]) => mockToast(...args);
  toast.error = jest.fn();
  toast.success = jest.fn();
  toast.info = jest.fn();
  toast.warning = (...args: unknown[]) => mockToastWarning(...args);
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
/** When set, the move request REJECTS with this instead of answering (CB2.5e.4). */
let moveRejection: unknown | null;

function response(a: Answer): Response {
  return {
    ok: a.status >= 200 && a.status < 300,
    status: a.status,
    json: async () => a.body,
  } as unknown as Response;
}

/** The options sonner was handed by the LAST `toast()` call (F15). */
function lastToastOptions(): { id?: string; duration?: number } {
  const call = mockToast.mock.calls[mockToast.mock.calls.length - 1];
  return (call?.[1] ?? {}) as { id?: string; duration?: number };
}

/** The node of the LAST `toast()` call — what sonner is rendering under that id. */
function lastToastNode(): React.ReactElement {
  return mockToast.mock.calls[mockToast.mock.calls.length - 1][0] as React.ReactElement;
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
  mockToastWarning.mockClear();
  moveRejection = null;
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
    if (href.includes("/move")) {
      // CB2.5e.4: a MOCKED fetch never reads the signal, so the abort is staged
      // as the rejection `AbortSignal.timeout` actually produces.
      if (moveRejection !== null) throw moveRejection;
      return response(moveAnswer);
    }
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

  // F1 (OC-1) REPLACES the old "dismisses before opening" pin. Dismissing the
  // completion toast on OPEN destroyed the Undo for anyone who then cancelled or
  // was refused: the toast is the only place the Undo lives, and there is no way
  // back to it. So the dismissal waits for the move to RESOLVE. While the dialog
  // is open the toast stays behind it, running its own 10 s clock — stated, and
  // the right side of the trade.
  it("opening the dialog does NOT dismiss the completion toast", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });

    expect(mockToastDismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("move-dialog-location")).toBeInTheDocument();
    // Still MOUNTED, behind the page-level modal — `getByRole` cannot see it
    // while Radix has `aria-hidden` on the rest of the document, which is
    // exactly the stated posture: the toast sits behind the dialog.
    expect(screen.getByText("Undo")).toBeInTheDocument();
  });

  // F15: DISMISSAL WAS NEVER THE ONLY CLOCK. The toast sitting behind the dialog
  // kept running its own 10 s, so a slow decision — or a late refusal — lost the
  // Undo just as surely as the old dismiss-on-open did. Opening the dialog
  // RE-ISSUES the completion toast under its own id with no clock at all; the
  // decision hands a fresh 10 s back, or dismisses it.
  it("opening the dialog HOLDS the toast open — re-issued under its id with no clock", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: 10000 });

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });

    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: Infinity });
    expect(mockToastDismiss).not.toHaveBeenCalled();
  });

  it("CANCELLING hands a fresh 10 s back, and the re-issued Undo still works", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const toastRender = await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    const heldOpen = mockToast.mock.calls.length;
    await act(async () => {
      await user.keyboard("{Escape}");
    });

    // A NEW issue under the same id — not the one the completion raised.
    expect(mockToast.mock.calls.length).toBeGreaterThan(heldOpen);
    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: 10000 });
    expect(mockToastDismiss).not.toHaveBeenCalled();

    // Sonner replaces the node under that id, so the RE-ISSUED toast is the one
    // the operator is now looking at — and its Undo is a real Undo.
    toastRender.unmount();
    render(<>{lastToastNode()}</>);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Undo/ }));
    });
    await waitFor(() => expect(callsTo("/reverse")).toHaveLength(1));
  });

  it("a REFUSED move hands the 10 s window back too", async () => {
    moveAnswer = {
      status: 409,
      body: {
        error: "This batch has already been put back (3 units)",
        code: "BATCH_RESTORED",
        restoredUnits: 3,
      },
    };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    const heldOpen = mockToast.mock.calls.length;
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("move-dialog-refusal")).toBeInTheDocument(),
    );

    expect(mockToast.mock.calls.length).toBeGreaterThan(heldOpen);
    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: 10000 });
    expect(mockToastDismiss).not.toHaveBeenCalled();
  });

  it("CANCELLING leaves the Undo reachable — nothing was dismissed", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await act(async () => {
      await user.keyboard("{Escape}");
    });

    expect(screen.queryByTestId("move-dialog-location")).toBeNull();
    expect(mockToastDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Undo/ })).toBeInTheDocument();
    expect(callsTo("/move")).toHaveLength(0);
    // The Undo still WORKS: clicking it reverses, exactly as it would have
    // before the dialog was ever opened.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Undo/ }));
    });
    await waitFor(() => expect(callsTo("/reverse")).toHaveLength(1));
  });

  it("a CONFIRMED move dismisses the completion toast — the decision is made", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() => expect(callsTo("/move")).toHaveLength(1));

    await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith("undo-ORD-1"));
    // F19: EXACTLY once — and never re-issued afterwards. Closing the dialog on
    // a settled move must not bring a dismissed Undo back for a move that has
    // already happened.
    expect(mockToastDismiss).toHaveBeenCalledTimes(1);
    const issuedSoFar = mockToast.mock.calls.length;
    await act(async () => {
      await user.keyboard("{Escape}");
    });
    expect(mockToast.mock.calls).toHaveLength(issuedSoFar);
  });

  it("a REFUSED move leaves the Undo standing", async () => {
    moveAnswer = {
      status: 409,
      body: {
        error: "This batch has already been put back (3 units)",
        code: "BATCH_RESTORED",
        restoredUnits: 3,
      },
    };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("move-dialog-refusal")).toBeInTheDocument(),
    );

    expect(mockToastDismiss).not.toHaveBeenCalled();
    expect(screen.getByText("Undo")).toBeInTheDocument();
  });

  // F13 (GX-8): the workbench always hands over an ORDER reference.
  it("heads the dialog with `Order …` — the workbench's ref is the order's", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });

    expect(
      screen.getByText("Order ORD-1 — where did this stock actually leave from?"),
    ).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// F25 (QA-3): THE HELD-OPEN TOAST DOES NOT OUTLIVE THE PAGE.
//
// Opening the dialog re-issues the completion toast with `duration: Infinity`,
// and sonner's provider lives in the app shell — so navigating away mid-decision
// left an Undo on screen with no clock at all, wired to callbacks belonging to a
// tree React had already thrown away. The page takes its toast with it.
// ---------------------------------------------------------------------------

describe("the workbench toast — unmount takes the live Undo with it (F25)", () => {
  /** Render the page and complete an order, handing back BOTH render results. */
  async function completeOnMountedPage(args: CompletionArgs = completion()) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const page = render(
      <QueryClientProvider client={queryClient}>
        <WorkbenchPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(completionProps.onSuccess).toBeDefined());
    await act(async () => {
      completionProps.onSuccess!(args);
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalled());
    render(<>{lastToastNode()}</>);
    return page;
  }

  it("unmounting with the move dialog OPEN dismisses the held-open toast", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const page = await completeOnMountedPage();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    // No clock at all — sonner would never retire this one on its own.
    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: Infinity });
    expect(mockToastDismiss).not.toHaveBeenCalled();

    await act(async () => {
      page.unmount();
    });

    expect(mockToastDismiss).toHaveBeenCalledWith("undo-ORD-1");
  });

  it("unmounting with NOTHING open dismisses nothing", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const page = render(
      <QueryClientProvider client={queryClient}>
        <WorkbenchPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(completionProps.onSuccess).toBeDefined());

    await act(async () => {
      page.unmount();
    });

    expect(mockToastDismiss).not.toHaveBeenCalled();
  });

  // A SETTLED move already dismissed the toast and nulled the closure, so the
  // cleanup has nothing left to do — a second dismiss would be a dismissal of
  // whatever sonner is showing under that id NEXT.
  it("unmounting after a CONFIRMED move dismisses exactly once, not twice", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const page = await completeOnMountedPage();

    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() => expect(mockToastDismiss).toHaveBeenCalledWith("undo-ORD-1"));

    await act(async () => {
      page.unmount();
    });

    expect(mockToastDismiss).toHaveBeenCalledTimes(1);
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

// ---------------------------------------------------------------------------
// CB2.5e.4 — the caller TIMES OUT, and says so honestly
// ---------------------------------------------------------------------------

const TIMEOUT_SENTENCE =
  "The move did not answer in time — check the batch before trying again";
const TIMEOUT_WARNING =
  "The move's outcome is unknown — check the batch in Admin → Reconciliation";

describe("the workbench move — the 60 s timeout (CB2.5e.4)", () => {
  async function timeOutAMove() {
    moveRejection = new DOMException("timeout", "TimeoutError");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() => expect(screen.getByTestId("move-dialog-refusal")).toBeInTheDocument());
    return user;
  }

  async function confirmAMove() {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() => expect(callsTo("/move")).toHaveLength(1));
  }

  it("the request carries an abort signal — the 60 s clock the server never gets to run past", async () => {
    await confirmAMove();
    const [, init] = callsTo("/move")[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("an ABORT renders the timeout sentence — never a bare 'could not be completed'", async () => {
    await timeOutAMove();

    expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(TIMEOUT_SENTENCE);
    expect(callsTo("/move")).toHaveLength(1);
  });

  // The latch is the dialog's, released by the request's own `finally` — a
  // timeout that left it held would freeze the dialog on a decision the
  // operator now has to make again somewhere else.
  it("the LATCH releases: the select and the confirm come back", async () => {
    await timeOutAMove();

    expect(screen.getByTestId("move-dialog-location")).not.toBeDisabled();
    expect(screen.getByTestId("move-dialog-confirm")).not.toBeDisabled();
  });

  // B25-G3-8: the move MAY have committed. An Undo re-armed here would restore
  // at a location the toast never named, so the toast goes and a warning says
  // where to look instead.
  it("DISMISSES the Undo toast and warns — it does NOT re-arm the 10 s window", async () => {
    await timeOutAMove();

    expect(mockToastDismiss).toHaveBeenCalledWith("undo-ORD-1");
    expect(mockToastWarning).toHaveBeenCalledWith(TIMEOUT_WARNING);
    // NOT re-armed: the last toast issued is the held-open one from opening the
    // dialog (no clock), never a fresh 10 s.
    expect(lastToastOptions().duration).not.toBe(10000);
  });

  // The contrast that makes the arm above meaningful: a REFUSAL still hands the
  // 10 s back, because a refused batch never moved.
  it("a REFUSAL is untouched by this — it still hands the 10 s back and warns nothing", async () => {
    moveAnswer = {
      status: 409,
      body: { error: "This batch spans 2 locations (3, 7) and cannot be moved as one", code: "MULTI_LOCATION" },
    };
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() => expect(screen.getByTestId("move-dialog-refusal")).toBeInTheDocument());

    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: 10000 });
    expect(mockToastDismiss).not.toHaveBeenCalled();
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  // A dead network is NOT a timeout: it keeps today's behaviour (the Undo comes
  // back), because nothing was ever sent.
  it("a TIMEOUT invalidates the inventory caches — the move MAY have committed (the seam check)", async () => {
    const spy = jest.spyOn(QueryClient.prototype, "invalidateQueries");
    try {
      await timeOutAMove();
      const roots = spy.mock.calls.map(([arg]) => {
        const key = (arg as { queryKey?: unknown } | undefined)?.queryKey;
        return Array.isArray(key) ? key[0] : undefined;
      });
      expect(roots).toContain("product-location-quantity");
    } finally {
      spy.mockRestore();
    }
  });

  it("a plain network failure is not relabelled TIMEOUT", async () => {
    moveRejection = new TypeError("Failed to fetch");
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await completeAndShowToast();
    await act(async () => {
      await user.click(screen.getByTestId("wrong-location-ORD-1"));
    });
    await user.selectOptions(screen.getByTestId("move-dialog-location"), "2");
    await user.click(screen.getByTestId("move-dialog-confirm"));
    await waitFor(() => expect(screen.getByTestId("move-dialog-refusal")).toBeInTheDocument());

    expect(screen.getByTestId("move-dialog-refusal")).toHaveTextContent(
      "The move could not be completed.",
    );
    expect(mockToastWarning).not.toHaveBeenCalled();
    expect(lastToastOptions()).toMatchObject({ id: "undo-ORD-1", duration: 10000 });
  });
});
