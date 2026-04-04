import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";

export const POST = apiHandler(async (_request: NextRequest, _context: { params: { orderId: string } }) => {
  await requireApproved();

  return NextResponse.json({
    success: true,
    message: "Order completed successfully",
    transactionId: `TXN-${Date.now()}`,
  });
});
