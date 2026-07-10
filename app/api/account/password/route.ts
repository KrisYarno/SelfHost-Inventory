import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler, requireCSRF } from "@/lib/api-utils";
import { verifyPassword, hashPassword } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { CreatePasswordSchema, ChangePasswordSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

/**
 * POST - Create a new password for OAuth-only users
 * Used by users who signed up via Google OAuth and want to add password authentication
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user: sessionUser } = await requireAuth();

  await requireCSRF(request);

  const body = await request.json();
  const { newPassword } = CreatePasswordSchema.parse(body);

  // Get user
  const user = await prisma.user.findUnique({
    where: { email: sessionUser.email },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Check if user already has a password
  if (user.passwordHash) {
    return NextResponse.json(
      { error: "Password already exists. Use the change password form instead." },
      { status: 400 }
    );
  }

  // Hash and save new password
  const hashedPassword = await hashPassword(newPassword);

  // Record the change in the SAME transaction as the write (R-D2). The event
  // carries NO password material in ANY field (spec D6: "NO VALUES") — only the
  // fact that a first password was created.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: hashedPassword },
    });
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "ACCOUNT_PASSWORD_CHANGE",
      entityType: "USER",
      entityId: user.id,
      action: "Created account password",
      details: { mode: "created" },
    });
  });

  return NextResponse.json({
    message: "Password created successfully. You can now sign in with your email and password.",
  });
});

/**
 * PATCH - Change existing password (requires old password verification)
 */
export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user: sessionUser } = await requireAuth();

  await requireCSRF(request);

  const body = await request.json();
  const parsed = ChangePasswordSchema.parse(body);

  // Get user with password hash
  const user = await prisma.user.findUnique({
    where: { email: sessionUser.email },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // OAuth users don't have passwords
  if (!user.passwordHash) {
    return NextResponse.json(
      { error: "Password change not available for OAuth accounts" },
      { status: 400 }
    );
  }

  // Verify old password
  const isValidPassword = await verifyPassword(parsed.currentPassword, user.passwordHash);
  if (!isValidPassword) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 });
  }

  // Hash new password
  const hashedPassword = await hashPassword(parsed.newPassword);

  // Record the change in the SAME transaction as the write (R-D2). NO password
  // material in ANY field (spec D6: "NO VALUES").
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: hashedPassword },
    });
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "ACCOUNT_PASSWORD_CHANGE",
      entityType: "USER",
      entityId: user.id,
      action: "Changed account password",
      details: { mode: "changed" },
    });
  });

  return NextResponse.json({
    message: "Password updated successfully",
  });
});
