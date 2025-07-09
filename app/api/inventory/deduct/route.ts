import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { DeductInventoryRequest, DeductInventoryResponse } from "@/types/workbench";
import { inventory_logs_logType } from "@prisma/client";
import { createInventoryTransaction } from "@/lib/inventory";
import { 
  AppError, 
  UnauthorizedError, 
  InvalidQuantityError,
  errorLogger
} from "@/lib/error-handling";
import { validateCSRFToken } from "@/lib/csrf";

export const dynamic = 'force-dynamic';

// POST /api/inventory/deduct - Process order deduction
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

    const body: DeductInventoryRequest = await request.json();

    // Validate request
    if (!body.orderReference?.trim()) {
      throw new AppError(
        "Order reference is required",
        "MISSING_ORDER_REFERENCE",
        400
      );
    }

    if (!body.items || body.items.length === 0) {
      throw new AppError(
        "No items to process in the order",
        "EMPTY_ORDER",
        400
      );
    }

    // Validate item quantities
    for (const item of body.items) {
      if (item.quantity <= 0 || !Number.isInteger(item.quantity)) {
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { name: true }
        });
        throw new InvalidQuantityError(
          `Invalid quantity for ${product?.name || `Product ${item.productId}`}: ${item.quantity}`
        );
      }
    }

    // Get default location (MVP: single location)
    const location = await prisma.location.findFirst({
      orderBy: { id: "asc" },
    });

    if (!location) {
      throw new AppError(
        "No location configured in the system",
        "NO_LOCATION",
        500
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