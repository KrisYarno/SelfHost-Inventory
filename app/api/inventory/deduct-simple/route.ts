import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { createInventoryTransaction } from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { 
  AppError, 
  UnauthorizedError, 
  InvalidQuantityError,
  errorLogger
} from "@/lib/error-handling";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = 'force-dynamic';

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
      throw new UnauthorizedError("process inventory deductions");
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body: DeductRequest = await request.json();

    // Validate request
    if (!body.items || body.items.length === 0) {
      throw new AppError(
        "No items to process in the order",
        "EMPTY_ORDER",
        400
      );
    }

    if (!body.locationId) {
      throw new AppError(
        "Location ID is required to process the order",
        "MISSING_LOCATION",
        400
      );
    }
    
    // Validate all item quantities
    for (const item of body.items) {
      if (item.quantity <= 0 || !Number.isInteger(item.quantity)) {
        throw new InvalidQuantityError(
          `Invalid quantity for Product ID ${item.productId}: ${item.quantity}`
        );
      }
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
    errorLogger.log(error as Error);
    
    if (error instanceof AppError) {
      return NextResponse.json(
        { 
          error: {
            message: error.message,
            code: error.code
          }
        },
        { status: error.statusCode }
      );
    }
    
    // Handle Prisma errors
    if (error instanceof Error && error.message.includes("Insufficient stock")) {
      const match = error.message.match(/Product (.+) has insufficient stock/);
      const productName = match ? match[1] : "Unknown product";
      return NextResponse.json(
        { 
          error: {
            message: `Not enough stock for ${productName}. Please check available inventory.`,
            code: "INVENTORY_INSUFFICIENT_STOCK",
            context: { productName }
          }
        },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { 
        error: {
          message: "Failed to process inventory deduction. Please try again.",
          code: "DEDUCTION_FAILED"
        }
      },
      { status: 500 }
    );
  }
}