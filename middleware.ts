import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';

// Routes that require authentication
const protectedRoutes = [
  '/workbench',
  '/products',
  '/reports',
  '/dashboard',
  '/admin',
  '/settings',
  '/account',
  '/api/inventory',
  '/api/products',
  '/api/users',
];

// Routes that require admin role
const adminRoutes = [
  '/admin',
  '/api/admin',
];

// Routes that should redirect to workbench if already authenticated
const authRoutes = [
  '/auth/signin',
  '/auth/signup',
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  
  // Check if the route is protected
  const isProtectedRoute = protectedRoutes.some(route => 
    pathname.startsWith(route)
  );
  
  const isAdminRoute = adminRoutes.some(route => 
    pathname.startsWith(route)
  );
  
  const isAuthRoute = authRoutes.some(route => 
    pathname.startsWith(route)
  );

  // Get the token
  const token = await getToken({ 
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  // Redirect to signin if accessing protected route without authentication
  if (isProtectedRoute && !token) {
    const signInUrl = new URL('/auth/signin', request.url);
    signInUrl.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Check if user is approved
  if (token && !token.isApproved && isProtectedRoute) {
    // Allow access to settings page so users can see their pending status
    if (!pathname.startsWith('/settings')) {
      return NextResponse.redirect(new URL('/auth/pending-approval', request.url));
    }
  }

  // Check admin access
  if (isAdminRoute && !token?.isAdmin) {
    return NextResponse.redirect(new URL('/unauthorized', request.url));
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && token && token.isApproved) {
    return NextResponse.redirect(new URL('/workbench', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     * - api/auth (NextAuth routes)
     */
    '/((?!_next/static|_next/image|favicon.ico|public|api/auth).*)',
  ],
};