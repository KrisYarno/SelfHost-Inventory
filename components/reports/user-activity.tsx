"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Users, Package, Settings } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { UserActivitySummary } from "@/types/reports";

export function UserActivity() {
  const [users, setUsers] = useState<UserActivitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchUserActivity();
  }, []);

  const fetchUserActivity = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/reports/user-activity");
      if (!response.ok) throw new Error("Failed to fetch user activity");
      const data = await response.json();
      setUsers(data.users.slice(0, 6)); // Top 6 users
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load user activity");
    } finally {
      setLoading(false);
    }
  };

  const getInitials = (username: string) => {
    return username
      .split(" ")
      .map(n => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  const getActivityLevel = (totalTransactions: number) => {
    if (totalTransactions > 100) return { level: "High", color: "text-green-600" };
    if (totalTransactions > 50) return { level: "Medium", color: "text-yellow-600" };
    return { level: "Low", color: "text-blue-600" };
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>User Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
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
          <CardTitle>User Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Error: {error}</p>
        </CardContent>
      </Card>
    );
  }

  const maxTransactions = Math.max(...users.map(u => u.totalTransactions), 1);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          User Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {users.map((user) => {
            const activityLevel = getActivityLevel(user.totalTransactions);
            const progressValue = (user.totalTransactions / maxTransactions) * 100;
            
            return (
              <div
                key={user.userId}
                className="rounded-lg border p-4 space-y-3"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={`/api/placeholder/40/40`} />
                      <AvatarFallback>{getInitials(user.username)}</AvatarFallback>
                    </Avatar>
                    <div>
                      <h4 className="font-medium">{user.username}</h4>
                      <p className="text-xs text-muted-foreground">
                        Last active {formatDistanceToNow(new Date(user.lastActivity), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary" className={activityLevel.color}>
                    {activityLevel.level}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Total Actions</span>
                    <span className="font-medium">{user.totalTransactions}</span>
                  </div>
                  <Progress value={progressValue} className="h-2" />
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="text-center p-2 rounded bg-green-50 dark:bg-green-950">
                    <Package className="h-4 w-4 mx-auto mb-1 text-green-600" />
                    <div className="font-medium text-green-600">{user.stockInCount}</div>
                    <div className="text-muted-foreground">Stock In</div>
                  </div>
                  <div className="text-center p-2 rounded bg-red-50 dark:bg-red-950">
                    <Package className="h-4 w-4 mx-auto mb-1 text-red-600" />
                    <div className="font-medium text-red-600">{user.stockOutCount}</div>
                    <div className="text-muted-foreground">Stock Out</div>
                  </div>
                  <div className="text-center p-2 rounded bg-blue-50 dark:bg-blue-950">
                    <Settings className="h-4 w-4 mx-auto mb-1 text-blue-600" />
                    <div className="font-medium text-blue-600">{user.adjustmentCount}</div>
                    <div className="text-muted-foreground">Adjustments</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}