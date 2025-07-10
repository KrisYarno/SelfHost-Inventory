import { NextRequest, NextResponse } from 'next/server';
import { WebhookProcessor } from '@/lib/woocommerce/webhook-processor';

// This endpoint should be called by a cron job (e.g., Vercel Cron or external service)
export async function GET(request: NextRequest) {
  try {
    // Verify cron secret if provided
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const authorization = request.headers.get('authorization');
      if (authorization !== `Bearer ${cronSecret}`) {
        return NextResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }
    }

    // Process pending webhook events
    await WebhookProcessor.processPendingEvents(20); // Process up to 20 events

    // Retry failed events older than 30 minutes
    await WebhookProcessor.retryFailedEvents(30);

    // Clean up old events older than 30 days
    await WebhookProcessor.cleanupOldEvents(30);

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Error in webhook processing cron:', error);
    return NextResponse.json(
      { 
        error: 'Failed to process webhooks',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// Also support POST for flexibility
export async function POST(request: NextRequest) {
  return GET(request);
}