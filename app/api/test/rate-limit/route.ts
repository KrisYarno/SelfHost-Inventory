import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { withRateLimitHandler } from '@/lib/rate-limit/route-handler';
import { authOptions } from '@/lib/auth';

// Test endpoint with very low rate limit for demonstration
const testRateLimit = {
  windowMs: 60 * 1000, // 1 minute
  max: 3,              // Only 3 requests per minute
  message: 'Test rate limit exceeded. Wait 1 minute before trying again.'
};

export const GET = withRateLimitHandler(
  async (request: NextRequest) => {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Simulate some processing time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return NextResponse.json({
      message: 'Request successful!',
      timestamp: new Date().toISOString(),
      info: 'This endpoint allows only 3 requests per minute for testing purposes.'
    });
  },
  { 
    type: 'ip',
    config: testRateLimit 
  }
);

// Different limits for POST requests
export const POST = withRateLimitHandler(
  async (request: NextRequest) => {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isAdmin) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const body = await request.json();
    
    return NextResponse.json({
      message: 'POST request successful!',
      timestamp: new Date().toISOString(),
      receivedData: body,
      info: 'This endpoint uses user-based rate limiting.'
    });
  },
  { 
    type: 'user',
    config: {
      windowMs: 60 * 1000,
      max: 5,
      message: 'Too many POST requests. User-based limit exceeded.'
    }
  }
);
