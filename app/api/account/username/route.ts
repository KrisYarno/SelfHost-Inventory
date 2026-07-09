import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { UpdateUsernameSchema } from "@/lib/validation/account";

export const dynamic = "force-dynamic";

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

  await requireCSRF(request);

  const body = await request.json();
  // Schema trims + lowercases + enforces the 3-30 char format.
  const { username: normalizedUsername } = UpdateUsernameSchema.parse(body);

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
