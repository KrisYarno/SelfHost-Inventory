import { NextResponse } from 'next/server';
import { generateCSRFToken } from '@/lib/csrf';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

const CSRF_TOKEN_COOKIE = 'csrf-token';
const COOKIE_MAX_AGE = 60 * 60 * 24; // 24 hours

export async function GET() {
  try {
    const cookieStore = await cookies();
    
    // Check if token already exists
    const existingToken = cookieStore.get(CSRF_TOKEN_COOKIE);
    if (existingToken?.value) {
      return NextResponse.json({ token: existingToken.value });
    }
    
    // Generate new token
    const token = generateCSRFToken();
    
    // Set cookie with secure options
    cookieStore.set(CSRF_TOKEN_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/'
    });
    
    return NextResponse.json({ token });
  } catch (error) {
    console.error('Error generating CSRF token:', error);
    return NextResponse.json(
      { error: 'Failed to generate CSRF token' },
      { status: 500 }
    );
  }
}