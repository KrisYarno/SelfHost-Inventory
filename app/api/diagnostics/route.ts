import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { headers } from 'next/headers';

export async function GET(request: NextRequest) {
  try {
    // Get session
    const session = await getServerSession(authOptions);
    
    // Get request headers
    const headersList = headers();
    const requestHeaders: Record<string, string> = {};
    headersList.forEach((value, key) => {
      requestHeaders[key] = value;
    });
    
    // Get environment info (safe subset)
    const envInfo = {
      NODE_ENV: process.env.NODE_ENV,
      NEXTAUTH_URL: process.env.NEXTAUTH_URL ? 'Set' : 'Not set',
      DATABASE_URL: process.env.DATABASE_URL ? 'Set' : 'Not set',
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ? 'Set' : 'Not set',
      SENDGRID_API_KEY: process.env.SENDGRID_API_KEY ? 'Set' : 'Not set',
    };
    
    // Check API routes
    const apiRoutes = {
      '/api/products': 'Product management',
      '/api/inventory/current': 'Current inventory',
      '/api/inventory/deduct': 'Mass update (deduct)',
      '/api/inventory/adjust': 'Inventory adjustment',
      '/api/inventory/stock-in': 'Stock in',
      '/api/auth/session': 'Authentication session',
      '/api/reports/metrics': 'Report metrics',
    };
    
    const diagnostics = {
      timestamp: new Date().toISOString(),
      server: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
      },
      auth: {
        hasSession: !!session,
        user: session?.user?.email || null,
        isAdmin: session?.user?.isAdmin || false,
      },
      request: {
        method: request.method,
        url: request.url,
        headers: requestHeaders,
        userAgent: request.headers.get('user-agent'),
      },
      environment: envInfo,
      apiRoutes,
      cors: {
        allowedOrigins: process.env.ALLOWED_ORIGINS || 'Not configured',
        credentials: 'same-origin',
      },
      features: {
        authentication: !!process.env.NEXTAUTH_SECRET,
        email: !!process.env.SENDGRID_API_KEY,
        database: !!process.env.DATABASE_URL,
      },
    };
    
    return NextResponse.json(diagnostics, {
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Diagnostics error:', error);
    return NextResponse.json(
      { 
        error: 'Failed to generate diagnostics',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// Also support POST for testing
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    
    return NextResponse.json({
      message: 'POST request received',
      timestamp: new Date().toISOString(),
      receivedData: body,
      headers: {
        'content-type': request.headers.get('content-type'),
        'content-length': request.headers.get('content-length'),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { 
        error: 'Failed to process POST request',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 400 }
    );
  }
}