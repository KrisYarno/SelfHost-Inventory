/** @jest-environment jsdom */
//
// Facelift F1-6 (plan 2026-11-18-facelift-f1 REV 2; FL-A-17, FL-D-1, FL-D-2;
// OC1-3, OC1-16, G1-17) — the `Page` frame.
//
// The shell owned no content frame, so every page picked its own gutter and
// width (Inventory and Orders had none). `Page` is one frame: `px-4 sm:px-6
// py-4 mx-auto` at `max-w-7xl` / `max-w-2xl` / `max-w-none`, the framed
// `PageHeader`, then the children under `mt-4`.
//
// `PageHeader framed`: no `px`, no bottom border, and (orchestrator ruling on
// the F1b report) no vertical padding and no fill of its own — `Page` owns the
// spacing. The title row wraps
// (`flex flex-wrap items-center justify-between gap-x-3 gap-y-2`); the h1 is
// `text-h2 sm:text-h1 min-w-0`; the description shows from `sm` only; the
// actions are `flex flex-wrap gap-2`. WITHOUT `framed` the six existing
// PageHeader pages render byte-for-byte as before (the HTML below was captured
// from the component at 9cfb4d4).

import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("F1-6 — Page", () => {
  it.each([
    ["default", "max-w-7xl", undefined],
    ["narrow", "max-w-2xl", "narrow"],
    ["wide", "max-w-none", "wide"],
  ] as const)("width %s: px-4 sm:px-6 py-4 mx-auto %s", (_name, max, width) => {
    const { container } = render(
      <Page title="Things" width={width}>
        <p>body</p>
      </Page>
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.tagName).toBe("DIV");
    expect(frame.getAttribute("class")).toBe(`px-4 sm:px-6 py-4 mx-auto ${max}`);
  });

  it("renders the framed header with the title, description and actions, then the children under mt-4", () => {
    const { container } = render(
      <Page title="Things" description="All the things" actions={<button>Do it</button>}>
        <p>body</p>
      </Page>
    );
    const frame = container.firstElementChild as HTMLElement;
    const [header, body] = Array.from(frame.children) as HTMLElement[];
    expect(frame.children).toHaveLength(2);
    expect(header.tagName).toBe("HEADER");
    expect(screen.getByRole("heading", { level: 1, name: "Things" }).getAttribute("class")).toBe(
      "text-h2 sm:text-h1 min-w-0"
    );
    expect(header).toContainElement(screen.getByText("All the things"));
    expect(header).toContainElement(screen.getByRole("button", { name: "Do it" }));
    expect(body.getAttribute("class")).toBe("mt-4");
    expect(body).toHaveTextContent("body");
  });
});

describe("F1-6 — PageHeader framed", () => {
  function framed() {
    const { container } = render(
      <PageHeader framed title="Orders" description="Manage orders">
        <button>Refresh</button>
      </PageHeader>
    );
    return container.firstElementChild as HTMLElement;
  }

  it("has no px and no bottom border", () => {
    const header = framed();
    const cls = classesOf(header);
    expect(cls.filter((c) => /^(sm:|md:)?px-/.test(c))).toEqual([]);
    expect(cls).not.toContain("border-b");
    expect(cls).not.toContain("border-border");
  });

  it("has no vertical padding and no fill of its own: Page owns the spacing", () => {
    const cls = classesOf(framed());
    expect(cls.filter((c) => /^(sm:|md:)?(p|py|pt|pb)-/.test(c))).toEqual([]);
    expect(cls.filter((c) => /^(sm:|md:)?bg-/.test(c))).toEqual([]);
  });

  it("wraps: the title row, the h1, the description (sm and up) and the actions carry the contract classes", () => {
    const header = framed();
    const row = header.firstElementChild as HTMLElement;
    expect(row.getAttribute("class")).toBe("flex flex-wrap items-center justify-between gap-x-3 gap-y-2");
    expect(screen.getByRole("heading", { level: 1, name: "Orders" }).getAttribute("class")).toBe(
      "text-h2 sm:text-h1 min-w-0"
    );
    expect(classesOf(screen.getByText("Manage orders"))).toEqual(
      expect.arrayContaining(["hidden", "sm:block"])
    );
    const actions = screen.getByRole("button", { name: "Refresh" }).parentElement as HTMLElement;
    expect(actions.getAttribute("class")).toBe("flex flex-wrap gap-2");
  });
});

describe("F1-6 — PageHeader WITHOUT framed is byte-unchanged", () => {
  // Captured from components/layout/page-header.tsx at 9cfb4d4.
  const BASE = {
    titleOnly:
      '<header class="border-b border-border bg-background px-4 sm:px-6 py-4"><div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div><h1 class="text-h1 tracking-tight">Products</h1></div></div></header>',
    described:
      '<header class="border-b border-border bg-background px-4 sm:px-6 py-4"><div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div><h1 class="text-h1 tracking-tight">Dashboard</h1><p class="text-body-sm text-muted-foreground mt-0.5">Viewing Main</p></div></div></header>',
    stickyWithActions:
      '<header class="border-b border-border px-4 sm:px-6 py-4 sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 mb-4 sm:mb-6 -mx-4 -mt-6 sm:-mx-4"><div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"><div><h1 class="text-h1 tracking-tight">Inventory Journal</h1><p class="text-body-sm text-muted-foreground mt-0.5">Make bulk changes</p></div><div class="flex items-center gap-2 flex-shrink-0"><button>Act</button></div></div></header>',
  };

  it("title only", () => {
    const { container } = render(<PageHeader title="Products" />);
    expect(container.innerHTML).toBe(BASE.titleOnly);
  });

  it("with a description", () => {
    const { container } = render(<PageHeader title="Dashboard" description="Viewing Main" />);
    expect(container.innerHTML).toBe(BASE.described);
  });

  it("sticky, with a className and actions", () => {
    const { container } = render(
      <PageHeader
        title="Inventory Journal"
        description="Make bulk changes"
        sticky
        className="mb-4 sm:mb-6 -mx-4 -mt-6 sm:-mx-4"
      >
        <button>Act</button>
      </PageHeader>
    );
    expect(container.innerHTML).toBe(BASE.stickyWithActions);
  });
});
