/** @jest-environment jsdom */
//
// Facelift F1-5 + F1-8 (plan 2026-11-18-facelift-f1 REV 2; FL-A-4, FL-A-5,
// FL-A-16, FL-A-18; OC1-18, OC1-19, OC1-22, G1-21) — the shell.
//
// The phone header was a 64 px blurred bar with a static "Inventory" title,
// a 36 px location select, a 42 x 30 search chip and a name+role user button
// that a long location name pushed off-screen. Now it is one 48 px row with no
// title (the page's own h1 follows): the location chip takes the free width,
// then a 44 x 44 search icon and a 44 x 44 account avatar.
//
// The desktop sidebar captions the chip `Location`, its search is a full-width
// bar (the only Cmd+K binding), and the footer's second theme control is gone
// (Theme lives in the user menu).
//
// Landmarks: a `Skip to content` link is the root's FIRST child and targets the
// one `<main>` (`id="main"`, focusable by script).

import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { AppShell } from "@/components/layout/app-shell";

jest.mock("next/navigation", () => ({ usePathname: () => "/" }));
jest.mock("@/components/layout/sidebar-nav", () => ({
  SidebarNav: () => <div data-testid="sidebar-nav" />,
}));
jest.mock("@/components/layout/mobile-nav", () => ({
  MobileNav: () => <div data-testid="mobile-nav" />,
}));
jest.mock("@/components/layout/location-switcher", () => ({
  LocationSwitcher: () => <div data-testid="location-switcher" />,
}));
jest.mock("@/components/layout/global-search", () => ({
  GlobalSearch: ({ variant }: { variant?: string }) => (
    <div data-testid="global-search" data-variant={String(variant)} />
  ),
}));
jest.mock("@/components/layout/user-menu", () => ({
  UserMenu: ({ compact }: { compact?: boolean }) => (
    <div data-testid="user-menu" data-compact={String(!!compact)} />
  ),
}));

const classesOf = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function renderShell() {
  return render(
    <AppShell>
      <div data-testid="page">page</div>
    </AppShell>
  );
}

describe("F1-5 — the phone header", () => {
  it("is one 48 px solid row: h-12 border-b border-border bg-background, hidden at md — no blur, no 60% fill", () => {
    const { container } = renderShell();
    const header = container.querySelector("header") as HTMLElement;
    expect(classesOf(header)).toEqual(
      expect.arrayContaining(["h-12", "border-b", "border-border", "bg-background", "md:hidden"])
    );
    for (const gone of ["h-16", "backdrop-blur", "bg-background/95", "supports-[backdrop-filter]:bg-background/60"]) {
      expect(classesOf(header)).not.toContain(gone);
    }
  });

  it("has no static title: the chip, then the search icon, then the compact account menu", () => {
    const { container } = renderShell();
    const header = container.querySelector("header") as HTMLElement;
    expect(header.textContent).toBe("");
    expect(within(header).queryByText("Inventory")).toBeNull();

    const row = header.firstElementChild as HTMLElement;
    const [chipSlot, search, account] = Array.from(row.children) as HTMLElement[];
    expect(row.children).toHaveLength(3);
    expect(classesOf(chipSlot)).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    expect(chipSlot.children).toHaveLength(1);
    expect(chipSlot.firstElementChild).toHaveAttribute("data-testid", "location-switcher");
    expect(search).toHaveAttribute("data-testid", "global-search");
    expect(search).toHaveAttribute("data-variant", "icon");
    expect(account).toHaveAttribute("data-testid", "user-menu");
    expect(account).toHaveAttribute("data-compact", "true");
  });
});

describe("F1-5 — the desktop sidebar", () => {
  it("captions the chip `Location`, directly above it", () => {
    const { container } = renderShell();
    const aside = container.querySelector("aside") as HTMLElement;
    const caption = within(aside).getByText("Location");
    expect(caption.getAttribute("class")).toBe("text-xs font-medium text-muted-foreground");
    expect(caption.nextElementSibling).toHaveAttribute("data-testid", "location-switcher");
  });

  it("holds the search BAR (the one Cmd+K binding) and the full user menu; the shell renders search twice, once per variant", () => {
    const { container } = renderShell();
    const aside = container.querySelector("aside") as HTMLElement;
    const search = within(aside).getByTestId("global-search");
    expect(search).toHaveAttribute("data-variant", "bar");
    expect(within(aside).getByTestId("user-menu")).toHaveAttribute("data-compact", "false");
    expect(
      screen.getAllByTestId("global-search").map((el) => el.getAttribute("data-variant")).sort()
    ).toEqual(["bar", "icon"]);
  });

  it("has no footer theme control: the footer holds only the user menu", () => {
    const { container } = renderShell();
    const aside = container.querySelector("aside") as HTMLElement;
    expect(within(aside).queryByText(/Theme/)).toBeNull();
    const footer = within(aside).getByTestId("user-menu").parentElement as HTMLElement;
    expect(footer.children).toHaveLength(1);
  });
});

describe("F1-8 — landmarks", () => {
  it("the skip link `Skip to content` is the root's FIRST child and targets #main", () => {
    const { container } = renderShell();
    const root = container.firstElementChild as HTMLElement;
    expect(classesOf(root)).toContain("h-dvh");
    const first = root.firstElementChild as HTMLElement;
    expect(first.tagName).toBe("A");
    expect(first).toHaveAttribute("href", "#main");
    expect(first).toHaveClass("skip-link");
    expect(first).toHaveTextContent("Skip to content");
  });

  it("the ONLY <main> is the shell's: id=main, tabIndex -1, and it holds the page", () => {
    const { container } = renderShell();
    const mains = container.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(mains[0]).toHaveAttribute("id", "main");
    expect(mains[0]).toHaveAttribute("tabindex", "-1");
    expect(within(mains[0]).getByTestId("page")).toBeInTheDocument();
  });
});
