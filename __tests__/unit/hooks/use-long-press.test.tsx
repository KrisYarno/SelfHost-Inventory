/** @jest-environment jsdom */
//
// Facelift F2-7 — `useLongPress` (plan 2026-11-19-facelift-f2 REV 2 A2 as
// replaced by REV 3 B6; test recipe B14). Pinned at the HOOK level: the fire
// COUNT (callers pass an idempotent opener, so "fires once" is only visible
// here), the cancel paths, the `#main` scroll listener, and the click guard.
//
// Fix round FR1-3 (REV 7): a `pointerdown` within 150 ms of the last `#main`
// scroll starts NO timer (a finger stopping a fling is not a long press). ONE
// module-level record, kept by ONE passive capture listener on `#main`,
// installed on the first hook use and tolerant of `#main` being absent.
//
// jsdom 26 has no PointerEvent. The test-local polyfill adds ONLY `pointerType`
// and `pointerId`; `clientX` / `clientY` / `button` pass through MouseEvent's
// init (they are getter-only on jsdom's MouseEvent and are never assigned).

import * as React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLongPress } from "@/hooks/use-long-press";

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

const at = (pointerType: string, x = 100, y = 100, button = 0) => ({ pointerType, pointerId: 1, button, clientX: x, clientY: y });
const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

function Harness({ onLongPress, onClick }: { onLongPress: () => void; onClick: (ignored: boolean) => void }) {
  const { handlers, shouldIgnoreClick } = useLongPress(onLongPress);
  return (
    <button type="button" {...handlers} onClick={() => onClick(shouldIgnoreClick())}>
      Press
    </button>
  );
}

function setup({ withMain = false }: { withMain?: boolean } = {}) {
  const onLongPress = jest.fn();
  const onClick = jest.fn();
  const ui = <Harness onLongPress={onLongPress} onClick={onClick} />;
  const utils = render(withMain ? <div id="main"><div>{ui}</div></div> : ui);
  const el = screen.getByRole("button", { name: "Press" });
  /** The guard's verdict on the most recent click. */
  const lastIgnored = () => onClick.mock.calls[onClick.mock.calls.length - 1]?.[0];
  return { ...utils, el, onLongPress, onClick, lastIgnored };
}

describe("F2-7 useLongPress — the timer", () => {
  it("a touch press of 500 ms fires exactly once (and only once however long it is held)", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(499);
    expect(onLongPress).not.toHaveBeenCalled();
    advance(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    advance(5000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("a touch press released at 499 ms never fires", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(499);
    fireEvent.pointerUp(el, at("touch"));
    advance(2000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("a pen press fires; a mouse press held 600 ms never starts the timer", () => {
    const pen = setup();
    fireEvent.pointerDown(pen.el, at("pen"));
    advance(500);
    expect(pen.onLongPress).toHaveBeenCalledTimes(1);
    pen.unmount();

    const mouse = setup();
    fireEvent.pointerDown(mouse.el, at("mouse"));
    advance(600);
    expect(mouse.onLongPress).not.toHaveBeenCalled();
  });

  it("a touch press with a button other than 0 never starts the timer", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch", 100, 100, 2));
    advance(600);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("movement of MORE than 10 px from the start cancels; exactly 10 px does not", () => {
    const near = setup();
    fireEvent.pointerDown(near.el, at("touch", 100, 100));
    fireEvent.pointerMove(near.el, at("touch", 106, 108)); // hypot(6, 8) = 10
    advance(500);
    expect(near.onLongPress).toHaveBeenCalledTimes(1);
    near.unmount();

    const far = setup();
    fireEvent.pointerDown(far.el, at("touch", 100, 100));
    fireEvent.pointerMove(far.el, at("touch", 100, 111));
    advance(1000);
    expect(far.onLongPress).not.toHaveBeenCalled();
  });

  it.each(["pointerUp", "pointerCancel", "pointerLeave"] as const)("%s before 500 ms cancels", (type) => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(300);
    fireEvent[type](el, at("touch"));
    advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("the next pointerdown re-arms: a second long press fires again", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    fireEvent.pointerUp(el, at("touch"));
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    expect(onLongPress).toHaveBeenCalledTimes(2);
  });

  it("an unmounted element never fires", () => {
    const { el, onLongPress, unmount } = setup();
    fireEvent.pointerDown(el, at("touch"));
    unmount();
    advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("calls the LATEST onLongPress the element was rendered with", () => {
    const first = jest.fn();
    const second = jest.fn();
    const onClick = jest.fn();
    const { rerender } = render(<Harness onLongPress={first} onClick={onClick} />);
    const el = screen.getByRole("button", { name: "Press" });
    fireEvent.pointerDown(el, at("touch"));
    rerender(<Harness onLongPress={second} onClick={onClick} />);
    advance(500);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("F2-7 useLongPress — the #main scroll (B14)", () => {
  it("a scroll on #main cancels a pending press", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.pointerDown(el, at("touch"));
    advance(200);
    fireEvent.scroll(document.getElementById("main")!);
    advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("a scroll of an element INSIDE #main cancels too (a capture listener)", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.pointerDown(el, at("touch"));
    fireEvent.scroll(el.parentElement!);
    advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("the listener is added on start and removed on fire and on cancel, as the same capture pair", () => {
    const { el } = setup({ withMain: true });
    const main = document.getElementById("main")!;
    const add = jest.spyOn(main, "addEventListener");
    const remove = jest.spyOn(main, "removeEventListener");

    fireEvent.pointerDown(el, at("touch"));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe("scroll");
    expect(add.mock.calls[0][2]).toBe(true);
    advance(500); // fire
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);

    fireEvent.pointerDown(el, at("touch"));
    fireEvent.pointerUp(el, at("touch")); // cancel
    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls[1]).toEqual(add.mock.calls[1]);

    // A mouse press starts no timer, so no listener.
    fireEvent.pointerDown(el, at("mouse"));
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("a scroll after a fire does nothing (the listener is gone)", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    fireEvent.scroll(document.getElementById("main")!);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("with no #main on the page: no listener, no throw, and the press still fires", () => {
    expect(document.getElementById("main")).toBeNull();
    const { el, onLongPress } = setup();
    expect(() => fireEvent.pointerDown(el, at("touch"))).not.toThrow();
    advance(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

describe("F2-7 useLongPress — contextmenu", () => {
  it("contextmenu calls preventDefault() and fires once", () => {
    const { el, onLongPress } = setup();
    expect(fireEvent.contextMenu(el)).toBe(false); // default prevented
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("contextmenu during a pending touch press fires ONCE: the pending timer is cancelled", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(300);
    fireEvent.contextMenu(el);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("after a timer fire, contextmenu is INERT (no second fire) but still prevents default (B6)", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    expect(fireEvent.contextMenu(el)).toBe(false);
    expect(fireEvent.contextMenu(el)).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("a desktop right-click (mouse pointerdown, button 2, then contextmenu) fires once", () => {
    const { el, onLongPress } = setup();
    fireEvent.pointerDown(el, at("mouse", 100, 100, 2));
    expect(fireEvent.contextMenu(el)).toBe(false);
    fireEvent.pointerUp(el, at("mouse", 100, 100, 2));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    // The next right-click is a new press: it fires again.
    fireEvent.pointerDown(el, at("mouse", 100, 100, 2));
    fireEvent.contextMenu(el);
    expect(onLongPress).toHaveBeenCalledTimes(2);
  });
});

describe("F2-7 useLongPress — the click guard (B6)", () => {
  it("with no fire, a click is never ignored", () => {
    const { el, lastIgnored } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(100);
    fireEvent.pointerUp(el, at("touch"));
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(false);
  });

  it("a click while the fired press is still down is ignored", () => {
    const { el, lastIgnored } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(true);
  });

  it("fire, hold 1000 ms, pointerup, click -> ignored (the window runs from the END of the press)", () => {
    const { el, lastIgnored } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    advance(1000);
    fireEvent.pointerUp(el, at("touch"));
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(true);
  });

  it("fire, pointerup, a click 600 ms later -> ignored; 700 ms later -> NOT ignored", () => {
    const inside = setup();
    fireEvent.pointerDown(inside.el, at("touch"));
    advance(500);
    fireEvent.pointerUp(inside.el, at("touch"));
    advance(600);
    fireEvent.click(inside.el, { detail: 1 });
    expect(inside.lastIgnored()).toBe(true);
    inside.unmount();

    const outside = setup();
    fireEvent.pointerDown(outside.el, at("touch"));
    advance(500);
    fireEvent.pointerUp(outside.el, at("touch"));
    advance(700);
    fireEvent.click(outside.el, { detail: 1 });
    expect(outside.lastIgnored()).toBe(false);
  });

  it("a pointercancel ENDS the fired press too: 600 ms -> ignored, 601 ms -> not", () => {
    const { el, lastIgnored } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    fireEvent.pointerCancel(el, at("touch"));
    advance(600);
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(true);
    advance(1);
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(false);
  });

  it("a fire with NO following click, then a fresh tap inside the window -> the tap's click is NOT ignored", () => {
    const { el, lastIgnored, onClick } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    fireEvent.pointerUp(el, at("touch"));
    // No click arrives (real browsers may not send one). 100 ms later, a tap:
    advance(100);
    fireEvent.pointerDown(el, at("touch"));
    advance(80);
    fireEvent.pointerUp(el, at("touch"));
    fireEvent.click(el, { detail: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(lastIgnored()).toBe(false);
  });

  it("the flag stays set until the next pointerdown (a click inside the window is ignored every time)", () => {
    const { el, lastIgnored } = setup();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    fireEvent.pointerUp(el, at("touch"));
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(true);
    advance(100);
    fireEvent.click(el, { detail: 1 });
    expect(lastIgnored()).toBe(true);
  });
});

describe("FR1-3 useLongPress — a finger that stops a scroll never long-presses", () => {
  it("a press 100 ms after a #main scroll -> no fire, however long it is held", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(100);
    fireEvent.pointerDown(el, at("touch"));
    advance(2000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("a press 200 ms after a #main scroll -> fires at 500 ms", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(200);
    fireEvent.pointerDown(el, at("touch"));
    advance(499);
    expect(onLongPress).not.toHaveBeenCalled();
    advance(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("at exactly 150 ms the press is still the scroll's; at 151 ms it is a press", () => {
    const at150 = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(150);
    fireEvent.pointerDown(at150.el, at("touch"));
    advance(1000);
    expect(at150.onLongPress).not.toHaveBeenCalled();
    at150.unmount();

    const at151 = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(151);
    fireEvent.pointerDown(at151.el, at("touch"));
    advance(500);
    expect(at151.onLongPress).toHaveBeenCalledTimes(1);
  });

  it("a scroll of an element INSIDE #main counts too (a capture listener)", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(el.parentElement!);
    advance(100);
    fireEvent.pointerDown(el, at("touch"));
    advance(1000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("the scroll that stopped one press does not stop the next one 200 ms later", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(50);
    fireEvent.pointerDown(el, at("touch"));
    advance(150);
    fireEvent.pointerUp(el, at("touch"));
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("ONE passive capture listener on #main, installed on the first hook use (mount), shared by every instance", () => {
    const main = document.createElement("div");
    main.id = "main";
    document.body.appendChild(main);
    const add = jest.spyOn(main, "addEventListener");
    try {
      const host = document.createElement("div");
      main.appendChild(host);
      const onLongPress = jest.fn();
      render(
        <>
          <Harness onLongPress={onLongPress} onClick={jest.fn()} />
          <Harness onLongPress={onLongPress} onClick={jest.fn()} />
        </>,
        { container: host },
      );
      // Installed at mount, before any press: one listener for both instances.
      const record = add.mock.calls.filter(([, , opts]) => typeof opts === "object");
      expect(record).toHaveLength(1);
      expect(record[0][0]).toBe("scroll");
      expect(record[0][2]).toEqual({ capture: true, passive: true });
      // Presses add only their own per-press listener (A2), never a second record.
      for (const button of screen.getAllByRole("button", { name: "Press" })) {
        fireEvent.pointerDown(button, at("touch"));
        fireEvent.pointerUp(button, at("touch"));
      }
      expect(add.mock.calls.filter(([, , opts]) => typeof opts === "object")).toHaveLength(1);
    } finally {
      main.remove();
    }
  });

  it("Android's contextmenu during a press 100 ms after a #main scroll: default prevented, NO fire", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(100);
    fireEvent.pointerDown(el, at("touch"));
    advance(400);
    expect(fireEvent.contextMenu(el)).toBe(false); // default prevented
    advance(2000);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("Android's contextmenu during a press 200 ms after a #main scroll: fires ONCE (and the timer adds nothing)", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(200);
    fireEvent.pointerDown(el, at("touch"));
    advance(400);
    expect(fireEvent.contextMenu(el)).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    advance(2000);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("the scroll-stopped press ends on the next pointerdown: a fresh press's contextmenu fires", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(50);
    fireEvent.pointerDown(el, at("touch"));
    fireEvent.contextMenu(el);
    fireEvent.pointerUp(el, at("touch"));
    expect(onLongPress).not.toHaveBeenCalled();
    advance(300);
    fireEvent.pointerDown(el, at("touch"));
    advance(100);
    fireEvent.contextMenu(el);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("a desktop right-click right after a #main scroll still fires (only a touch / pen press is a finger stopping a scroll)", () => {
    const { el, onLongPress } = setup({ withMain: true });
    fireEvent.scroll(document.getElementById("main")!);
    advance(20);
    fireEvent.pointerDown(el, at("mouse", 100, 100, 2));
    expect(fireEvent.contextMenu(el)).toBe(false);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("no #main on the page (after tests that scrolled one): no record is left over, and a touch press fires", () => {
    const { el, onLongPress } = setup();
    expect(document.getElementById("main")).toBeNull();
    fireEvent.pointerDown(el, at("touch"));
    advance(500);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
