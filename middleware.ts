import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { enforceRateLimit, RateLimitError } from "./lib/rateLimit";

// Public routes that skip authentication entirely
// Everything else requires auth by default (deny-by-default)
const publicRoutes = [
  "/api/healthz",
  "/api/csrf",
  "/api/placeholder",
  "/api/webhooks",    // Webhooks use HMAC signature verification
  "/api/cron",        // Cron routes use CRON_SECRET bearer token
  "/auth/error",      // Auth pages handled separately (redirect if already logged in)
  "/auth/pending-approval",
  "/unauthorized",
  "/",                // Landing page
];

// Routes that require admin role
const adminRoutes = ["/admin", "/api/admin"];

// Routes that should redirect to workbench if already authenticated
const authRoutes = ["/auth/signin", "/auth/signup"];

// Routes that should have rate limiting
const rateLimitedRoutes = ["/api/", "/auth/"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Check if route is public (deny-by-default: everything NOT listed requires auth)
  const isPublicRoute = publicRoutes.some((route) =>
    pathname === route || pathname.startsWith(route + "/")
  );

  // Apply rate limiting to API and auth routes
  const shouldRateLimit = rateLimitedRoutes.some((route) => pathname.includes(route));

  if (shouldRateLimit) {
    try {
      enforceRateLimit(request, `middleware:${pathname}`);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return NextResponse.json(
          { error: error.message, retryAfter: error.headers['Retry-After'] },
          { status: 429, headers: error.headers }
        );
      }
    }
  }

  // Handle auth routes before the public route early return
  // (auth pages are public but should redirect authenticated users to workbench)
  const isAuthRoute = authRoutes.some((route) => pathname.startsWith(route));
  if (isAuthRoute) {
    const token = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
    if (token?.isApproved) {
      return NextResponse.redirect(new URL("/workbench", request.url));
    }
    return NextResponse.next();
  }

  // Skip authentication checks for other public routes
  if (isPublicRoute) {
    return NextResponse.next();
  }

  // Everything below this line requires authentication
  const isAdminRoute = adminRoutes.some((route) => pathname.startsWith(route));

  // Get the token
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
  });

  // Redirect to signin if not authenticated (deny-by-default)
  if (!token) {
    // API routes get 401 JSON, page routes get redirect
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const signInUrl = new URL("/auth/signin", request.url);
    signInUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(signInUrl);
  }

  // Check if user is approved
  if (!token.isApproved) {
    // Allow access to settings page so users can see their pending status
    if (!pathname.startsWith("/settings") && !pathname.startsWith("/api/")) {
      return NextResponse.redirect(new URL("/auth/pending-approval", request.url));
    }
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Account pending approval" }, { status: 403 });
    }
  }

  // Check admin access
  if (isAdminRoute && !token.isAdmin) {
    if (pathname.startsWith("/api/admin")) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/unauthorized", request.url));
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
    "/((?!_next/static|_next/image|favicon.ico|public|api/auth).*)",
  ],
};
