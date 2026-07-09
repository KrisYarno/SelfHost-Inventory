import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { UpdateDefaultLocationSchema } from "@/lib/validation/account";

export const dynamic = "force-dynamic";

export const PATCH = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  await requireCSRF(request);

  const body = await request.json();
  const { locationId } = UpdateDefaultLocationSchema.parse(body);

  // Verify location exists
  const location = await prisma.location.findUnique({
    where: { id: locationId },
  });

  if (!location) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  // Update user's default location
  const updatedUser = await prisma.user.update({
    where: { email: user.email },
    data: { defaultLocationId: locationId },
  });

  return NextResponse.json({
    message: "Default location updated successfully",
    defaultLocationId: updatedUser.defaultLocationId,
  });
});
