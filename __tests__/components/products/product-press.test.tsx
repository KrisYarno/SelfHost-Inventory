/** @jest-environment jsdom */
//
// Facelift F2-7 / F2-8 — the press on a product's main button, for BOTH the
// List row (`ProductRow`) and the Grid tile (`ProductGridTile`) (plan
// 2026-11-19-facelift-f2: A2's pins as replaced by B6; recipe B14).
//   - a tap opens Adjust stock; a touch long press (500 ms) opens the actions
//     menu (the SAME instance as the "…") and its click is ignored;
//   - 499 ms, > 10 px movement, and a `#main` scroll cancel;
//   - a mouse never long-presses (a slow click opens Adjust); right-click does;
//   - B6's window: fire + hold 1000 ms + up + click -> ignored; a click 700 ms
//     after the up -> Adjust; a keyboard click is never ignored.
// "Fires once" is pinned at the hook level (use-long-press.test.tsx): the
// opener is idempotent, so a second fire is invisible here.

import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductRow } from "@/components/products/product-row";
import { ProductGridTile } from "@/components/products/product-grid-tile";
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

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const product = {
  id: 7,
  name: "Widget 10mg",
  baseName: "Widget",
  variant: "10mg",
  approvalStatus: "APPROVED",
  currentQuantity: 48,
  totalQuantity: 48,
  hereQuantity: 4,
  stockState: "ok",
  costPrice: null,
  retailPrice: null,
} as unknown as ProductWithQuantity;

const at = (pointerType: string, x = 50, y = 20, button = 0) => ({ pointerType, pointerId: 1, button, clientX: x, clientY: y });
const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

describe.each([
  ["ProductRow", ProductRow],
  ["ProductGridTile", ProductGridTile],
] as const)("%s — the press", (_name, View) => {
  function setup() {
    const onAdjust = jest.fn();
    const onStockIn = jest.fn();
    render(
      <div id="main">
        <View
          product={product}
          isAdmin={false}
          hereLocationId={1}
          selectedLocationId={1}
          onAdjust={onAdjust}
          onStockIn={onStockIn}
        />
      </div>
    );
    const main = screen.getByRole("button", { name: "Adjust stock for Widget 10mg" });
    const dots = screen.getByRole("button", { name: "More actions for Widget 10mg" });
    const menuIsOpen = () => screen.queryByRole("menu") !== null;
    /** A whole tap: down, a short hold, up, and the pointer's click. */
    const tap = (type = "touch", holdMs = 80) => {
      fireEvent.pointerDown(main, at(type));
      advance(holdMs);
      fireEvent.pointerUp(main, at(type));
      fireEvent.click(main, { detail: 1 });
    };
    return { main, dots, onAdjust, menuIsOpen, tap };
  }

  it("a short touch tap opens Adjust stock (with the product) and no menu", () => {
    const { onAdjust, menuIsOpen, tap } = setup();
    tap();
    expect(onAdjust).toHaveBeenCalledTimes(1);
    expect(onAdjust).toHaveBeenCalledWith(product);
    expect(menuIsOpen()).toBe(false);
  });

  it("touch, 500 ms -> the menu opens; the release's click does NOT open Adjust", () => {
    const { main, onAdjust, menuIsOpen } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(499);
    expect(menuIsOpen()).toBe(false);
    advance(1);
    expect(menuIsOpen()).toBe(true);
    fireEvent.pointerUp(main, at("touch"));
    fireEvent.click(main, { detail: 1 });
    expect(onAdjust).not.toHaveBeenCalled();
    expect(menuIsOpen()).toBe(true);
  });

  it("the long press opens the SAME menu instance as the \"…\" (anchored to it)", () => {
    const { main, dots } = setup();
    expect(dots).toHaveAttribute("aria-expanded", "false");
    fireEvent.pointerDown(main, at("touch"));
    advance(500);
    expect(dots).toHaveAttribute("aria-expanded", "true");
    expect(dots.getAttribute("aria-controls")).toBe(screen.getByRole("menu").id);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });

  it("touch, 499 ms -> no menu, and the tap opens Adjust", () => {
    const { onAdjust, menuIsOpen, tap } = setup();
    tap("touch", 499);
    advance(1000);
    expect(menuIsOpen()).toBe(false);
    expect(onAdjust).toHaveBeenCalledTimes(1);
  });

  it("moving more than 10 px cancels the press", () => {
    const { main, menuIsOpen } = setup();
    fireEvent.pointerDown(main, at("touch", 50, 20));
    fireEvent.pointerMove(main, at("touch", 50, 31));
    advance(1000);
    expect(menuIsOpen()).toBe(false);
  });

  it("a #main scroll cancels the press", () => {
    const { main, menuIsOpen } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(200);
    fireEvent.scroll(document.getElementById("main")!);
    advance(1000);
    expect(menuIsOpen()).toBe(false);
  });

  it("a fire with NO following click, then a fresh tap -> Adjust opens", () => {
    const { main, onAdjust, menuIsOpen, tap } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(500);
    expect(menuIsOpen()).toBe(true);
    fireEvent.pointerUp(main, at("touch"));
    // No click arrives. 100 ms later (inside the 600 ms window), a fresh tap:
    advance(100);
    tap();
    expect(onAdjust).toHaveBeenCalledTimes(1);
  });

  it("a fire, then a click within 600 ms -> ignored", () => {
    const { main, onAdjust } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(500);
    fireEvent.pointerUp(main, at("touch"));
    advance(400);
    fireEvent.click(main, { detail: 1 });
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("contextmenu, then the timer -> the menu opens ONCE and stays open", () => {
    const { main, onAdjust, menuIsOpen } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(300);
    expect(fireEvent.contextMenu(main)).toBe(false); // preventDefault
    expect(menuIsOpen()).toBe(true);
    advance(1000); // the cancelled timer's 500 ms passes
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    fireEvent.pointerUp(main, at("touch"));
    fireEvent.click(main, { detail: 1 });
    expect(menuIsOpen()).toBe(true);
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("a desktop right-click opens the menu, never Adjust", () => {
    const { main, onAdjust, menuIsOpen } = setup();
    fireEvent.pointerDown(main, at("mouse", 50, 20, 2));
    expect(fireEvent.contextMenu(main)).toBe(false);
    fireEvent.pointerUp(main, at("mouse", 50, 20, 2));
    expect(menuIsOpen()).toBe(true);
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("a mouse held for 600 ms, then click -> Adjust opens and the menu doesn't", () => {
    const { onAdjust, menuIsOpen, tap } = setup();
    tap("mouse", 600);
    expect(onAdjust).toHaveBeenCalledTimes(1);
    expect(menuIsOpen()).toBe(false);
  });

  it("B6: fire, hold 1000 ms, pointerup, click -> ignored", () => {
    const { main, onAdjust } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(500);
    advance(1000);
    fireEvent.pointerUp(main, at("touch"));
    fireEvent.click(main, { detail: 1 });
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("B6: fire, pointerup, a click 700 ms later -> NOT ignored (Adjust opens)", () => {
    const { main, onAdjust } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(500);
    fireEvent.pointerUp(main, at("touch"));
    advance(700);
    fireEvent.click(main, { detail: 1 });
    expect(onAdjust).toHaveBeenCalledTimes(1);
  });

  it("B6: a keyboard click (detail 0) is never ignored, even while the fired press is down", () => {
    const { main, onAdjust } = setup();
    fireEvent.pointerDown(main, at("touch"));
    advance(500);
    fireEvent.click(main, { detail: 0 });
    expect(onAdjust).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(main, at("touch"));
    fireEvent.click(main, { detail: 0 });
    expect(onAdjust).toHaveBeenCalledTimes(2);
  });

  it("Enter and Space on the focused main button open Adjust", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { main, onAdjust } = setup();
    act(() => main.focus());
    await user.keyboard("{Enter}");
    expect(onAdjust).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onAdjust).toHaveBeenCalledTimes(2);
  });

  it("B2: the pressed element carries select-none [-webkit-user-select:none] [-webkit-touch-callout:none]", () => {
    const { main } = setup();
    expect(main).toHaveClass("select-none", "[-webkit-user-select:none]", "[-webkit-touch-callout:none]");
  });
});
