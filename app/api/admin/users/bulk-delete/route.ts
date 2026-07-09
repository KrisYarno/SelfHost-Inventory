import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, apiHandler, requireCSRF } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { BulkUserIdsSchema } from "@/lib/validation/admin";

export const dynamic = "force-dynamic";

// R-D14: bulk events carry per-row detail up to this cap, then summary+count.
const MAX_DETAIL_ROWS = 500;

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();

  await requireCSRF(request);

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

  // ONE event for the whole bulk op, sharing a fresh batchId (spec R-D14 +
  // batchId recipe). The before-state is uniform (every fetched row matched
  // `deletedAt: null`), so each row's change is the deletedAt null -> timestamp
  // transition the route actually performs.
  const deletedAt = new Date();
  const batchId = newBatchId();
  const updateResult = await prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: {
        id: { in: usersToDelete.map((u) => u.id) },
      },
      data: { deletedAt },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "USER_DELETION",
      entityType: "USER",
      action: `Bulk deleted ${usersToDelete.length} users`,
      details: {
        userIds: usersToDelete.map((u) => u.id),
        emails: usersToDelete.map((u) => u.email),
        rows: usersToDelete.slice(0, MAX_DETAIL_ROWS).map((u) => ({
          entityId: String(u.id),
          changes: { deletedAt: { from: null, to: deletedAt } },
        })),
        ...(usersToDelete.length > MAX_DETAIL_ROWS
          ? { rowsTruncated: true, rowCount: usersToDelete.length }
          : {}),
      },
      affectedCount: usersToDelete.length,
      batchId,
    });

    return result;
  });

  return NextResponse.json({
    deleted: updateResult.count,
    message: `Successfully deleted ${updateResult.count} users`,
  });
});
