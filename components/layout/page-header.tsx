import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
  sticky?: boolean;
  /**
   * Facelift F1-6: rendered inside `Page`, which owns the gutter and the
   * spacing. No padding, no fill of its own and no bottom border (a sticky
   * header still takes its fill); the title is 20/28 on phones (24/32 from
   * `sm`), the description shows from `sm` only, and the actions wrap under
   * the title when they don't fit. Without it the header is unchanged.
   */
  framed?: boolean;
}

export function PageHeader({ title, description, children, className, sticky = false, framed = false }: PageHeaderProps) {
  if (framed) {
    return (
      <header
        className={
          cn(
            sticky && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
            className
          ) || undefined
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div>
            <h1 className="text-h2 sm:text-h1 min-w-0">
              {title}
            </h1>
            {description && (
              <p className="hidden sm:block text-body-sm text-muted-foreground mt-0.5">
                {description}
              </p>
            )}
          </div>
          {children && (
            <div className="flex flex-wrap gap-2">
              {children}
            </div>
          )}
        </div>
      </header>
    );
  }

  return (
    <header
      className={cn(
        "border-b border-border bg-background px-4 sm:px-6 py-4",
        sticky && "sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        className
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-h1 tracking-tight">
            {title}
          </h1>
          {description && (
            <p className="text-body-sm text-muted-foreground mt-0.5">
              {description}
            </p>
          )}
        </div>
        {children && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {children}
          </div>
        )}
      </div>
    </header>
  );
}
