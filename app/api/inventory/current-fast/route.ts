import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { getCurrentInventoryLevelsFast, getCurrentInventoryLevelsPaginated } from '@/lib/inventory-fast';
import type { CurrentInventoryResponse } from '@/types/inventory';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      console.error('[/api/inventory/current-fast] Unauthorized access attempt');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const locationId = searchParams.get('locationId');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('pageSize') || '50');
    const paginate = searchParams.get('paginate') === 'true';

    if (paginate) {
      // Use paginated version for large datasets
      const result = await getCurrentInventoryLevelsPaginated(
        locationId ? parseInt(locationId) : undefined,
        page,
        pageSize
      );
      
      return NextResponse.json({
        ...result,
        asOf: new Date(),
      });
    } else {
      // Use fast version without pagination
      const inventory = await getCurrentInventoryLevelsFast(
        locationId ? parseInt(locationId) : undefined
      );

      const response: CurrentInventoryResponse = {
        inventory,
        asOf: new Date(),
      };

      return NextResponse.json(response);
    }
  } catch (error) {
    console.error('[/api/inventory/current-fast] Error:', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    
    return NextResponse.json(
      { 
        error: 'Failed to fetch current inventory levels',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}