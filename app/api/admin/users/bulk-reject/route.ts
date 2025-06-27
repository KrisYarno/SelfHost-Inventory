import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    
    if (!session?.user?.isAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { userIds, reason } = await request.json();
    
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return NextResponse.json({ error: "Invalid user IDs" }, { status: 400 });
    }

    // Get users before deletion for email notifications
    const usersToReject = await prisma.user.findMany({
      where: {
        id: { in: userIds },
        isApproved: false, // Only reject non-approved users
        isAdmin: false, // Cannot reject admins
      },
      select: {
        id: true,
        email: true,
        username: true,
      },
    });

    // Delete users
    const deleteResult = await prisma.user.deleteMany({
      where: {
        id: { in: usersToReject.map(u => u.id) },
      },
    });


    return NextResponse.json({
      rejected: deleteResult.count,
      message: `Successfully rejected ${deleteResult.count} users`,
    });
  } catch (error) {
    console.error('Error bulk rejecting users:', error);
    return NextResponse.json(
      { error: "Failed to reject users" },
      { status: 500 }
    );
  }
}