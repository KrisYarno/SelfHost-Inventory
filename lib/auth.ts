import { NextAuthOptions, getServerSession } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import prisma from '@/lib/prisma';
import { verifyPassword } from '@/lib/auth-helpers';

// Allowed email domains for authentication, comma-separated
// e.g. "advancedresearchpep.com,artech.tools"
const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || 'advancedresearchpep.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
const allowAllDomains = allowedDomains.includes('*');

/**
 * Check if an email domain is allowed
 */
function isAllowedDomain(email: string): boolean {
  const domain = email.toLowerCase().split('@')[1];
  if (!domain) return false;
  return allowAllDomains || allowedDomains.includes(domain);
}

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
      async authorize(credentials, _req) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const email = credentials.email.toLowerCase();

        // Check domain restriction
        if (!isAllowedDomain(email)) {
          console.warn('[auth] Credentials sign-in blocked by domain policy', { email });
          return null;
        }

        // Find user
        const user = await prisma.user.findUnique({
          where: { email },
        });

        if (!user) {
          return null;
        }

        // Block soft-deleted users
        if (user.deletedAt) {
          console.warn('[auth] Sign-in blocked for soft-deleted user', { email });
          return null;
        }

        // Check if user has a password (OAuth-only users don't)
        if (!user.passwordHash) {
          return null;
        }

        // Verify password
        const isValid = await verifyPassword(credentials.password, user.passwordHash);
        if (!isValid) {
          return null;
        }

        // Return user object matching the User type in types/next-auth.d.ts
        return {
          id: String(user.id),
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
    maxAge: 7 * 24 * 60 * 60, // 7 days
  },
  callbacks: {
    async signIn({ user, account, profile }) {
      // Handle credentials provider - user already validated in authorize()
      if (account?.provider === 'credentials') {
        // Fetch user to check approval status
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email! },
        });

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

      if (!isAllowedDomain(email)) {
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
        console.error('Error in signIn callback:', error);
        return false;
      }
    },
    async jwt({ token, user, account, profile, trigger, session }) {
      // Handle credentials provider sign-in
      if (account?.provider === 'credentials' && user?.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email.toLowerCase() },
        });

        if (dbUser) {
          token.id = dbUser.id.toString();
          token.email = dbUser.email;
          token.name = dbUser.username;
          token.isAdmin = dbUser.isAdmin;
          token.isApproved = dbUser.isApproved;
          token.defaultLocationId = dbUser.defaultLocationId;
        }
      }

      // Handle Google OAuth sign-in
      if (account?.provider === 'google' && profile?.email) {
        if (!isAllowedDomain(profile.email)) {
          return token;
        }

        // For Google sign-in, fetch the user from our database
        const dbUser = await prisma.user.findUnique({
          where: { email: profile.email.toLowerCase() },
        });

        if (dbUser) {
          token.id = dbUser.id.toString();
          token.email = dbUser.email;
          token.name = dbUser.username;
          token.isAdmin = dbUser.isAdmin;
          token.isApproved = dbUser.isApproved;
          token.defaultLocationId = dbUser.defaultLocationId;
        }
      }

      // Handle session updates (e.g., when user is approved)
      if (trigger === 'update' && session) {
        token.isAdmin = session.user.isAdmin;
        token.isApproved = session.user.isApproved;
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
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
