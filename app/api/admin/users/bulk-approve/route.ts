import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";
import { BulkUserIdsSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  const body = await request.json();
  const { userIds } = BulkUserIdsSchema.parse(body);

  // Get user emails for audit log
  const usersToApprove = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      isApproved: false,
    },
    select: {
      id: true,
      email: true,
    },
  });

  if (usersToApprove.length === 0) {
    return NextResponse.json({
      approved: 0,
      message: "No users to approve",
    });
  }

  // Update users in bulk
  const updateResult = await prisma.user.updateMany({
    where: {
      id: { in: usersToApprove.map((u) => u.id) },
    },
    data: {
      isApproved: true,
    },
  });

  // Log the bulk approval action
  await auditService.logBulkUserApproval(
    user.id,
    usersToApprove.map((u) => u.id),
    usersToApprove.map((u) => u.email)
  );

  return NextResponse.json({
    approved: updateResult.count,
    message: `Successfully approved ${updateResult.count} users`,
  });
});
