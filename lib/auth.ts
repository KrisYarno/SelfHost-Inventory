import { NextAuthOptions, getServerSession } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import prisma from '@/lib/prisma';
import { verifyPassword } from '@/lib/auth-helpers';
import { enforceRateLimitByKey } from '@/lib/rateLimit';

// Allowed email domains for authentication, comma-separated
// e.g. "advancedresearchpep.com,artech.tools"
const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || 'advancedresearchpep.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
const allowAllDomains = allowedDomains.includes('*');

// N0 FR2 F6: a plain DNS name — letters, digits and hyphens per label (never a
// leading or trailing hyphen), at least one dot. Checked in BOTH modes.
const DOMAIN_SHAPE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * The ONE email-domain rule (N0 C6), shared by signup, credentials sign-in and
 * Google sign-in. An address passes only when, after trimming:
 *   1. it has EXACTLY ONE "@";
 *   2. the local part and the domain are both non-empty;
 *   3. it contains no whitespace or control characters, and the local part is
 *      printable ASCII only (N0 FR1 E5: no zero-width, bidi-override, fullwidth or
 *      other non-ASCII lookalikes);
 *   4. the DOMAIN is a plain DNS name — letters, digits and hyphens per label, no
 *      leading/trailing hyphen, at least one dot (N0 FR2 F6) — in BOTH modes;
 *   5. THEN the wildcard ("*") is configured, or the domain is allowed.
 * So "a@allowed.com@evil.com" is refused in BOTH modes (the old split('@')[1]
 * read it as allowed.com). Signup deliberately does not .email()-validate
 * (lib/validation/auth.ts): an odd address falls through to this refusal.
 */
export function emailDomainAllowed(email: string): boolean {
  const address = email.trim();
  if (/\s/.test(address)) return false;
  for (let i = 0; i < address.length; i++) {
    const code = address.charCodeAt(i);
    // C0 controls, DEL, and C1 controls.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  const parts = address.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (local === '' || domain === '') return false;
  if (!/^[\x21-\x7e]+$/.test(local)) return false;
  if (!DOMAIN_SHAPE.test(domain)) return false;
  return allowAllDomains || allowedDomains.includes(domain.toLowerCase());
}

// D0: a claims re-read needs a real primary key. Anything else re-reads nothing
// (and so grants nothing).
function isUserIdKey(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}

// N0 FR3 G3: a Prisma error's code for a log line — `code` when it is a string (a
// known request error), else `errorCode` when it is a string (an initialization
// error carries it there, with no `code`). Never the message: a Prisma message can
// name the database host or user.
function prismaErrorCode(error: unknown): string | undefined {
  const failure = error as { code?: unknown; errorCode?: unknown } | null | undefined;
  if (typeof failure?.code === 'string') return failure.code;
  if (typeof failure?.errorCode === 'string') return failure.errorCode;
  return undefined;
}

// N0 FR3 G2: a sign-in database call that throws never reaches the sign-in form
// as raw Prisma text (next-auth turns a thrown error's message into the result's
// `error`). One address-free line, then the fixed `ServiceUnavailable`.
async function signInLookup<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(`[auth] sign-in lookup failed (${prismaErrorCode(error) ?? 'unknown'})`);
    throw new Error('ServiceUnavailable');
  }
}

// N0 FR3 G1/G4: what next-auth's error logger may print. Each value is printed
// only when it is a plain token; anything else (a newline, a forged string) is
// `invalid` — or, for the optional parts, left out.
const LOG_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const OAUTH_ERROR = /^[a-z_]{1,40}$/;

/**
 * Generate a username from Google profile name or email
 * Normalizes to lowercase alphanumeric with dots
 */
function generateUsername(email: string, googleName?: string | null): string {
  if (googleName) {
    // "John Smith" -> "john.smith"
    const normalized = googleName
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '.')
      .replace(/[^a-z0-9.]/g, '');
    if (normalized.length >= 2) {
      return normalized;
    }
  }
  // Fallback to email prefix
  return email.split('@')[0].toLowerCase();
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      // Only hint hosted domain when a single domain is configured
      authorization: allowedDomains.length === 1 ? {
        params: { hd: allowedDomains[0], prompt: 'select_account' },
      } : {
        params: { prompt: 'select_account' },
      },
    }),
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email.toLowerCase();

        // Check domain restriction
        if (!emailDomainAllowed(email)) {
          console.warn('[auth] Credentials sign-in blocked by domain policy', { email });
          return null;
        }

        // S3: per-IP credentials-login rate limit. NextAuth's authorize receives only a
        // partial request (plain lowercase headers object), so throttle by a derived key.
        const fwd = req?.headers?.['x-forwarded-for'];
        const ip =
          (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ||
          req?.headers?.['x-real-ip'] ||
          'unknown';
        try {
          enforceRateLimitByKey(`auth-login:${ip}`, { limit: 20, ttl: 15 * 60_000 });
        } catch {
          // RETURN NULL, never throw — a thrown string would surface as a DISTINCT
          // result.error, confirming the account exists. null keeps rate-limited
          // rejections protocol-indistinguishable from wrong-password rejections
          // (both produce CredentialsSignin).
          return null;
        }

        // Find user
        const user = await signInLookup(() =>
          prisma.user.findUnique({
            where: { email },
          })
        );

        if (!user) {
          return null;
        }

        // Block soft-deleted users
        if (user.deletedAt) {
          console.warn('[auth] Sign-in blocked for soft-deleted user', { email });
          return null;
        }

        // Check account lockout
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          console.warn('[auth] Sign-in blocked: account locked', { email, lockedUntil: user.lockedUntil });
          return null;
        }

        // Check if user has a password (OAuth-only users don't)
        if (!user.passwordHash) {
          return null;
        }

        // Verify password
        const isValid = await verifyPassword(credentials.password, user.passwordHash);
        if (!isValid) {
          // Increment failed attempts, lock after 5
          const attempts = (user.failedLoginAttempts || 0) + 1;
          const lockout = attempts >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60 * 1000) } : {};
          await signInLookup(() =>
            prisma.user.update({
              where: { id: user.id },
              data: { failedLoginAttempts: attempts, ...lockout },
            })
          );
          return null;
        }

        // Reset failed attempts on successful login
        if (user.failedLoginAttempts > 0) {
          await signInLookup(() =>
            prisma.user.update({
              where: { id: user.id },
              data: { failedLoginAttempts: 0, lockedUntil: null },
            })
          );
        }

        // Return user object matching the User type in types/next-auth.d.ts
        return {
          id: user.id,
          email: user.email,
          username: user.username,
          isAdmin: user.isAdmin,
          isApproved: user.isApproved,
          defaultLocationId: user.defaultLocationId,
        };
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 12 * 60 * 60, // 12 hours
  },
  jwt: {
    maxAge: 12 * 60 * 60, // 12 hours — must match session.maxAge
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      // Handle credentials provider - user already validated in authorize()
      if (account?.provider === 'credentials') {
        // Fetch user to check approval status
        const dbUser = await signInLookup(() =>
          prisma.user.findUnique({
            where: { email: user.email! },
          })
        );

        if (!dbUser) {
          return false;
        }

        if (!dbUser.isApproved) {
          return '/auth/pending-approval';
        }

        return true;
      }

      // Handle Google OAuth
      if (account?.provider !== 'google' || !profile?.email) {
        return false;
      }

      const email = profile.email.toLowerCase();

      if (!emailDomainAllowed(email)) {
        console.warn('[auth] Sign-in blocked by domain policy', {
          email,
          allowedDomains,
        });
        return false;
      }

      // For OAuth providers, create/update user with proper fields
      try {
        const existingUser = await prisma.user.findUnique({
          where: { email },
        });

        if (existingUser) {
          // Block soft-deleted users
          if (existingUser.deletedAt) {
            console.warn('[auth] OAuth sign-in blocked for soft-deleted user', { email });
            return false;
          }

          // Update username from Google name if user's current username is just email prefix
          // (allows auto-improvement of username on subsequent logins)
          const googleName = (profile as { name?: string }).name;
          const emailPrefix = email.split('@')[0].toLowerCase();
          if (googleName && existingUser.username === emailPrefix) {
            const betterUsername = generateUsername(email, googleName);
            if (betterUsername !== emailPrefix) {
              await prisma.user.update({
                where: { id: existingUser.id },
                data: { username: betterUsername },
              });
            }
          }

          if (!existingUser.isApproved) {
            return '/auth/pending-approval';
          }
          return true;
        }

        // Create new user with username from Google profile name
        const googleName = (profile as { name?: string }).name;
        await prisma.user.create({
          data: {
            email,
            username: generateUsername(email, googleName),
            passwordHash: null, // OAuth users have no password initially
            isAdmin: false,
            isApproved: false,
          },
        });

        return '/auth/pending-approval';
      } catch (error) {
        // N0 FR3 G6: the context and the error's code or name — never the object.
        const name = (error as { name?: unknown } | null)?.name;
        console.error(
          `Error in signIn callback (${prismaErrorCode(error) ?? (typeof name === 'string' ? name : 'unknown')})`
        );
        return false;
      }
    },
    async jwt({ token, user, account, profile }) {
      // Handle credentials provider sign-in
      if (account?.provider === 'credentials' && user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email.toLowerCase() },
        });

        if (dbUser) {
          token.id = dbUser.id;
          token.email = dbUser.email;
          token.name = dbUser.username;
          token.isAdmin = dbUser.isAdmin;
          token.isApproved = dbUser.isApproved;
          token.defaultLocationId = dbUser.defaultLocationId;
        }
      }

      // Handle Google OAuth sign-in
      if (account?.provider === 'google' && profile?.email) {
        if (!emailDomainAllowed(profile.email)) {
          return token;
        }

        // For Google sign-in, fetch the user from our database
        const dbUser = await prisma.user.findUnique({
          where: { email: profile.email.toLowerCase() },
        });

        if (dbUser) {
          token.id = dbUser.id;
          token.email = dbUser.email;
          token.name = dbUser.username;
          token.isAdmin = dbUser.isAdmin;
          token.isApproved = dbUser.isApproved;
          token.defaultLocationId = dbUser.defaultLocationId;
        }
      }

      // N0 D0: on EVERY run that is not a sign-in (every session read, and
      // trigger 'update' included), the claims are re-read from the database by
      // primary key. The client's `update` payload is NEVER read — it could carry
      // { isAdmin: true }. A promotion, a demotion, an approval or a deletion is
      // therefore picked up on the next session read, and a token minted with
      // claims the row does not hold is downgraded. A missing row, a soft-deleted
      // user, or a token without a usable id holds no rights. A FAILED read
      // RETHROWS (N0 FR1 E1), so a cookie is never re-encoded with made-up claims
      // and no one lands on a false "pending approval" page:
      //   - on the session route (GET/POST /api/auth/session) next-auth logs
      //     JWT_SESSION_ERROR (code only — see `logger` below) and CLEARS the
      //     cookie: a clean sign-out;
      //   - in route handlers and server components getServerSession returns null
      //     but CANNOT clear the cookie. Route handlers answer 401; the app layout
      //     sends the user to /auth/signin?reauth=1, which the middleware lets
      //     render despite the still-approved-looking cookie (N0 FR2 F1), and the
      //     sign-in page's own session fetch then clears it.
      if (!user) {
        let row: {
          isAdmin: boolean;
          isApproved: boolean;
          deletedAt: Date | null;
          defaultLocationId: number | null;
        } | null;
        try {
          row = isUserIdKey(token.id)
            ? await prisma.user.findUnique({
                where: { id: token.id },
                select: { isAdmin: true, isApproved: true, deletedAt: true, defaultLocationId: true },
              })
            : null;
        } catch (error) {
          // ONE address-free line: the Prisma error code only, never the error.
          console.error(`[auth] jwt claims re-read failed (${prismaErrorCode(error) ?? 'unknown'})`);
          throw error;
        }
        if (row && !row.deletedAt) {
          token.isAdmin = row.isAdmin;
          token.isApproved = row.isApproved;
          token.defaultLocationId = row.defaultLocationId;
        } else {
          token.isAdmin = false;
          token.isApproved = false;
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as number;
        session.user.email = token.email as string;
        session.user.name = token.name as string;
        session.user.isAdmin = token.isAdmin as boolean;
        session.user.isApproved = token.isApproved as boolean;
        session.user.defaultLocationId = token.defaultLocationId as number | null;
      }

      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  debug: process.env.NODE_ENV === 'development',
  // N0 FR2 F3: next-auth's default error logger prints the error's message, stack
  // and metadata object — and a Prisma message can name the database host or user.
  // So: the code, plus the error's own code (Prisma's `code` or `errorCode`) or name,
  // the provider id and an OAuth error token — each only as a plain token (N0 FR3
  // G1/G3/G4). Never a message, an `error_description` or a URL. `warn` and `debug`
  // keep next-auth's defaults. (Setting a logger switches on next-auth's
  // unauthenticated `_log` action; the route file answers that with 204 — G1.)
  logger: {
    error(code, metadata) {
      const meta = (metadata ?? {}) as { error?: unknown; providerId?: unknown };
      // The nested error — unless `.error` is a STRING: then the metadata IS the
      // error (an OAuth OPError) and `.error` is its OAuth token (G4).
      const error = (meta.error && typeof meta.error === 'object' ? meta.error : meta) as {
        code?: unknown;
        name?: unknown;
        error?: unknown;
      };
      const detail =
        prismaErrorCode(error) ??
        (typeof error.code === 'number' && Number.isFinite(error.code)
          ? String(error.code)
          : typeof error.name === 'string'
            ? error.name
            : undefined);
      const token = (value: string) => (LOG_TOKEN.test(value) ? value : 'invalid');
      let line = `[next-auth] ${token(String(code))}`;
      if (detail !== undefined) line += ` (${token(detail)})`;
      if (typeof meta.providerId === 'string' && PROVIDER_ID.test(meta.providerId)) {
        line += ` provider=${meta.providerId}`;
      }
      if (typeof error.error === 'string' && OAUTH_ERROR.test(error.error)) {
        line += ` oauth=${error.error}`;
      }
      console.error(line);
    },
  },
};

/**
 * Get the current user session server-side
 * @returns The session object or null if not authenticated
 */
export async function getSession() {
  return await getServerSession(authOptions);
}

/**
 * Get the current user from the database
 * @returns The user object or null if not authenticated
 */
export async function getCurrentUser() {
  const session = await getSession();
  
  if (!session?.user?.email) {
    return null;
  }

  return await prisma.user.findUnique({
    where: { email: session.user.email },
  });
}
