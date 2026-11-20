"use client";

import { useEffect, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

// ---------------------------------------------------------------------------
// THE LONG PRESS (facelift F2-7, plan 2026-11-19-facelift-f2 REV 2 A2 as
// replaced by REV 3 B6 / B14). A product's tap opens Adjust stock; a long press
// opens its actions menu. One element, one press at a time.
//
// - The timer starts ONLY for a `touch` or `pen` pointer with `button === 0`. A
//   mouse never starts it, so a slow mouse click still opens Adjust (mouse
//   users have right-click, which is `contextmenu` below).
// - A press fires after 500 ms. Movement of more than 10 px from the start,
//   `pointerup`, `pointercancel`, `pointerleave`, or a `scroll` on the shell's
//   `#main` (a capture listener added when the timer starts and removed on
//   cancel or fire; no `#main`, no listener) cancels it.
// - `contextmenu` -> `preventDefault()`, cancels any pending timer, and fires.
// - AT MOST ONE FIRE PER PRESS: after a fire, both paths are inert until the
//   next `pointerdown` (an inert `contextmenu` still calls `preventDefault()`).
//   Callers pass an IDEMPOTENT opener (`() => setMenuOpen(true)`), never a
//   toggle.
// - THE CLICK GUARD (B6): after a fire the flag stays set until the next
//   `pointerdown`. A click is ignored while it is set AND either the press is
//   still down or no more than 600 ms have passed since the `pointerup` /
//   `pointercancel` that ENDED the fired press. It never waits for a click a
//   real browser may not send. A keyboard click (`event.detail === 0`) is never
//   ignored: the caller's onClick checks `detail` before asking, because
//   `shouldIgnoreClick` (A2's signature) takes no event.
// - A FINGER THAT STOPS A SCROLL (FR1-3): a `pointerdown` within 150 ms of the
//   last `#main` scroll starts NO timer. On a phone, a touch during a fling
//   stops the fling; held, it would otherwise open the menu on whichever row
//   the list stopped under the finger. Android also sends its own long-press
//   `contextmenu`: during a press suppressed this way it still calls
//   `preventDefault()` but never fires (the FR1 ruling). The press ends on
//   the next `pointerdown`, as every press does.
// ---------------------------------------------------------------------------

/** A touch or pen press held this long fires. */
const LONG_PRESS_MS = 500;
/** A press that moves farther than this from where it started is cancelled. */
const MOVE_TOLERANCE_PX = 10;
/** B6: a click this soon after a fired press ENDED is that press's own click. */
const CLICK_GUARD_MS = 600;
/** FR1-3: a press this soon after `#main` scrolled is a finger stopping that scroll. */
const SCROLL_SETTLE_MS = 150;

// FR1-3: ONE module-level record of the last `#main` scroll, kept by ONE
// passive capture `scroll` listener on the shell's `#main`. It is installed
// lazily, on the first hook use (an element's mount, checked again on every
// `pointerdown`), and follows `#main` if the element is replaced; with no
// `#main` there is no listener and nothing throws. The record belongs to the
// `#main` it was kept on: a new (or absent) `#main` starts with no scroll.
let lastMainScrollAt: number | null = null;
let mainScrollTarget: HTMLElement | null = null;

const recordMainScroll = () => {
  lastMainScrollAt = Date.now();
};

function watchMainScroll() {
  const main = document.getElementById("main");
  if (main === mainScrollTarget) return;
  mainScrollTarget?.removeEventListener("scroll", recordMainScroll, true);
  lastMainScrollAt = null;
  mainScrollTarget = main;
  main?.addEventListener("scroll", recordMainScroll, { capture: true, passive: true });
}

/** `#main` scrolled within the last 150 ms. A clock that went backwards is no scroll. */
function mainScrolledJustNow(): boolean {
  if (lastMainScrollAt === null) return false;
  const since = Date.now() - lastMainScrollAt;
  return since >= 0 && since <= SCROLL_SETTLE_MS;
}

interface PressState {
  timer: ReturnType<typeof setTimeout> | null;
  start: { x: number; y: number } | null;
  /** The `#main` capture listener, kept with its target so the same pair is removed. */
  scroll: { target: HTMLElement; listener: () => void } | null;
  /** A fire happened since the last `pointerdown`. */
  fired: boolean;
  /** The current press is still down (`pointerdown` seen, no `pointerup` / `pointercancel` yet). */
  down: boolean;
  /** When the fired press ended, or null. */
  endedAt: number | null;
  /** FR1-3: this press's touch / pen `pointerdown` came within 150 ms of a `#main` scroll. */
  scrollStopped: boolean;
}

export function useLongPress(onLongPress: () => void): {
  handlers: {
    onPointerDown: (event: ReactPointerEvent) => void;
    onPointerMove: (event: ReactPointerEvent) => void;
    onPointerUp: (event: ReactPointerEvent) => void;
    onPointerCancel: (event: ReactPointerEvent) => void;
    onPointerLeave: (event: ReactPointerEvent) => void;
    onContextMenu: (event: ReactMouseEvent) => void;
  };
  /** Call first in the element's onClick; returns true when this click must be ignored. */
  shouldIgnoreClick: () => boolean;
} {
  const callbackRef = useRef(onLongPress);
  useEffect(() => {
    callbackRef.current = onLongPress;
  }, [onLongPress]);

  const stateRef = useRef<PressState>({
    timer: null,
    start: null,
    scroll: null,
    fired: false,
    down: false,
    endedAt: null,
    scrollStopped: false,
  });

  const api = useMemo(() => {
    const state = stateRef.current;

    // Stops a pending press: the timer, the movement origin and the #main listener.
    const cancel = () => {
      if (state.timer !== null) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.scroll) {
        state.scroll.target.removeEventListener("scroll", state.scroll.listener, true);
        state.scroll = null;
      }
      state.start = null;
    };

    const fire = () => {
      cancel();
      state.fired = true;
      callbackRef.current();
    };

    // A press ends on pointerup / pointercancel; a FIRED press opens the click window.
    const end = () => {
      cancel();
      if (state.down && state.fired) state.endedAt = Date.now();
      state.down = false;
    };

    return {
      handlers: {
        onPointerDown: (event: ReactPointerEvent) => {
          cancel();
          state.fired = false;
          state.endedAt = null;
          state.down = true;
          state.scrollStopped = false;
          watchMainScroll();
          if ((event.pointerType !== "touch" && event.pointerType !== "pen") || event.button !== 0) return;
          // FR1-3: the finger that stopped a scroll is not a long press — not
          // by the timer, and not by Android's own long-press `contextmenu`.
          if (mainScrolledJustNow()) {
            state.scrollStopped = true;
            return;
          }
          state.start = { x: event.clientX, y: event.clientY };
          state.timer = setTimeout(fire, LONG_PRESS_MS);
          const target = document.getElementById("main");
          if (target) {
            const listener = () => cancel();
            target.addEventListener("scroll", listener, true);
            state.scroll = { target, listener };
          }
        },
        onPointerMove: (event: ReactPointerEvent) => {
          if (state.timer === null || state.start === null) return;
          const dx = event.clientX - state.start.x;
          const dy = event.clientY - state.start.y;
          if (Math.hypot(dx, dy) > MOVE_TOLERANCE_PX) cancel();
        },
        onPointerUp: end,
        onPointerCancel: end,
        onPointerLeave: cancel,
        onContextMenu: (event: ReactMouseEvent) => {
          event.preventDefault();
          if (state.fired || state.scrollStopped) return;
          fire();
        },
      },
      shouldIgnoreClick: () => {
        if (!state.fired) return false;
        if (state.down) return true;
        return state.endedAt !== null && Date.now() - state.endedAt <= CLICK_GUARD_MS;
      },
      cancel,
    };
  }, []);

  // FR1-3: the first use installs the `#main` scroll record.
  useEffect(() => {
    watchMainScroll();
  }, []);

  // An unmounted element never fires and leaves no listener behind.
  useEffect(() => api.cancel, [api]);

  return { handlers: api.handlers, shouldIgnoreClick: api.shouldIgnoreClick };
}
