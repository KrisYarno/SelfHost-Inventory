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

  // Filter out the current user (cannot delete yourself)
  const filteredIds = userIds.filter(
    (id: number) => id !== user.id
  );

  if (filteredIds.length === 0) {
    return NextResponse.json({
      deleted: 0,
      message: "No users to delete (cannot delete yourself)",
    });
  }

  // Get users before soft deletion for audit log
  const usersToDelete = await prisma.user.findMany({
    where: {
      id: { in: filteredIds },
      deletedAt: null, // Only delete active users
    },
    select: {
      id: true,
      email: true,
      username: true,
    },
  });

  if (usersToDelete.length === 0) {
    return NextResponse.json({
      deleted: 0,
      message: "No users to delete",
    });
  }

  // Soft delete users
  const updateResult = await prisma.user.updateMany({
    where: {
      id: { in: usersToDelete.map((u) => u.id) },
    },
    data: { deletedAt: new Date() },
  });

  // Log the bulk deletion action
  await auditService.logBulkUserDeletion(
    user.id,
    usersToDelete.map((u) => u.id),
    usersToDelete.map((u) => u.email)
  );

  return NextResponse.json({
    deleted: updateResult.count,
    message: `Successfully deleted ${updateResult.count} users`,
  });
});
