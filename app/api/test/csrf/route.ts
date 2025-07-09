import { NextRequest, NextResponse } from "next/server";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = 'force-dynamic';

// Test endpoint to verify CSRF protection
export async function POST(request: NextRequest) {
  try {
    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    
    const body = await request.json();
    
    return NextResponse.json({
      success: true,
      csrfValid: isValidCSRF,
      message: isValidCSRF ? 'CSRF token is valid' : 'CSRF token is invalid or missing',
      receivedData: body
    }, {
      status: isValidCSRF ? 200 : 403
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Test endpoint error", details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}