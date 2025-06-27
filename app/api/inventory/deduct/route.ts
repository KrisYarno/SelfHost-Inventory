import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { DeductInventoryRequest, DeductInventoryResponse } from "@/types/workbench";
import { inventory_logs_logType } from "@prisma/client";
import { createInventoryTransaction } from "@/lib/inventory";

export const dynamic = 'force-dynamic';

// POST /api/inventory/deduct - Process order deduction
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: DeductInventoryRequest = await request.json();

    // Validate request
    if (!body.orderReference?.trim()) {
      return NextResponse.json(
        { error: "Order reference is required" },
        { status: 400 }
      );
    }

    if (!body.items || body.items.length === 0) {
      return NextResponse.json(
        { error: "No items to process" },
        { status: 400 }
      );
    }

    // Get default location (MVP: single location)
    const location = await prisma.location.findFirst({
      orderBy: { id: "asc" },
    });

    if (!location) {
      return NextResponse.json(
        { error: "No location found" },
        { status: 400 }
      );
    }

    // Prepare items for the transaction
    const items = body.items.map(item => ({
      productId: item.productId,
      locationId: location.id,
      quantityChange: -item.quantity, // Negative for deduction
      notes: body.notes
    }));

    // Process the transaction
    const result = await createInventoryTransaction(
      'SALE',
      session.user.id,
      items,
      {
        orderReference: body.orderReference,
        notes: body.notes
      }
    );

    const response: DeductInventoryResponse = {
      success: true,
      transactionId: result.transaction.id,
      itemsProcessed: result.logs.length,
      message: `Successfully processed order ${body.orderReference}`,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Error processing inventory deduction:", error);
    
    if (error instanceof Error) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { error: "Failed to process inventory deduction" },
      { status: 500 }
    );
  }
}