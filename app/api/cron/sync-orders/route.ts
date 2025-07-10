import { NextRequest, NextResponse } from 'next/server';
import { syncWooCommerceOrders } from '@/lib/woocommerce-sync';
import { headers } from 'next/headers';

export const runtime = 'nodejs';
export const maxDuration = 300; // 5 minutes max for cron job

export async function GET(request: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = headers().get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret) {
      console.error('CRON_SECRET not configured');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Check if WooCommerce is configured
    if (!process.env.WOOCOMMERCE_URL || 
        !process.env.WOOCOMMERCE_CONSUMER_KEY || 
        !process.env.WOOCOMMERCE_CONSUMER_SECRET) {
      return NextResponse.json(
        { 
          error: 'WooCommerce not configured',
          message: 'Missing required WooCommerce environment variables'
        },
        { status: 503 }
      );
    }

    console.log('Starting WooCommerce order sync...');
    
    // Call the sync service
    const syncResult = await syncWooCommerceOrders();
    
    console.log('Sync completed:', syncResult);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...syncResult
    });

  } catch (error) {
    console.error('Cron sync error:', error);
    
    return NextResponse.json(
      { 
        error: 'Sync failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

// Also support POST for some cron services
export async function POST(request: NextRequest) {
  return GET(request);
}