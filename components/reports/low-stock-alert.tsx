"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Package } from "lucide-react";
import { LowStockAlert as LowStockAlertType } from "@/types/reports";
import { cn } from "@/lib/utils";

export function LowStockAlert() {
  const [alerts, setAlerts] = useState<LowStockAlertType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchLowStockAlerts();
  }, []);

  const fetchLowStockAlerts = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/reports/low-stock");
      if (!response.ok) throw new Error("Failed to fetch low stock alerts");
      const data = await response.json();
      setAlerts(data.alerts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  };

  const getSeverity = (percentageRemaining: number) => {
    if (percentageRemaining === 0) return "critical";
    if (percentageRemaining < 25) return "high";
    if (percentageRemaining < 50) return "medium";
    return "low";
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "text-red-600 bg-red-50 border-red-200";
      case "high":
        return "text-orange-600 bg-orange-50 border-orange-200";
      case "medium":
        return "text-yellow-600 bg-yellow-50 border-yellow-200";
      default:
        return "text-blue-600 bg-blue-50 border-blue-200";
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Low Stock Alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Low Stock Alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-orange-600" />
          Low Stock Alerts
          {alerts.length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              {alerts.length} items
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="text-center py-8">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              All products are well stocked!
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => {
              const severity = getSeverity(alert.percentageRemaining);
              return (
                <div
                  key={alert.productId}
                  className={cn(
                    "rounded-lg border p-3 space-y-2",
                    getSeverityColor(severity)
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-medium text-sm">
                        {alert.productName}
                      </h4>
                      <p className="text-xs opacity-90">
                        {alert.currentStock} units remaining
                      </p>
                    </div>
                    <Badge
                      variant={severity === "critical" ? "destructive" : "secondary"}
                      className="text-xs"
                    >
                      {severity === "critical" ? "Out of Stock" : 
                       alert.daysUntilEmpty ? `${alert.daysUntilEmpty} days left` : "Low usage"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span>Stock Level</span>
                      <span>{alert.percentageRemaining}% of threshold</span>
                    </div>
                    <Progress 
                      value={alert.percentageRemaining} 
                      className="h-1.5"
                    />
                  </div>
                  {alert.averageDailyUsage > 0 && (
                    <p className="text-xs opacity-75">
                      Average daily usage: {alert.averageDailyUsage} units
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}