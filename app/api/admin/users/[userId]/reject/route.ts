import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const DELETE = apiHandler(async (request: NextRequest, { params }: { params: { userId: string } }) => {
  const { user: adminUser } = await requireAdmin();

  const userId = parseInt(params.userId);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  // Get user info before deletion for audit log
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Soft delete the user
  await prisma.user.update({
    where: { id: userId },
    data: { deletedAt: new Date() },
  });

  // Log the rejection action
  await auditService.logUserRejection(adminUser.id, user.id, user.email);

  return NextResponse.json({
    message: "User rejected and removed successfully",
  });
});
