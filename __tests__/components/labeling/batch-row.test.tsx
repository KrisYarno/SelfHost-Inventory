/** @jest-environment jsdom */
/**
 * THE SHARED BATCH ROW (contract pack C4b.0, seam S21; spec §4.3.2-3).
 *
 * One control books labeled units, and it is mounted in two places — the order
 * detail's fast path (M4b) and the labeling queue (M5). It exists once because
 * the three rules below are the kind that survive being written once and rot
 * being written twice:
 *
 *   1. THE QUANTITY IS TYPED, ALWAYS. The field is EMPTY on every new attempt
 *      and is never seeded from `remaining` or `verified` — a pre-filled count
 *      is a count nobody made (G1s-2, SURVIVE-1).
 *   2. THE TOAST REPORTS THE PERSISTED BATCH. What the server says it stored,
 *      not what was typed — which is the only way a REPLAY can say "already
 *      stocked N" truthfully.
 *   3. D-COST IS THE SERVER'S CALL. The prompt opens only on a successful,
 *      NON-replayed result carrying a `costPrompt`; the server's
 *      `stockedBefore === 0` rule is the once-per-line authority, so there is no
 *      client-side "already shown" flag to get out of step with it.
 */

import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, "x-csrf-token": "t" }),
}));

let sessionUser: Record<string, unknown> | null = { id: 7, defaultLocationId: null };
jest.mock("next-auth/react", () => ({
  useSession: () => ({ data: sessionUser ? { user: sessionUser } : null, status: "authenticated" }),
}));

const toastError = jest.fn();
const toastSuccess = jest.fn();
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: jest.fn(),
  },
}));

import { BatchRow } from "@/components/labeling/batch-row";

const ORDER_ID = "cksupply000000000000000001";
const LINE_ID = 4242;
const LOCATIONS = [
  { id: 1, name: "Main" },
  { id: 2, name: "Cold room" },
];

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});

let mintedUuids = 0;
const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  sessionUser = { id: 7, defaultLocationId: null };
  global.fetch = mockFetch as unknown as typeof fetch;
  window.sessionStorage.clear();
  mintedUuids = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => `booking-key-${++mintedUuids}` },
  });
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A BookingResult + the refreshed line, exactly as M3b's stock-in returns it. */
function bookingResult(over: Record<string, unknown> = {}, batch: Record<string, unknown> = {}) {
  return {
    lineId: LINE_ID,
    status: "LABELING",
    stockedQuantity: 3,
    disposedQuantity: 0,
    remaining: 4,
    batch: {
      quantity: 3,
      locationId: 1,
      unitCostCents: 1250,
      receiptCostCents: 3750,
      replayed: false,
      ...batch,
    },
    productId: 55,
    approvalStatus: "APPROVED",
    costPrompt: null,
    line: { id: LINE_ID },
    ...over,
  };
}

function renderRow(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onStocked = jest.fn();
  // A FRESH element every time: React bails out of a re-render when the element
  // is referentially identical, and these tests re-render precisely to let an
  // asynchronous session land.
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <BatchRow
        orderId={ORDER_ID}
        lineId={LINE_ID}
        remaining={7}
        priorLocationId={null}
        locations={LOCATIONS}
        onStocked={onStocked}
        {...props}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(tree());
  return { onStocked, queryClient, rerender: () => rerender(tree()) };
}

const quantityField = () => screen.getByLabelText(/quantity/i) as HTMLInputElement;
const stockInWrites = () =>
  mockFetch.mock.calls.filter(([url]) => String(url).includes("/stock-in"));

// ---------------------------------------------------------------------------
// Rule 1 — the count is typed
// ---------------------------------------------------------------------------

describe("the quantity field", () => {
  it("is EMPTY on mount — never seeded from remaining", () => {
    renderRow({ remaining: 7 });
    expect(quantityField().value).toBe("");
    expect(screen.queryByDisplayValue("7")).not.toBeInTheDocument();
  });

  it("is EMPTY again after a booking — every attempt is typed afresh", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(jsonResponse(200, bookingResult()));
    renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "3");
    await user.click(screen.getByRole("button", { name: /stock 3 labeled units/i }));

    await waitFor(() => expect(quantityField().value).toBe(""));
  });

  it("names the TYPED quantity on the button", async () => {
    const user = userEvent.setup();
    renderRow({ priorLocationId: 1 });
    await user.type(quantityField(), "12");
    expect(screen.getByRole("button", { name: /stock 12 labeled units/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// The default location
// ---------------------------------------------------------------------------

describe("the default location", () => {
  it("uses the line's own location when the line has one (the next-batch default)", () => {
    renderRow({ priorLocationId: 2 });
    expect(screen.getByRole("combobox", { name: /location/i })).toHaveTextContent("Cold room");
  });

  it("falls back to the operator's default location", () => {
    sessionUser = { id: 7, defaultLocationId: 1 };
    renderRow({ priorLocationId: null });
    expect(screen.getByRole("combobox", { name: /location/i })).toHaveTextContent("Main");
  });

  it("ADOPTS the default once the session resolves (REV-10 clause 10)", () => {
    // The session is asynchronous; the row mounts before it lands. Reading the
    // default only at mount left the operator with an empty select and a
    // disabled button for no reason they could see.
    sessionUser = null;
    const { rerender } = renderRow({ priorLocationId: null });
    expect(screen.getByRole("combobox", { name: /location/i })).not.toHaveTextContent("Main");

    sessionUser = { id: 7, defaultLocationId: 1 };
    rerender();

    expect(screen.getByRole("combobox", { name: /location/i })).toHaveTextContent("Main");
  });

  it("NEVER overwrites a location the operator picked", async () => {
    const user = userEvent.setup();
    sessionUser = null;
    const { rerender } = renderRow({ priorLocationId: null });

    await user.click(screen.getByRole("combobox", { name: /location/i }));
    await user.click(await screen.findByRole("option", { name: "Cold room" }));

    sessionUser = { id: 7, defaultLocationId: 1 };
    rerender();

    expect(screen.getByRole("combobox", { name: /location/i })).toHaveTextContent("Cold room");
  });

  it("stays UNSELECTED when there is neither, and refuses to book", async () => {
    const user = userEvent.setup();
    sessionUser = { id: 7, defaultLocationId: null };
    renderRow({ priorLocationId: null });

    await user.type(quantityField(), "2");
    expect(screen.getByRole("button", { name: /stock 2 labeled units/i })).toBeDisabled();
    expect(stockInWrites()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — the toast reports the persisted batch
// ---------------------------------------------------------------------------

describe("booking", () => {
  it("posts the batch and reports the SERVER's quantity and location", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonResponse(200, bookingResult({}, { quantity: 3, locationId: 2 })),
    );
    const { onStocked } = renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "4");
    await user.type(screen.getByLabelText(/note/i), "bench run");
    await user.click(screen.getByRole("button", { name: /stock 4 labeled units/i }));

    await waitFor(() => expect(stockInWrites()).toHaveLength(1));
    const body = JSON.parse(String(stockInWrites()[0][1].body));
    expect(body).toMatchObject({ quantity: 4, locationId: 1, note: "bench run" });
    expect(typeof body.bookingKey).toBe("string");
    expect(String(stockInWrites()[0][0])).toContain(
      `/api/inbound-shipments/${ORDER_ID}/lines/${LINE_ID}/stock-in`,
    );

    // The server said 3 at location 2; the typed 4 at location 1 is not the truth.
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls[0][0])).toBe("Stocked 3 at Cold room");
    expect(onStocked).toHaveBeenCalled();
  });

  it("says a REPLAY was not repeated, using the persisted batch", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonResponse(
        200,
        bookingResult({ costPrompt: null }, { quantity: 5, locationId: 1, replayed: true }),
      ),
    );
    renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "5");
    await user.click(screen.getByRole("button", { name: /stock 5 labeled units/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(String(toastSuccess.mock.calls[0][0])).toBe(
      "Already stocked 5 at Main — not repeated",
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — D-COST
// ---------------------------------------------------------------------------

describe("the cost prompt", () => {
  const prompt = { productId: 55, currentCents: 1000, receiptCents: 1250 };

  it("opens on a successful NON-replayed result and writes through the product PUT", async () => {
    const user = userEvent.setup();
    mockFetch.mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes("/stock-in")) {
        return jsonResponse(200, bookingResult({ costPrompt: prompt }));
      }
      return jsonResponse(200, { id: 55 });
    });
    renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "3");
    await user.click(screen.getByRole("button", { name: /stock 3 labeled units/i }));

    const dialog = await screen.findByTestId("cost-prompt");
    expect(dialog).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /update product cost/i }));

    await waitFor(() => {
      const puts = mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(puts).toHaveLength(1);
      expect(String(puts[0][0])).toContain("/api/products/55");
      expect(JSON.parse(String((puts[0][1] as RequestInit).body))).toEqual({ costPrice: 12.5 });
    });
  });

  it("KEEPS the current cost without writing anything", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(jsonResponse(200, bookingResult({ costPrompt: prompt })));
    renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "3");
    await user.click(screen.getByRole("button", { name: /stock 3 labeled units/i }));

    await screen.findByTestId("cost-prompt");
    await user.click(screen.getByRole("button", { name: /keep current cost/i }));

    await waitFor(() => expect(screen.queryByTestId("cost-prompt")).not.toBeInTheDocument());
    expect(
      mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      ),
    ).toHaveLength(0);
  });

  it("NEVER opens on a replay, even when a prompt rides along", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonResponse(200, bookingResult({ costPrompt: prompt }, { replayed: true })),
    );
    renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "3");
    await user.click(screen.getByRole("button", { name: /stock 3 labeled units/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(screen.queryByTestId("cost-prompt")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The 409 UX (C4b.4)
// ---------------------------------------------------------------------------

describe("a refused batch", () => {
  it("shows the server's sentence VERBATIM and never resubmits by itself", async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValue(
      jsonResponse(409, {
        error:
          "Only 2 unit(s) remain on this line (10 verified, 7 stocked, 1 disposed); 5 were requested",
        code: "CEILING",
        stocked: 7,
        disposed: 1,
        verified: 10,
        requested: 5,
      }),
    );
    renderRow({ priorLocationId: 1 });

    await user.type(quantityField(), "5");
    await user.click(screen.getByRole("button", { name: /stock 5 labeled units/i }));

    expect(
      await screen.findByText(
        "Only 2 unit(s) remain on this line (10 verified, 7 stocked, 1 disposed); 5 were requested",
      ),
    ).toBeInTheDocument();
    expect(stockInWrites()).toHaveLength(1);
  });
});
