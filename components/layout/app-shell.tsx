"use client";

/**
 * components/layout/app-shell.tsx — the app chrome (Lane 4 spec §10 R-A2).
 *
 * `{children}` renders EXACTLY ONCE. The shell used to render two complete
 * copies of every page (a desktop copy and a mobile copy toggled by CSS),
 * double-mounting page trees and double-firing their effects/fetches. Now a
 * single `<main>` hosts the one children render, and the desktop sidebar /
 * mobile header + dock are responsive chrome around it.
 *
 * Pinned DOM invariants (plan codex #18; regression-tested in
 * `__tests__/unit/components/lane4-app-shell.test.tsx`):
 *   - root uses a definite-height model (`h-dvh`);
 *   - exactly ONE `<main>`, carrying `min-h-0 flex-1 overflow-y-auto` — the
 *     scroll container with a definite height, so a full-height flex page
 *     (`h-full flex flex-col min-h-0`) can pin a footer and scroll its middle
 *     (the D-B5 seam the assistant chat column relies on);
 *   - desktop: sidebar `w-64` on the left (`hidden md:flex`), main fills the
 *     rest;
 *   - mobile: in-flow header on top (`md:hidden`), the fixed bottom dock
 *     (`MobileNav`), and main padded for the dock + safe-area inset
 *     (`md:pb-0` clears it on desktop).
 *
 * Facelift F1-5 / F1-8 (pinned in `__tests__/components/layout/f1-shell.test.tsx`):
 *   - the skip link to `#main` is the root's FIRST child, and the one `<main>`
 *     is its focusable target;
 *   - the phone header is one compact 48 px row with no static title (the
 *     page's own h1 follows): the location chip takes the free width, then the
 *     search icon and the account avatar, each 44 × 44;
 *   - the sidebar captions the chip `Location`, its search bar is the only
 *     Cmd+K binding, and Theme lives in the user menu only.
 */

import { SidebarNav } from "./sidebar-nav";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { LocationSwitcher } from "./location-switcher";
import { GlobalSearch } from "./global-search";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background md:flex-row">
      <a href="#main" className="skip-link">Skip to content</a>

      {/* Desktop sidebar (chrome; hidden below md) */}
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface md:flex">
        <div className="flex h-full w-full flex-col">
          {/* Logo/Brand Section */}
          <div className="flex h-16 shrink-0 items-center border-b border-border px-6">
            <div className="text-xl font-semibold">Inventory</div>
          </div>

          {/* Location Switcher */}
          <div className="space-y-2 border-b border-border p-4">
            <p className="text-xs font-medium text-muted-foreground">Location</p>
            <LocationSwitcher />
          </div>

          {/* Global Search */}
          <div className="border-b border-border p-4">
            <GlobalSearch variant="bar" />
          </div>

          {/* Navigation */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarNav />
          </div>

          {/* User Menu at Bottom (Theme is inside it) */}
          <div className="border-t border-border p-4">
            <UserMenu />
          </div>
        </div>
      </aside>

      {/* Mobile header (chrome; hidden at md+). One row: the chip takes the
          free width and truncates (min-w-0 flex-1), so a long location name can
          never push the search or the avatar off-screen (FL-A-4). */}
      <header className="h-12 shrink-0 border-b border-border bg-background md:hidden">
        <div className="flex h-full items-center gap-2 px-4">
          <div className="min-w-0 flex-1">
            <LocationSwitcher />
          </div>
          <GlobalSearch variant="icon" />
          <UserMenu compact />
        </div>
      </header>

      {/* THE single main — the only children render (R-A2). Mobile bottom
          padding keeps content clear of the fixed dock + safe-area inset; the
          dock height is the one --dock-height variable (facelift F1-3). It is
          the skip link's target (tabIndex -1), so focusing it draws no outline
          around the whole page (FR1-9). */}
      <main
        id="main"
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-y-auto pb-[calc(var(--dock-height)+env(safe-area-inset-bottom))] md:pb-0 focus:outline-none"
      >
        {children}
      </main>

      {/* Mobile bottom dock (fixed; md:hidden internally) */}
      <MobileNav />
    </div>
  );
}
