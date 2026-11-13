/** @jest-environment jsdom */
/**
 * THE ORDER NUMBER FIELD (reconciliation Part 2, pack § P2-B3-1R, R-b.1).
 * Moved here from `order-lookup.test.tsx` with the component it replaced: ONE
 * field where there were two (a lookup and a typed box).
 *
 * What is pinned:
 *
 *   1. ONE HOOK, ONE KEY. The field reads the SAME `useOrderSearch` the
 *      Attribute… picker uses (its leaf module), now with this product and a
 *      five-row page: the key carries both, and the URL asks for both.
 *   2. THE DEBOUNCE. 250 ms; keystrokes inside the window never reach the hook.
 *   3. NORMALISATION, AS TYPED. A leading `#` and every space go, in view.
 *   4. THE SHAPE. With nothing picked, text that is not 1–20 digits says so,
 *      offers `Clear`, and is never searched.
 *   5. SETTLED. Nothing answers until the answer is for the CURRENT text:
 *      `Checking…` and no rows. A background refetch never demotes it.
 *   6. THE STATUS LINE, its rows and its precedence; the found row byte-equal;
 *      the product line's cases and the quantity warning's gate; the date with
 *      and without the year.
 *   7. ROWS: 44 px, no `#`, the page, then "and N more — keep typing".
 *   8. PICK, CHANGE, and NEVER AN IMPLICIT PICK.
 *   9. FOCUS on mount (only when asked) + `scrollIntoView`; no Escape handling.
 *
 * The hook module is mocked (the attribute-flow idiom); the key and settled
 * pins let the REAL hook through the mock, under a real QueryClient.
 */

import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const useOrderSearchMock = jest.fn();
jest.mock("@/hooks/use-order-search", () => ({
  useOrderSearch: (q: string, opts?: unknown) => useOrderSearchMock(q, opts),
}));

import {
  OrderNumberField,
  formatOrderDate,
  type OrderCapture,
  type PickedOrder,
} from "@/components/inventory/order-number-field";
import { NO_COMPANY_MEMBERSHIP_NOTE } from "@/lib/orders/order-capture-sentences";

const THIS_YEAR = new Date().getFullYear();

function order(over: Partial<PickedOrder> = {}): PickedOrder {
  return {
    id: "ord-2",
    orderNumber: "1009",
    platform: "woocommerce",
    internalStatus: "PROCESSING",
    // Midday UTC: the same calendar day in any test machine's zone.
    externalCreatedAt: `${THIS_YEAR}-08-19T12:00:00.000Z`,
    itemCount: 4,
    store: "North Shop",
    thisProduct: { orderedUnits: 3, uncheckedLines: 0 },
    ...over,
  };
}

const ORDER_1009 = order();

type Answer = {
  status?: "pending" | "success" | "error";
  data?: { orders: PickedOrder[]; moreCount: number; exactCount: number; note?: string };
  error?: { status?: number } | null;
};

/** Every non-empty query answers with `answer`; "" is the hook's disabled state. */
function setSearch(answer: Answer) {
  useOrderSearchMock.mockImplementation((q: string) =>
    q === ""
      ? { status: "pending", data: undefined, error: null }
      : {
          status: answer.status ?? (answer.error ? "error" : "success"),
          data: answer.data,
          error: answer.error ?? null,
        },
  );
}

/** A host that owns the value, as the dialog does. */
function Host({
  initial = { text: "", picked: null },
  quantity = 2,
  onChange,
  disabled = false,
  focusOnMount = false,
}: {
  initial?: OrderCapture;
  quantity?: number | null;
  onChange?: (next: OrderCapture) => void;
  disabled?: boolean;
  focusOnMount?: boolean;
}) {
  const [value, setValue] = React.useState<OrderCapture>(initial);
  return (
    <>
      <OrderNumberField
        productId={42}
        quantity={quantity}
        value={value}
        onChange={(next) => {
          onChange?.(next);
          setValue(next);
        }}
        disabled={disabled}
        focusOnMount={focusOnMount}
      />
      <button type="button">After the field</button>
    </>
  );
}

const field = () => screen.getByLabelText("Order number");
const statusLine = () => screen.getByTestId("order-number-status");
const statusText = () => statusLine().querySelector("p")?.textContent;

/** Type with fake timers and let the debounce catch up. */
function typeSettled(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  act(() => jest.advanceTimersByTime(250));
}

/** The REAL hook through the mock, under a real QueryClient. */
function renderWithRealHook(client: QueryClient, ui: React.ReactElement = <Host />) {
  const actual = jest.requireActual("@/hooks/use-order-search") as {
    useOrderSearch: (q: string, opts?: unknown) => unknown;
  };
  useOrderSearchMock.mockImplementation((q: string, opts?: unknown) => actual.useOrderSearch(q, opts));
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  useOrderSearchMock.mockReset();
  setSearch({ data: { orders: [], moreCount: 0, exactCount: 0 } });
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the input", () => {
  it("is labelled `Order number`, numeric, done-keyed, `e.g. 20105`, at most 40 characters", () => {
    render(<Host />);
    const input = field();
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("enterkeyhint", "done");
    expect(input).toHaveAttribute("placeholder", "e.g. 20105");
    expect(input).toHaveAttribute("maxlength", "40");
  });

  it("with an empty field, the helper says a number not in the app is still saved", () => {
    render(<Host />);
    expect(screen.getByTestId("order-number-helper").textContent).toBe(
      "If the order isn't in the app yet, type its number anyway — it's saved so an admin can link it later.",
    );
    fireEvent.change(field(), { target: { value: "1" } });
    expect(screen.queryByTestId("order-number-helper")).toBeNull();
  });

  it.each([
    ["#1009", "1009"],
    [" 10 09 ", "1009"],
    ["# 1009", "1009"],
    ["1009\t", "1009"],
  ])("normalises as typed, visibly: %j -> %j", (typed, shown) => {
    const onChange = jest.fn();
    render(<Host onChange={onChange} />);
    fireEvent.change(field(), { target: { value: typed } });
    expect(field()).toHaveValue(shown);
    expect(onChange).toHaveBeenLastCalledWith({ text: shown, picked: null });
  });

  it("only a LEADING `#` goes: `10#9` stays as typed (and is not an order number)", () => {
    render(<Host />);
    fireEvent.change(field(), { target: { value: "10#9" } });
    expect(field()).toHaveValue("10#9");
    expect(screen.getByTestId("order-number-shape")).toBeInTheDocument();
  });
});

describe("one shared hook, one key", () => {
  it("the REAL hook runs under the search key with this product and five rows, and asks the route for both", async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ orders: [ORDER_1009], moreCount: 0, exactCount: 1 }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderWithRealHook(client);
    fireEvent.change(field(), { target: { value: "1009" } });

    await waitFor(() => expect(statusText()).toBe("Order 1009 found — North Shop, placed Aug 19, processing."));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(
      "/api/reconciliation/orders/search?q=1009&productId=42&limit=5",
    );
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ["admin", "reconciliation", "orders", "1009", 42, 5], exact: true }),
    ).toBeDefined();
  });

  it("an untouched field asks with an empty query (the hook's disabled state), with the product and the page", () => {
    render(<Host />);
    expect(useOrderSearchMock).toHaveBeenCalled();
    for (const call of useOrderSearchMock.mock.calls) {
      expect(call[0]).toBe("");
      expect(call[1]).toEqual({ productId: 42, limit: 5 });
    }
  });
});

describe("the 250 ms debounce", () => {
  it("keystrokes inside the window never reach the hook; the last one does at 250 ms", () => {
    jest.useFakeTimers();
    render(<Host />);

    fireEvent.change(field(), { target: { value: "1" } });
    act(() => jest.advanceTimersByTime(100));
    fireEvent.change(field(), { target: { value: "10" } });
    act(() => jest.advanceTimersByTime(100));
    fireEvent.change(field(), { target: { value: "1009" } });
    act(() => jest.advanceTimersByTime(249));
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("", { productId: 42, limit: 5 });

    act(() => jest.advanceTimersByTime(1));
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("1009", { productId: 42, limit: 5 });

    const asked = useOrderSearchMock.mock.calls.map((call) => call[0]);
    expect(asked).not.toContain("1");
    expect(asked).not.toContain("10");
  });

  it('`243 ` is asked as "243" (the text is normalised before the search sees it)', () => {
    jest.useFakeTimers();
    render(<Host />);
    typeSettled("243 ");
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("243", { productId: 42, limit: 5 });
    expect(useOrderSearchMock.mock.calls.map((call) => call[0])).not.toContain("243 ");
  });
});

describe("the shape (only with nothing picked)", () => {
  it.each([["20a4"], ["1".repeat(21)], ["12-34"]])(
    "%j -> `Order numbers are 1–20 digits.` + Clear, NO search, no status line, no rows",
    (typed) => {
      jest.useFakeTimers();
      setSearch({ data: { orders: [ORDER_1009], moreCount: 3, exactCount: 1 } });
      render(<Host />);
      useOrderSearchMock.mockClear();

      typeSettled(typed);

      const message = screen.getByTestId("order-number-shape");
      expect(message.textContent).toBe("Order numbers are 1–20 digits.");
      expect(field()).toHaveAttribute("aria-invalid", "true");
      expect(field()).toHaveAttribute("aria-describedby", message.id);
      expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
      for (const call of useOrderSearchMock.mock.calls) expect(call[0]).toBe("");
      expect(screen.queryByTestId("order-number-status")).toBeNull();
      expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();
      expect(screen.queryByTestId("order-number-more")).toBeNull();
    },
  );

  it("`Clear` empties the field in one tap and puts the cursor back in it", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Host onChange={onChange} />);
    await user.type(field(), "20a4");

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onChange).toHaveBeenLastCalledWith({ text: "", picked: null });
    expect(field()).toHaveValue("");
    expect(field()).toHaveFocus();
    expect(screen.queryByTestId("order-number-shape")).toBeNull();
  });

  it("a well-shaped number shows no shape message", () => {
    jest.useFakeTimers();
    render(<Host />);
    typeSettled("4521");
    expect(screen.queryByTestId("order-number-shape")).toBeNull();
    expect(field()).toHaveAttribute("aria-invalid", "false");
  });

  it("a PICKED order is never judged by the shape, even when its number is not digits", () => {
    render(<Host initial={{ text: "WC-77", picked: order({ orderNumber: "WC-77" }) }} />);
    expect(screen.queryByTestId("order-number-shape")).toBeNull();
    expect(screen.getByTestId("order-number-picked")).toBeInTheDocument();
  });

  it("a fixed number is searched only once the debounce catches up — the malformed one never is", () => {
    jest.useFakeTimers();
    render(<Host />);

    typeSettled("45a");
    fireEvent.change(field(), { target: { value: "45" } });
    act(() => jest.advanceTimersByTime(100));
    // The debounced text still reads "45a": checking, and nothing asked.
    expect(statusText()).toBe("Checking…");
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("", { productId: 42, limit: 5 });

    act(() => jest.advanceTimersByTime(150));
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("45", { productId: 42, limit: 5 });
    expect(useOrderSearchMock.mock.calls.map((call) => call[0])).not.toContain("45a");
  });
});

describe("settled: nothing answers until the answer is for the current text", () => {
  it("while the debounce catches up: exactly `Checking…` and no rows, even with an answer in hand", () => {
    jest.useFakeTimers();
    setSearch({ data: { orders: [ORDER_1009], moreCount: 2, exactCount: 1 } });
    render(<Host />);

    fireEvent.change(field(), { target: { value: "1009" } });
    expect(statusText()).toBe("Checking…");
    expect(statusLine()).toHaveAttribute("role", "status");
    expect(statusLine()).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();
    expect(screen.queryByTestId("order-number-more")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use this order" })).toBeNull();

    act(() => jest.advanceTimersByTime(250));
    expect(statusText()).toBe("Order 1009 found — North Shop, placed Aug 19, processing.");
  });

  it("while the first answer is in flight (real hook): `Checking…`, then the answer", async () => {
    let answer!: (value: unknown) => void;
    global.fetch = jest.fn(() => new Promise((resolve) => (answer = resolve))) as unknown as typeof fetch;
    renderWithRealHook(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    fireEvent.change(field(), { target: { value: "1009" } });
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(statusText()).toBe("Checking…");
    expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();

    await act(async () => {
      answer({ ok: true, json: async () => ({ orders: [ORDER_1009], moreCount: 0, exactCount: 0 }) });
    });
    await waitFor(() =>
      expect(statusText()).toBe(
        "No order 1009 found. If the number is right, it's saved with this removal so an admin can link it later.",
      ),
    );
  });

  it("a NEW number never shows the previous number's rows while its own answer is on the way (no placeholderData)", async () => {
    const answers: Array<(value: unknown) => void> = [];
    global.fetch = jest.fn(() => new Promise((resolve) => answers.push(resolve))) as unknown as typeof fetch;
    renderWithRealHook(new QueryClient({ defaultOptions: { queries: { retry: false } } }));

    fireEvent.change(field(), { target: { value: "1009" } });
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => {
      answers[0]({ ok: true, json: async () => ({ orders: [ORDER_1009], moreCount: 0, exactCount: 0 }) });
    });
    await waitFor(() => expect(screen.getByTestId("order-number-row-ord-2")).toBeInTheDocument());

    fireEvent.change(field(), { target: { value: "1010" } });
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(statusText()).toBe("Checking…");
    expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();
  });

  it("a background refetch of the SAME number does not demote it to `Checking…`", async () => {
    let answer!: (value: unknown) => void;
    const fetchMock = jest.fn(() => new Promise((resolve) => (answer = resolve)));
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // An answer a minute old: stale, so the query refetches it behind the rows.
    client.setQueryData(
      ["admin", "reconciliation", "orders", "1009", 42, 5],
      { orders: [ORDER_1009], moreCount: 0, exactCount: 1 },
      { updatedAt: Date.now() - 60_000 },
    );
    renderWithRealHook(client);

    fireEvent.change(field(), { target: { value: "1009" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(statusText()).toBe("Order 1009 found — North Shop, placed Aug 19, processing."));

    await act(async () => {
      answer({ ok: true, json: async () => ({ orders: [ORDER_1009], moreCount: 0, exactCount: 1 }) });
    });
    expect(statusText()).toBe("Order 1009 found — North Shop, placed Aug 19, processing.");
  });
});

describe("the status line: each state, and the precedence", () => {
  const NOT_FOUND = (n: string) =>
    `No order ${n} found. If the number is right, it's saved with this removal so an admin can link it later.`;

  function settle(answer: Answer, typed = "1009") {
    jest.useFakeTimers();
    setSearch(answer);
    render(<Host />);
    typeSettled(typed);
  }

  it("429 -> the rate-limit sentence (before a note or a count)", () => {
    settle({ error: { status: 429 }, data: { orders: [], moreCount: 0, exactCount: 0, note: NO_COMPANY_MEMBERSHIP_NOTE } });
    expect(statusText()).toBe(
      "Too many lookups just now — the number will still be saved with this removal.",
    );
  });

  it("any other failure -> the lookup-failed sentence, never an empty list that reads as no order", () => {
    settle({ error: { status: 500 } });
    expect(statusText()).toBe(
      "Couldn't look up orders right now — the number will still be saved with this removal.",
    );
    expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();
  });

  it("a member of no company -> that reason (before the count)", () => {
    settle({ data: { orders: [], moreCount: 0, exactCount: 0, note: NO_COMPANY_MEMBERSHIP_NOTE } });
    expect(statusText()).toBe(
      "You're not in any company yet, so orders can't be looked up — the number will still be saved with this removal.",
    );
  });

  it("any OTHER note is ignored: the count speaks", () => {
    settle({
      data: { orders: [], moreCount: 0, exactCount: 0, note: "no order matching that number in your companies" },
    });
    expect(statusText()).toBe(NOT_FOUND("1009"));
    expect(screen.queryByText("no order matching that number in your companies")).toBeNull();
  });

  it("exactCount 1 with a byte-equal row -> found, its product line, `Use this order`; the row is not repeated", () => {
    const other = order({ id: "ord-3", orderNumber: "10090", store: "South Shop" });
    settle({ data: { orders: [ORDER_1009, other], moreCount: 0, exactCount: 1 } });

    expect(statusText()).toBe("Order 1009 found — North Shop, placed Aug 19, processing.");
    expect(within(statusLine()).getByTestId("order-number-product-line").textContent).toBe(
      "This product: 3 ordered.",
    );
    const use = screen.getByRole("button", { name: "Use this order" });
    expect(use).toHaveClass("min-h-[44px]");
    expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();
    expect(screen.getByTestId("order-number-row-ord-3")).toBeInTheDocument();
  });

  it("exactCount 1 with NO byte-equal row -> the not-found sentence (what the save will do), and the row stays a row", () => {
    const lookalike = order({ orderNumber: "1009 " });
    settle({ data: { orders: [lookalike], moreCount: 0, exactCount: 1 } });
    expect(statusText()).toBe(NOT_FOUND("1009"));
    expect(screen.queryByRole("button", { name: "Use this order" })).toBeNull();
    expect(screen.getByTestId("order-number-row-ord-2")).toBeInTheDocument();
  });

  it("exactCount 0 -> the not-found sentence", () => {
    settle({ data: { orders: [order({ orderNumber: "10091" })], moreCount: 0, exactCount: 0 } });
    expect(statusText()).toBe(NOT_FOUND("1009"));
  });

  it("exactCount 2+ -> `{n} orders have this number`, and every row is listed to tap", () => {
    const twin = order({ id: "ord-3", store: "South Shop" });
    settle({ data: { orders: [ORDER_1009, twin], moreCount: 0, exactCount: 2 } });
    expect(statusText()).toBe(
      "2 orders have this number — tap the right one, or save the number without linking.",
    );
    expect(screen.queryByRole("button", { name: "Use this order" })).toBeNull();
    expect(screen.getByTestId("order-number-row-ord-2")).toBeInTheDocument();
    expect(screen.getByTestId("order-number-row-ord-3")).toBeInTheDocument();
  });

  it("checking comes FIRST: an answer (even a failure) for a lagging debounce is not shown", () => {
    jest.useFakeTimers();
    setSearch({ error: { status: 429 } });
    render(<Host />);
    typeSettled("1009");
    fireEvent.change(field(), { target: { value: "10091" } });
    expect(statusText()).toBe("Checking…");
  });

  it("no status line and no rows while the field is empty", () => {
    jest.useFakeTimers();
    setSearch({ data: { orders: [ORDER_1009], moreCount: 4, exactCount: 1 } });
    render(<Host />);
    act(() => jest.advanceTimersByTime(250));
    expect(screen.queryByTestId("order-number-status")).toBeNull();
    expect(screen.queryByTestId("order-number-row-ord-2")).toBeNull();
    expect(screen.queryByTestId("order-number-more")).toBeNull();
  });
});

describe("the product line and the quantity warning", () => {
  function foundLines(facts: Partial<PickedOrder>, quantity: number | null = 2) {
    jest.useFakeTimers();
    setSearch({ data: { orders: [order(facts)], moreCount: 0, exactCount: 1 } });
    render(<Host quantity={quantity} />);
    typeSettled("1009");
    return within(statusLine())
      .queryAllByTestId("order-number-product-line")
      .map((line) => ({ text: line.textContent, warn: line.classList.contains("text-warning") }));
  }

  it("no lines recorded -> can't tell (never 'not on the order')", () => {
    expect(foundLines({ itemCount: 0, thisProduct: { orderedUnits: 0, uncheckedLines: 0 } })).toEqual([
      {
        text: "Can't tell if this product is on this order — none of its lines are recorded yet.",
        warn: false,
      },
    ]);
  });

  it("ordered, every line checked", () => {
    expect(foundLines({ thisProduct: { orderedUnits: 3, uncheckedLines: 0 } })).toEqual([
      { text: "This product: 3 ordered.", warn: false },
    ]);
  });

  it("ordered, some lines unchecked -> at least", () => {
    expect(foundLines({ thisProduct: { orderedUnits: 3, uncheckedLines: 1 } })).toEqual([
      { text: "This product: at least 3 ordered — some lines aren't linked to products.", warn: false },
    ]);
  });

  it("not ordered, every line checked -> amber, and it never blocks", () => {
    expect(foundLines({ thisProduct: { orderedUnits: 0, uncheckedLines: 0 } })).toEqual([
      { text: "This product isn't on order 1009. Check the number — you can still remove it.", warn: true },
    ]);
  });

  it("not ordered, some lines unchecked -> can't tell", () => {
    expect(foundLines({ thisProduct: { orderedUnits: 0, uncheckedLines: 2 } })).toEqual([
      {
        text: "Can't tell if this product is on this order — some of its lines aren't linked to products.",
        warn: false,
      },
    ]);
  });

  it("removing MORE than a fully-checked order lists -> the amber quantity warning", () => {
    expect(foundLines({ thisProduct: { orderedUnits: 3, uncheckedLines: 0 } }, 5)).toEqual([
      { text: "This product: 3 ordered.", warn: false },
      { text: "You're removing 5; order 1009 lists 3. Check the quantity — you can still save.", warn: true },
    ]);
  });

  it.each([
    ["equal to what it lists", { orderedUnits: 3, uncheckedLines: 0 }, 3],
    ["unchecked lines (it could be more)", { orderedUnits: 3, uncheckedLines: 1 }, 5],
    ["not on the order at all", { orderedUnits: 0, uncheckedLines: 0 }, 5],
    ["no quantity yet", { orderedUnits: 3, uncheckedLines: 0 }, null],
  ])("no quantity warning when %s", (_label, facts, quantity) => {
    const lines = foundLines({ thisProduct: facts }, quantity as number | null);
    expect(lines.some((line) => line.text?.startsWith("You're removing"))).toBe(false);
  });
});

describe("the date", () => {
  it("`MMM d` in the current year, `MMM d, yyyy` otherwise, `date unknown` without one", () => {
    expect(formatOrderDate(`${THIS_YEAR}-03-05T12:00:00.000Z`)).toBe("Mar 5");
    expect(formatOrderDate("2019-03-05T12:00:00.000Z")).toBe("Mar 5, 2019");
    expect(formatOrderDate(null)).toBe("date unknown");
  });

  it("a row from another year carries its year; a dateless one says so", () => {
    jest.useFakeTimers();
    setSearch({
      data: {
        orders: [
          order({ id: "a", orderNumber: "10091", externalCreatedAt: "2019-03-05T12:00:00.000Z" }),
          order({ id: "b", orderNumber: "10092", externalCreatedAt: null }),
        ],
        moreCount: 0,
        exactCount: 0,
      },
    });
    render(<Host />);
    typeSettled("1009");
    expect(screen.getByTestId("order-number-row-a")).toHaveTextContent("placed Mar 5, 2019 · processing");
    expect(screen.getByTestId("order-number-row-b")).toHaveTextContent("placed date unknown · processing");
  });
});

describe("the rows", () => {
  it("`{orderNumber} · {store}` / `placed {date} · {status} · {short line}` — 44 px, no `#`", () => {
    jest.useFakeTimers();
    setSearch({ data: { orders: [order({ orderNumber: "21009" })], moreCount: 0, exactCount: 0 } });
    render(<Host />);
    typeSettled("1009");

    const row = screen.getByTestId("order-number-row-ord-2");
    const [first, second] = Array.from(row.querySelectorAll("span")).map((span) => span.textContent);
    expect(first).toBe("21009 · North Shop");
    expect(second).toBe("placed Aug 19 · processing · this product: 3 ordered");
    expect(row.textContent).not.toContain("#");
    expect(row).toHaveClass("min-h-[44px]");
  });

  it.each([
    ["no lines recorded", { itemCount: 0, thisProduct: { orderedUnits: 0, uncheckedLines: 0 } }, "can't tell"],
    ["ordered", { thisProduct: { orderedUnits: 2, uncheckedLines: 0 } }, "this product: 2 ordered"],
    ["at least", { thisProduct: { orderedUnits: 2, uncheckedLines: 1 } }, "at least 2"],
    ["not on it", { thisProduct: { orderedUnits: 0, uncheckedLines: 0 } }, "not on the order"],
    ["unchecked", { thisProduct: { orderedUnits: 0, uncheckedLines: 1 } }, "can't tell"],
  ])("the short line: %s -> %j", (_label, facts, short) => {
    jest.useFakeTimers();
    setSearch({ data: { orders: [order({ orderNumber: "21009", ...facts })], moreCount: 0, exactCount: 0 } });
    render(<Host />);
    typeSettled("1009");
    expect(screen.getByTestId("order-number-row-ord-2").textContent?.endsWith(` · ${short}`)).toBe(true);
  });

  it('up to the page, then "and N more — keep typing"', () => {
    jest.useFakeTimers();
    const five = [1, 2, 3, 4, 5].map((i) => order({ id: `o${i}`, orderNumber: `1009${i}` }));
    setSearch({ data: { orders: five, moreCount: 7, exactCount: 0 } });
    render(<Host />);
    typeSettled("1009");

    for (const row of five) expect(screen.getByTestId(`order-number-row-${row.id}`)).toBeInTheDocument();
    expect(screen.getByTestId("order-number-more").textContent).toBe("and 7 more — keep typing");
  });

  it("no more-line when nothing was left off", () => {
    jest.useFakeTimers();
    setSearch({ data: { orders: [order({ orderNumber: "10091" })], moreCount: 0, exactCount: 0 } });
    render(<Host />);
    typeSettled("1009");
    expect(screen.queryByTestId("order-number-more")).toBeNull();
  });

  it("disabled disables the field, the rows and `Use this order`", () => {
    jest.useFakeTimers();
    setSearch({ data: { orders: [ORDER_1009, order({ id: "ord-3", orderNumber: "10090" })], moreCount: 0, exactCount: 1 } });
    render(<Host initial={{ text: "1009", picked: null }} disabled />);
    act(() => jest.advanceTimersByTime(250));
    expect(field()).toBeDisabled();
    expect(screen.getByTestId("order-number-row-ord-3")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use this order" })).toBeDisabled();
  });
});

describe("pick and change", () => {
  it("a tap on a row picks it: the host gets { text: its number, picked: the row }", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const row = order({ orderNumber: "21009" });
    setSearch({ data: { orders: [row], moreCount: 0, exactCount: 0 } });
    render(<Host onChange={onChange} />);
    await user.type(field(), "1009");
    await waitFor(() => expect(screen.getByTestId("order-number-row-ord-2")).toBeInTheDocument());

    await user.click(screen.getByTestId("order-number-row-ord-2"));

    expect(onChange).toHaveBeenLastCalledWith({ text: "21009", picked: row });
    expect(screen.getByTestId("order-number-picked")).toBeInTheDocument();
    expect(screen.queryByLabelText("Order number", { selector: "input" })).toBeNull();
    expect(useOrderSearchMock).toHaveBeenLastCalledWith("", { productId: 42, limit: 5 });
  });

  it.each([["{Enter}"], [" "]])("%j on a focused row picks it", async (key) => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const row = order({ orderNumber: "21009" });
    setSearch({ data: { orders: [row], moreCount: 0, exactCount: 0 } });
    render(<Host onChange={onChange} />);
    await user.type(field(), "1009");
    await waitFor(() => expect(screen.getByTestId("order-number-row-ord-2")).toBeInTheDocument());

    screen.getByTestId("order-number-row-ord-2").focus();
    await user.keyboard(key);
    expect(onChange).toHaveBeenLastCalledWith({ text: "21009", picked: row });
  });

  it("`Use this order` is an explicit pick of the found order", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0, exactCount: 1 } });
    render(<Host onChange={onChange} />);
    await user.type(field(), "1009");
    await user.click(await screen.findByRole("button", { name: "Use this order" }));
    expect(onChange).toHaveBeenLastCalledWith({ text: "1009", picked: ORDER_1009 });
  });

  it("the picked summary: `Order {n} · {store}`, `placed {date} · {status}`, the product line(s), `Change`", () => {
    render(<Host quantity={5} initial={{ text: "1009", picked: ORDER_1009 }} />);
    const summary = screen.getByTestId("order-number-picked");
    const texts = Array.from(summary.querySelectorAll("p")).map((p) => p.textContent);
    expect(texts).toEqual([
      "Order 1009 · North Shop",
      "placed Aug 19 · processing",
      "This product: 3 ordered.",
      "You're removing 5; order 1009 lists 3. Check the quantity — you can still save.",
    ]);
    expect(within(summary).getByRole("button", { name: "Change" })).toHaveClass("min-h-[44px]");
    // Nothing is searched for a picked order: no status, no rows.
    expect(screen.queryByTestId("order-number-status")).toBeNull();
    for (const call of useOrderSearchMock.mock.calls) expect(call[0]).toBe("");
  });

  it("`Change` hands back the picked number as text and focuses the field", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Host onChange={onChange} initial={{ text: "1009", picked: ORDER_1009 }} />);

    await user.click(screen.getByRole("button", { name: "Change" }));

    expect(onChange).toHaveBeenLastCalledWith({ text: "1009", picked: null });
    expect(field()).toHaveValue("1009");
    expect(field()).toHaveFocus();
  });

  it("`Change` on a picked number that is NOT an order number hands back empty text", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    const odd = order({ orderNumber: "WC-77" });
    render(<Host onChange={onChange} initial={{ text: "WC-77", picked: odd }} />);

    await user.click(screen.getByRole("button", { name: "Change" }));

    expect(onChange).toHaveBeenLastCalledWith({ text: "", picked: null });
    expect(field()).toHaveValue("");
  });
});

describe("never an implicit pick", () => {
  async function typeWithOneFoundResult(user: ReturnType<typeof userEvent.setup>, onChange: jest.Mock) {
    setSearch({ data: { orders: [ORDER_1009], moreCount: 0, exactCount: 1 } });
    render(<Host onChange={onChange} />);
    await user.type(field(), "1009");
    await waitFor(() => expect(screen.getByRole("button", { name: "Use this order" })).toBeInTheDocument());
  }

  const picks = (onChange: jest.Mock) =>
    onChange.mock.calls.filter((call) => (call[0] as OrderCapture).picked !== null);

  it("not on blur, nor on Tab", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    await typeWithOneFoundResult(user, onChange);
    await user.tab();
    fireEvent.blur(field());
    expect(picks(onChange)).toEqual([]);
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
  });

  it("not on Enter in the input — and Enter does nothing else there (its default is prevented)", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    await typeWithOneFoundResult(user, onChange);
    field().focus();
    const notPrevented = fireEvent.keyDown(field(), { key: "Enter" });
    expect(notPrevented).toBe(false);
    await user.keyboard("{Enter}");
    expect(picks(onChange)).toEqual([]);
    expect(screen.queryByTestId("order-number-picked")).toBeNull();
  });

  it("not for a single result, nor for a found match", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    await typeWithOneFoundResult(user, onChange);
    expect(picks(onChange)).toEqual([]);
    expect(onChange).toHaveBeenLastCalledWith({ text: "1009", picked: null });
  });
});

describe("focus", () => {
  const original = Element.prototype.scrollIntoView;
  let scrollIntoView: jest.Mock;
  beforeEach(() => {
    scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  it("`focusOnMount` focuses the field on mount, and the focus scrolls it to the centre", () => {
    render(<Host focusOnMount />);
    expect(field()).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("without it, the field does not take focus", () => {
    render(<Host />);
    expect(field()).not.toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("any focus of the field scrolls it to the centre", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(field());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
});

describe("no Escape handling in the field", () => {
  it("Escape in the field is neither handled nor prevented, and changes nothing", () => {
    const onChange = jest.fn();
    render(<Host onChange={onChange} initial={{ text: "1009", picked: null }} />);
    const notPrevented = fireEvent.keyDown(field(), { key: "Escape" });
    expect(notPrevented).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveValue("1009");
  });

  it("the source carries no Escape handler (Radix owns Escape; the dialog's draft rule keeps it open)", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../components/inventory/order-number-field.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/key\s*===\s*["']Escape["']/);
    expect(source).not.toMatch(/onEscapeKeyDown/);
  });
});

describe("the sentences come from the leaf", () => {
  it("the field imports the no-company note from the leaf and spells no copy of it", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../components/inventory/order-number-field.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\bNO_COMPANY_MEMBERSHIP_NOTE\b[^}]*\}\s*from\s*["']@\/lib\/orders\/order-capture-sentences["']/,
    );
    expect(source).not.toContain("you are not a member of any company yet");
  });
});
