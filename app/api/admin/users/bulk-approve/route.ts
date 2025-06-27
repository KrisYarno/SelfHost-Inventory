import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";

export const dynamic = 'force-dynamic';

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

    // Update users in bulk
    const updateResult = await prisma.user.updateMany({
      where: {
        id: { in: userIds },
        isApproved: false, // Only update non-approved users
      },
      data: {
        isApproved: true,
      },
    });


    return NextResponse.json({
      approved: updateResult.count,
      message: `Successfully approved ${updateResult.count} users`,
    });
  } catch (error) {
    console.error('Error bulk approving users:', error);
    return NextResponse.json(
      { error: "Failed to approve users" },
      { status: 500 }
    );
  }
}