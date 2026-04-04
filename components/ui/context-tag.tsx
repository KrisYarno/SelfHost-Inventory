import * as React from "react";
import { cn } from "@/lib/utils";

export interface ContextTagProps
  extends React.HTMLAttributes<HTMLSpanElement> {
  icon?: React.ReactNode;
}

export function ContextTag({
  icon,
  className,
  children,
  ...props
}: ContextTagProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        "border-border bg-muted text-muted-foreground",
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}
