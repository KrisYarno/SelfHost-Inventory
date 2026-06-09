"use client";

/**
 * Mobile bottom dock: the 6 ordered top-level slots from the shared nav config
 * (see {@link navConfig}). Direct slots render as <Link>s; group slots render
 * the speed-dial {@link NavGroupPopover}. After admin-gating, a group with one
 * visible child collapses to a direct link to that child (one-tap-group), and a
 * group with zero visible children renders nothing.
 *
 * Per the mobile-nav-analytics-polish design doc ("Design Review Resolutions
 * 2026-06-08"):
 *   - Pending useSession: paint the base slots immediately; the admin-only Admin
 *     slot (the LAST slot) APPENDS when the session resolves -> no mid-bar reflow.
 *   - Single-open invariant: opening one group closes any other open group. This
 *     parent owns the open state.
 *   - Edge-anchoring: align is derived per slot from its index in the filtered
 *     array (left for the left half, right for the right half) so rising pill
 *     columns never clip.
 *
 * This <nav> keeps the safe-area inset chrome (T2 left it here deliberately).
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { filterNav, navConfig, type NavLink } from "@/lib/nav-config";
import { NavGroupPopover } from "@/components/layout/nav-group-popover";

/** True when a pathname is at, or nested under, the given href. */
function routeMatches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * A single direct dock link (icon + label + active dot). Shared by genuine
 * direct slots AND one-tap-group collapses so they look identical.
 */
function DirectNavLink({ link, isActive }: { link: NavLink; isActive: boolean }) {
  const Icon = link.icon;
  return (
    <Link
      href={link.href}
      className={cn(
        // z-50 keeps direct links ABOVE an open group's dismiss-backdrop (z-40)
        // so they navigate on the first tap instead of just dismissing the dial.
        "relative z-50 flex flex-col items-center justify-center p-2 transition-colors rounded-lg",
        "hover:bg-muted/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        "min-w-[44px] min-h-[44px]",
        isActive ? "text-primary" : "text-muted-foreground",
      )}
      aria-label={link.label}
      aria-current={isActive ? "page" : undefined}
      title={link.label}
    >
      <Icon className={cn("h-5 w-5", isActive && "scale-110")} aria-hidden="true" />
      <span className="mt-1 text-[10px] leading-none">{link.label}</span>
      {isActive && (
        <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary" />
      )}
    </Link>
  );
}

export function MobileNav() {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAdmin;

  // Filtered top-level slots: Admin drops for non-admins, so a non-admin paints
  // 5 slots and an admin's resolved session appends Admin at the end.
  const slots = filterNav(navConfig, isAdmin);
  const total = slots.length;

  // Single-open state: the key of the currently-open group, or null.
  const [openKey, setOpenKey] = React.useState<string | null>(null);

  // Close any open speed-dial when the route changes. Direct dock links (and
  // pills) now sit above the dismiss-backdrop, so a navigation can happen while
  // a group is open; this guarantees the dial never lingers over the new page.
  React.useEffect(() => {
    setOpenKey(null);
  }, [pathname]);

  return (
    <nav className="fixed bottom-0 z-50 w-full border-t border-border/60 bg-background/85 backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/65 shadow-[0_-8px_24px_-12px_hsl(0_0%_0%/0.35),inset_0_1px_0_0_hsl(0_0%_100%/0.07)] md:hidden pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14 items-center justify-around px-2">
        {slots.map((slot, index) => {
          if (slot.kind === "link") {
            return (
              <DirectNavLink
                key={slot.href}
                link={slot}
                isActive={routeMatches(pathname, slot.href)}
              />
            );
          }

          // Group slot: gate children, then collapse degenerate cases.
          const visible = slot.children.filter((c) => !(c.adminOnly && !isAdmin));
          if (visible.length === 0) return null;
          if (visible.length === 1) {
            const child = visible[0];
            return (
              <DirectNavLink
                key={child.href}
                link={child}
                isActive={routeMatches(pathname, child.href)}
              />
            );
          }

          return (
            <NavGroupPopover
              key={slot.key}
              group={slot}
              isAdmin={isAdmin}
              isOpen={openKey === slot.key}
              onToggle={() => setOpenKey((k) => (k === slot.key ? null : slot.key))}
              onClose={() => setOpenKey(null)}
              align={index < total / 2 ? "left" : "right"}
            />
          );
        })}
      </div>
    </nav>
  );
}
