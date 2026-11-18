/** @jest-environment jsdom */
//
// Facelift F0-10 (plan 2026-11-17-facelift-f0, F0-10 part 3) — a readable ghost
// hover. The ghost variant's hover was `bg-accent/40` + `text-accent-foreground`:
// in dark mode that is near-black text (222 47% 11%) on a 40% sky-blue over
// navy, about 1.7:1. It is now the surface hover with the foreground text.

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Button, buttonVariants } from "@/components/ui/button";

describe("F0-10 — the ghost variant", () => {
  it("hovers to the surface hover with foreground text", () => {
    render(<Button variant="ghost">Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).toHaveClass("hover:bg-surface-hover", "hover:text-foreground");
    expect(button).not.toHaveClass("hover:bg-accent/40");
    expect(button).not.toHaveClass("hover:text-accent-foreground");
  });

  it("the variant string is exactly the new pair", () => {
    const classes = buttonVariants({ variant: "ghost", size: null }).split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["hover:bg-surface-hover", "hover:text-foreground"]));
    expect(classes.some((c) => c.includes("accent"))).toBe(false);
  });
});
