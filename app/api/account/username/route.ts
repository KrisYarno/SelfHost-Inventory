import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = "force-dynamic";

// Username validation regex: lowercase alphanumeric, dots, underscores, 3-30 chars
const USERNAME_REGEX = /^[a-z0-9._]{3,30}$/;

/**
 * GET - Get current user's username
 */
export async function GET() {
  try {
    const session = await getSession();

    if (!session || !session.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { username: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    return NextResponse.json({ username: user.username });
  } catch (error) {
    console.error("Error fetching username:", error);
    return NextResponse.json({ error: "Failed to fetch username" }, { status: 500 });
  }
}

/**
 * PATCH - Update username
 */
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session || !session.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

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
      where: { email: session.user.email },
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
  } catch (error) {
    console.error("Error updating username:", error);
    return NextResponse.json({ error: "Failed to update username" }, { status: 500 });
  }
}
