import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { stockChecker } from '@/lib/stock-checker';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.user?.isApproved) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { combinedBreaches } = await stockChecker.checkMinimums();

    return NextResponse.json({
      breaches: combinedBreaches,
    });
  } catch (error) {
    console.error('Error fetching minimum report', error);
    return NextResponse.json(
      { error: 'Failed to load minimum report' },
      { status: 500 }
    );
  }
}
