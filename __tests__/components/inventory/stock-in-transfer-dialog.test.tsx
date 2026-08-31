/** @jest-environment jsdom */
//
// STOCK-IN TRANSFER DIALOG — the partial-success (207) branch
// (reconciliation Part 2, pack CB1b.6; spec REV-9 CX6-18).
//
// This dialog sends an `expectedVersion` per SOURCE location, and B1's prelock
// is what makes those versions bite: a concurrent commit that used to slip
// between the read and the write now loses, per transfer, with a 409 the batch
// route folds into a 207 envelope. The branch under contract here is what the
// operator sees when that happens:
//
//   the dialog STAYS OPEN · each failed source shows ITS OWN message, verbatim ·
//   availability and versions are re-read · succeeded rows go back to zero ·
//   failed rows keep what was asked for, re-clamped against the fresh read.
//
// A request-wide "partially completed, 1 failed" toast — which is what this
// branch used to say before closing the dialog — tells an operator neither
// which location refused nor what to do about it.

import * as React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));

const toastError = jest.fn();
const toastSuccess = jest.fn();
const toastWarning = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
  },
}));

import { StockInTransferDialog } from "@/components/inventory/stock-in-transfer-dialog";

const PRODUCT = {
  productId: 5,
  productName: "Widget A",
  quantity: 2,
  minQuantity: 10,
  shortage: 8,
};

/**
 * The two source locations, before anything moves. The dialog lists them by
 * available quantity, highest first — so row 0 is Warehouse, row 1 is Office.
 */
const LOCATIONS_BEFORE = [
  { locationId: 2, locationName: "Office", quantity: 20, version: 7 },
  { locationId: 3, locationName: "Warehouse", quantity: 30, version: 4 },
];

/**
 * After the partial success: Warehouse moved 5, and Office — which refused on a
 * version conflict — has been drained to 3 by whoever won that race. The list
 * order is unchanged, so the same rows are still in the same places.
 */
const LOCATIONS_AFTER = [
  { locationId: 2, locationName: "Office", quantity: 3, version: 9 },
  { locationId: 3, locationName: "Warehouse", quantity: 25, version: 5 },
];

let fetchMock: jest.Mock;
let locationsPayloads: Array<typeof LOCATIONS_BEFORE>;
let transferResponse: { status: number; body: unknown };

beforeEach(() => {
  toastError.mockClear();
  toastSuccess.mockClear();
  toastWarning.mockClear();
  locationsPayloads = [LOCATIONS_BEFORE, LOCATIONS_AFTER];
  transferResponse = { status: 200, body: { success: true, results: [], totalTransferred: 0 } };

  fetchMock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/locations")) {
      const payload = locationsPayloads.shift() ?? LOCATIONS_AFTER;
      return { ok: true, json: async () => ({ locations: payload }) } as unknown as Response;
    }
    return {
      ok: transferResponse.status === 200,
      status: transferResponse.status,
      json: async () => transferResponse.body,
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = jest.fn();
  const onSuccess = jest.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <StockInTransferDialog
        open
        onOpenChange={onOpenChange}
        product={PRODUCT}
        destinationLocationId={1}
        destinationLocationName="Main"
        onSuccess={onSuccess}
      />
    </QueryClientProvider>
  );
  return { onOpenChange, onSuccess };
}

/** The quantity input for a source row, by its position in the list. */
const quantityInputs = () => screen.getAllByPlaceholderText("0") as HTMLInputElement[];

async function askFor(user: ReturnType<typeof userEvent.setup>, values: number[]) {
  const inputs = quantityInputs();
  for (let i = 0; i < values.length; i++) {
    await user.clear(inputs[i]);
    await user.type(inputs[i], String(values[i]));
  }
}

describe("Stock-In transfer dialog — the 207 partial-success branch", () => {
  it("surfaces each FAILED transfer's own error, against its own source location", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    transferResponse = {
      status: 207,
      body: {
        success: false,
        totalTransferred: 5,
        batchId: "batch-1",
        results: [
          { fromLocationId: 3, quantity: 5, success: true, transferId: "t-1" },
          {
            fromLocationId: 2,
            quantity: 4,
            success: false,
            error: "Inventory was modified by another user",
          },
        ],
      },
    };
    renderDialog();
    await waitFor(() => expect(quantityInputs()).toHaveLength(2));

    await askFor(user, [5, 4]);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Stock In 9 units/ }));
    });

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The route's sentence, verbatim, named against the location that refused.
    expect(toastError).toHaveBeenCalledWith("Office: Inventory was modified by another user");
    // ...and never a request-wide failure when the other half moved stock.
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith(
      "Transferred 5 units of Widget A from 1 location"
    );
  });

  it("stays OPEN, re-reads the locations, and resets only the rows that succeeded", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    transferResponse = {
      status: 207,
      body: {
        success: false,
        totalTransferred: 5,
        batchId: "batch-1",
        results: [
          { fromLocationId: 3, quantity: 5, success: true, transferId: "t-1" },
          {
            fromLocationId: 2,
            quantity: 4,
            success: false,
            error: "Inventory was modified by another user",
          },
        ],
      },
    };
    const { onOpenChange, onSuccess } = renderDialog();
    await waitFor(() => expect(quantityInputs()).toHaveLength(2));

    await askFor(user, [5, 4]);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Stock In 9 units/ }));
    });

    await waitFor(() => expect(toastError).toHaveBeenCalled());

    // The dialog is NOT dismissed — the failed row is the retry.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The caller still refreshes: stock DID move.
    expect(onSuccess).toHaveBeenCalled();

    // The locations read ran twice: once on mount, once after the partial.
    const locationCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/locations"));
    expect(locationCalls).toHaveLength(2);

    await waitFor(() => {
      const inputs = quantityInputs();
      // Warehouse succeeded -> back to zero (an empty input is 0 here).
      expect(inputs[0].value).toBe("");
      // Office failed -> keeps what was asked for, RE-CLAMPED to the 3 units the
      // refreshed read says are actually there.
      expect(inputs[1].value).toBe("3");
    });
  });

  it("a fully successful transfer still closes and never shows a per-transfer error", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    transferResponse = {
      status: 200,
      body: {
        success: true,
        totalTransferred: 5,
        batchId: "batch-1",
        results: [{ fromLocationId: 3, quantity: 5, success: true, transferId: "t-1" }],
      },
    };
    const { onOpenChange } = renderDialog();
    await waitFor(() => expect(quantityInputs()).toHaveLength(2));

    await askFor(user, [5]);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Stock In 5 units/ }));
    });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("Stock-In transfer dialog — the versions it submits", () => {
  it("sends the version it READ per source location (what the prelock now enforces)", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    transferResponse = {
      status: 200,
      body: {
        success: true,
        totalTransferred: 5,
        batchId: "batch-1",
        results: [{ fromLocationId: 3, quantity: 5, success: true }],
      },
    };
    renderDialog();
    await waitFor(() => expect(quantityInputs()).toHaveLength(2));

    await askFor(user, [5]);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /Stock In 5 units/ }));
    });

    const transferCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/inventory/transfer/batch")
    );
    expect(transferCall).toBeDefined();
    expect(JSON.parse((transferCall![1] as RequestInit).body as string)).toEqual({
      productId: 5,
      toLocationId: 1,
      transfers: [{ fromLocationId: 3, quantity: 5, expectedVersion: 4 }],
    });
  });
});
