import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { auditService } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userIds, reason: _reason } = await request.json();

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return NextResponse.json({ error: "Invalid user IDs" }, { status: 400 });
    }

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
      parseInt(session.user.id),
      usersToReject.map((u) => u.id),
      usersToReject.map((u) => u.email)
    );

    return NextResponse.json({
      rejected: updateResult.count,
      message: `Successfully rejected ${updateResult.count} users`,
    });
  } catch (error) {
    console.error("Error bulk rejecting users:", error);
    return NextResponse.json({ error: "Failed to reject users" }, { status: 500 });
  }
}
