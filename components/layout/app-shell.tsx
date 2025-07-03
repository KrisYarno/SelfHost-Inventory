"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { SidebarNav } from "./sidebar-nav";
import { MobileNav } from "./mobile-nav";
import { UserMenu } from "./user-menu";
import { LocationSwitcher } from "./location-switcher";
import { ThemeToggleSidebar } from "@/components/theme-toggle-sidebar";

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [, setIsMobileMenuOpen] = useState(false);
  const pathname = usePathname();

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop Layout */}
      <div className="hidden md:flex h-screen">
        {/* Sidebar */}
        <aside className="w-64 border-r border-border bg-surface">
          <div className="flex h-full flex-col">
            {/* Logo/Brand Section */}
            <div className="flex h-16 items-center border-b border-border px-6">
              <h1 className="text-xl font-semibold">Inventory</h1>
            </div>
            
            {/* Location Switcher */}
            <div className="border-b border-border p-4">
              <LocationSwitcher />
            </div>
            
            {/* Navigation */}
            <div className="flex-1 overflow-y-auto">
              <SidebarNav />
            </div>
            
            {/* User Menu and Theme Toggle at Bottom */}
            <div className="border-t border-border p-4 space-y-2">
              <ThemeToggleSidebar />
              <UserMenu />
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="h-full">{children}</div>
        </main>
      </div>

      {/* Mobile Layout */}
      <div className="md:hidden">
        {/* Mobile Header */}
        <header className="fixed top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex h-16 items-center justify-between px-4">
            <h1 className="text-lg font-semibold">Inventory</h1>
            <div className="flex items-center gap-2">
              <LocationSwitcher />
              <UserMenu />
            </div>
          </div>
        </header>

        {/* Main Content with padding for header and bottom nav */}
        <main className="pt-16 pb-14">
          <div className="min-h-[calc(100vh-7.5rem)]">{children}</div>
        </main>

        {/* Mobile Bottom Navigation */}
        <MobileNav />
      </div>
    </div>
  );
}