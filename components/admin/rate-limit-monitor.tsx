'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Clock, TrendingUp } from 'lucide-react';
import { useRateLimits } from '@/hooks/use-admin';

// Shape returned by /api/admin/rate-limits documented in hooks/use-admin.ts:
// the in-memory store only knows the request count and expiry per key — it does
// NOT persist each scope's configured limit, nor a separate "blocked" tally — so
// the widget shows only what is actually knowable rather than dividing by an
// invented limit (which rendered NaN).

export function RateLimitMonitor() {
  const { data, isLoading: loading } = useRateLimits();
  const rateLimits = data ?? [];

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Rate Limit Monitor</CardTitle>
          <CardDescription>Loading rate limit data...</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5" />
          Rate Limit Monitor
        </CardTitle>
        <CardDescription>
          Active rate-limit windows across API scopes
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-4">
          Counts are in-memory and per-instance — they reflect only this server
          instance and reset when each window expires or the app restarts.
        </p>
        <div className="space-y-4">
          {rateLimits.map((limit) => {
            const resetIn = new Date(limit.resetTime).getTime() - new Date().getTime();
            const resetMinutes = Math.max(0, Math.floor(resetIn / 60000));
            const resetSeconds = Math.max(0, Math.floor((resetIn % 60000) / 1000));

            return (
              <div key={limit.endpoint} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="font-medium truncate max-w-[60vw] sm:max-w-none">
                    {limit.endpoint}
                  </span>
                  <div className="flex items-center gap-2 text-sm flex-shrink-0">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Resets in {resetMinutes}m {resetSeconds}s
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-baseline gap-1">
                    <span className="font-semibold tabular-nums">{limit.current}</span>
                    <span className="text-muted-foreground">peak req / window</span>
                  </div>
                  <Badge variant="secondary" className="text-xs tabular-nums">
                    {limit.entries} active client{limit.entries !== 1 ? 's' : ''}
                  </Badge>
                </div>
              </div>
            );
          })}

          {rateLimits.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No active rate limits to display
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
