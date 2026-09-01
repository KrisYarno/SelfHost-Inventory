/** @jest-environment jsdom */
//
// THE JOURNAL PAGE — the request cap and the 409 recovery
// (reconciliation Part 2, pack REV-22 F4 / F5 / F7).
//
// Two operator traps this page carried into B1, and both are about a cart that
// is PERSISTED across page loads:
//
//   F4 — `/api/inventory/batch-adjust` takes at most 100 adjustments (and the
//        prelock caps the key set for the same reason). The cart had no limit,
//        so 140 counted rows met the cap as a 400 that refused ALL of them.
//
//   F5 — every cart row carries the product version it was typed against. On a
//        409 the page refetched the PRODUCTS but never told the CART, so the
//        retry re-sent the same losing `expectedVersion` — a 409 loop whose
//        only exit was discarding the operator's counting.
//
// The store is the REAL zustand store and the dialog is the REAL dialog, so
// these pins cover the page -> store -> dialog seam, not just a renderer.

import * as React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { id: "u-1", name: "Kris" } }, status: "authenticated" }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("@/contexts/location-context", () => ({
  useLocation: () => ({ selectedLocationId: 1, locations: [{ id: 1, name: "Main" }] }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "test-csrf", isLoading: false, error: null, refreshToken: jest.fn() }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "test-csrf" }),
}));

const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: jest.fn(),
    info: jest.fn(),
  },
}));

import JournalPage from "@/app/(app)/journal/page";
import { useJournalStore } from "@/hooks/use-journal";

const PRODUCTS = [
  {
    id: 1,
    name: "Widget A",
    baseName: null,
    variant: null,
    unit: "EA",
    numericValue: null,
    quantity: 10,
    location: 1,
    lowStockThreshold: 5,
    deletedAt: null,
    approvalStatus: "APPROVED",
  },
];

/** The version `/api/inventory/current-fast` is currently answering with. */
let liveVersion = 3;
/** Queued answers for the batch-adjust POST, oldest first. */
let batchResponses: Array<{ status: number; body: unknown }>;
let fetchMock: jest.Mock;

beforeEach(() => {
  toastError.mockClear();
  toastSuccess.mockClear();
  liveVersion = 3;
  batchResponses = [];
  useJournalStore.getState().clearAllAdjustments();

  fetchMock = jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.includes("/api/products")) {
      return { ok: true, json: async () => ({ products: PRODUCTS }) } as unknown as Response;
    }
    if (href.includes("/api/inventory/current-fast")) {
      return {
        ok: true,
        json: async () => ({ inventory: [{ productId: 1, quantity: 10, version: liveVersion }] }),
      } as unknown as Response;
    }
    if (href.includes("/api/settings/low-stock-default")) {
      return { ok: true, json: async () => ({ threshold: 10 }) } as unknown as Response;
    }
    if (href.includes("/api/inventory/batch-adjust")) {
      const answer = batchResponses.shift() ?? { status: 500, body: { error: "unqueued" } };
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
      } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function renderJournal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <JournalPage />
    </QueryClientProvider>
  );
}

/** Every batch-adjust request body this test has sent, in order. */
const submittedBatches = () =>
  fetchMock.mock.calls
    .filter((c) => String(c[0]).includes("/api/inventory/batch-adjust"))
    .map((c) => JSON.parse((c[1] as RequestInit).body as string));

async function openReviewAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await act(async () => {
    await user.click(screen.getByRole("button", { name: /Review & Submit/ }));
  });
  await act(async () => {
    await user.click(screen.getByRole("button", { name: /confirm and submit adjustments/i }));
  });
}

describe("Journal page — the 409 recovery re-seeds the persisted cart (F5)", () => {
  it("retries with the version the refetch returned, keeping the quantity", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    useJournalStore.getState().addAdjustment({ productId: 1, quantityChange: 5, version: 3 });

    batchResponses = [
      // The flat 409 `apiHandler` actually emits.
      {
        status: 409,
        body: {
          error: "Inventory was modified by another user",
          code: "OPTIMISTIC_LOCK_ERROR",
          currentVersion: 4,
          expectedVersion: 3,
        },
      },
      { status: 200, body: { logs: [{ id: 1 }] } },
    ];

    renderJournal();
    await waitFor(() => expect(screen.getAllByText("Widget A").length).toBeGreaterThan(0));

    // Whoever won the race left version 4 behind.
    liveVersion = 4;
    await openReviewAndConfirm(user);

    // The first attempt sent the version the row was typed against.
    await waitFor(() => expect(submittedBatches()).toHaveLength(1));
    expect(submittedBatches()[0].adjustments[0]).toEqual({
      productId: 1,
      locationId: 1,
      delta: 5,
      expectedVersion: 3,
    });
    expect(toastError).toHaveBeenCalled();

    // The refresh runs on a 1s delay, and the CART is re-seeded from it.
    await waitFor(
      () => expect(useJournalStore.getState().adjustments[1].version).toBe(4),
      { timeout: 4000 }
    );
    // The operator's count is their intent — it is never touched.
    expect(useJournalStore.getState().adjustments[1].quantityChange).toBe(5);

    // ...so the retry is no longer the same losing request.
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /confirm and submit adjustments/i }));
    });
    await waitFor(() => expect(submittedBatches()).toHaveLength(2));
    expect(submittedBatches()[1].adjustments[0]).toEqual({
      productId: 1,
      locationId: 1,
      delta: 5,
      expectedVersion: 4,
    });
    expect(toastSuccess).toHaveBeenCalledWith("Successfully submitted 1 adjustments");
  }, 15000);
});

describe("Journal page — the request cap is on screen before it bites (F4)", () => {
  it("says nothing while the cart is small", async () => {
    useJournalStore.getState().addAdjustment({ productId: 1, quantityChange: 5, version: 3 });
    renderJournal();

    await waitFor(() => expect(screen.getByText("1 products")).toBeInTheDocument());
    expect(screen.queryByText(/of 100 items/)).not.toBeInTheDocument();
    expect(screen.queryByText(/at most 100 items per request/)).not.toBeInTheDocument();
  });

  it("counts the cart against the cap from 81 on, and says how to fix 101", async () => {
    const store = useJournalStore.getState();
    for (let id = 1; id <= 81; id++) {
      store.addAdjustment({ productId: id, quantityChange: 1, version: 1 });
    }
    renderJournal();

    await waitFor(() => expect(screen.getByText("81 of 100 items")).toBeInTheDocument());
    expect(screen.queryByText(/at most 100 items per request/)).not.toBeInTheDocument();

    await act(async () => {
      for (let id = 82; id <= 101; id++) {
        useJournalStore.getState().addAdjustment({ productId: id, quantityChange: 1, version: 1 });
      }
    });

    await waitFor(() => expect(screen.getByText("101 of 100 items")).toBeInTheDocument());
    expect(
      screen.getByText("at most 100 items per request — split this batch")
    ).toBeInTheDocument();
  });
});

describe("Journal page — a refusal says what the SERVER said (F7)", () => {
  it("shows the flat INSUFFICIENT_STOCK sentence instead of a generic failure", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    // -5 against the 10 on screen: the dialog is happy, the SERVER is not — the
    // stock drained under the operator between the read and the submit.
    useJournalStore.getState().addAdjustment({ productId: 1, quantityChange: -5, version: 3 });

    batchResponses = [
      {
        status: 400,
        body: {
          error: "Product 1: Insufficient inventory: current 0, trying to remove 5",
          code: "INSUFFICIENT_STOCK",
        },
      },
    ];

    renderJournal();
    await waitFor(() => expect(screen.getAllByText("Widget A").length).toBeGreaterThan(0));
    await openReviewAndConfirm(user);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The toast body is JSX; render it and read the copy the operator gets.
    const body = toastError.mock.calls[0][0] as React.ReactElement;
    render(<>{body}</>);
    expect(
      screen.getByText("Product 1: Insufficient inventory: current 0, trying to remove 5")
    ).toBeInTheDocument();
  });

  it("carries a FLAT body's code through, so a 400 is titled as one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    useJournalStore.getState().addAdjustment({ productId: 1, quantityChange: 5, version: 3 });

    // What the route answers when the request itself is malformed or over a
    // maximum — flat, with the code beside the sentence. The old reader only
    // understood the NESTED shape, so it threw away this code and every flat
    // refusal came out as the same "Something went wrong".
    batchResponses = [
      {
        status: 400,
        body: { error: "at most 100 items per request", code: "VALIDATION_ERROR" },
      },
    ];

    renderJournal();
    await waitFor(() => expect(screen.getAllByText("Widget A").length).toBeGreaterThan(0));
    await openReviewAndConfirm(user);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const body = toastError.mock.calls[0][0] as React.ReactElement;
    render(<>{body}</>);
    expect(screen.getByText("Invalid Input")).toBeInTheDocument();
    expect(screen.getByText("at most 100 items per request")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});
