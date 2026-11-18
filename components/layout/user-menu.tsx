"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { User, Settings, LogOut, ChevronDown, Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface UserMenuProps {
  /**
   * Facelift F1-5: the phone header's 44 × 44 avatar button. The name and the
   * role appear only inside the menu, so the header never widens with them.
   */
  compact?: boolean;
}

export function UserMenu({ compact = false }: UserMenuProps) {
  const { data: session } = useSession();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const { theme, setTheme } = useTheme();

  if (!session?.user) {
    return null;
  }

  const handleSignOut = async () => {
    setIsLoading(true);
    await signOut({ redirect: false });
    router.push("/auth/signin");
  };

  const userInitials = session.user.email
    ?.split("@")[0]
    ?.slice(0, 2)
    ?.toUpperCase() || "U";
  const userName = session.user.email?.split("@")[0];
  const userRole = session.user.isAdmin ? "Admin" : "User";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 rounded-full p-0 hover:bg-surface-hover"
            aria-label="Account menu"
          >
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                {userInitials}
              </AvatarFallback>
            </Avatar>
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="w-full min-w-0 justify-start gap-2 px-2 hover:bg-surface-hover"
          >
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                {userInitials}
              </AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
              <div className="flex min-w-0 flex-col items-start">
                {/* The name is user data of unbounded length: truncate rather than
                    widen the header past the viewport (Lane 5 drive). */}
                <span className="max-w-full truncate text-sm font-medium">
                  {userName}
                </span>
                <span className="text-xs text-muted-foreground">{userRole}</span>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {compact ? (
          <DropdownMenuLabel className="flex min-w-0 flex-col">
            <span className="truncate">{userName}</span>
            <span className="text-xs font-normal text-muted-foreground">{userRole}</span>
          </DropdownMenuLabel>
        ) : (
          <DropdownMenuLabel>My Account</DropdownMenuLabel>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push("/account")}
          className="cursor-pointer"
        >
          <User className="mr-2 h-4 w-4" />
          <span>My Account</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => router.push("/settings")}
          className="cursor-pointer"
        >
          <Settings className="mr-2 h-4 w-4" />
          <span>Settings</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="cursor-pointer">
            {theme === "dark" ? (
              <Moon className="mr-2 h-4 w-4" />
            ) : theme === "light" ? (
              <Sun className="mr-2 h-4 w-4" />
            ) : (
              <Monitor className="mr-2 h-4 w-4" />
            )}
            <span>Theme</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="bg-surface text-foreground rounded-xl border border-border/70 shadow-lg">
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
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={handleSignOut}
          disabled={isLoading}
          className="cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="mr-2 h-4 w-4" />
          <span>{isLoading ? "Signing out..." : "Sign Out"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
