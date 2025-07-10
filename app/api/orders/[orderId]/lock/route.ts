import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { OrderLockResponse } from "@/types/orders";

export async function POST(
  request: NextRequest,
  { params }: { params: { orderId: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { userId } = body;

    // Mock implementation - replace with actual database logic
    // In a real implementation, you would:
    // 1. Check if the order exists
    // 2. Check if it's already locked by another user
    // 3. Update the order with lock information
    // 4. Return the lock details

    const response: OrderLockResponse = {
      success: true,
      lockedBy: {
        userId: session.user.id,
        userName: session.user.name || "Unknown User",
        lockedAt: new Date(),
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error locking order:", error);
    return NextResponse.json(
      { error: "Failed to lock order" },
      { status: 500 }
    );
  }
}