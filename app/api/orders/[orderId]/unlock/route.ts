import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";

export async function POST(_request: NextRequest, _context: { params: { orderId: string } }) {
  try {
    await requireApproved();

    // Mock implementation - replace with actual database logic
    // In a real implementation, you would:
    // 1. Check if the order exists
    // 2. Check if the current user has the lock
    // 3. Remove the lock information from the order
    // 4. Return success

    return NextResponse.json({
      success: true,
      message: "Order unlocked successfully",
    });
  } catch (error) {
    console.error("Error unlocking order:", error);
    return NextResponse.json({ error: "Failed to unlock order" }, { status: 500 });
  }
}
