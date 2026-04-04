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

export interface StatusBadgeProps extends BadgeProps {
  tone?: StatusTone;
}

export function StatusBadge({
  tone = "neutral",
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <Badge
      className={cn(
        "rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
