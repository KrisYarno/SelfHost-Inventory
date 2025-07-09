import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';
import prisma from '@/lib/prisma';
import { hashPassword } from '@/lib/auth-helpers';
import { withRateLimitHandler } from '@/lib/rate-limit/route-handler';
import { rateLimitConfigs } from '@/lib/rate-limit/config';

export const POST = withRateLimitHandler(
  async (request: NextRequest) => {
  try {
    const { email, password, username } = await request.json();

    // Validate input
    if (!email || !password || !username) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username }
        ]
      }
    });

    if (existingUser) {
      return NextResponse.json(
        { error: existingUser.email === email ? 'Email already in use' : 'Username already taken' },
        { status: 409 }
      );
    }

    // Hash the password
    const hashedPassword = await hashPassword(password);

    // Create the user
    const user = await prisma.user.create({
      data: {
        email,
        username,
        passwordHash: hashedPassword,
        isAdmin: false,
        isApproved: false, // New users need approval
      },
      select: {
        id: true,
        email: true,
        username: true,
        isAdmin: true,
        isApproved: true,
      },
    });

    // In a real app, you might send an email notification here

    return NextResponse.json({
      message: 'Account created successfully. Please wait for administrator approval.',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
    return NextResponse.json(
      { error: 'Failed to create account' },
      { status: 500 }
    );
  }
  },
  { 
    type: 'ip', // Use IP-based rate limiting for signup
    config: rateLimitConfigs.auth.signup 
  }
);