import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest, { params }: { params: { userId: string } }) => {
  const { user: adminUser } = await requireAdmin();

  await requireCSRF(request);

  const userId = parseInt(params.userId);
  if (isNaN(userId)) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  // Update user approval status
  const user = await prisma.user.update({
    where: { id: userId },
    data: { isApproved: true },
  });

  // Log the approval action
  await auditService.logUserApproval(adminUser.id, user.id, user.email);

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
