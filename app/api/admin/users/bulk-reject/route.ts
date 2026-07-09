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

  // ONE event for the whole bulk op, sharing a fresh batchId (spec R-D14 +
  // batchId recipe). Rejection soft-deletes the row; the before-state is uniform
  // (every fetched row matched `deletedAt: null`), so each row's change is the
  // deletedAt null -> timestamp transition the route actually performs.
  const rejectedAt = new Date();
  const batchId = newBatchId();
  const updateResult = await prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: {
        id: { in: usersToReject.map((u) => u.id) },
      },
      data: { deletedAt: rejectedAt },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "USER_BULK_REJECTION",
      entityType: "USER",
      action: `Bulk rejected ${usersToReject.length} users`,
      details: {
        userIds: usersToReject.map((u) => u.id),
        emails: usersToReject.map((u) => u.email),
        rows: usersToReject.slice(0, MAX_DETAIL_ROWS).map((u) => ({
          entityId: String(u.id),
          changes: { deletedAt: { from: null, to: rejectedAt } },
        })),
        ...(usersToReject.length > MAX_DETAIL_ROWS
          ? { rowsTruncated: true, rowCount: usersToReject.length }
          : {}),
      },
      affectedCount: usersToReject.length,
      batchId,
    });

    return result;
  });

  return NextResponse.json({
    rejected: updateResult.count,
    message: `Successfully rejected ${updateResult.count} users`,
  });
});
