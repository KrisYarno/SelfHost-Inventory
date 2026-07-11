"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { toast } from "sonner";
import { TransferLogTable } from "@/components/inventory/transfer-log-table";

interface TransferLogRow {
  id: number;
  createdAt: string | Date;
  productName: string;
  quantity: number | null;
  fromLocationName: string;
  toLocationName: string;
  userName: string;
  batchId?: string | null;
  transferId?: string | null;
}

export function TransferLogTab({ active }: { active: boolean }) {
  const {
    data: logs = [],
    isFetching: isLoading,
    error,
    refetch,
  } = useQuery<TransferLogRow[]>({
    queryKey: ["inventory-transfers", { pageSize: 50 }],
    queryFn: async () => {
      const res = await fetch("/api/inventory/transfers?pageSize=50");
      if (!res.ok) throw new Error("Failed to load transfer history");
      const data = await res.json();
      return (data.transfers ?? []) as TransferLogRow[];
    },
    enabled: active,
  });

  const errorMessage =
    error instanceof Error ? error.message : error ? "Failed to load transfer history" : null;

  useEffect(() => {
    if (errorMessage) toast.error(errorMessage);
  }, [errorMessage]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Transfers</h2>
          <p className="text-muted-foreground text-sm">
            From/to location moves, separate from other adjustments.
          </p>
        </div>
        <Button onClick={() => refetch()} variant="outline" size="sm" disabled={isLoading}>
          {isLoading ? (
            <>
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Refreshing...
            </>
          ) : (
            "Refresh"
          )}
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Transfers</CardTitle>
          <StatusBadge tone="info" className="bg-muted text-foreground border-border/70">
            Latest {logs.length}
          </StatusBadge>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transfer activity recorded yet.</p>
          ) : (
            <TransferLogTable logs={logs} />
          )}

          {errorMessage && <p className="text-sm text-destructive mt-3">{errorMessage}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
