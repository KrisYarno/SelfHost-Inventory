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

    const { userIds } = await request.json();

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return NextResponse.json({ error: "Invalid user IDs" }, { status: 400 });
    }

    // Filter out the current user (cannot delete yourself)
    const filteredIds = userIds.filter(
      (id: number) => id.toString() !== session.user.id
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
      parseInt(session.user.id),
      usersToDelete.map((u) => u.id),
      usersToDelete.map((u) => u.email)
    );

    return NextResponse.json({
      deleted: updateResult.count,
      message: `Successfully deleted ${updateResult.count} users`,
    });
  } catch (error) {
    console.error("Error bulk deleting users:", error);
    return NextResponse.json({ error: "Failed to delete users" }, { status: 500 });
  }
}
