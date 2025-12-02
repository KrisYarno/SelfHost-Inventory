import * as React from "react";
import { cn } from "@/lib/utils";
import { toneClasses, type StatusTone } from "@/components/ui/status-badge";

type ValueTone = "positive" | "negative" | "neutral";

export interface ValueChipProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: ValueTone;
}

export function ValueChip({
  tone = "neutral",
  className,
  ...props
}: ValueChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold tabular-nums",
        toneClasses[tone as StatusTone],
        className
      )}
      {...props}
    />
  );
}
