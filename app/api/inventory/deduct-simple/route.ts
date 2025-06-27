import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createInventoryTransaction } from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";

interface DeductItem {
  productId: number;
  quantity: number;
}

interface DeductRequest {
  items: DeductItem[];
  locationId: number;
  orderReference?: string;
  notes?: string;
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body: DeductRequest = await request.json();

    // Validate request
    if (!body.items || body.items.length === 0) {
      return NextResponse.json(
        { error: "No items to process" },
        { status: 400 }
      );
    }

    if (!body.locationId) {
      return NextResponse.json(
        { error: "Location ID is required" },
        { status: 400 }
      );
    }

    // Transform items for inventory transaction
    const transactionItems = body.items.map(item => ({
      productId: item.productId,
      locationId: body.locationId,
      quantityChange: -Math.abs(item.quantity), // Ensure negative for deduction
      notes: body.notes,
    }));

    // Create the deduction transaction
    const result = await createInventoryTransaction(
      'DEDUCTION',
      session.user.id,
      transactionItems,
      { 
        orderReference: body.orderReference,
        notes: body.notes 
      }
    );

    return NextResponse.json({
      success: true,
      transactionId: result.transaction.id,
      itemsProcessed: result.logs.length,
      message: `Successfully processed ${result.logs.length} items`,
    });
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