/** @jest-environment jsdom */
//
// Facelift F2-7 — `ProductActionsMenu` (plan 2026-11-19-facelift-f2: F2-7 as
// replaced by A2 and B7; F2-11's carried behaviours of the retired
// product-card-analytics-link test: the Analytics and History links).
//   - one controlled DropdownMenu; its trigger is the 44 px "…"
//     (`Button variant="ghost" size="icon"`, `More actions for {name}`);
//   - the items in order, per role; each calls its handler; the links;
//   - B7: a touch / pen pointerdown alone never opens; its click does; a mouse
//     opens on Radix's pointerdown and the following click does NOT close it;
//     Enter / Space open through Radix's keydown.

import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductActionsMenu } from "@/components/products/product-actions-menu";
import type { ProductWithQuantity } from "@/types/product";

class PointerEvent extends MouseEvent {
  pointerType: string;
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
    this.pointerId = init.pointerId ?? 0;
  }
}

// Radix's menu needs pointer capture + scrollIntoView, which jsdom lacks
// (the recipe of product-card-analytics-link.test.tsx:10-15).
beforeAll(() => {
  Object.defineProperty(window, "PointerEvent", { value: PointerEvent, configurable: true, writable: true });
  Element.prototype.hasPointerCapture = jest.fn(() => false) as never;
  Element.prototype.setPointerCapture = jest.fn() as never;
  Element.prototype.releasePointerCapture = jest.fn() as never;
  Element.prototype.scrollIntoView = jest.fn() as never;
});
afterAll(() => {
  delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
});

const product = {
  id: 42,
  name: "Widget 10mg",
  baseName: "Widget",
  variant: "10mg",
  approvalStatus: "APPROVED",
  currentQuantity: 5,
  totalQuantity: 5,
  hereQuantity: 5,
  stockState: "low",
  costPrice: null,
  retailPrice: null,
} as unknown as ProductWithQuantity;

type Handlers = {
  onAdjust: jest.Mock; onStockIn: jest.Mock; onEdit?: jest.Mock; onDelete?: jest.Mock; onOpenChange: jest.Mock;
};

function Harness({ isAdmin, initialOpen = false, handlers }: { isAdmin: boolean; initialOpen?: boolean; handlers: Handlers }) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <ProductActionsMenu
      product={product}
      isAdmin={isAdmin}
      open={open}
      onOpenChange={(next) => {
        handlers.onOpenChange(next);
        setOpen(next);
      }}
      onAdjust={handlers.onAdjust}
      onStockIn={handlers.onStockIn}
      onEdit={handlers.onEdit}
      onDelete={handlers.onDelete}
    />
  );
}

function setup({ isAdmin = false, initialOpen = false, adminHandlers = true } = {}) {
  const handlers: Handlers = {
    onAdjust: jest.fn(),
    onStockIn: jest.fn(),
    onOpenChange: jest.fn(),
    ...(adminHandlers ? { onEdit: jest.fn(), onDelete: jest.fn() } : {}),
  };
  render(<Harness isAdmin={isAdmin} initialOpen={initialOpen} handlers={handlers} />);
  return handlers;
}

const trigger = () => screen.getByRole("button", { name: "More actions for Widget 10mg", hidden: true });
const menuIsOpen = () => screen.queryByRole("menu") !== null;
/** The menu's items and separators in DOM order. */
const sequence = () =>
  Array.from(screen.getByRole("menu").querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
    el.getAttribute("role") === "separator" ? "---" : el.textContent
  );

describe("F2-7 — the trigger", () => {
  it("is the ghost icon Button, More actions for {name}, with the MoreHorizontal icon and the 44 px phone floor", () => {
    setup();
    const t = trigger();
    expect(t).toHaveAttribute("aria-label", "More actions for Widget 10mg");
    expect(t).toHaveAttribute("aria-haspopup", "menu");
    const cls = (t.getAttribute("class") ?? "").split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["h-9", "w-9", "max-md:min-h-11", "max-md:min-w-11"]));
    expect(cls).toContain("hover:bg-surface-hover"); // variant="ghost"
    expect(cls.some((c) => /^(absolute|relative|fixed)$/.test(c))).toBe(false);
    expect(t.querySelector("svg.lucide-ellipsis")).not.toBeNull(); // MoreHorizontal
    expect(menuIsOpen()).toBe(false);
  });
});

describe("F2-7 — the items, in order, per role", () => {
  it("a member: Adjust stock, Stock In, ---, Analytics, History (no Edit / Delete even with handlers)", () => {
    setup({ isAdmin: false, initialOpen: true });
    expect(sequence()).toEqual(["Adjust stock", "Stock In", "---", "Analytics", "History"]);
  });

  it("an admin: ... then ---, Edit, Delete", () => {
    setup({ isAdmin: true, initialOpen: true });
    expect(sequence()).toEqual(["Adjust stock", "Stock In", "---", "Analytics", "History", "---", "Edit", "Delete"]);
  });

  it("an admin with no edit / delete handlers gets no admin separator or items", () => {
    setup({ isAdmin: true, initialOpen: true, adminHandlers: false });
    expect(sequence()).toEqual(["Adjust stock", "Stock In", "---", "Analytics", "History"]);
  });

  it("each item carries its icon; Delete is text-destructive", () => {
    setup({ isAdmin: true, initialOpen: true });
    const icon = (name: string, cls: string) =>
      expect(screen.getByRole("menuitem", { name }).querySelector(`svg.${cls}`)).not.toBeNull();
    icon("Adjust stock", "lucide-sliders-horizontal");
    icon("Stock In", "lucide-package-plus");
    icon("Analytics", "lucide-trending-up");
    icon("History", "lucide-history");
    icon("Edit", "lucide-square-pen"); // lucide's Edit
    icon("Delete", "lucide-trash-2");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("text-destructive");
    expect(screen.getByRole("menuitem", { name: "Edit" })).not.toHaveClass("text-destructive");
  });

  it("the content is aligned to the end of the trigger", () => {
    setup({ initialOpen: true });
    expect(screen.getByRole("menu")).toHaveAttribute("data-align", "end");
  });

  it("Analytics links to /analytics/product/{id}; History to ?tab=history (carried from the retired card test)", () => {
    setup({ initialOpen: true });
    const analytics = screen.getByRole("menuitem", { name: "Analytics" });
    expect(analytics.tagName).toBe("A");
    expect(analytics).toHaveAttribute("href", "/analytics/product/42");
    const history = screen.getByRole("menuitem", { name: "History" });
    expect(history.tagName).toBe("A");
    expect(history).toHaveAttribute("href", "/analytics/product/42?tab=history");
  });
});

describe("F2-7 — each item calls its handler with the product", () => {
  it.each([
    ["Adjust stock", "onAdjust"],
    ["Stock In", "onStockIn"],
    ["Edit", "onEdit"],
    ["Delete", "onDelete"],
  ] as const)("%s -> %s(product), and the menu closes", async (name, key) => {
    const user = userEvent.setup();
    const handlers = setup({ isAdmin: true, initialOpen: true });
    await user.click(screen.getByRole("menuitem", { name }));
    expect(handlers[key]).toHaveBeenCalledTimes(1);
    expect(handlers[key]).toHaveBeenCalledWith(product);
    for (const other of ["onAdjust", "onStockIn", "onEdit", "onDelete"] as const) {
      if (other !== key) expect(handlers[other]).not.toHaveBeenCalled();
    }
    expect(handlers.onOpenChange).toHaveBeenLastCalledWith(false);
    expect(menuIsOpen()).toBe(false);
  });

  it("a keyboard Enter on an item selects it too", async () => {
    const user = userEvent.setup();
    const handlers = setup({ initialOpen: true });
    act(() => screen.getByRole("menuitem", { name: "Stock In" }).focus());
    await user.keyboard("{Enter}");
    expect(handlers.onStockIn).toHaveBeenCalledWith(product);
  });
});

describe("B7 — telling touch from mouse on the \"…\"", () => {
  const press = (pointerType: string) => ({ pointerType, pointerId: 1, button: 0, ctrlKey: false });

  it.each(["touch", "pen"])("a %s pointerdown ALONE leaves it closed; the click that follows opens it", (type) => {
    const handlers = setup();
    const t = trigger();
    // preventDefault() on a non-mouse pointerdown: Radix's own open is skipped.
    expect(fireEvent.pointerDown(t, press(type))).toBe(false);
    expect(menuIsOpen()).toBe(false);
    expect(handlers.onOpenChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(t, press(type));
    fireEvent.click(t, { detail: 1 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenChange).toHaveBeenCalledWith(true);
  });

  it("a mouse pointerdown opens it (Radix), and the click that follows does NOT close it", () => {
    const handlers = setup();
    const t = trigger();
    fireEvent.pointerDown(t, press("mouse"));
    expect(menuIsOpen()).toBe(true);
    fireEvent.pointerUp(t, press("mouse"));
    fireEvent.click(t, { detail: 1 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("a real mouse click (user-event's full sequence) opens it and leaves it open", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(trigger());
    expect(menuIsOpen()).toBe(true);
  });

  it("a click with no pointerdown before it (a synthetic click) does not toggle", () => {
    const handlers = setup();
    fireEvent.click(trigger());
    expect(menuIsOpen()).toBe(false);
    expect(handlers.onOpenChange).not.toHaveBeenCalled();
  });

  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("%s on the focused \"…\" opens it (Radix's keydown)", async (_name, keys) => {
    const user = userEvent.setup();
    const handlers = setup();
    act(() => trigger().focus());
    await user.keyboard(keys);
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("opening by keyboard lands focus inside the menu", async () => {
    const user = userEvent.setup();
    setup();
    act(() => trigger().focus());
    await user.keyboard("{Enter}");
    expect(within(screen.getByRole("menu")).queryAllByRole("menuitem").length).toBeGreaterThan(0);
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
  });
});
