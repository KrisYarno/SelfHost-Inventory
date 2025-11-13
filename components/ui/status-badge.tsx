import * as React from "react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusTone = "positive" | "negative" | "warning" | "info" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  positive: "bg-emerald-400/10 text-emerald-200 border border-emerald-400/40",
  negative: "bg-red-400/10 text-red-200 border border-red-400/40",
  warning: "bg-amber-400/10 text-amber-200 border border-amber-400/40",
  info: "bg-sky-400/10 text-sky-200 border border-sky-400/40",
  neutral: "bg-slate-800 text-slate-200 border border-slate-600",
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
