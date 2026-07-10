import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, diff } from "@/lib/change-tracking";
import { UpdateUserPreferencesSchema } from "@/lib/validation/account";

export const dynamic = "force-dynamic";

// GET /api/user/preferences - Get user preferences
export const GET = apiHandler(async () => {
  const { user: sessionUser } = await requireAuth();

  const user = await prisma.user.findUnique({
    where: { id: sessionUser.id },
    select: {
      username: true,
      passwordHash: true,
      emailAlerts: true,
      defaultLocationId: true,
      minLocationEmailAlerts: true,
      minCombinedEmailAlerts: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Return user data with hasPassword flag (don't expose the actual hash)
  return NextResponse.json({
    ...user,
    passwordHash: undefined, // Never send the hash to the client
    hasPassword: !!user.passwordHash, // Boolean flag indicating if password exists
  });
});

// PATCH /api/user/preferences - Update user preferences
export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user: sessionUser } = await requireAuth();

  await requireCSRF(request);

  const body = await request.json();
  const parsed = UpdateUserPreferencesSchema.parse(body);
  const updateData: Record<string, unknown> = {};

  if (parsed.emailAlerts !== undefined) {
    updateData.emailAlerts = parsed.emailAlerts;
  }

  const booleanFields = [
    "minLocationEmailAlerts",
    "minCombinedEmailAlerts",
  ] as const;

  booleanFields.forEach((field) => {
    if (parsed[field] !== undefined) {
      updateData[field] = parsed[field];
    }
  });

  // Update defaultLocationId if provided
  if (parsed.defaultLocationId !== undefined) {
    const locationId =
      typeof parsed.defaultLocationId === "number"
        ? parsed.defaultLocationId
        : parseInt(parsed.defaultLocationId);
    if (!isNaN(locationId)) {
      // Verify location exists
      const location = await prisma.location.findUnique({
        where: { id: locationId },
      });
      if (!location) {
        return NextResponse.json({ error: "Invalid location" }, { status: 400 });
      }
      updateData.defaultLocationId = locationId;
    }
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  // Fetch the before-image inside the tx, update, and record only the provided
  // fields that actually changed (ER-B9 no-op rule).
  const prefFields = {
    emailAlerts: true,
    defaultLocationId: true,
    minLocationEmailAlerts: true,
    minCombinedEmailAlerts: true,
  } as const;

  const updatedUser = await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({
      where: { id: sessionUser.id },
      select: prefFields,
    });
    const updated = await tx.user.update({
      where: { id: sessionUser.id },
      data: updateData,
      select: prefFields,
    });
    const changes = diff(
      before as Record<string, unknown>,
      updateData,
      Object.keys(updateData),
    );
    if (Object.keys(changes).length > 0) {
      await recordChange(tx, {
        actor: { userId: sessionUser.id },
        actionType: "ACCOUNT_PREFERENCES_CHANGE",
        entityType: "USER",
        entityId: sessionUser.id,
        action: "Updated account preferences",
        changes,
      });
    }
    return updated;
  });

  return NextResponse.json(updatedUser);
});
