import { PageHeader } from "./page-header";

/** `default` 1280 px, `narrow` 672 px (forms), `wide` the full content area. */
const PAGE_WIDTHS = {
  default: "max-w-7xl",
  narrow: "max-w-2xl",
  wide: "max-w-none",
} as const;

interface PageProps {
  title: string;
  description?: string;
  /** The header's buttons. They wrap under the title when they don't fit. */
  actions?: React.ReactNode;
  width?: keyof typeof PAGE_WIDTHS;
  children: React.ReactNode;
}

/**
 * The page frame (facelift F1-6; FL-A-17; DESIGN.md §3.4): one gutter, one
 * width, and the framed `PageHeader` with the page's one h1, so every page
 * stops picking its own.
 */
export function Page({ title, description, actions, width = "default", children }: PageProps) {
  return (
    <div className={`px-4 sm:px-6 py-4 mx-auto ${PAGE_WIDTHS[width]}`}>
      <PageHeader framed title={title} description={description}>
        {actions}
      </PageHeader>
      <div className="mt-4">{children}</div>
    </div>
  );
}
