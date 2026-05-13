"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  fetchedAt: string | undefined;
  onRefresh: () => void;
  refreshing: boolean;
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function RefreshButton({ fetchedAt, onRefresh, refreshing }: Props) {
  const stale = fetchedAt
    ? Date.now() - new Date(fetchedAt).getTime() > 30 * 60_000
    : false;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={stale ? "text-yellow-600" : "text-muted-foreground"}>
        Catalog loaded {relativeTime(fetchedAt)}
      </span>
      <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
        Refresh
      </Button>
    </div>
  );
}
