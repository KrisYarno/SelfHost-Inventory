import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    
    if (!session || !session.user?.email) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get the user from database
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
    });

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    if (user.isApproved) {
      return NextResponse.json(
        { error: 'User is already approved' },
        { status: 400 }
      );
    }

    const rateLimitHeaders = enforceRateLimit(request, 'auth:resend-notification', {
      identifier: session.user.id ?? session.user.email ?? undefined,
    });

    // In a real app, you might send an email notification here
    // For now, we'll just simulate success

    const response = NextResponse.json({
      message: 'Notification sent to administrators',
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    console.error('Error sending notification:', error);

    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }
    return NextResponse.json(
      { error: 'Failed to send notification' },
      { status: 500 }
    );
  }
}
