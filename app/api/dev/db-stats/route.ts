import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { getQueryStatsHandler } from '@/lib/db-monitoring';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // Only available in development
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      { error: 'This endpoint is only available in development' },
      { status: 404 }
    );
  }

  try {
    const session = await getServerSession(authOptions);
    
    // Require admin access
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const stats = getQueryStatsHandler();
    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error fetching DB stats:', error);
    return NextResponse.json(
      { error: 'Failed to fetch database statistics' },
      { status: 500 }
    );
  }
}