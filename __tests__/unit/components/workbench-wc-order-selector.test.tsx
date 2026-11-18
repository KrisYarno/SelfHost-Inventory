/** @jest-environment jsdom */
//
// Facelift F0-1 (plan 2026-11-17-facelift-f0, fold (e), OC1-1) — "here" must
// mean the location the stock will leave from.
//
// Selecting a store order builds the cart from the products array the page
// holds. While that array is still loading, or is the PREVIOUS location's rows
// shown as placeholder data after a switch, a selection would build "in stock
// here" from somewhere else. So the order rows are disabled and say why while
// the products query is loading or showing placeholder data.

import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("@/hooks/use-external-orders", () => ({
  useExternalOrders: () => ({
    data: {
      orders: [
        {
          id: "ord-1",
          orderNumber: "9001",
          customerName: "Ada L",
          total: 10,
          internalStatus: "processing",
          stockedOut: false,
          integration: { platform: "WOOCOMMERCE" },
        },
      ],
    },
    isFetching: false,
    error: null,
  }),
}));

import { WCOrderSelector, noLocationSentence } from "@/components/workbench/wc-order-selector";

const renderSelector = (stockLoading: boolean, stockFailed?: boolean) => {
  const onOrderSelected = jest.fn();
  render(
    <WCOrderSelector
      onOrderSelected={onOrderSelected}
      selectedOrder={null}
      onClear={jest.fn()}
      stockLoading={stockLoading}
      stockFailed={stockFailed}
    />
  );
  return { onOrderSelected };
};

const orderRow = () => screen.getByRole("button", { name: /#9001/ });

describe("F0-1 — order rows wait for this location's stock", () => {
  it("while stock is loading, the rows are disabled and read 'Loading stock…'", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOrderSelected } = renderSelector(true);

    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent("Loading stock…");
    expect(orderRow()).not.toHaveTextContent("Select");

    await user.click(orderRow());
    expect(onOrderSelected).not.toHaveBeenCalled();
  });

  it("once the stock is here, the rows are live and read 'Select' (unchanged)", async () => {
    const user = userEvent.setup();
    const { onOrderSelected } = renderSelector(false);

    expect(orderRow()).toBeEnabled();
    expect(orderRow()).toHaveTextContent("Select");
    expect(orderRow()).not.toHaveTextContent("Loading stock…");

    await user.click(orderRow());
    expect(onOrderSelected).toHaveBeenCalledTimes(1);
  });
});

// Facelift F0 FR1-1 (e): when the products read FAILED there is no stock to
// build "in stock here" from, and "Loading stock…" would be untrue — nothing is
// loading. The rows wait and say why.
describe("FR1-1 (e) — order rows when the stock read failed", () => {
  it("the rows are disabled and read `Stock couldn't be loaded — try again shortly.`", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onOrderSelected } = renderSelector(false, true);

    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent("Stock couldn't be loaded — try again shortly.");
    expect(orderRow()).not.toHaveTextContent("Select");
    expect(orderRow()).not.toHaveTextContent("Loading stock…");

    await user.click(orderRow());
    expect(onOrderSelected).not.toHaveBeenCalled();
  });
});

// Facelift F0 FR2-6 (REV 7, QA-3): with no location selected there is no
// "here" and no stock read in flight, so "Loading stock…" was untrue — it would
// never finish. The rows wait and say why. F1-9 replaced F0's sentence (`Choose
// a location at the top of the page.`, false on desktop, where the chip is in
// the sidebar) with the loaded-list one: `Choose a location first.`
describe("FR2-6 — order rows with no location selected", () => {
  it("the rows are disabled and read `Choose a location first.`", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOrderSelected = jest.fn();
    render(
      <WCOrderSelector
        onOrderSelected={onOrderSelected}
        selectedOrder={null}
        onClear={jest.fn()}
        noLocation
        // What the page's products query reports with no location: not
        // arrived. The no-location sentence wins over both stock sentences.
        stockLoading
        stockFailed={false}
      />
    );

    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent("Choose a location first.");
    expect(orderRow()).not.toHaveTextContent("Loading stock…");
    expect(orderRow()).not.toHaveTextContent("Select");

    await user.click(orderRow());
    expect(onOrderSelected).not.toHaveBeenCalled();
  });

  it("`noLocation` alone disables the rows (whatever the stock flags say)", () => {
    render(
      <WCOrderSelector onOrderSelected={jest.fn()} selectedOrder={null} onClear={jest.fn()} noLocation />
    );

    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent("Choose a location first.");
  });

  it("over a failed stock read too, the location comes first", () => {
    render(
      <WCOrderSelector
        onOrderSelected={jest.fn()}
        selectedOrder={null}
        onClear={jest.fn()}
        noLocation
        stockFailed
      />
    );

    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent("Choose a location first.");
    expect(orderRow()).not.toHaveTextContent("Stock couldn't be loaded");
  });
});

// Facelift F0 FR2-5 (REV 7, QA-2; orchestrator ruling, option (a)): the
// stock-failed sentence gets a Retry. The sentence lives inside each order
// row's (disabled) button, where a button cannot go — so in the stock-failed
// state ONLY the selector renders ONE line above the rows: the sentence, then
// a 44px `Retry` that calls `onRetryStock` (the page passes its products
// refetch). The rows keep their disabled state and trailing label.
describe("FR2-5 — the stock-failed line and its Retry", () => {
  const SENTENCE = "Stock couldn't be loaded — try again shortly.";
  const renderWith = (over: Partial<React.ComponentProps<typeof WCOrderSelector>>) => {
    const onRetryStock = jest.fn();
    render(
      <WCOrderSelector
        onOrderSelected={jest.fn()}
        selectedOrder={null}
        onClear={jest.fn()}
        onRetryStock={onRetryStock}
        {...over}
      />
    );
    return { onRetryStock };
  };
  /** The line: the sentence NOT inside a row's button. */
  const lineSentences = () => screen.queryAllByText(SENTENCE).filter((el) => el.closest("button") === null);

  it("stock failed: ONE line above the rows — the sentence, then Retry — and the rows keep their label", async () => {
    const user = userEvent.setup();
    const { onRetryStock } = renderWith({ stockFailed: true });

    expect(lineSentences()).toHaveLength(1);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(retry).toHaveClass("min-h-[44px]");
    // The line sits above the rows, sentence first.
    const line = lineSentences()[0];
    expect(line.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(retry.compareDocumentPosition(orderRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The row is as built: disabled, with the sentence as its label.
    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent(SENTENCE);

    await user.click(retry);
    expect(onRetryStock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["stock loading", { stockLoading: true }],
    ["stock here", {}],
    ["no location", { noLocation: true, stockFailed: true }],
  ])("no line and no Retry when %s", (_label, over) => {
    renderWith(over);
    expect(lineSentences()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

// Facelift F1-9 (plan 2026-11-18-facelift-f1, F0 FD2-3; G1-18): with no
// location, the rows say WHY — the location chip's own states, first match
// wins. F0's one sentence also showed while the locations were still loading
// or had failed, where there was nothing to choose from yet.
describe("F1-9 — the order rows' location states", () => {
  type List = { isLoading: boolean; loadFailed: boolean; count: number };
  const renderWithList = (locationList: List) =>
    render(
      <WCOrderSelector
        onOrderSelected={jest.fn()}
        selectedOrder={null}
        onClear={jest.fn()}
        noLocation
        locationList={locationList}
      />
    );

  it.each<[string, List, string]>([
    ["loading", { isLoading: true, loadFailed: false, count: 0 }, "Loading locations…"],
    // A retry of a failed read is loading: the first match wins.
    ["loading over a failed read", { isLoading: true, loadFailed: true, count: 0 }, "Loading locations…"],
    ["failed, nothing loaded", { isLoading: false, loadFailed: true, count: 0 }, "Couldn't load locations."],
    ["zero locations", { isLoading: false, loadFailed: false, count: 0 }, "No locations configured."],
    ["loaded, none selected", { isLoading: false, loadFailed: false, count: 2 }, "Choose a location first."],
    // A failed refresh over a LOADED list keeps the list, as the chip does.
    ["a failed refresh over a loaded list", { isLoading: false, loadFailed: true, count: 2 }, "Choose a location first."],
  ])("%s: the rows are disabled and read the state's sentence", (_label, list, sentence) => {
    renderWithList(list);
    expect(orderRow()).toBeDisabled();
    expect(orderRow()).toHaveTextContent(sentence);
    for (const other of [
      "Loading locations…",
      "Couldn't load locations.",
      "No locations configured.",
      "Choose a location first.",
      "Choose a location at the top of the page.",
      "Loading stock…",
      "Select",
    ].filter((s) => s !== sentence)) {
      expect(orderRow()).not.toHaveTextContent(other);
    }
  });

  it("with a location, the list's state is not read: the rows read the stock state", () => {
    render(
      <WCOrderSelector
        onOrderSelected={jest.fn()}
        selectedOrder={null}
        onClear={jest.fn()}
        locationList={{ isLoading: true, loadFailed: false, count: 0 }}
      />
    );
    expect(orderRow()).toBeEnabled();
    expect(orderRow()).toHaveTextContent("Select");
    expect(orderRow()).not.toHaveTextContent("Loading locations…");
  });
});

describe("F1-9 — `noLocationSentence`, the ladder the rows and the workbench grid share", () => {
  it("first match wins: loading, failed with nothing loaded, zero, then the caller's sentence", () => {
    const unselected = "Choose a location to see products.";
    expect(noLocationSentence({ isLoading: true, loadFailed: true, count: 0 }, unselected)).toBe("Loading locations…");
    expect(noLocationSentence({ isLoading: false, loadFailed: true, count: 0 }, unselected)).toBe(
      "Couldn't load locations."
    );
    expect(noLocationSentence({ isLoading: false, loadFailed: false, count: 0 }, unselected)).toBe(
      "No locations configured."
    );
    expect(noLocationSentence({ isLoading: false, loadFailed: false, count: 3 }, unselected)).toBe(unselected);
    expect(noLocationSentence({ isLoading: false, loadFailed: true, count: 3 }, unselected)).toBe(unselected);
  });
});
