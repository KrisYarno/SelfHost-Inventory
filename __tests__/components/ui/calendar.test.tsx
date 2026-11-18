/** @jest-environment jsdom */
//
// Facelift F0 FR1-10 (plan 2026-11-17-facelift-f0, REV 5; GR-11 = OCR-11) — a
// selected day stays readable under the pointer.
//
// F0-10 changed the ghost button's hover to `hover:bg-surface-hover
// hover:text-foreground`. Every day is a ghost button, and a selected day's own
// `hover:bg-primary hover:text-primary-foreground` then competed with the ghost
// pair at equal specificity — whichever rule the CSS emitted LAST won, so a
// hovered selected day could lose its primary fill and text. The selected day
// now carries the important modifier, which wins regardless of order.

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Calendar } from "@/components/ui/calendar";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "@/tailwind.config";

const IMPORTANT = [
  "hover:!bg-primary",
  "hover:!text-primary-foreground",
  "focus:!bg-primary",
  "focus:!text-primary-foreground",
];

describe("FR1-10 — the selected day keeps primary on hover and focus", () => {
  it("the selected day's class list carries the important hover and focus pair", () => {
    const day = new Date(2026, 10, 17);
    render(<Calendar mode="single" selected={day} month={day} />);

    const selected = screen.getByRole("gridcell", { selected: true });
    expect(selected).toHaveClass("bg-primary", "text-primary-foreground", ...IMPORTANT);
  });

  it("a day that is not selected carries none of them", () => {
    const day = new Date(2026, 10, 17);
    render(<Calendar mode="single" selected={day} month={day} />);

    const other = screen.getByRole("gridcell", { name: "18" });
    for (const cls of IMPORTANT) expect(other).not.toHaveClass(cls);
  });
});

// ---------------------------------------------------------------------------
// Facelift F0 FR2-7 (REV 7, QA-5; orchestrator ruling on the implementer's
// STOP) — days INSIDE a selected range keep the accent fill on hover and focus.
//
// A range-middle day is also a selected day, so it carries FR1-10's
// `hover:!bg-primary` (and the focus/text pairs). The contract's first form,
// `hover:!bg-accent` and friends, LOST to it: both are `!important` at the same
// specificity (0,2,0), and Tailwind emits `…accent` BEFORE `…primary` (it sorts
// candidates alphabetically within one plugin and variant), so primary — last —
// won. The ruled form is `aria-selected:hover:!bg-accent` etc.: the attribute
// adds specificity (0,3,0), so it wins whatever the order. The range start and
// end do not carry `day_range_middle`, so they keep primary.
//
// Pinned twice: on the class lists the days actually render with, and on the
// cascade itself — the project's own Tailwind config compiles those class lists
// and a small resolver picks the winning `background-color` / `color` for a
// hovered or focused day (importance, then specificity, then source order).
// ---------------------------------------------------------------------------

const RANGE_MIDDLE_IMPORTANT = [
  "aria-selected:hover:!bg-accent",
  "aria-selected:hover:!text-accent-foreground",
  "aria-selected:focus:!bg-accent",
  "aria-selected:focus:!text-accent-foreground",
];

function renderRange() {
  const from = new Date(2026, 10, 10);
  const to = new Date(2026, 10, 14);
  const view = render(<Calendar mode="range" selected={{ from, to }} month={from} />);
  const day = (n: string) => screen.getByRole("gridcell", { name: n });
  return { view, start: day("10"), middle: day("12"), end: day("14"), outside: day("20") };
}

type State = { hover?: boolean; focus?: boolean; ariaSelected: boolean };

/**
 * The value of `property` that wins for an element with `classes` in `state`,
 * over `css` (single-compound class selectors only: `.cls`, `:hover`, `:focus`,
 * `[aria-selected="true"]` — exactly what these day classes compile to).
 */
function winning(css: string, classes: string[], state: State, property: string): string | null {
  const root = postcss.parse(css);
  let best: { important: boolean; spec: number; index: number; value: string } | null = null;
  let index = 0;
  root.walkRules((rule) => {
    if (rule.parent?.type !== "root") return; // no media/dark-scoped rules here
    for (const selector of rule.selectors) {
      index += 1;
      const m = selector.match(/^\.((?:\\.|[^.:[\s\\])+)((?::[a-z-]+|\[[^\]]+\])*)$/);
      if (!m) continue;
      const cls = m[1].replace(/\\(.)/g, "$1");
      if (!classes.includes(cls)) continue;
      const parts = m[2].match(/:[a-z-]+|\[[^\]]+\]/g) ?? [];
      const applies = parts.every((p) =>
        p === ":hover"
          ? !!state.hover
          : p === ":focus"
            ? !!state.focus
            : p === '[aria-selected="true"]'
              ? state.ariaSelected
              : false
      );
      if (!applies) continue;
      const spec = 1 + parts.length;
      rule.walkDecls(property, (decl) => {
        const cand = { important: decl.important, spec, index, value: decl.value };
        if (
          best === null ||
          (cand.important && !best.important) ||
          (cand.important === best.important &&
            (cand.spec > best.spec || (cand.spec === best.spec && cand.index > best.index)))
        ) {
          best = cand;
        }
      });
    }
  });
  return best === null ? null : (best as { value: string }).value;
}

async function compile(classLists: string[]): Promise<string> {
  const result = await postcss([
    tailwindcss({
      ...tailwindConfig,
      content: [{ raw: `<div class="${classLists.join(" ")}"></div>`, extension: "html" }],
      corePlugins: { preflight: false },
    }),
  ]).process("@tailwind utilities;", { from: undefined });
  return result.css;
}

const ACCENT = /var\(--accent\)/;
const ACCENT_FG = /var\(--accent-foreground\)/;
const PRIMARY = /var\(--primary\)/;
const PRIMARY_FG = /var\(--primary-foreground\)/;

describe("FR2-7 — a range-middle day keeps accent on hover and focus", () => {
  it("the range-middle day carries the aria-selected important hover/focus classes; the start and end do not", () => {
    const { start, middle, end } = renderRange();
    expect(middle).toHaveClass("aria-selected:bg-accent", "aria-selected:text-accent-foreground", ...RANGE_MIDDLE_IMPORTANT);
    for (const edge of [start, end]) {
      for (const cls of RANGE_MIDDLE_IMPORTANT) expect(edge).not.toHaveClass(cls);
      // and they are still primary days
      expect(edge).toHaveClass("bg-primary", "hover:!bg-primary");
    }
  });

  it("compiled with the project's config: hovered and focused range-middle days resolve to accent; the start, the end and a single selected day stay primary", async () => {
    const { start, middle, end, view } = renderRange();
    const lists = { middle: middle.className, start: start.className, end: end.className };
    view.unmount();
    const day = new Date(2026, 10, 17);
    render(<Calendar mode="single" selected={day} month={day} />);
    const single = screen.getByRole("gridcell", { selected: true }).className;

    const css = await compile([lists.middle, lists.start, lists.end, single]);
    const split = (s: string) => s.split(/\s+/).filter(Boolean);

    for (const state of [{ hover: true }, { focus: true }, { hover: true, focus: true }]) {
      const s = { ...state, ariaSelected: true };
      expect(winning(css, split(lists.middle), s, "background-color")).toMatch(ACCENT);
      expect(winning(css, split(lists.middle), s, "color")).toMatch(ACCENT_FG);
      for (const edge of [lists.start, lists.end, single]) {
        expect(winning(css, split(edge), s, "background-color")).toMatch(PRIMARY);
        expect(winning(css, split(edge), s, "color")).toMatch(PRIMARY_FG);
      }
    }
    // At rest the middle day is accent (unchanged).
    expect(winning(css, split(lists.middle), { ariaSelected: true }, "background-color")).toMatch(ACCENT);
  });
});
