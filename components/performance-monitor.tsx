'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';

export function PerformanceMonitor() {
  const [metrics, setMetrics] = useState({
    loadTime: 0,
    apiCalls: 0,
    cacheHits: 0,
  });

  useEffect(() => {
    // Monitor performance
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'resource' && entry.name.includes('/api/')) {
          setMetrics(prev => ({
            ...prev,
            apiCalls: prev.apiCalls + 1,
            loadTime: Math.max(prev.loadTime, entry.duration),
          }));
        }
      }
    });

    observer.observe({ entryTypes: ['resource'] });

    return () => observer.disconnect();
  }, []);

  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  return (
    <Card className="fixed bottom-4 right-4 p-2 text-xs opacity-75 hover:opacity-100 transition-opacity">
      <div className="space-y-1">
        <div>API Calls: {metrics.apiCalls}</div>
        <div>Max Load: {metrics.loadTime.toFixed(0)}ms</div>
        <div>Cache Hits: {metrics.cacheHits}</div>
      </div>
    </Card>
  );
}