/** @jest-environment jsdom */
/**
 * THE ORDER LOOKUP (reconciliation Part 2, pack CB3b-ii.1b + § P2-B3-1, B3-1b).
 *
 * The adjust dialog's type-ahead over the order search. What is pinned:
 *
 *   1. ONE HOOK, ONE KEY. The lookup reads through the SAME `useOrderSearch`
 *      the Attribute… picker uses (its leaf module), so the two surfaces share
 *      a cache key and an `enabled` rule — never a second spelling.
 *   2. THE DEBOUNCE. 250 ms, the picker's idiom: keystrokes inside the window
 *      never reach the hook.
 *   3. WHAT A ROW SAYS. `orderNumber · platform · status · N items`, and the
 *      number WITHOUT a `#` (the reference field beside it refuses `#`).
 *   4. THREE DIFFERENT EMPTINESSES. "and N more", the route's `note` for a
 *      member's empty answer (pack row 94) vs the picker's own sentence, and a
 *      FAILED search said as a failure — never an empty list.
 *   5. PICK AND CLEAR.
 *
 * The hook module is mocked (the attribute-flow idiom); the key pin lets the
 * REAL hook through the mock, under a real QueryClient.
 */

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const useOrderSearchMock = jest.fn();
jest.mock("@/hooks/use-order-search", () => ({
  useOrderSearch: (q: string) => useOrderSearchMock(q),
}));

import {
  ORDER_LOOKUP_EMPTY_SENTENCE,
  ORDER_LOOKUP_ERROR_SENTENCE,
  ORDER_LOOKUP_RATE_LIMITED_SENTENCE,
  ORDER_LOOKUP_SEARCHING_SENTENCE,
  OrderLookup,
  type PickedOrder,
} from "@/components/inventory/order-lookup";
import { ORDER_REFERENCE_HINT } from "@/lib/orders/order-reference-shape";

const ORDER_1009 = {
  id: "ord-2",
  orderNumber: "1009",
  platform: "woocommerce",
  internalStatus: "PROCESSING",
  externalCreatedAt: "2026-08-19T09:00:00.000Z",
  itemCount: 4,
};

function setSearch(answer: {
  data?: { orders: Array<typeof ORDER_1009>; moreCount: number; note?: string };
  isError?: boolean;
  error?: { status?: number } | null;
}) {
  useOrderSearchMock.mockReturnValue({
    data: answer.data,
    isError: answer.isError ?? false,
    error: answer.error ?? null,
    isLoading: false,
  });
}

/** The REAL hook through the mock, under a real QueryClient (the key pin's idiom). */
function renderWithRealHook(client: QueryClient) {
  const actual = jest.requireActual("@/hooks/use-order-search") as {
    useOrderSearch: (q: string) => unknown;
  };
  useOrderSearchMock.mockImplementation((q: string) => actual.useOrderSearch(q));
  return render(
    <QueryClientProvider client={client}>
      <Host />
    </QueryClientProvider>,
  );
}

/** A host that owns the value, as the dialog does. */
function Host({ onChange, disabled }: { onChange?: (next: PickedOrder | null) => void; disabled?: boolean }) {
  const [value, setValue] = React.useState<PickedOrder | null>(null);
  return (
    <OrderLookup
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      disabled={disabled}
    />
  );
}

const lookupInput = () => screen.getByLabelText("Find the order");

beforeEach(() => {
  jest.clearAllMocks();
  useOrderSearchMock.mockReset();
  setSearch({ data: undefined });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("one shared hook, one key", () => {
  it("the REAL hook runs under the admin search key and asks the widened route", async () => {
    const actual = jest.requireActual("@/hooks/use-order-search") as {
      useOrderSearch: (q: string) => unknown;
    };
    useOrderSearchMock.mockImplementation((q: string) => actual.useOrderSearch(q));
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ orders: [ORDER_1009], moreCount: 0 }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>,
    );
    fireEvent.change(lookupInput(), { target: { value: "1009" } });

    await waitFor(() => expect(screen.getByTestId("order-lookup-result-ord-2")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/reconciliation/orders/search?q=1009");
    expect(
      client.getQueryCache().find({ queryKey: ["admin", "reconciliation", "orders", "1009"], exact: true }),
    ).toBeDefined();
  });

  it("an untouched lookup asks with an empty query (the hook's disabled state)", () => {
    render(<Host />);
    expect(useOrderSearchMock).toHaveBeenCalled();
    for (const call of useOrderSearchMock.mock.calls) expect(call[0]).toBe("");
  });
});

describe("the 250 ms debounce", () => {
  it("keystrokes inside the window never reach the hook; the last one does at 250 ms", () => {
    jest.useFakeTimers();
    render(<Host />);

    fireEvent.change(lookupInput(), { target: { value: "1" } });
    act(() => jest.advanceTimersByTime(100));
    fireEvent.change(lookupInput(), { target: { value: "10" } });
    act(() => jest.advanceTimersByTime(100));
    fireEvent.change(lookupInput(), { target: { value: "1009" } });

    act(() => jest.advanceTimersByTime(249));
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("");

    act(() => jest.advanceTimersByTime(1));
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("1009");

    const asked = useOrderSearchMock.mock.calls.map((call) => call[0]);
    expect(asked).not.toContain("1");
    expect(asked).not.toContain("10");
  });
});

describe("what the rows say", () => {
  it("orderNumber · platform · status · N items — with no `#`", () => {
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0 } });
    render(<Host />);

    const row = screen.getByTestId("order-lookup-result-ord-2");
    expect(row).toHaveTextContent("1009 · woocommerce · PROCESSING · 4 items");
    expect(row.textContent).not.toContain("#");
  });

  it('says what the ceiling left off: "and N more — narrow the search"', () => {
    setSearch({ data: { orders: [ORDER_1009], moreCount: 7 } });
    render(<Host />);

    expect(screen.getByTestId("order-lookup-more")).toHaveTextContent(
      "and 7 more — narrow the search",
    );
  });

  it("no more-line when nothing was left off", () => {
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0 } });
    render(<Host />);

    expect(screen.queryByTestId("order-lookup-more")).toBeNull();
    expect(screen.queryByTestId("order-lookup-empty")).toBeNull();
  });
});

describe("the empty answers", () => {
  it("renders the route's `note` when it sent one (a member's empty answer)", () => {
    setSearch({
      data: { orders: [], moreCount: 0, note: "no order matching that number in your companies" },
    });
    render(<Host />);

    expect(screen.getByTestId("order-lookup-empty")).toHaveTextContent(
      "no order matching that number in your companies",
    );
    expect(screen.queryByText(ORDER_LOOKUP_EMPTY_SENTENCE)).toBeNull();
  });

  it("falls back to the picker's own sentence when there is no note", () => {
    setSearch({ data: { orders: [], moreCount: 0 } });
    render(<Host />);

    expect(ORDER_LOOKUP_EMPTY_SENTENCE).toBe("No order number starts with what you typed.");
    expect(screen.getByTestId("order-lookup-empty")).toHaveTextContent(
      "No order number starts with what you typed.",
    );
  });

  it("a FAILED search is said as a failure — never an empty list that reads as no orders", () => {
    setSearch({ data: { orders: [], moreCount: 0 }, isError: true });
    render(<Host />);

    expect(screen.getByRole("alert")).toHaveTextContent(ORDER_LOOKUP_ERROR_SENTENCE);
    expect(ORDER_LOOKUP_ERROR_SENTENCE).toBe("Could not search orders — try again.");
    expect(screen.queryByTestId("order-lookup-empty")).toBeNull();
    expect(screen.queryByText(ORDER_LOOKUP_EMPTY_SENTENCE)).toBeNull();
  });

  it("nothing asked yet renders no answer at all", () => {
    render(<Host />);
    expect(screen.queryByTestId("order-lookup-empty")).toBeNull();
    expect(screen.queryByTestId("order-lookup-error")).toBeNull();
  });

  it("a 429 says it was too many searches — never the generic failure (B3-1 FR1, OC-4)", () => {
    setSearch({ isError: true, error: { status: 429 } });
    render(<Host />);

    expect(ORDER_LOOKUP_RATE_LIMITED_SENTENCE).toBe(
      "Too many searches just now — wait a minute, or type the order number instead.",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /^Too many searches just now — wait a minute, or type the order number instead\.$/,
    );
    expect(screen.queryByText(ORDER_LOOKUP_ERROR_SENTENCE)).toBeNull();
  });

  it("every other failure keeps the generic sentence", () => {
    setSearch({ isError: true, error: { status: 500 } });
    render(<Host />);

    expect(screen.getByRole("alert")).toHaveTextContent(/^Could not search orders — try again\.$/);
    expect(screen.queryByText(ORDER_LOOKUP_RATE_LIMITED_SENTENCE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B3-1 FR1 (OC-7): the shape check comes BEFORE the search. A query that is not
// an order number gets the reference field's hint and is never asked — "no
// order matching that number" would be a false answer to a malformed question.
// ---------------------------------------------------------------------------

describe("the shape check comes first", () => {
  const NOTE = "no order matching that number in your companies";

  it.each([
    ["rows", { orders: [ORDER_1009], moreCount: 3 }],
    ["an empty answer with a note", { orders: [], moreCount: 0, note: NOTE }],
  ])(
    "`#4521` -> the hint, NO search, and nothing else rendered (the hook would answer %s)",
    (_label, data) => {
      jest.useFakeTimers();
      useOrderSearchMock.mockReturnValue({ data, isError: false, error: null, isLoading: false });
      render(<Host />);
      useOrderSearchMock.mockClear();

      fireEvent.change(lookupInput(), { target: { value: "#4521" } });
      act(() => jest.advanceTimersByTime(250));

      expect(ORDER_REFERENCE_HINT).toBe("digits only, without #");
      const hint = screen.getByText(ORDER_REFERENCE_HINT);
      expect(hint).toHaveClass("text-[11px]", "text-destructive");
      expect(lookupInput()).toHaveAttribute("aria-invalid", "true");
      expect(lookupInput()).toHaveAttribute("aria-describedby", hint.id);

      // The hook was only ever handed its disabled state.
      expect(useOrderSearchMock).toHaveBeenCalled();
      for (const call of useOrderSearchMock.mock.calls) expect(call[0]).toBe("");

      expect(screen.queryByTestId("order-lookup-result-ord-2")).toBeNull();
      expect(screen.queryByTestId("order-lookup-more")).toBeNull();
      expect(screen.queryByTestId("order-lookup-empty")).toBeNull();
      expect(screen.queryByText(NOTE)).toBeNull();
      expect(screen.queryByText(ORDER_LOOKUP_EMPTY_SENTENCE)).toBeNull();
    },
  );

  it("`4521` -> a search, and no hint", () => {
    jest.useFakeTimers();
    render(<Host />);

    fireEvent.change(lookupInput(), { target: { value: "4521" } });
    act(() => jest.advanceTimersByTime(250));

    expect(useOrderSearchMock).toHaveBeenLastCalledWith("4521");
    expect(screen.queryByText(ORDER_REFERENCE_HINT)).toBeNull();
    expect(lookupInput()).toHaveAttribute("aria-invalid", "false");
  });

  it("a fixed query is searched only once the debounce catches up — the malformed one never is", () => {
    jest.useFakeTimers();
    render(<Host />);

    fireEvent.change(lookupInput(), { target: { value: "45#" } });
    act(() => jest.advanceTimersByTime(250));
    fireEvent.change(lookupInput(), { target: { value: "45" } });
    // The debounced value still reads "45#" here; the hint is already gone.
    act(() => jest.advanceTimersByTime(100));
    expect(screen.queryByText(ORDER_REFERENCE_HINT)).toBeNull();
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("");

    act(() => jest.advanceTimersByTime(150));
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("45");
    expect(useOrderSearchMock.mock.calls.map((call) => call[0])).not.toContain("45#");
  });
});

// ---------------------------------------------------------------------------
// B3-1 FR1 (OC-7): the lookup says when it is searching — the FIRST answer for
// a query in flight — and never flashes it over an answer already on screen.
// Driven through the REAL hook, so the flag it reads is TanStack's own.
// ---------------------------------------------------------------------------

describe("searching", () => {
  it("while the first answer is in flight: exactly `Searching…`, then the answer", async () => {
    let answer!: (value: unknown) => void;
    global.fetch = jest.fn(() => new Promise((resolve) => (answer = resolve))) as unknown as typeof fetch;
    renderWithRealHook(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    fireEvent.change(lookupInput(), { target: { value: "1009" } });

    const line = await screen.findByTestId("order-lookup-searching");
    expect(ORDER_LOOKUP_SEARCHING_SENTENCE).toBe("Searching…");
    expect(line.textContent).toBe("Searching…");
    expect(screen.queryByTestId("order-lookup-empty")).toBeNull();

    await act(async () => {
      answer({ ok: true, json: async () => ({ orders: [ORDER_1009], moreCount: 0 }) });
    });
    await waitFor(() => expect(screen.getByTestId("order-lookup-result-ord-2")).toBeInTheDocument());
    expect(screen.queryByTestId("order-lookup-searching")).toBeNull();
  });

  it("a background refetch of an answer already on screen shows NO searching line", async () => {
    let answer!: (value: unknown) => void;
    const fetchMock = jest.fn(() => new Promise((resolve) => (answer = resolve)));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // An answer a minute old: stale, so the query refetches it behind the rows.
    client.setQueryData(
      ["admin", "reconciliation", "orders", "1009"],
      { orders: [ORDER_1009], moreCount: 0 },
      { updatedAt: Date.now() - 60_000 },
    );
    renderWithRealHook(client);

    fireEvent.change(lookupInput(), { target: { value: "1009" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("order-lookup-result-ord-2")).toBeInTheDocument();
    expect(screen.queryByTestId("order-lookup-searching")).toBeNull();

    await act(async () => {
      answer({ ok: true, json: async () => ({ orders: [ORDER_1009], moreCount: 0 }) });
    });
    expect(screen.queryByTestId("order-lookup-searching")).toBeNull();
  });
});

describe("pick and clear", () => {
  it("a pick hands the host { id, orderNumber }, shows the order as chosen, and stops searching", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0 } });
    render(<Host onChange={onChange} />);

    await user.click(screen.getByTestId("order-lookup-result-ord-2"));

    expect(onChange).toHaveBeenCalledWith({ id: "ord-2", orderNumber: "1009" });
    expect(screen.getByTestId("order-lookup-picked")).toHaveTextContent("Order 1009");
    expect(screen.queryByLabelText("Find the order")).toBeNull();
    expect(screen.queryByTestId("order-lookup-result-ord-2")).toBeNull();
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("");
  });

  it("Clear hands the host null and brings the search back", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0 } });
    render(<Host onChange={onChange} />);

    await user.click(screen.getByTestId("order-lookup-result-ord-2"));
    await user.click(screen.getByRole("button", { name: "Clear order 1009" }));

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId("order-lookup-picked")).toBeNull();
    expect(screen.getByLabelText("Find the order")).toBeInTheDocument();
  });

  it("disabled disables the field and the rows", () => {
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0 } });
    render(<Host disabled />);

    expect(lookupInput()).toBeDisabled();
    expect(screen.getByTestId("order-lookup-result-ord-2")).toBeDisabled();
  });
});
