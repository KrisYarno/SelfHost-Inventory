import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";
import { BulkUserIdsSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

  const body = await request.json();
  const { userIds } = BulkUserIdsSchema.parse(body);

  // Get users before soft deletion for email notifications
  const usersToReject = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      isApproved: false, // Only reject non-approved users
      isAdmin: false, // Cannot reject admins
      deletedAt: null, // Only reject active users
    },
    select: {
      id: true,
      email: true,
      username: true,
    },
  });

  if (usersToReject.length === 0) {
    return NextResponse.json({
      rejected: 0,
      message: "No users to reject",
    });
  }

  // Soft delete users
  const updateResult = await prisma.user.updateMany({
    where: {
      id: { in: usersToReject.map((u) => u.id) },
    },
    data: { deletedAt: new Date() },
  });

  // Log the bulk rejection action
  await auditService.logBulkUserRejection(
    user.id,
    usersToReject.map((u) => u.id),
    usersToReject.map((u) => u.email)
  );

  return NextResponse.json({
    rejected: updateResult.count,
    message: `Successfully rejected ${updateResult.count} users`,
  });
});
