/** @jest-environment jsdom */
//
// Facelift F1-3 (plan 2026-11-18-facelift-f1 REV 2; FL-A-14, FL-D-17, FL-A-8;
// OC1-4, OC1-7, G1-10) — one position above the dock.
//
// Everything that sits above the phone dock reads ONE variable,
// `--dock-height` (calc(3.5rem + 1px) below md, 0px at md and up; pinned in
// __tests__/unit/styles/f1-tokens.test.ts):
//   - the shell's <main> bottom padding;
//   - StickyActionBar, fixed at EVERY width (md:left-64 beside the sidebar),
//     used by the Journal's pending-changes bar and the Thresholds save bar;
//   - the workbench's floating cart button (1rem above the dock);
//   - the toasts (sonner's offset 601-767px and mobileOffset <= 600px), whose
//     action buttons are thumb-sized on a phone.
// The bars used to carry their own magic numbers (4.75rem, 4.5rem), and the
// Thresholds bar floated 76 px above the window's bottom on desktop.

import * as React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { StickyActionBar } from "@/components/layout/sticky-action-bar";
import { FloatingCartButton } from "@/components/workbench/floating-cart-button";
import { Toaster } from "@/components/ui/sonner";
import { AppShell } from "@/components/layout/app-shell";
import RootLayout from "@/app/layout";

jest.mock("@/lib/csrf", () => ({ getExistingCSRFToken: async () => null }));
// The shell's chrome is irrelevant here; only <main>'s classes are read.
jest.mock("next/navigation", () => ({ usePathname: () => "/" }));
jest.mock("@/components/layout/sidebar-nav", () => ({ SidebarNav: () => null }));
jest.mock("@/components/layout/mobile-nav", () => ({ MobileNav: () => null }));
jest.mock("@/components/layout/user-menu", () => ({ UserMenu: () => null }));
jest.mock("@/components/layout/location-switcher", () => ({ LocationSwitcher: () => null }));
jest.mock("@/components/theme-toggle-sidebar", () => ({ ThemeToggleSidebar: () => null }));
jest.mock("@/components/layout/global-search", () => ({ GlobalSearch: () => null }));

const BAR =
  "fixed inset-x-0 md:left-64 z-30 border-t border-border bg-background/95 backdrop-blur px-4 py-3 bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom))]";
const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("F1-3 — StickyActionBar", () => {
  it("is a labelled region with the exact contract classes, fixed at every width", () => {
    render(
      <StickyActionBar ariaLabel="Pending things" summary={<span>2 pending</span>}>
        <button>Save</button>
      </StickyActionBar>
    );
    const region = screen.getByRole("region", { name: "Pending things" });
    expect(region.getAttribute("class")).toBe(BAR);
    // no breakpoint unfixes it, and no inline style places it
    expect(classesOf(region).some((c) => /^(sm|md|lg):(static|relative|sticky)$/.test(c))).toBe(false);
    expect(region.getAttribute("style")).toBeNull();
  });

  it("the summary sits first in an aria-live=polite div; the actions follow in flex gap-2 sm:justify-end", () => {
    render(
      <StickyActionBar ariaLabel="Bar" summary={<span>2 pending</span>}>
        <button>Undo</button>
        <button>Save</button>
      </StickyActionBar>
    );
    const region = screen.getByRole("region", { name: "Bar" });
    const inner = region.firstElementChild as HTMLElement;
    expect(inner.getAttribute("class")).toBe("flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between");
    const [summary, actions] = Array.from(inner.children) as HTMLElement[];
    expect(inner.children).toHaveLength(2);
    expect(summary.getAttribute("aria-live")).toBe("polite");
    expect(summary).toHaveTextContent("2 pending");
    expect(actions.getAttribute("class")).toBe("flex gap-2 sm:justify-end");
    expect(within(actions).getAllByRole("button").map((b) => b.textContent)).toEqual(["Undo", "Save"]);
    expect(actions.getAttribute("aria-live")).toBeNull();
  });

  it("className merges LAST, so a consumer's emphasis wins over the bar's defaults", () => {
    render(
      <StickyActionBar ariaLabel="Bar" className="border-t-2 border-primary shadow-lg bg-amber-50/90">
        <button>Go</button>
      </StickyActionBar>
    );
    const cls = classesOf(screen.getByRole("region", { name: "Bar" }));
    expect(cls).toEqual(expect.arrayContaining(["border-t-2", "border-primary", "shadow-lg", "bg-amber-50/90"]));
    expect(cls).not.toContain("border-t");
    expect(cls).not.toContain("border-border");
    expect(cls).not.toContain("bg-background/95");
  });
});

describe("F1-3 — the shell's main padding", () => {
  it("pads for --dock-height plus the safe-area inset, and clears it at md", () => {
    const { container } = render(<AppShell><p>x</p></AppShell>);
    const main = container.querySelector("main") as HTMLElement;
    const cls = classesOf(main);
    expect(cls).toEqual(
      expect.arrayContaining(["pb-[calc(var(--dock-height)+env(safe-area-inset-bottom))]", "md:pb-0"])
    );
    expect(main.className).not.toContain("theme(spacing.14)");
  });
});

describe("F1-3 — the floating cart button", () => {
  it("sits 1rem above the dock through the variable; no inline bottom; h-14 w-14 survive F1-1", () => {
    render(<FloatingCartButton itemCount={2} skippedCount={0} onClick={() => {}} />);
    const button = screen.getByRole("button");
    const cls = classesOf(button);
    expect(cls).toEqual(
      expect.arrayContaining([
        "bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom)+1rem)]",
        "h-14",
        "w-14",
        "max-md:min-h-11",
      ])
    );
    expect(cls).not.toContain("h-9");
    expect(button.style.bottom).toBe("");
  });
});

describe("F1-3 — the toasts", () => {
  const OFFSET = "calc(var(--dock-height) + env(safe-area-inset-bottom) + 24px)";
  const MOBILE_OFFSET = "calc(var(--dock-height) + env(safe-area-inset-bottom) + 8px)";

  /** The <Toaster> element app/layout.tsx actually mounts (its props, as written). */
  async function layoutToasterProps(): Promise<Record<string, unknown>> {
    const tree = await RootLayout({ children: null });
    const found: Array<Record<string, unknown>> = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!React.isValidElement(node)) return;
      if (node.type === Toaster) found.push(node.props as Record<string, unknown>);
      walk((node.props as { children?: unknown }).children);
    };
    walk(tree);
    expect(found).toHaveLength(1);
    return found[0];
  }

  it("the root layout mounts ONE Toaster with both bottom offsets", async () => {
    const props = await layoutToasterProps();
    expect(props.offset).toEqual({ bottom: OFFSET });
    expect(props.mobileOffset).toEqual({ bottom: MOBILE_OFFSET });
  });

  it("sonner applies them (desktop/tablet and phone vars), and a toast's action button is thumb-sized below md", async () => {
    const props = await layoutToasterProps();
    render(<Toaster {...props} />);
    act(() => {
      toast("Moved 2 units.", { action: { label: "Undo", onClick: () => {} } });
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(classesOf(undo)).toEqual(
      expect.arrayContaining([
        "group-[.toast]:bg-primary",
        "group-[.toast]:text-primary-foreground",
        "max-md:min-h-11",
        "max-md:px-4",
      ])
    );
    const list = document.querySelector("[data-sonner-toaster]") as HTMLElement;
    await waitFor(() => expect(list).not.toBeNull());
    expect(list.style.getPropertyValue("--offset-bottom")).toBe(OFFSET);
    expect(list.style.getPropertyValue("--mobile-offset-bottom")).toBe(MOBILE_OFFSET);
    act(() => {
      toast.dismiss();
    });
  });
});
