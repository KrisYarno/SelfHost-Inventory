import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { userId: string } }) => {
  const { user: adminUser } = await requireAdmin();

  await requireCSRF(request);

  const userId = parseInt(params.userId);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  // Get user info before deletion for the audit event (before-state read stays
  // outside the tx — the recipe forbids adding reads inside the transaction).
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Soft delete + record atomically (spec R-D2/D4).
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
    await recordChange(tx, {
      actor: { userId: adminUser.id },
      actionType: "USER_REJECTION",
      entityType: "USER",
      entityId: user.id,
      action: `Rejected user ${user.email}`,
      details: { targetEmail: user.email },
    });
  });

  return NextResponse.json({
    message: "User rejected and removed successfully",
  });
});
