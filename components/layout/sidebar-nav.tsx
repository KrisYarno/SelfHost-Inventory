"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Package, BarChart3, Settings, Warehouse, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";

const navigation = [
  {
    name: "Workbench",
    href: "/workbench",
    icon: Home,
    description: "Main inventory management",
  },
  {
    name: "Products",
    href: "/products",
    icon: Package,
    description: "Product catalog",
  },
  {
    name: "Inventory",
    href: "/inventory",
    icon: Warehouse,
    description: "Inventory ledger and tracking",
  },
  {
    name: "Journal",
    href: "/journal",
    icon: BookOpen,
    description: "Bulk inventory adjustments",
  },
  {
    name: "Reports",
    href: "/reports",
    icon: BarChart3,
    description: "Analytics and reports",
  },
];

const adminNavigation = [
  {
    name: "Admin",
    href: "/admin",
    icon: Settings,
    description: "Administration panel",
  },
];

export function SidebarNav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin;

  const allNavigation = [...navigation, ...(isAdmin ? adminNavigation : [])];

  return (
    <nav className="space-y-1 px-3 py-4">
      {allNavigation.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        
        return (
          <Link
            key={item.name}
            href={item.href}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              "hover:bg-surface-hover hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground"
            )}
            aria-label={item.description}
            aria-current={isActive ? "page" : undefined}
          >
            <item.icon
              className={cn(
                "h-5 w-5 flex-shrink-0",
                isActive
                  ? "text-primary-foreground"
                  : "text-muted-foreground group-hover:text-foreground"
              )}
              aria-hidden="true"
            />
            <span>{item.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}