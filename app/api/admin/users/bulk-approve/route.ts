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

  // ONE event for the whole bulk op, sharing a fresh batchId (spec R-D14 +
  // batchId recipe). The before-state is uniform: every fetched row matched the
  // `isApproved: false` filter, so each row's change is isApproved false -> true.
  const batchId = newBatchId();
  const updateResult = await prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: {
        id: { in: usersToApprove.map((u) => u.id) },
      },
      data: {
        isApproved: true,
      },
    });

    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "USER_BULK_APPROVAL",
      entityType: "USER",
      action: `Bulk approved ${usersToApprove.length} users`,
      details: {
        userIds: usersToApprove.map((u) => u.id),
        emails: usersToApprove.map((u) => u.email),
        rows: usersToApprove.slice(0, MAX_DETAIL_ROWS).map((u) => ({
          entityId: String(u.id),
          changes: { isApproved: { from: false, to: true } },
        })),
        ...(usersToApprove.length > MAX_DETAIL_ROWS
          ? { rowsTruncated: true, rowCount: usersToApprove.length }
          : {}),
      },
      affectedCount: usersToApprove.length,
      batchId,
    });

    return result;
  });

  return NextResponse.json({
    approved: updateResult.count,
    message: `Successfully approved ${updateResult.count} users`,
  });
});
