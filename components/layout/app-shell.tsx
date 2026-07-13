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
 */

import { SidebarNav } from "./sidebar-nav";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { LocationSwitcher } from "./location-switcher";
import { ThemeToggleSidebar } from "@/components/theme-toggle-sidebar";
import { GlobalSearch } from "./global-search";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background md:flex-row">
      {/* Desktop sidebar (chrome; hidden below md) */}
      <aside className="hidden w-64 shrink-0 border-r border-border bg-surface md:flex">
        <div className="flex h-full w-full flex-col">
          {/* Logo/Brand Section */}
          <div className="flex h-16 shrink-0 items-center border-b border-border px-6">
            <div className="text-xl font-semibold">Inventory</div>
          </div>

          {/* Location Switcher */}
          <div className="border-b border-border p-4">
            <LocationSwitcher />
          </div>

          {/* Global Search */}
          <div className="border-b border-border p-4">
            <GlobalSearch />
          </div>

          {/* Navigation */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SidebarNav />
          </div>

          {/* User Menu and Theme Toggle at Bottom */}
          <div className="space-y-2 border-t border-border p-4">
            <ThemeToggleSidebar />
            <UserMenu />
          </div>
        </div>
      </aside>

      {/* Mobile header (chrome; hidden at md+) */}
      <header className="shrink-0 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden">
        <div className="flex h-16 items-center justify-between px-4">
          <div className="text-lg font-semibold">Inventory</div>
          <div className="flex items-center gap-2">
            <GlobalSearch />
            <LocationSwitcher />
            <UserMenu />
          </div>
        </div>
      </header>

      {/* THE single main — the only children render (R-A2). Mobile bottom
          padding keeps content clear of the fixed dock + safe-area inset. */}
      <main className="min-h-0 flex-1 overflow-y-auto pb-[calc(theme(spacing.14)+env(safe-area-inset-bottom))] md:pb-0">
        {children}
      </main>

      {/* Mobile bottom dock (fixed; md:hidden internally) */}
      <MobileNav />
    </div>
  );
}
