"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import type { CombinedMinBreach } from "@/types/inventory";

export function CombinedMinimumsReport() {
  const [breaches, setBreaches] = useState<CombinedMinBreach[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/reports/minimums");
        if (!res.ok) throw new Error("Failed to fetch minimum report");
        const data = await res.json();
        setBreaches(data.breaches || []);
      } catch (err) {
        console.error(err);
        setError("Failed to load minimum report");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base font-semibold">
          Below combined minimums
        </CardTitle>
        <Badge variant="secondary">
          {breaches.length} product{breaches.length === 1 ? "" : "s"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading combined minimums...
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : breaches.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All products are above their combined minimums.
          </p>
        ) : (
          breaches.map((item) => {
            const percentage =
              item.combinedMinimum > 0
                ? Math.round((item.totalQuantity / item.combinedMinimum) * 100)
                : 0;
            return (
              <div
                key={item.productId}
                className="flex items-center justify-between rounded border border-slate-800 bg-slate-900/70 px-3 py-2"
              >
                <div>
                  <p className="text-sm font-medium text-slate-100">
                    {item.productName}
                  </p>
                  <p className="text-xs text-slate-400">
                    {item.totalQuantity} / {item.combinedMinimum} units (
                    {percentage}%)
                  </p>
                </div>
                <Badge
                  variant="destructive"
                  className="text-xs capitalize"
                >
                  Need {Math.max(item.combinedMinimum - item.totalQuantity, 0)}{" "}
                  units
                </Badge>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
