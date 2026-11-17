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

import { WCOrderSelector } from "@/components/workbench/wc-order-selector";

const renderSelector = (stockLoading: boolean) => {
  const onOrderSelected = jest.fn();
  render(
    <WCOrderSelector
      onOrderSelected={onOrderSelected}
      selectedOrder={null}
      onClear={jest.fn()}
      stockLoading={stockLoading}
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
