"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { 
  LayoutDashboard, 
  Users, 
  FileText,
  Settings,
  Package,
  Shield,
  BarChart3
} from "lucide-react";

const adminNavItems = [
  {
    title: "Overview",
    href: "/admin",
    icon: LayoutDashboard,
  },
  {
    title: "Mass Update",
    href: "/admin/inventory/mass-update",
    icon: Package,
  },
  {
    title: "Reports",
    href: "/admin/reports",
    icon: BarChart3,
  },
  {
    title: "Change Logs",
    href: "/admin/logs",
    icon: FileText,
  },
  {
    title: "Users",
    href: "/admin/users",
    icon: Users,
  },
  {
    title: "Audit Logs",
    href: "/admin/audit-logs",
    icon: Shield,
  },
  {
    title: "Settings",
    href: "/admin/settings",
    icon: Settings,
  },
  {
    title: "Backup",
    href: "/admin/backup",
    icon: FileText,
  },
];

export function AdminSubNav() {
  const pathname = usePathname();

  return (
    <div className="border-b">
      <div className="flex h-16 items-center px-4 sm:px-6">
        <nav className="flex items-center gap-4 sm:gap-6 overflow-x-auto max-w-full">
          {adminNavItems.map((item) => {
            const isActive = pathname === item.href;
            const Icon = item.icon;
            
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 text-sm font-medium transition-colors hover:text-primary",
                  isActive
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.title}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
