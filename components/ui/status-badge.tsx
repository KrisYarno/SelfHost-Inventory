import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusTone = "positive" | "negative" | "warning" | "info" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  positive:
    "bg-emerald-100 text-emerald-800 border border-emerald-200 dark:bg-emerald-400/10 dark:text-emerald-200 dark:border-emerald-400/40",
  negative:
    "bg-red-100 text-red-800 border border-red-200 dark:bg-red-400/10 dark:text-red-200 dark:border-red-400/40",
  warning:
    "bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:border-amber-400/40",
  info:
    "bg-sky-100 text-sky-800 border border-sky-200 dark:bg-sky-400/10 dark:text-sky-200 dark:border-sky-400/40",
  neutral:
    "bg-slate-200 text-slate-800 border border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600",
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
