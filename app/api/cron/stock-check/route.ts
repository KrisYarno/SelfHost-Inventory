import { NextRequest, NextResponse } from 'next/server';
import { stockChecker } from '@/lib/stock-checker';

// This endpoint will be called by Vercel Cron
export async function GET(request: NextRequest) {
  try {
    // Verify the request is from Vercel Cron (in production)
    const authHeader = request.headers.get('authorization');
    if (process.env.NODE_ENV === 'production' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('Running stock check cron job...');
    const startTime = Date.now();

    const result = await stockChecker.runDailyCheck();
    
    const duration = Date.now() - startTime;
    console.log(`Stock check completed in ${duration}ms`);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      duration,
      ...result,
    });
  } catch (error) {
    console.error('Stock check cron job failed:', error);
    return NextResponse.json(
      { 
        error: 'Stock check failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}