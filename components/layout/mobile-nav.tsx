"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Package, Settings, Warehouse, ClipboardList } from "lucide-react";
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
    name: "Journal",
    href: "/journal",
    icon: ClipboardList,
    label: "Journal",
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
    <nav className="fixed bottom-0 z-50 w-full border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14 items-center justify-around px-2">
        {allNavigation.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "relative flex flex-col items-center justify-center p-2 transition-colors rounded-lg",
                "hover:bg-muted/50",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                "min-w-[44px] min-h-[44px]",
                isActive
                  ? "text-primary"
                  : "text-muted-foreground"
              )}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              title={item.label}
            >
              <item.icon className={cn("h-5 w-5", isActive && "scale-110")} aria-hidden="true" />
              <span className="mt-1 text-[10px] leading-none">{item.label}</span>
              {isActive && (
                <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
