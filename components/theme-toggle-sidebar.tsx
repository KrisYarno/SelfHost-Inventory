"use client";

import * as React from "react";
import { Moon, Sun, Monitor, ChevronDown } from "lucide-react";
import { useTheme } from "next-themes";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export function ThemeToggleSidebar() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  // Avoid hydration mismatch
  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <Button variant="ghost" className="w-full justify-start gap-2 px-2 hover:bg-surface-hover">
        <Sun className="h-4 w-4" />
        <span className="text-sm">Light</span>
      </Button>
    );
  }

  // Determine which icon to show based on current theme
  const currentTheme = theme === "system" ? resolvedTheme : theme;
  
  const themeConfig = {
    light: { icon: Sun, label: "Light" },
    dark: { icon: Moon, label: "Dark" },
    system: { icon: Monitor, label: "System" },
  };

  const CurrentIcon = theme === "system" ? themeConfig.system.icon : themeConfig[currentTheme as keyof typeof themeConfig]?.icon || Sun;
  const currentLabel = theme === "system" ? "System" : themeConfig[currentTheme as keyof typeof themeConfig]?.label || "Light";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-full justify-between gap-2 px-2 hover:bg-surface-hover">
          <div className="flex items-center gap-2">
            <CurrentIcon className="h-4 w-4" />
            <span className="text-sm">Theme: {currentLabel}</span>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onClick={() => setTheme("light")}
          className="cursor-pointer"
        >
          <Sun className="mr-2 h-4 w-4" />
          <span>Light</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("dark")}
          className="cursor-pointer"
        >
          <Moon className="mr-2 h-4 w-4" />
          <span>Dark</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("system")}
          className="cursor-pointer"
        >
          <Monitor className="mr-2 h-4 w-4" />
          <span>System</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}