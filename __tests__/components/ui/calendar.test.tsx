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
