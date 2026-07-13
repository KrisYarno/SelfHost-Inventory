/**
 * @jest-environment jsdom
 *
 * Lane 4 Task 2 — AppShell single-mount fix (spec §10 R-A2; plan codex #18).
 *
 * The shell must render `{children}` EXACTLY ONCE: one mounted probe, one DOM
 * instance. Historically the shell rendered children twice (a desktop copy and
 * a mobile copy toggled by CSS), double-mounting every page and double-firing
 * every page-level effect/fetch.
 *
 * Pinned DOM invariants (structural/class assertions only — jsdom does not do
 * pixel layout; the real scroll behavior is T6's live-drive check):
 *   - root uses a definite-height model (`h-dvh`);
 *   - exactly ONE <main>;
 *   - the main scroll container carries `min-h-0 flex-1 overflow-y-auto` so a
 *     full-height flex page can pin its footer and scroll its middle (D-B5's
 *     seam);
 *   - responsive chrome around the single main: desktop sidebar (w-64, hidden
 *     below md), mobile header (hidden at md+), mobile dock, safe-area padding.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { AppShell } from "@/components/layout/app-shell";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
}));
jest.mock("@/components/layout/sidebar-nav", () => ({
  SidebarNav: () => <div data-testid="sidebar-nav" />,
}));
jest.mock("@/components/layout/mobile-nav", () => ({
  MobileNav: () => <nav data-testid="mobile-nav" />,
}));
jest.mock("@/components/layout/user-menu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));
jest.mock("@/components/layout/location-switcher", () => ({
  LocationSwitcher: () => <div data-testid="location-switcher" />,
}));
jest.mock("@/components/theme-toggle-sidebar", () => ({
  ThemeToggleSidebar: () => <div data-testid="theme-toggle" />,
}));
jest.mock("@/components/layout/global-search", () => ({
  GlobalSearch: () => <div data-testid="global-search" />,
}));

let mountCount = 0;

function MountProbe() {
  React.useEffect(() => {
    mountCount += 1;
  }, []);
  return <div data-testid="mount-probe">page content</div>;
}

beforeEach(() => {
  mountCount = 0;
});

describe("AppShell — children render exactly once (R-A2)", () => {
  it("mounts the child exactly once and places exactly one instance in the DOM", () => {
    render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    expect(screen.getAllByTestId("mount-probe")).toHaveLength(1);
    expect(mountCount).toBe(1);
  });

  it("renders exactly one <main>, and the child lives inside it", () => {
    const { container } = render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    const mains = container.querySelectorAll("main");
    expect(mains).toHaveLength(1);
    expect(mains[0].querySelector('[data-testid="mount-probe"]')).not.toBeNull();
  });
});

describe("AppShell — pinned DOM invariants (codex #18)", () => {
  it("root uses a definite-height model (h-dvh)", () => {
    const { container } = render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain("h-dvh");
  });

  it("the single main is the min-h-0 scrollable flex child (footer-pin seam)", () => {
    const { container } = render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    const main = container.querySelector("main") as HTMLElement;
    expect(main).not.toBeNull();
    expect(main.className).toContain("min-h-0");
    expect(main.className).toContain("flex-1");
    expect(main.className).toContain("overflow-y-auto");
  });

  it("keeps the desktop sidebar chrome (w-64 aside, hidden below md)", () => {
    const { container } = render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    const aside = container.querySelector("aside") as HTMLElement;
    expect(aside).not.toBeNull();
    expect(aside.className).toContain("w-64");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("md:flex");
    // Sidebar chrome renders exactly once too.
    expect(screen.getAllByTestId("sidebar-nav")).toHaveLength(1);
  });

  it("keeps the mobile header (hidden at md+) and the mobile dock", () => {
    const { container } = render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    const header = container.querySelector("header") as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.className).toContain("md:hidden");
    expect(screen.getAllByTestId("mobile-nav")).toHaveLength(1);
  });

  it("pads the main for the mobile dock with safe-area awareness, cleared at md+", () => {
    const { container } = render(
      <AppShell>
        <MountProbe />
      </AppShell>,
    );
    const main = container.querySelector("main") as HTMLElement;
    expect(main.className).toContain("safe-area-inset-bottom");
    expect(main.className).toContain("md:pb-0");
  });
});
