"use client";

/**
 * Desktop sidebar: a FLAT vertical list of every visible leaf link, in workflow
 * order, via {@link flattenNav} over the shared {@link navConfig}. Grouping and
 * the speed-dial are mobile-only; the desktop stays flat by design.
 *
 * Consuming the shared config ungates Orders (now a Fulfill child, present for
 * all users) and reorders the list to the workflow IA:
 *   Workbench, Orders, Inventory, Stocker, Pre-Staging, Journal, Products,
 *   Price Board, Analytics, [Admin], Assistant.
 *
 * The desktop-only {@link desktopOnlyNav} leaves (Assistant) are appended here
 * and NOWHERE else (Lane 4 spec §10 R-A3): the mobile dock stays exactly the 6
 * `navConfig` slots.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { desktopOnlyNav, flattenNav, navConfig } from "@/lib/nav-config";

export function SidebarNav() {
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAdmin;

  const links = [...flattenNav(navConfig, isAdmin), ...desktopOnlyNav];

  return (
    <nav className="space-y-1 px-3 py-4">
      {links.map((link) => {
        const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);

        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors min-h-[44px]",
              "hover:bg-surface-hover hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            )}
            aria-label={link.label}
            aria-current={isActive ? "page" : undefined}
          >
            <link.icon
              className={cn(
                "h-5 w-5 flex-shrink-0",
                isActive
                  ? "text-primary-foreground"
                  : "text-muted-foreground group-hover:text-foreground"
              )}
              aria-hidden="true"
            />
            <span>{link.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}
