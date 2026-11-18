/** @jest-environment jsdom */
//
// Facelift F0-1 (plan 2026-11-17-facelift-f0, part 3 + fold (b)) — a store-order
// cart line that holds LESS than the order needs says so on its own row.
//
// FL-C-2: order needs 5, stock is 3 — the cart said 3, and the only record of
// "5" was a toast that disappeared. Every store-order line now carries
// `neededQuantity` (the line's remaining quantity), and whenever the cart holds
// fewer units than that the row prints one sentence under the name, in the
// warning tone. It covers the stock cap AND a line the operator stepped down.

import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrderItemComponent } from "@/components/workbench/order-item";
import type { OrderItem } from "@/types/workbench";
import type { ProductWithQuantity } from "@/types/product";

const product = (currentQuantity: number) =>
  ({ id: 501, name: "Widget 10mg", currentQuantity }) as unknown as ProductWithQuantity;

const renderItem = (item: OrderItem) =>
  render(<OrderItemComponent item={item} onUpdateQuantity={jest.fn()} onRemove={jest.fn()} />);

const SENTENCE = /needed ·/;

describe("F0-1 — the store-order line says what it is short", () => {
  it("a line capped at stock: '5 needed · 3 in stock here · 2 not in this cart', in the warning tone", () => {
    renderItem({
      product: product(3),
      quantity: 3,
      neededQuantity: 5,
      fulfillmentItemId: "it-short",
      source: "wc-order",
    });

    const line = screen.getByText("5 needed · 3 in stock here · 2 not in this cart");
    expect(line).toHaveClass("text-xs", "text-amber-700", "dark:text-amber-400");
  });

  it("sits under the name", () => {
    renderItem({
      product: product(3),
      quantity: 3,
      neededQuantity: 5,
      fulfillmentItemId: "it-short",
      source: "wc-order",
    });

    const name = screen.getByRole("heading", { name: "Widget 10mg" });
    // The sentence is the name's own next sibling — not text somewhere inside
    // the chip row that follows it.
    expect(name.nextElementSibling).toBe(
      screen.getByText("5 needed · 3 in stock here · 2 not in this cart")
    );
  });

  it("a line the operator stepped down below what the order needs says so too", () => {
    renderItem({
      product: product(10),
      quantity: 4,
      neededQuantity: 5,
      fulfillmentItemId: "it-full",
      source: "wc-order",
    });

    expect(
      screen.getByText("5 needed · 10 in stock here · 1 not in this cart")
    ).toBeInTheDocument();
  });

  it("a complete line prints no sentence", () => {
    renderItem({
      product: product(10),
      quantity: 5,
      neededQuantity: 5,
      fulfillmentItemId: "it-full",
      source: "wc-order",
    });

    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it("a hand-added line (no neededQuantity) prints no sentence", () => {
    renderItem({ product: product(10), quantity: 2, source: "manual" });

    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR2-1 (REV 7): a read-only line. While the order is being
// updated the cart is about to be replaced, so no edit may be made — it would
// be lost without a word.
// ---------------------------------------------------------------------------

describe("FR2-1 — a read-only line", () => {
  const line: OrderItem = {
    product: product(10),
    quantity: 3,
    neededQuantity: 3,
    fulfillmentItemId: "it-1",
    source: "wc-order",
  };

  it("disables the steppers, the quantity editor and the bin, and none of them acts", () => {
    const onUpdateQuantity = jest.fn();
    const onRemove = jest.fn();
    render(<OrderItemComponent item={line} onUpdateQuantity={onUpdateQuantity} onRemove={onRemove} readOnly />);

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(onUpdateQuantity).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    // The quantity editor never opened.
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("an edit already open when the line turns read-only cannot be confirmed", () => {
    const onUpdateQuantity = jest.fn();
    const view = render(
      <OrderItemComponent item={line} onUpdateQuantity={onUpdateQuantity} onRemove={jest.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    const editor = screen.getByRole("spinbutton");
    fireEvent.change(editor, { target: { value: "1" } });

    view.rerender(
      <OrderItemComponent item={line} onUpdateQuantity={onUpdateQuantity} onRemove={jest.fn()} readOnly />
    );
    expect(screen.getByRole("spinbutton")).toBeDisabled();
    // The editor's confirm (the first of its two buttons) is disabled; the bin too.
    const [confirm, cancel, bin] = screen.getAllByRole("button");
    expect(confirm).toBeDisabled();
    expect(bin).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("spinbutton"), { key: "Enter" });
    fireEvent.click(confirm);
    expect(onUpdateQuantity).not.toHaveBeenCalled();
    // Cancel still closes the editor.
    fireEvent.click(cancel);
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("not read-only, the same line is live (unchanged)", () => {
    const onUpdateQuantity = jest.fn();
    render(<OrderItemComponent item={line} onUpdateQuantity={onUpdateQuantity} onRemove={jest.fn()} />);

    for (const button of screen.getAllByRole("button")) expect(button).toBeEnabled();
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(onUpdateQuantity).toHaveBeenCalledWith(2);
  });
});
