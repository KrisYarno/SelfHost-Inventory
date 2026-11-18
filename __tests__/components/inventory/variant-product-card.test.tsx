/** @jest-environment jsdom */
//
// Facelift F0-8 (plan 2026-11-17-facelift-f0, F0-8 part 2 + the REV 2 folds) —
// no Inventory card's action is clipped or hidden.
//
// Before: the three actions were `flex-1` buttons that could not shrink
// (`whitespace-nowrap`), so at phone widths about half of Transfer was cut off
// at the card's `overflow-hidden` edge; and from `md` up they were
// `opacity-0` until hover, so on a touch tablet they were invisible but still
// tappable. The Location Breakdown sat in `max-h-96 overflow-hidden`. Now the
// row is a three-column grid of buttons that may shrink (`min-w-0
// overflow-hidden px-2`, labels `truncate`, icons only from `xl`), the actions
// are always visible, and the breakdown has no height clip and is not rendered
// while collapsed.

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { VariantProductCard } from "@/components/inventory/variant-product-card";

const LOCATIONS = Array.from({ length: 12 }, (_, i) => ({
  locationId: i + 1,
  locationName: `Shelf ${i + 1}`,
  quantity: 12 - i,
  minQuantity: 0,
}));

function renderCard() {
  return render(
    <VariantProductCard
      product={{
        id: 1,
        name: "Widget (Blue)",
        baseName: "Widget",
        variant: "Blue",
        locations: LOCATIONS,
        totalQuantity: 78,
        combinedMinimum: 0,
      }}
      onStockIn={jest.fn()}
      onAdjust={jest.fn()}
      onTransfer={jest.fn()}
    />,
  );
}

const actions = () =>
  ["Stock In", "Adjust", "Transfer"].map((name) => screen.getByRole("button", { name }));

describe("F0-8 — the variant card's action row", () => {
  it("is a three-column grid with no opacity classes (always visible)", () => {
    renderCard();
    const row = actions()[0].parentElement as HTMLElement;
    expect(row).toHaveClass("grid", "grid-cols-3", "gap-2");
    expect(row.className).not.toMatch(/opacity/);
    for (const button of actions()) expect(button.parentElement).toBe(row);
  });

  it("each button may shrink: `min-w-0 overflow-hidden px-2`, its label `truncate`, its icon only from xl", () => {
    renderCard();
    for (const button of actions()) {
      expect(button).toHaveClass("min-w-0", "overflow-hidden", "px-2");
      expect(button.className).not.toMatch(/flex-1/);
      const label = button.querySelector("span") as HTMLElement;
      expect(label).toHaveClass("truncate");
      const icon = button.querySelector("svg") as SVGElement;
      expect(icon).toHaveClass("hidden", "xl:inline-block");
    }
  });
});

describe("F0-8 — the Location Breakdown", () => {
  it("is not rendered while collapsed", () => {
    renderCard();
    expect(screen.queryByText("Shelf 1")).toBeNull();
  });

  it("renders every location when expanded, with no height clip", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /Location Breakdown/ }));
    expect(screen.getByText("Shelf 1")).toBeInTheDocument();
    expect(screen.getByText("Shelf 12")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /Location Breakdown/ });
    const section = toggle.parentElement as HTMLElement;
    for (let el: HTMLElement | null = screen.getByText("Shelf 12").parentElement; el && el !== section; el = el.parentElement) {
      expect(el.className).not.toMatch(/max-h-/);
      expect(el.className).not.toMatch(/overflow-hidden/);
    }
  });
});
