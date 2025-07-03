import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { getCurrentInventoryLevelsPerformance } from '@/lib/inventory-performance';
import type { CurrentInventoryResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';

// Add caching headers for CDN/browser caching
const CACHE_DURATION = 60; // 1 minute

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const locationId = searchParams.get('locationId');

    // Use the optimized performance function
    const inventory = await getCurrentInventoryLevelsPerformance(
      locationId ? parseInt(locationId) : undefined
    );

    const response: CurrentInventoryResponse = {
      inventory,
      asOf: new Date(),
    };

    // Create response with cache headers
    const jsonResponse = NextResponse.json(response);
    
    // Set cache headers for better performance
    jsonResponse.headers.set(
      'Cache-Control',
      `private, max-age=${CACHE_DURATION}, stale-while-revalidate=${CACHE_DURATION * 2}`
    );
    
    // Add ETag for cache validation
    const etag = `"${Date.now()}-${locationId || 'all'}"`;
    jsonResponse.headers.set('ETag', etag);

    return jsonResponse;
  } catch (error) {
    console.error('Error fetching current inventory:', error);
    return NextResponse.json(
      { error: 'Failed to fetch current inventory levels' },
      { status: 500 }
    );
  }
}