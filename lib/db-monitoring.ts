import { Prisma } from '@prisma/client';

interface QueryLog {
  query: string;
  params: any;
  duration: number;
  timestamp: Date;
}

class DatabaseMonitor {
  private queries: QueryLog[] = [];
  private slowQueryThreshold = 100; // milliseconds
  private enabled = process.env.NODE_ENV === 'development';

  logQuery(query: string, params: any, duration: number) {
    if (!this.enabled) return;

    const log: QueryLog = {
      query,
      params,
      duration,
      timestamp: new Date(),
    };

    this.queries.push(log);

    // Keep only last 100 queries
    if (this.queries.length > 100) {
      this.queries.shift();
    }

    // Log slow queries
    if (duration > this.slowQueryThreshold) {
      console.warn(`[SLOW QUERY] ${duration}ms:`, {
        query: this.formatQuery(query),
        params,
      });
    }
  }

  private formatQuery(query: string): string {
    // Remove excessive whitespace
    return query.replace(/\s+/g, ' ').trim();
  }

  getSlowQueries(threshold?: number): QueryLog[] {
    const limit = threshold || this.slowQueryThreshold;
    return this.queries
      .filter(q => q.duration > limit)
      .sort((a, b) => b.duration - a.duration);
  }

  getQueryStats() {
    if (this.queries.length === 0) return null;

    const durations = this.queries.map(q => q.duration);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const avg = total / durations.length;
    const sorted = [...durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    return {
      count: this.queries.length,
      totalTime: total,
      avgTime: avg,
      medianTime: median,
      minTime: Math.min(...durations),
      maxTime: Math.max(...durations),
      slowQueries: this.getSlowQueries().length,
    };
  }

  reset() {
    this.queries = [];
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }
}

// Singleton instance
export const dbMonitor = new DatabaseMonitor();

// Prisma middleware for query logging
export function createPrismaMiddleware(): Prisma.Middleware {
  return async (params, next) => {
    const start = Date.now();
    
    try {
      const result = await next(params);
      const duration = Date.now() - start;
      
      // Log the query
      dbMonitor.logQuery(
        `${params.model}.${params.action}`,
        params.args,
        duration
      );
      
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      
      // Log failed queries too
      dbMonitor.logQuery(
        `${params.model}.${params.action} [FAILED]`,
        params.args,
        duration
      );
      
      throw error;
    }
  };
}

// Development endpoint for query stats
export function getQueryStatsHandler() {
  if (process.env.NODE_ENV !== 'development') {
    return { error: 'Query stats only available in development' };
  }

  const stats = dbMonitor.getQueryStats();
  const slowQueries = dbMonitor.getSlowQueries();

  return {
    stats,
    slowQueries: slowQueries.slice(0, 10).map(q => ({
      query: q.query,
      duration: q.duration,
      timestamp: q.timestamp,
    })),
  };
}