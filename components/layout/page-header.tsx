import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  className?: string;
  sticky?: boolean;
}

export function PageHeader({ title, description, children, className, sticky = false }: PageHeaderProps) {
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
