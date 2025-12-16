"use client";

import { ShoppingBag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PlatformType } from "@/types/external-orders";
import { PLATFORM_CONFIGS } from "@/types/external-orders";

interface PlatformBadgeProps {
  platform: PlatformType;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function PlatformBadge({ platform, size = "md", className }: PlatformBadgeProps) {
  const config = PLATFORM_CONFIGS[platform];

  const sizeClasses = {
    sm: "text-[10px] px-1.5 py-0.5 gap-0.5",
    md: "text-xs px-2 py-1 gap-1",
    lg: "text-sm px-2.5 py-1.5 gap-1.5",
  };

  const iconSizes = {
    sm: "h-2.5 w-2.5",
    md: "h-3 w-3",
    lg: "h-3.5 w-3.5",
  };

  if (platform === "SHOPIFY") {
    return (
      <Badge
        variant="outline"
        className={cn(
          "inline-flex items-center font-medium border",
          config.bgColor,
          config.color,
          sizeClasses[size],
          className
        )}
      >
        <ShoppingBag className={iconSizes[size]} />
        <span>{config.label}</span>
      </Badge>
    );
  }

  // WooCommerce badge
  return (
    <Badge
      variant="outline"
      className={cn(
        "inline-flex items-center font-semibold border",
        config.bgColor,
        config.color,
        sizeClasses[size],
        className
      )}
    >
      <span className="font-bold tracking-tight">WOO</span>
    </Badge>
  );
}
