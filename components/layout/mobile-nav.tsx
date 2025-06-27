"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Package, BarChart3, Settings, Warehouse } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";

const navigation = [
  {
    name: "Workbench",
    href: "/workbench",
    icon: Home,
    label: "Workbench",
  },
  {
    name: "Products",
    href: "/products",
    icon: Package,
    label: "Products",
  },
  {
    name: "Inventory",
    href: "/inventory",
    icon: Warehouse,
    label: "Inventory",
  },
  {
    name: "Reports",
    href: "/reports",
    icon: BarChart3,
    label: "Reports",
  },
];

const adminNavigation = [
  {
    name: "Admin",
    href: "/admin",
    icon: Settings,
    label: "Admin",
  },
];

export function MobileNav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin;

  const allNavigation = [...navigation, ...(isAdmin ? adminNavigation : [])];

  return (
    <nav className="fixed bottom-0 z-40 w-full border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center justify-around px-4">
        {allNavigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center gap-1 px-3 py-2 text-xs font-medium transition-colors",
                "hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
            >
              <item.icon
                className={cn(
                  "h-5 w-5",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground"
                )}
                aria-hidden="true"
              />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}