import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAdmin();

    const { userIds } = await request.json();

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return NextResponse.json({ error: "Invalid user IDs" }, { status: 400 });
    }

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
  } catch (error) {
    console.error("Error bulk approving users:", error);
    return NextResponse.json({ error: "Failed to approve users" }, { status: 500 });
  }
}
