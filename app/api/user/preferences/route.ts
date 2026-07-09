import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

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
  const updateData: Record<string, unknown> = {};

  if (typeof body.emailAlerts === "boolean") {
    updateData.emailAlerts = body.emailAlerts;
  }

  const booleanFields = [
    "minLocationEmailAlerts",
    "minCombinedEmailAlerts",
  ] as const;

  booleanFields.forEach((field) => {
    if (typeof body[field] === "boolean") {
      updateData[field] = body[field];
    }
  });

  // Update defaultLocationId if provided
  if (body.defaultLocationId !== undefined) {
    const locationId = parseInt(body.defaultLocationId);
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

  const updatedUser = await prisma.user.update({
    where: { id: sessionUser.id },
    data: updateData,
    select: {
      emailAlerts: true,
      defaultLocationId: true,
      minLocationEmailAlerts: true,
      minCombinedEmailAlerts: true,
    },
  });

  return NextResponse.json(updatedUser);
});
