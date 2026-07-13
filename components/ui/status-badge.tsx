import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "positive" | "negative" | "warning" | "info" | "neutral";

/** Shared semantic tone classes - used by StatusBadge and ValueChip */
export const toneClasses: Record<StatusTone, string> = {
  positive: "bg-positive-muted text-positive-foreground border border-positive-border",
  negative: "bg-negative-muted text-negative-foreground border border-negative-border",
  warning: "bg-warning-muted text-warning-foreground border border-warning-border",
  info: "bg-info-muted text-info-foreground border border-info-border",
  neutral: "bg-muted text-muted-foreground border border-border",
};

export type StatusBadgeSize = "default" | "body";

/**
 * Size variants (Lane 4 spec §12 D-B8): the 11px default is for short
 * REDUNDANT tags only (D-L7 type floor); `size="body"` (14px) is for badges
 * that carry a load-bearing label — e.g. the chat ActorChip and provider-panel
 * status, where the badge may be the effective label.
 */
const sizeClasses: Record<StatusBadgeSize, string> = {
  default: "px-2.5 py-0.5 text-[11px]",
  body: "px-3 py-1 text-sm",
};

export interface StatusBadgeProps extends BadgeProps {
  tone?: StatusTone;
  size?: StatusBadgeSize;
}

export function StatusBadge({
  tone = "neutral",
  size = "default",
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <Badge
      className={cn(
        "rounded-full font-medium tracking-wide",
        sizeClasses[size],
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
