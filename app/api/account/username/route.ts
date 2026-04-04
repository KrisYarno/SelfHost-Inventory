import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = "force-dynamic";

// Username validation regex: lowercase alphanumeric, dots, underscores, 3-30 chars
const USERNAME_REGEX = /^[a-z0-9._]{3,30}$/;

/**
 * GET - Get current user's username
 */
export const GET = apiHandler(async () => {
  const { user: sessionUser } = await requireAuth();

  const user = await prisma.user.findUnique({
    where: { email: sessionUser.email },
    select: { username: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({ username: user.username });
});

/**
 * PATCH - Update username
 */
export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user: sessionUser } = await requireAuth();

  // Validate CSRF token
  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const body = await request.json();
  const { username } = body;

  if (!username) {
    return NextResponse.json(
      { error: "Username is required" },
      { status: 400 }
    );
  }

  // Normalize username to lowercase
  const normalizedUsername = username.toLowerCase().trim();

  // Validate format
  if (!USERNAME_REGEX.test(normalizedUsername)) {
    return NextResponse.json(
      { error: "Username must be 3-30 characters and contain only lowercase letters, numbers, dots, and underscores" },
      { status: 400 }
    );
  }

  // Get current user
  const currentUser = await prisma.user.findUnique({
    where: { email: sessionUser.email },
  });

  if (!currentUser) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Check if username is unchanged
  if (currentUser.username === normalizedUsername) {
    return NextResponse.json({ username: normalizedUsername, message: "Username unchanged" });
  }

  // Check uniqueness (case-insensitive)
  const existingUser = await prisma.user.findFirst({
    where: {
      username: normalizedUsername,
      id: { not: currentUser.id },
    },
  });

  if (existingUser) {
    return NextResponse.json(
      { error: "Username is already taken" },
      { status: 409 }
    );
  }

  // Update username
  await prisma.user.update({
    where: { id: currentUser.id },
    data: { username: normalizedUsername },
  });

  return NextResponse.json({
    username: normalizedUsername,
    message: "Username updated successfully",
  });
});
