import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { hashPassword } from "@/lib/auth-helpers";
import { apiHandler } from "@/lib/api-utils";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { SignupSchema } from "@/lib/validation/auth";

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

export const POST = apiHandler(async (request: NextRequest) => {
  const rateLimitHeaders = enforceRateLimit(request, "auth:signup");

  const raw = await request.json();
  // Schema normalizes email (trim+lowercase) and username, and enforces the
  // username format + password strength. The env-driven domain restriction and
  // the uniqueness check remain below.
  const {
    email: normalizedEmail,
    username: normalizedUsername,
    password,
  } = SignupSchema.parse(raw);

  // Validate domain
  if (!isAllowedDomain(normalizedEmail)) {
    return NextResponse.json(
      { error: `Sign up is restricted to company email addresses (${allowedDomains.join(', ')})` },
      { status: 403 }
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
      isApproved: false,
    },
    select: {
      id: true,
      email: true,
      username: true,
      isAdmin: true,
      isApproved: true,
    },
  });

  const response = NextResponse.json({
    message: "Account created successfully. Please wait for administrator approval.",
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
    },
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
