import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { memoryStore, rateLimitConfigs } from '@/lib/rate-limit';

interface EndpointStats {
  endpoint: string;
  current: number;
  limit: number;
  resetTime: string;
  blocked: number;
}

export async function GET(request: NextRequest) {
  // Check if user is admin
  const token = await getToken({ 
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  if (!token || !token.isAdmin) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  // Get all entries from memory store
  const allEntries = memoryStore.getAllEntries();
  
  // Aggregate data by endpoint
  const endpointStats = new Map<string, EndpointStats>();
  
  // Define endpoints to monitor
  const monitoredEndpoints = [
    { path: '/api/auth/signin', config: rateLimitConfigs.auth.signin },
    { path: '/api/auth/signup', config: rateLimitConfigs.auth.signup },
    { path: '/api/inventory', config: rateLimitConfigs.api.inventory },
    { path: '/api/reports', config: rateLimitConfigs.api.reports },
    { path: '/api/admin/users', config: rateLimitConfigs.admin.userManagement },
    { path: '/api/products', config: rateLimitConfigs.api.default },
  ];

  // Initialize stats for all monitored endpoints
  monitoredEndpoints.forEach(({ path, config }) => {
    endpointStats.set(path, {
      endpoint: path,
      current: 0,
      limit: config.max,
      resetTime: new Date(Date.now() + config.windowMs).toISOString(),
      blocked: 0
    });
  });

  // Process actual entries
  const entries = Array.from(allEntries.entries());
  for (const [key, entry] of entries) {
    // Extract endpoint from key (format: "type:identifier:endpoint" or similar)
    // This is a simplified extraction - adjust based on your actual key format
    for (const { path } of monitoredEndpoints) {
      if (key.includes(path)) {
        const stats = endpointStats.get(path);
        if (stats) {
          stats.current = Math.max(stats.current, entry.count);
          stats.resetTime = new Date(entry.resetTime).toISOString();
          
          // Count blocked requests (those exceeding the limit)
          const config = monitoredEndpoints.find(e => e.path === path)?.config;
          if (config && entry.count > config.max) {
            stats.blocked++;
          }
        }
        break;
      }
    }
  }

  // Convert to array and sort by usage percentage
  const rateLimitData = Array.from(endpointStats.values())
    .sort((a, b) => (b.current / b.limit) - (a.current / a.limit));

  return NextResponse.json(rateLimitData);
}