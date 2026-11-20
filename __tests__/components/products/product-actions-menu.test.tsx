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
//
// Fix round FR1 (REV 7):
//   - FR1-1: a menu the owner opened by a PRESS (`openedByPress`) never
//     chooses an item by itself: until a pointerdown inside the menu, an item's
//     pointerup is default-prevented (Radix skips its click) and a pointer
//     click is refused (no handler, menu open, a link does not navigate). Any
//     button but the primary never chooses on pointerup. A keyboard selection
//     (detail 0) always works. A "…"-opened menu works as before.
//   - FR1-7: a `pointercancel` clears the recorded pointer type; a trigger click
//     with `detail === 0` only ever OPENS (never toggles closed). This AMENDS
//     B7's "a click with no pointerdown does not toggle" to a POINTER click
//     (detail 1): a detail-0 click with no pointerdown now opens.
//   - NOT built (stopped, see the FR1 report): FR1-7's "cleared on
//     `pointerleave`". A touch tap fires `pointerleave` right after `pointerup`
//     and BEFORE its click, so clearing there would stop every touch tap from
//     opening the "…"; the browsers' real order is pinned below.

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

function Harness({
  isAdmin,
  initialOpen = false,
  openedByPress = false,
  handlers,
}: {
  isAdmin: boolean;
  initialOpen?: boolean;
  openedByPress?: boolean;
  handlers: Handlers;
}) {
  const [open, setOpen] = React.useState(initialOpen);
  return (
    <ProductActionsMenu
      product={product}
      isAdmin={isAdmin}
      open={open}
      openedByPress={openedByPress}
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

function setup({ isAdmin = false, initialOpen = false, adminHandlers = true, openedByPress = false } = {}) {
  const handlers: Handlers = {
    onAdjust: jest.fn(),
    onStockIn: jest.fn(),
    onOpenChange: jest.fn(),
    ...(adminHandlers ? { onEdit: jest.fn(), onDelete: jest.fn() } : {}),
  };
  render(<Harness isAdmin={isAdmin} initialOpen={initialOpen} openedByPress={openedByPress} handlers={handlers} />);
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

  it("a POINTER click (detail 1) with no pointerdown before it does not toggle (FR1-7 amends this pin: detail 0 now opens)", () => {
    const handlers = setup();
    fireEvent.click(trigger(), { detail: 1 });
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

describe("FR1-7 — the \"…\" for keyboards and assistive technology", () => {
  const press = (pointerType: string) => ({ pointerType, pointerId: 1, button: 0, ctrlKey: false });

  it("a detail: 0 click with no pointerdown opens the menu", () => {
    const handlers = setup();
    fireEvent.click(trigger(), { detail: 0 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("Space keydown, then a detail: 0 click -> open (not toggled closed)", () => {
    const handlers = setup();
    fireEvent.keyDown(trigger(), { key: " " });
    expect(menuIsOpen()).toBe(true);
    fireEvent.click(trigger(), { detail: 0 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("a touch pointerdown, then pointercancel, then later a keyboard Space (keydown + its detail-0 click) -> open", () => {
    const handlers = setup();
    const t = trigger();
    fireEvent.pointerDown(t, press("touch"));
    fireEvent.pointerCancel(t, press("touch"));
    expect(menuIsOpen()).toBe(false);
    fireEvent.keyDown(t, { key: " " });
    fireEvent.click(t, { detail: 0 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange.mock.calls).toEqual([[true]]);
  });

  it("a pointercancel clears the recorded type: a later POINTER click with no pointerdown does not toggle", () => {
    const handlers = setup();
    const t = trigger();
    fireEvent.pointerDown(t, press("touch"));
    fireEvent.pointerCancel(t, press("touch"));
    fireEvent.click(t, { detail: 1 });
    expect(menuIsOpen()).toBe(false);
    expect(handlers.onOpenChange).not.toHaveBeenCalled();
  });

  it("a detail: 0 click on an OPEN menu's trigger never closes it", () => {
    const handlers = setup({ initialOpen: true });
    fireEvent.click(trigger(), { detail: 0 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange).not.toHaveBeenCalled();
  });

  it("a touch tap in the browsers' real order (pointerdown, pointerup, pointerout, pointerleave, click) opens it", () => {
    // A pointer without hover fires pointerout + pointerleave right after its
    // pointerup, BEFORE the click: the recorded type must survive pointerleave.
    const handlers = setup();
    const t = trigger();
    fireEvent.pointerDown(t, press("touch"));
    fireEvent.pointerUp(t, press("touch"));
    fireEvent.pointerOut(t, press("touch"));
    fireEvent.pointerLeave(t, press("touch"));
    fireEvent.click(t, { detail: 1 });
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange.mock.calls).toEqual([[true]]);
  });
});

describe("FR1-1 — a press-opened menu never fires an item by itself", () => {
  const item = (name: string) => screen.getByRole("menuitem", { name });
  const mouse = (button: number) => ({ pointerType: "mouse", pointerId: 1, button });

  it.each([2, 0])(
    "openedByPress: a button-%i pointerup on an item with no pointerdown inside -> default-prevented, no handler, the menu open",
    (button) => {
      const handlers = setup({ isAdmin: true, initialOpen: true, openedByPress: true });
      expect(fireEvent.pointerUp(item("Delete"), mouse(button))).toBe(false);
      expect(handlers.onDelete).not.toHaveBeenCalled();
      expect(handlers.onOpenChange).not.toHaveBeenCalled();
      expect(menuIsOpen()).toBe(true);
    },
  );

  it("openedByPress: a pointer click on an item with no pointerdown inside -> refused (no handler, menu open)", () => {
    const handlers = setup({ isAdmin: true, initialOpen: true, openedByPress: true });
    for (const [name, key] of [
      ["Adjust stock", "onAdjust"],
      ["Stock In", "onStockIn"],
      ["Edit", "onEdit"],
      ["Delete", "onDelete"],
    ] as const) {
      expect(fireEvent.click(item(name), { detail: 1 })).toBe(false);
      expect(handlers[key]).not.toHaveBeenCalled();
    }
    expect(menuIsOpen()).toBe(true);
    expect(handlers.onOpenChange).not.toHaveBeenCalled();
  });

  it("openedByPress: a link item's pointer click is default-prevented (no navigation) and the menu stays open", () => {
    setup({ initialOpen: true, openedByPress: true });
    expect(fireEvent.click(item("Analytics"), { detail: 1 })).toBe(false);
    expect(fireEvent.click(item("History"), { detail: 1 })).toBe(false);
    expect(menuIsOpen()).toBe(true);
  });

  it("then a pointerdown inside the menu clears the guard: pointerdown + click on the item runs its handler", () => {
    const handlers = setup({ initialOpen: true, openedByPress: true });
    fireEvent.click(item("Stock In"), { detail: 1 });
    expect(handlers.onStockIn).not.toHaveBeenCalled();
    fireEvent.pointerDown(item("Stock In"), mouse(0));
    fireEvent.pointerUp(item("Stock In"), mouse(0));
    fireEvent.click(item("Stock In"), { detail: 1 });
    expect(handlers.onStockIn).toHaveBeenCalledTimes(1);
    expect(handlers.onStockIn).toHaveBeenCalledWith(product);
    expect(menuIsOpen()).toBe(false);
  });

  it("a pointerdown anywhere inside the menu content clears it (not only on an item)", () => {
    const handlers = setup({ initialOpen: true, openedByPress: true });
    fireEvent.pointerDown(screen.getByRole("menu"), mouse(0));
    fireEvent.click(item("Adjust stock"), { detail: 1 });
    expect(handlers.onAdjust).toHaveBeenCalledTimes(1);
  });

  it("after a press-open, Enter on an item runs its handler (a keyboard selection always works)", () => {
    const handlers = setup({ initialOpen: true, openedByPress: true });
    act(() => item("Stock In").focus());
    fireEvent.keyDown(item("Stock In"), { key: "Enter" });
    expect(handlers.onStockIn).toHaveBeenCalledTimes(1);
    expect(menuIsOpen()).toBe(false);
  });

  it("a \"…\"-opened menu (openedByPress false) works as before: a primary pointerup with no pointerdown on the item chooses it (Radix's press-drag-release)", () => {
    const handlers = setup({ initialOpen: true, openedByPress: false });
    fireEvent.pointerUp(item("Stock In"), mouse(0));
    expect(handlers.onStockIn).toHaveBeenCalledTimes(1);
    expect(menuIsOpen()).toBe(false);
  });

  it("a \"…\"-opened menu: a pointer click with no pointerdown inside runs its handler", () => {
    const handlers = setup({ initialOpen: true, openedByPress: false });
    fireEvent.click(item("Adjust stock"), { detail: 1 });
    expect(handlers.onAdjust).toHaveBeenCalledTimes(1);
  });

  it("any button but the primary never chooses on its pointerup, even in a \"…\"-opened menu", () => {
    const handlers = setup({ initialOpen: true, openedByPress: false });
    expect(fireEvent.pointerUp(item("Stock In"), mouse(2))).toBe(false);
    expect(handlers.onStockIn).not.toHaveBeenCalled();
    expect(menuIsOpen()).toBe(true);
  });
});
