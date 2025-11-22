import * as React from "react";
import { cn } from "@/lib/utils";

type ValueTone = "positive" | "negative" | "neutral";

const valueToneClasses: Record<ValueTone, string> = {
  positive:
    "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-200 dark:border-emerald-400/40",
  negative:
    "bg-red-100 text-red-800 border border-red-200 dark:bg-red-400/10 dark:text-red-200 dark:border-red-400/40",
  neutral:
    "bg-slate-200 text-slate-800 border border-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:border-slate-600",
};

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
        valueToneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
