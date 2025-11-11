import { NextAuthOptions, getServerSession } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import prisma from '@/lib/prisma';

// Allowed email domains for Google OAuth, comma-separated
// e.g. "advancedresearchpep.com,artech.tools"
const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || 'advancedresearchpep.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
const allowAllDomains = allowedDomains.includes('*');

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
      if (account?.provider !== 'google' || !profile?.email) {
        return false;
      }

      const email = profile.email.toLowerCase();
      const emailDomain = email.split('@')[1];
      if (!emailDomain || (!allowAllDomains && !allowedDomains.includes(emailDomain))) {
        console.warn('[auth] Sign-in blocked by domain policy', {
          email,
          emailDomain,
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
          if (!existingUser.isApproved) {
            return '/auth/pending-approval';
          }
          return true;
        }

        await prisma.user.create({
          data: {
            email,
            username: email.split('@')[0],
            passwordHash: '',
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
      if (account?.provider === 'google' && profile?.email) {
        const domain = profile.email.toLowerCase().split('@')[1];
        if (!domain || (!allowAllDomains && !allowedDomains.includes(domain))) {
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
