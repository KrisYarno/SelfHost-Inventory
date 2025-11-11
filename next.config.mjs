/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  eslint: {
    // Warning: This allows production builds to successfully complete even if
    // your project has ESLint errors.
    ignoreDuringBuilds: true,
  },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';

    // Allow Next.js dev tooling and Google OAuth in development
    const devCsp = [
      "default-src 'self'",
      "img-src 'self' data: https://lh3.googleusercontent.com",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self' ws: https://accounts.google.com https://www.googleapis.com",
      "frame-ancestors 'none'",
      "frame-src 'self' https://accounts.google.com",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');

    // Stricter policy for production while allowing Google OAuth redirects
    const prodCsp = [
      "default-src 'self'",
      "img-src 'self' data: https://lh3.googleusercontent.com",
      // Allow inline scripts for Next.js runtime bootstrapping in prod
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      // Include Google fonts host just in case next/font falls back
      "font-src 'self' data: https://fonts.gstatic.com",
      // Allow Google OAuth endpoints
      "connect-src 'self' https://accounts.google.com https://www.googleapis.com https://oauth2.googleapis.com",
      "frame-ancestors 'none'",
      "frame-src 'self' https://accounts.google.com",
      "base-uri 'self'",
      // Allow posting to our app and Google during OAuth handoff
      "form-action 'self' https://accounts.google.com",
    ].join('; ');

    const csp = isProd ? prodCsp : devCsp;

    const securityHeaders = [
      {
        key: 'Strict-Transport-Security',
        value: 'max-age=31536000; includeSubDomains; preload',
      },
      {
        key: 'X-Frame-Options',
        value: 'DENY',
      },
      {
        key: 'X-Content-Type-Options',
        value: 'nosniff',
      },
      {
        key: 'Referrer-Policy',
        value: 'no-referrer',
      },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=()',
      },
      {
        key: 'Content-Security-Policy',
        value: csp,
      },
    ];

    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
