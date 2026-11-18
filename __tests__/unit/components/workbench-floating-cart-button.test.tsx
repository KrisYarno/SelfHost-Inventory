/** @jest-environment jsdom */
//
// Facelift F0-1 (plan 2026-11-17-facelift-f0, part 4 + fold (d)) — the phone's
// only door into the cart sheet.
//
// The button used to render only for a non-empty cart. A store order whose
// every line was skipped (unmapped, unavailable, out of stock here, a bundle)
// therefore left the phone with NO way to open the sheet and see those lines.
// It now shows for skipped lines too: the badge reads the item count when there
// is one and `!` otherwise, and the screen-reader label names what is not being
// deducted. A manual cart is exactly as it was.

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { FloatingCartButton } from "@/components/workbench/floating-cart-button";

const renderButton = (itemCount: number, skippedCount: number) =>
  render(<FloatingCartButton itemCount={itemCount} skippedCount={skippedCount} onClick={jest.fn()} />);

/**
 * The screen-reader label, read off its own sr-only span. The button's
 * accessible NAME also carries the badge's text in front of it ("3 View cart
 * (3 items)" today), so the label is matched exactly where it lives.
 */
const srLabel = (text: string) => {
  const label = screen.getByText(text);
  expect(label).toHaveClass("sr-only");
  return label.closest("button") as HTMLElement;
};

describe("F0-1 — the floating cart button", () => {
  it("renders nothing with no cart lines and no skipped lines", () => {
    const { container } = renderButton(0, 0);
    expect(container).toBeEmptyDOMElement();
  });

  it("a manual cart shows it exactly as today: the count badge and 'View cart (N items)'", () => {
    renderButton(3, 0);

    const button = srLabel("View cart (3 items)");
    expect(button).toHaveTextContent(/^3View cart \(3 items\)$/);
  });

  it("an all-skipped store order still shows it, with '!' and the not-deducted label", () => {
    renderButton(0, 2);

    const button = srLabel("View order (0 items, 2 not deducted)");
    expect(button).toHaveTextContent(/^!View order/);
  });

  it("a store order with cart lines AND skipped lines: the count, and both numbers in the label", () => {
    renderButton(2, 1);

    const button = srLabel("View order (2 items, 1 not deducted)");
    expect(button).toHaveTextContent(/^2View order/);
  });
});

// Facelift F1-12 (plan 2026-11-18-facelift-f1; F0 QA-6.5, G1-22): the
// screen-reader label said `(1 items`. One line reads `item`; every other count
// keeps `items` (the plural pins above are unchanged).
describe("F1-12 — singular forms on the cart button's label", () => {
  it("a manual cart of one line: `View cart (1 item)`", () => {
    renderButton(1, 0);
    const button = srLabel("View cart (1 item)");
    expect(button).toHaveTextContent(/^1View cart \(1 item\)$/);
  });

  it("a store order with one cart line: `View order (1 item, N not deducted)`", () => {
    renderButton(1, 2);
    const button = srLabel("View order (1 item, 2 not deducted)");
    expect(button).toHaveTextContent(/^1View order \(1 item, 2 not deducted\)$/);
  });

  it("zero cart lines stay plural: `View order (0 items, 1 not deducted)`", () => {
    renderButton(0, 1);
    srLabel("View order (0 items, 1 not deducted)");
  });
});
