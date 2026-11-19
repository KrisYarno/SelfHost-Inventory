/** @jest-environment jsdom */
//
// Facelift F2-8 — `ProductRow`, the List view below `lg` (plan
// 2026-11-19-facelift-f2: F2-8, A3 -> B12, A15, B2; F2-11's carried behaviour
// of the retired pending-glow test: pending review is indicated).
//   - `flex min-h-14 items-center gap-2 px-3`; the main area is a
//     `<button type="button">` (`min-w-0 flex-1 text-left`),
//     `Adjust stock for {name}`, then the "…";
//   - baseName / variant classes; `Pending review` (info) on the variant line;
//   - the F2-6 figure right-aligned inside the main button;
//   - no icon, aspect ratio, ribbon, active:scale or absolute child;
//   - B12: the accessible description is the figure's text + the here line +
//     the pending badge, through per-instance `useId` ids.
// The press itself (tap / long press / click guard) is pinned in
// product-press.test.tsx for the row and the tile alike.

import * as React from "react";
import fs from "fs";
import path from "path";
import { render, screen, within } from "@testing-library/react";
import { ProductRow } from "@/components/products/product-row";
import { toneClasses } from "@/components/ui/tone-classes";
import type { ProductWithQuantity } from "@/types/product";

const base = {
  id: 7,
  name: "Widget 10mg",
  baseName: "Widget",
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

function renderRow(product = make(), { here = 1 as number | null, selected = 1 as number | null } = {}) {
  return render(
    <ProductRow
      product={product}
      isAdmin={false}
      hereLocationId={here}
      selectedLocationId={selected}
      onAdjust={jest.fn()}
      onStockIn={jest.fn()}
    />
  );
}

const mainButton = () => screen.getByRole("button", { name: /^Adjust stock for / });

describe("F2-8 ProductRow — structure, strings and classes", () => {
  it("the row is flex min-h-14 items-center gap-2 px-3: the main button, then the \"…\"", () => {
    const { container } = renderRow();
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveClass("flex", "min-h-14", "items-center", "gap-2", "px-3");
    const children = Array.from(row.children);
    expect(children).toHaveLength(2);
    expect(children[0]).toBe(mainButton());
    expect(children[1]).toBe(screen.getByRole("button", { name: "More actions for Widget 10mg" }));
  });

  it("the main area is <button type=button> min-w-0 flex-1 text-left, named Adjust stock for {name}", () => {
    renderRow();
    const btn = mainButton();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toHaveAttribute("aria-label", "Adjust stock for Widget 10mg");
    expect(btn).toHaveClass("min-w-0", "flex-1", "text-left");
  });

  it("baseName is text-sm font-semibold truncate; the variant under it is text-xs text-muted-foreground truncate", () => {
    renderRow();
    expect(within(mainButton()).getByText("Widget", { exact: true })).toHaveClass("text-sm", "font-semibold", "truncate");
    expect(within(mainButton()).getByText("10mg", { exact: true })).toHaveClass("text-xs", "text-muted-foreground", "truncate");
  });

  it("the F2-6 figure sits inside the main button, right-aligned", () => {
    renderRow();
    const total = within(mainButton()).getByText("48", { exact: true });
    const figure = total.closest("[id]") as HTMLElement;
    expect(mainButton().contains(figure)).toBe(true);
    expect(figure).toHaveClass("items-end", "text-right");
    expect(within(figure).getByText("Low")).toBeInTheDocument();
    expect(within(figure).getByText("4 here")).toBeInTheDocument();
  });

  it("no icon (only the \"…\"'s), no aspect ratio, no ribbon, no active:scale, no absolutely positioned child", () => {
    const { container } = renderRow(make({ totalQuantity: 0, stockState: "out" }));
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(screen.getByRole("button", { name: "More actions for Widget 10mg" }).contains(svgs[0])).toBe(true);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/);
      expect(cls).not.toMatch(/aspect-|active:scale|rotate-45/);
    }
    expect(screen.queryByText("OUT")).toBeNull(); // the old ribbon
    expect(container.querySelector("[style]")).toBeNull(); // the old inline glow
  });
});

describe("F2-8 ProductRow — the pending badge (carried from the retired pending-glow test)", () => {
  it("PENDING_REVIEW -> an info StatusBadge `Pending review` on the variant line", () => {
    renderRow(make({ approvalStatus: "PENDING_REVIEW" }));
    const badge = within(mainButton()).getByText("Pending review", { exact: true });
    expect(badge).toHaveClass(...toneClasses.info.split(" "));
    expect(badge.parentElement).toBe(within(mainButton()).getByText("10mg").parentElement);
  });

  it("PENDING_REVIEW with no variant still shows the badge", () => {
    renderRow(make({ approvalStatus: "PENDING_REVIEW", variant: null }));
    expect(within(mainButton()).getByText("Pending review")).toBeInTheDocument();
  });

  it("APPROVED -> no pending badge", () => {
    renderRow();
    expect(screen.queryByText("Pending review")).toBeNull();
  });
});

describe("B12 — the main button's accessible description", () => {
  it("carries the total, the state word and the here line", () => {
    renderRow();
    const btn = mainButton();
    expect(btn).toHaveAccessibleDescription(/\b48\b/);
    expect(btn).toHaveAccessibleDescription(/\bLow\b/);
    expect(btn).toHaveAccessibleDescription(/\b4 here\b/);
    expect(btn).not.toHaveAccessibleDescription(/Pending review/);
  });

  it("adds the pending badge when pending", () => {
    renderRow(make({ approvalStatus: "PENDING_REVIEW" }));
    expect(mainButton()).toHaveAccessibleDescription(/48 Low 4 here Pending review/);
  });

  it("a null total: no — in the description; the No record badge carries it", () => {
    renderRow(make({ totalQuantity: null, hereQuantity: null, stockState: "no-record" }));
    const btn = mainButton();
    expect(btn).toHaveAccessibleDescription(/\bNo record\b/);
    expect(btn).toHaveAccessibleDescription(/No record here/);
    expect(btn).not.toHaveAccessibleDescription(/—/);
  });

  it("no here line in the description when the echo is for another location", () => {
    renderRow(make(), { here: 2, selected: 1 });
    expect(mainButton()).toHaveAccessibleDescription(/\b48\b/);
    expect(mainButton()).not.toHaveAccessibleDescription(/here/);
  });

  it("the ids are per instance: two rows never share one", () => {
    render(
      <>
        <ProductRow product={make({ approvalStatus: "PENDING_REVIEW" })} isAdmin={false} hereLocationId={1} selectedLocationId={1} onAdjust={jest.fn()} onStockIn={jest.fn()} />
        <ProductRow product={make({ id: 8, name: "Gadget", approvalStatus: "PENDING_REVIEW" })} isAdmin={false} hereLocationId={1} selectedLocationId={1} onAdjust={jest.fn()} onStockIn={jest.fn()} />
      </>
    );
    const [a, b] = screen.getAllByRole("button", { name: /^Adjust stock for / });
    const idsA = a.getAttribute("aria-describedby")!.split(" ");
    const idsB = b.getAttribute("aria-describedby")!.split(" ");
    expect(idsA).toHaveLength(2);
    expect(idsB).toHaveLength(2);
    for (const id of [...idsA, ...idsB]) expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
    expect(new Set([...idsA, ...idsB]).size).toBe(4);
  });
});

describe("F2-8 — the F2b views never use the retired cards", () => {
  it.each([
    "components/products/product-row.tsx",
    "components/products/product-grid-tile.tsx",
    "components/products/product-table.tsx",
    "components/products/product-actions-menu.tsx",
    "components/products/product-stock.tsx",
  ])("%s imports neither ProductCard nor ProductCardMobile, nor useIsMobile", (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    expect(src).not.toMatch(/product-card(-mobile)?["']/);
    expect(src).not.toMatch(/\bProductCard(Mobile)?\b/);
    expect(src).not.toMatch(/use-is-mobile|useIsMobile/);
  });
});
