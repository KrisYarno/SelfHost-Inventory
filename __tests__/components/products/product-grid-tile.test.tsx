/** @jest-environment jsdom */
//
// Facelift F2-8 — `ProductGridTile`, the Grid view at every width (plan
// 2026-11-19-facelift-f2: F2-8, A19 (the name), A24 (`pr-12`), B2, B3, B12).
//   - `relative rounded-lg border bg-surface`, holding a full-tile
//     `<button type="button">` (`p-3 text-left min-h-28`) named like the row;
//   - the name `text-sm font-semibold line-clamp-2`, the variant, the pending
//     badge, the F2-6 figure at the bottom; the text block is `pr-12`;
//   - B3: the "…" sits in a WRAPPER `absolute right-1 top-1`; the Button inside
//     has no `absolute` and keeps the 44 px floor (f1-touch-floor's sweep);
//   - no icon (but the "…"), aspect ratio or ribbon.

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { ProductGridTile } from "@/components/products/product-grid-tile";
import { toneClasses } from "@/components/ui/tone-classes";
import type { ProductWithQuantity } from "@/types/product";

const base = {
  id: 9,
  name: "Long Widget Name 10mg",
  baseName: "Long Widget Name",
  variant: "10mg",
  approvalStatus: "APPROVED",
  currentQuantity: 48,
  totalQuantity: 48,
  hereQuantity: 4,
  stockState: "low",
  costPrice: null,
  retailPrice: null,
};
const make = (over: Record<string, unknown> = {}) => ({ ...base, ...over }) as unknown as ProductWithQuantity;

function renderTile(product = make()) {
  return render(
    <ProductGridTile
      product={product}
      isAdmin={false}
      hereLocationId={1}
      selectedLocationId={1}
      onAdjust={jest.fn()}
      onStockIn={jest.fn()}
    />
  );
}

const mainButton = () => screen.getByRole("button", { name: "Adjust stock for Long Widget Name 10mg" });
const dots = () => screen.getByRole("button", { name: "More actions for Long Widget Name 10mg" });

describe("F2-8 ProductGridTile (A19) — structure, strings and classes", () => {
  it("the tile is relative rounded-lg border bg-surface, holding the full-tile button and the \"…\" wrapper", () => {
    const { container } = renderTile();
    const tile = container.firstElementChild as HTMLElement;
    expect(tile).toHaveClass("relative", "rounded-lg", "border", "bg-surface");
    expect(Array.from(tile.children)).toEqual([mainButton(), dots().parentElement]);
  });

  it("the full-tile button: type=button, p-3 text-left min-h-28, the same name as the row", () => {
    renderTile();
    const btn = mainButton();
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toHaveClass("p-3", "text-left", "min-h-28", "w-full", "h-full");
  });

  it("C1 (REV 5 R15): the main button carries the ONE focus ring of DESIGN §1.1", () => {
    renderTile();
    expect(mainButton()).toHaveClass(
      "rounded-md",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    );
  });

  it("the name is text-sm font-semibold line-clamp-2; the text block is pr-12 (A24), clear of the \"…\"", () => {
    renderTile();
    const name = within(mainButton()).getByText("Long Widget Name", { exact: true });
    expect(name).toHaveClass("text-sm", "font-semibold", "line-clamp-2");
    expect(name.parentElement).toHaveClass("pr-12");
    expect(within(name.parentElement!).getByText("10mg")).toBeInTheDocument();
  });

  it("the F2-6 figure is at the bottom of the button (after the text block, mt-auto)", () => {
    renderTile();
    const btn = mainButton();
    const figure = within(btn).getByText("48", { exact: true }).closest("[id]") as HTMLElement;
    expect(figure.parentElement).toBe(btn);
    expect(btn.lastElementChild).toBe(figure);
    expect(figure).toHaveClass("mt-auto");
    expect(within(figure).getByText("Low")).toBeInTheDocument();
    expect(within(figure).getByText("4 here")).toBeInTheDocument();
  });

  it("B3: the \"…\" wrapper is a div at absolute right-1 top-1; the Button itself has no absolute and keeps the 44 px floor", () => {
    renderTile();
    const wrapper = dots().parentElement!;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper).toHaveClass("absolute", "right-1", "top-1");
    const cls = (dots().getAttribute("class") ?? "").split(/\s+/);
    expect(cls).not.toContain("absolute");
    expect(cls).toEqual(expect.arrayContaining(["max-md:min-h-11", "max-md:min-w-11"]));
  });

  it("no icon (only the \"…\"'s), no aspect ratio, no ribbon, no inline glow", () => {
    const { container } = renderTile(make({ totalQuantity: 0, stockState: "out" }));
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(dots().contains(svgs[0])).toBe(true);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      expect(el.getAttribute("class") ?? "").not.toMatch(/aspect-|active:scale|rotate-45/);
    }
    expect(screen.queryByText("OUT")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });
});

describe("F2-8 ProductGridTile — the pending badge and the description", () => {
  it("PENDING_REVIEW -> an info StatusBadge `Pending review` in the text block", () => {
    renderTile(make({ approvalStatus: "PENDING_REVIEW" }));
    const badge = within(mainButton()).getByText("Pending review", { exact: true });
    expect(badge).toHaveClass(...toneClasses.info.split(" "));
    expect(badge.parentElement).toHaveClass("pr-12");
  });

  it("APPROVED -> no pending badge", () => {
    renderTile();
    expect(screen.queryByText("Pending review")).toBeNull();
  });

  it("B12: the description carries the total, the state word, the here line and the pending badge", () => {
    renderTile(make({ approvalStatus: "PENDING_REVIEW" }));
    const btn = mainButton();
    expect(btn).toHaveAccessibleDescription(/\b48\b/);
    expect(btn).toHaveAccessibleDescription(/\bLow\b/);
    expect(btn).toHaveAccessibleDescription(/\b4 here\b/);
    expect(btn).toHaveAccessibleDescription(/Pending review/);
  });
});
