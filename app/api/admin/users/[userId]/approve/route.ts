import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest, { params }: { params: { userId: string } }) => {
  const { user: adminUser } = await requireAdmin();

  await requireCSRF(request);

  const userId = parseInt(params.userId);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  // Update approval + record the change atomically (spec R-D2/D4: the bare write
  // is wrapped in a transaction so an unrecordable approval never commits).
  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: { isApproved: true },
    });
    await recordChange(tx, {
      actor: { userId: adminUser.id },
      actionType: "USER_APPROVAL",
      entityType: "USER",
      entityId: updated.id,
      action: `Approved user ${updated.email}`,
      details: { targetEmail: updated.email },
    });
    return updated;
  });

  return NextResponse.json({
    message: "User approved successfully",
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      isApproved: user.isApproved,
    },
  });
});
