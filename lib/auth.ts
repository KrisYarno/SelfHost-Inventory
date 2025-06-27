import { NextAuthOptions, getServerSession } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import CredentialsProvider from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import prisma from '@/lib/prisma';
import { verifyPassword } from '@/lib/auth-helpers';
import type { Adapter } from 'next-auth/adapters';

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as Adapter,
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Invalid credentials');
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user || !user.passwordHash) {
          throw new Error('Invalid credentials');
        }

        const isPasswordValid = await verifyPassword(
          credentials.password,
          user.passwordHash
        );

        if (!isPasswordValid) {
          throw new Error('Invalid credentials');
        }

        // Check if user is approved
        if (!user.isApproved) {
          throw new Error('Your account is pending approval. Please wait for an administrator to approve your account.');
        }

        return {
          id: user.id.toString(),
          email: user.email,
          name: user.username,
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
      // For OAuth providers, create/update user with proper fields
      if (account?.provider === 'google' && profile?.email) {
        try {
          const existingUser = await prisma.user.findUnique({
            where: { email: profile.email },
          });

          if (existingUser) {
            // Check if approved
            if (!existingUser.isApproved) {
              return '/auth/pending-approval';
            }
          } else {
            // Create new user with username from email
            const newUser = await prisma.user.create({
              data: {
                email: profile.email,
                username: profile.email.split('@')[0],
                passwordHash: '', // OAuth users don't have passwords
                isAdmin: false,
                isApproved: false,
              },
            });
            
            // In a real app, you might send an email notification here
            
            return '/auth/pending-approval';
          }
        } catch (error) {
          console.error('Error in signIn callback:', error);
          return false;
        }
      }

      return true;
    },
    async jwt({ token, user, trigger, session }) {
      // Initial sign in
      if (user) {
        // For OAuth users, fetch the full user data
        const dbUser = await prisma.user.findUnique({
          where: { email: user.email! },
        });

        if (dbUser) {
          token.id = dbUser.id.toString();
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
        session.user.id = token.id;
        session.user.isAdmin = token.isAdmin;
        session.user.isApproved = token.isApproved;
        session.user.defaultLocationId = token.defaultLocationId;
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