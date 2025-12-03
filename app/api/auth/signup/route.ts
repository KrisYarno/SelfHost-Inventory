import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/auth-helpers";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

// Allowed email domains, matching auth.ts
const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS || 'advancedresearchpep.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
const allowAllDomains = allowedDomains.includes('*');

function isAllowedDomain(email: string): boolean {
  const domain = email.toLowerCase().split('@')[1];
  if (!domain) return false;
  return allowAllDomains || allowedDomains.includes(domain);
}

export async function POST(request: NextRequest) {
  try {
    const rateLimitHeaders = enforceRateLimit(request, "auth:signup");

    const { email, password, username } = await request.json();

    // Validate input
    if (!email || !password || !username) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Validate domain
    if (!isAllowedDomain(normalizedEmail)) {
      return NextResponse.json(
        { error: `Sign up is restricted to company email addresses (${allowedDomains.join(', ')})` },
        { status: 403 }
      );
    }

    // Validate username format
    const normalizedUsername = username.toLowerCase().trim();
    if (!/^[a-z0-9._]{3,30}$/.test(normalizedUsername)) {
      return NextResponse.json(
        { error: "Username must be 3-30 characters and contain only letters, numbers, dots, and underscores" },
        { status: 400 }
      );
    }

    // Validate password strength
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters long" },
        { status: 400 }
      );
    }

    // Check if user already exists (case-insensitive)
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { username: normalizedUsername }],
      },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: existingUser.email === normalizedEmail ? "Email already in use" : "Username already taken" },
        { status: 409 }
      );
    }

    // Hash the password
    const hashedPassword = await hashPassword(password);

    // Create the user
    const user = await prisma.user.create({
      data: {
        email: normalizedEmail,
        username: normalizedUsername,
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

    const response = NextResponse.json({
      message: "Account created successfully. Please wait for administrator approval.",
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
      },
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }
    console.error("Signup error:", error);
    return NextResponse.json({ error: "Failed to create account" }, { status: 500 });
  }
}
