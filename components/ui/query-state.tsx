"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The slice of a react-query result QueryState reads. */
interface QueryStateQuery<T> {
  isPending: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  isError: boolean;
  isPlaceholderData?: boolean;
  data: T | undefined;
  refetch: () => unknown;
}

interface QueryStateProps<T> {
  query: QueryStateQuery<T>;
  /** Shown while the first read is in flight, inside `role="status"`. */
  skeleton: React.ReactNode;
  /** Whether an ANSWER is empty. Never asked of placeholder data. */
  isEmpty?: (data: T) => boolean;
  empty?: React.ReactNode;
  errorTitle?: string;
  errorText: React.ReactNode;
  /** Shown while the query is disabled (pending with nothing in flight). */
  idle?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}

/**
 * One read's states, said truthfully (facelift F1-7; FL-D-12, FL-D-13;
 * DESIGN.md §3.4). Error and empty are said only about an ANSWER:
 *   - pending, a read in flight: `skeleton`, inside `role="status"`;
 *   - pending, disabled: `idle`, or nothing;
 *   - failed with no data: the error, with Retry. A failed refresh over data
 *     already loaded keeps the data — the error is for a read with no answer;
 *   - an answer (not placeholder data) that `isEmpty`: `empty`;
 *   - otherwise: `children(data)`.
 */
export function QueryState<T>({
  query,
  skeleton,
  isEmpty,
  empty,
  errorTitle,
  errorText,
  idle,
  children,
}: QueryStateProps<T>) {
  const { isPending, fetchStatus, isError, isPlaceholderData, data, refetch } = query;

  if (isPending) {
    if (fetchStatus === "idle") return <>{idle ?? null}</>;
    return <div role="status">{skeleton}</div>;
  }

  if (data === undefined) {
    if (!isError) return null;
    return (
      <div role="alert" className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        {errorTitle && <p className="font-semibold">{errorTitle}</p>}
        <div className="text-body-sm text-muted-foreground">{errorText}</div>
        <Button variant="outline" onClick={() => refetch()} className="mt-2">
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  if (!isPlaceholderData && isEmpty?.(data)) return <>{empty}</>;

  return <>{children(data)}</>;
}
