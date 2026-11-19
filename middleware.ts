import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { enforceRateLimit, RateLimitError } from "./lib/rateLimit";

// Public routes that skip authentication entirely
// Everything else requires auth by default (deny-by-default)
const publicRoutes = [
  "/api/healthz",
  "/api/version",     // Build-identity probe (same posture as healthz; sha is not a secret)
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

// THE per-path overrides of the per-IP, per-pathname bucket (the limiter's
// default is 30/min). Every bench device behind one office IP shares that bucket,
// so a path a few people hit together at work speed needs more than 30. EXACT
// pathnames, never prefixes: any deeper path, and every other path, keeps the
// default 30. Each route's own per-user limit is a separate bucket and unchanged.
//
// - The ORDER SEARCH (reconciliation Part 2, FR-R2 (1), QA-1): up to one call per
//   digit at phone typing speed; read-only, authenticated, its own per-user
//   60/min — 240/min here.
// - The STOCKTAKE paths (P2-B3-2, Kris 2026-11-16). One spot count is one save to
//   the adjust route, and every successful save refreshes the lists on screen
//   behind the dialog (`invalidateInventoryCaches` refetches only ACTIVE
//   queries). The dialog opens from two pages:
//     /inventory — `/api/inventory/variants` (an infinite list: a refresh
//       refetches EVERY loaded page — three load on their own, more after "Load
//       more" — and search keystrokes use the same path, so 480), plus whichever
//       of `/api/inventory/logs` / `/api/inventory/transfers` backs the tab on
//       screen (lazy panes: the hidden one refetches when its tab opens);
//     /products — `/api/products/optimized`.
//   At 30/min a few people counting together would be refused at about one count
//   every 2 s office-wide; the save and each refresh get 120 (variants 480). The
//   adjust route keeps its own per-user 30/min; the four list reads have no
//   per-user limit, so this bucket is their only throttle (they are read-only
//   and page-capped, except `/api/products/optimized`'s pageSize — registered).
//   And `/api/csrf`, 240: a tab whose full page load found no CSRF cookie has no
//   token meta tag for its whole life, so `useCSRF` fetches a token on EVERY
//   mount of a writing dialog (one per open on /inventory; two on /products,
//   where Adjust and Stock In mount together) — refused, the save then fails its
//   CSRF check. Public, no database; cheap to serve.
// - The LOCATIONS list (facelift F1, Kris 2026-11-19): read once per signed-in
//   user per page load and on a Retry (FR2-3), on every device behind the office
//   IP. A refused first read now blocks every stock write until a read succeeds
//   (FR1-1: writers only see a confirmed location), so 120. The same bucket also
//   serves the Fulfill dialog's and `useLocations`' / the admin user editor's
//   cached reads (5-min staleTime). The route has NO per-user limit, so this
//   bucket is its only throttle (read-only, a small table).
const PER_IP_LIMIT_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ["/api/reconciliation/orders/search", 240],
  ["/api/inventory/adjust", 120],
  ["/api/inventory/variants", 480],
  ["/api/inventory/logs", 120],
  ["/api/inventory/transfers", 120],
  ["/api/products/optimized", 120],
  ["/api/csrf", 240],
  ["/api/locations", 120],
]);

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
      enforceRateLimit(
        request,
        `middleware:${pathname}`,
        PER_IP_LIMIT_OVERRIDES.has(pathname) ? { limit: PER_IP_LIMIT_OVERRIDES.get(pathname) } : {}
      );
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
