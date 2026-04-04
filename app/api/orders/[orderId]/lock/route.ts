import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import { OrderLockResponse } from "@/types/orders";

export const POST = apiHandler(async (request: NextRequest, _context: { params: { orderId: string } }) => {
  const { user } = await requireApproved();

  const body = await request.json();
  const { userId: _userId } = body;

  const response: OrderLockResponse = {
    success: true,
    lockedBy: {
      userId: user.id,
      userName: user.name || "Unknown User",
      lockedAt: new Date(),
    },
  };

  return NextResponse.json(response);
});
