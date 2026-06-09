"use client";

import { useQuery } from "@tanstack/react-query";
import type { InventoryLogWithRelations } from "@/types/inventory";
import type { TransferLogRow } from "@/components/inventory/transfer-log-table";

export function useInventoryLogs() {
  return useQuery({
    queryKey: ["inventory-logs", { pageSize: 20 }],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/inventory/logs?pageSize=20", { signal });
      if (!res.ok) throw new Error("Failed to load inventory logs");
      const data = await res.json();
      return (data.logs ?? []) as InventoryLogWithRelations[];
    },
    staleTime: 60_000,
  });
}

export function useInventoryTransfers() {
  return useQuery({
    queryKey: ["inventory-transfers", { pageSize: 20 }],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/inventory/transfers?pageSize=20", { signal });
      if (!res.ok) throw new Error("Failed to load transfer history");
      const data = await res.json();
      return (data.transfers ?? []) as TransferLogRow[];
    },
    staleTime: 60_000,
  });
}
