"use client";

import { Loader2, AlertCircle, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type RowStatus = "unmapped" | "mapped" | "saving" | "error";

export function RowStatusBadge({ status }: { status: RowStatus }) {
  switch (status) {
    case "mapped":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
          <Check className="h-3 w-3" />
          Mapped
        </span>
      );
    case "saving":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-yellow-700 dark:text-yellow-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-xs text-destructive">
          <AlertCircle className="h-3 w-3" />
          Error
        </span>
      );
    default:
      return (
        <span
          className={cn(
            "inline-block h-2 w-2 rounded-full bg-orange-500",
          )}
          aria-label="unmapped"
        />
      );
  }
}
