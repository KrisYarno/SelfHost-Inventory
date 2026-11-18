import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route-level loading state (facelift F1-4): only the page gutter and a
 * title-bar skeleton. Each page's own skeleton follows, so there is no second
 * shape change.
 */
export default function AppRouteLoading() {
  return (
    <div className="px-4 sm:px-6 py-4" role="status" aria-label="Loading"><Skeleton className="h-7 w-40" /></div>
  );
}
