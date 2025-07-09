'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle, Clock, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RateLimitData {
  endpoint: string;
  current: number;
  limit: number;
  resetTime: string;
  blocked: number;
}

export function RateLimitMonitor() {
  const [rateLimits, setRateLimits] = useState<RateLimitData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRateLimitData();
    const interval = setInterval(fetchRateLimitData, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const fetchRateLimitData = async () => {
    try {
      const response = await fetch('/api/admin/rate-limits');
      if (response.ok) {
        const data = await response.json();
        setRateLimits(data);
      }
    } catch (error) {
      console.error('Failed to fetch rate limit data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (current: number, limit: number) => {
    const percentage = (current / limit) * 100;
    if (percentage >= 90) return 'text-red-500';
    if (percentage >= 70) return 'text-yellow-500';
    return 'text-green-500';
  };

  const getProgressColor = (current: number, limit: number) => {
    const percentage = (current / limit) * 100;
    if (percentage >= 90) return 'bg-red-500';
    if (percentage >= 70) return 'bg-yellow-500';
    return 'bg-green-500';
  };

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
          Real-time monitoring of API rate limits across endpoints
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {rateLimits.map((limit) => {
            const percentage = (limit.current / limit.limit) * 100;
            const resetIn = new Date(limit.resetTime).getTime() - new Date().getTime();
            const resetMinutes = Math.max(0, Math.floor(resetIn / 60000));
            const resetSeconds = Math.max(0, Math.floor((resetIn % 60000) / 1000));

            return (
              <div key={limit.endpoint} className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{limit.endpoint}</span>
                    {limit.blocked > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        {limit.blocked} blocked
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      Reset in {resetMinutes}m {resetSeconds}s
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Progress 
                    value={percentage} 
                    className="flex-1"
                    style={{
                      '--progress-background': getProgressColor(limit.current, limit.limit)
                    } as React.CSSProperties}
                  />
                  <div className="flex items-center gap-1 min-w-[100px]">
                    {percentage < 90 ? (
                      <CheckCircle className={cn("h-4 w-4", getStatusColor(limit.current, limit.limit))} />
                    ) : (
                      <AlertCircle className={cn("h-4 w-4", getStatusColor(limit.current, limit.limit))} />
                    )}
                    <span className={cn("text-sm font-medium", getStatusColor(limit.current, limit.limit))}>
                      {limit.current} / {limit.limit}
                    </span>
                  </div>
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