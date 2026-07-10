import { NextRequest, NextResponse } from "next/server";
import { requireAuth, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, diff } from "@/lib/change-tracking";
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

  // Fetch the before-image inside the tx (the handler otherwise reads only the
  // target location), update, and record only a real change (ER-B9 no-op rule).
  const updatedUser = await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUniqueOrThrow({
      where: { email: user.email },
      select: { defaultLocationId: true },
    });
    const updated = await tx.user.update({
      where: { email: user.email },
      data: { defaultLocationId: locationId },
    });
    const changes = diff(before, { defaultLocationId: locationId }, ["defaultLocationId"]);
    if (Object.keys(changes).length > 0) {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "ACCOUNT_PREFERENCES_CHANGE",
        entityType: "USER",
        entityId: user.id,
        action: "Changed default location",
        changes,
      });
    }
    return updated;
  });

  return NextResponse.json({
    message: "Default location updated successfully",
    defaultLocationId: updatedUser.defaultLocationId,
  });
});
