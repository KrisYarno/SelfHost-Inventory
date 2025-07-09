import { NextRequest, NextResponse } from 'next/server';
import { withRateLimitHandler } from '@/lib/rate-limit/route-handler';

// Test endpoint with very low rate limit for demonstration
const testRateLimit = {
  windowMs: 60 * 1000, // 1 minute
  max: 3,              // Only 3 requests per minute
  message: 'Test rate limit exceeded. Wait 1 minute before trying again.'
};

export const GET = withRateLimitHandler(
  async (request: NextRequest) => {
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