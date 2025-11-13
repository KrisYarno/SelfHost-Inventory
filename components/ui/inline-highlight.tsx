import * as React from "react";
import { cn } from "@/lib/utils";

export type InlineHighlightProps = React.HTMLAttributes<HTMLSpanElement>;

export function InlineHighlight({
  className,
  ...props
}: InlineHighlightProps) {
  return (
    <span
      className={cn(
        "rounded-sm bg-slate-800/80 px-1 py-0.5 text-[13px] font-medium text-slate-100",
        className
      )}
      {...props}
    />
  );
}
