"use client";

import { cn } from "@/lib/utils";
import { BarChart3, Boxes } from "lucide-react";

export type AnalyticsView = "sales" | "operations";

// Segmented control switching the /analytics hub between the company-scoped Sales
// rollup and the GLOBAL Operations view (spec D6 / D-L3). Labels are locked:
// "Sales by company | Inventory operations". Real buttons (focusable, aria-pressed);
// state color rides toneClasses via bg-surface/primary, never a raw utility hue.
const OPTIONS: { key: AnalyticsView; label: string; icon: typeof BarChart3 }[] = [
  { key: "sales", label: "Sales by company", icon: BarChart3 },
  { key: "operations", label: "Inventory operations", icon: Boxes },
];

export function ViewToggle({
  value,
  onChange,
}: {
  value: AnalyticsView;
  onChange: (v: AnalyticsView) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Analytics view"
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
    >
      {OPTIONS.map(({ key, label, icon: Icon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex min-h-[44px] items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
