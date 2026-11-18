import { cn } from "@/lib/utils";

interface StickyActionBarProps {
  children: React.ReactNode;
  /** What is pending, announced politely as it changes. Sits first. */
  summary?: React.ReactNode;
  ariaLabel: string;
  /** Merged last, so each consumer keeps its own emphasis. */
  className?: string;
}

/**
 * The one bar for pages with pending changes (facelift F1-3; DESIGN.md §3.4).
 *
 * It is fixed at EVERY width: on a phone it sits on top of the dock
 * (`--dock-height` plus the safe-area inset), and at `md` and up, where the
 * variable is 0, it sits on the bottom edge beside the `w-64` sidebar. Each
 * consumer keeps its own bottom padding so its content can scroll clear.
 */
export function StickyActionBar({ children, summary, ariaLabel, className }: StickyActionBarProps) {
  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={cn(
        "fixed inset-x-0 md:left-64 z-30 border-t border-border bg-background/95 backdrop-blur px-4 py-3 bottom-[calc(var(--dock-height)+env(safe-area-inset-bottom))]",
        className
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div aria-live="polite">{summary}</div>
        <div className="flex gap-2 sm:justify-end">{children}</div>
      </div>
    </div>
  );
}
