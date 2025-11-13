import * as React from "react";
import { cn } from "@/lib/utils";

type ValueTone = "positive" | "negative" | "neutral";

const valueToneClasses: Record<ValueTone, string> = {
  positive:
    "bg-emerald-400/10 text-emerald-200 border border-emerald-400/40",
  negative: "bg-red-400/10 text-red-200 border border-red-400/40",
  neutral: "bg-slate-800 text-slate-100 border border-slate-600",
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
