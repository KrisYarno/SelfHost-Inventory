import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toneClasses, type StatusTone } from "@/components/ui/tone-classes";

// The tones live in tone-classes.ts (facelift F1-2); re-exported here so every
// existing `@/components/ui/status-badge` import keeps working.
export { toneClasses, type StatusTone };

export type StatusBadgeSize = "default" | "body";

/**
 * Size variants (Lane 4 spec §12 D-B8): the default is for short REDUNDANT
 * tags only (D-L7 type floor); `size="body"` (14px) is for badges that carry a
 * load-bearing label — e.g. the chat ActorChip and provider-panel status, where
 * the badge may be the effective label. Facelift F1-2: the default is 12/16
 * (`text-xs`, a size tailwind-merge recognises), no longer 11px.
 */
const sizeClasses: Record<StatusBadgeSize, string> = {
  default: "px-2.5 py-0.5 text-xs",
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
