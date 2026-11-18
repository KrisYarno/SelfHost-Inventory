/** @jest-environment jsdom */
//
// Facelift F0-8 (plan 2026-11-17-facelift-f0, F0-8 part 1 + the REV 2 folds) —
// no Inventory group is clipped, and nothing hidden stays focusable.
//
// Before: open content sat in `overflow-hidden max-h-[2000px]`, so a long group
// (every product without a baseName lands in one "Uncategorized" group) was cut
// off after about nine cards on a phone, with no scroll and no cue. Collapsed
// content stayed mounted at `max-h-0`, so keyboard focus walked through
// invisible buttons; the trigger had no `aria-expanded`. Now open content has
// no height clip, collapsed content is not rendered, and the trigger carries
// `aria-expanded` (always) and `aria-controls` (while open) naming the
// content's `useId()` id.

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const VARIANTS = Array.from({ length: 20 }, (_, i) => `Variant ${i + 1}`);

function Group({ name = "Uncategorized" }: { name?: string }) {
  return (
    <AccordionItem value={name}>
      <AccordionTrigger>{name}</AccordionTrigger>
      <AccordionContent>
        {VARIANTS.map((v) => (
          <button key={`${name}-${v}`} data-testid={`card-${name}`}>
            {v}
          </button>
        ))}
      </AccordionContent>
    </AccordionItem>
  );
}

const trigger = (name = "Uncategorized") => screen.getByRole("button", { name });

describe("F0-8 — the accordion", () => {
  it("a closed group renders none of its content", () => {
    render(
      <Accordion type="multiple">
        <Group />
      </Accordion>,
    );
    expect(screen.queryAllByTestId("card-Uncategorized")).toHaveLength(0);
  });

  it("a group of 20 variants renders all 20 when open, with no height clip around them", () => {
    render(
      <Accordion type="multiple">
        <Group />
      </Accordion>,
    );
    fireEvent.click(trigger());

    const cards = screen.getAllByTestId("card-Uncategorized");
    expect(cards).toHaveLength(20);

    const content = document.getElementById(trigger().getAttribute("aria-controls") as string) as HTMLElement;
    expect(content).not.toBeNull();
    // Every element from the content down to a card: no max-height, no overflow
    // of any kind, no fixed height class and no inline height (FR1-11: a clip by
    // ANY of these cuts a long group off as surely as the old `max-h-[2000px]`).
    for (let el: HTMLElement | null = cards[19].parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)([\w-]+:)*max-h-/);
      expect(el.className).not.toMatch(/(^|\s)([\w-]+:)*overflow-/);
      expect(el.className).not.toMatch(/(^|\s)([\w-]+:)*h-\[/);
      expect(el.style.height).toBe("");
      expect(el.style.maxHeight).toBe("");
      expect(el.style.overflow).toBe("");
      if (el === content) break;
    }
  });

  it("aria-expanded follows the state; aria-controls names the content only while open", () => {
    render(
      <Accordion type="multiple">
        <Group />
      </Accordion>,
    );
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-controls");

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const id = trigger().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    expect(document.getElementById(id as string)).toContainElement(
      screen.getAllByTestId("card-Uncategorized")[0],
    );

    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    expect(trigger()).not.toHaveAttribute("aria-controls");
    expect(screen.queryAllByTestId("card-Uncategorized")).toHaveLength(0);
  });

  it("each item's content id is its own", () => {
    render(
      <Accordion type="multiple" defaultValue={["A", "B"]}>
        <Group name="A" />
        <Group name="B" />
      </Accordion>,
    );
    const a = trigger("A").getAttribute("aria-controls");
    const b = trigger("B").getAttribute("aria-controls");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
