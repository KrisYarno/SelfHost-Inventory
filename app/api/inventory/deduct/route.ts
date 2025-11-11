import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { DeductInventoryResponse } from "@/types/workbench";
import { createInventoryTransaction } from "@/lib/inventory";
import { 
  AppError, 
  UnauthorizedError, 
  errorLogger
} from "@/lib/error-handling";
import { validateCSRFToken } from "@/lib/csrf";
import { DeductInventorySchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

export const dynamic = 'force-dynamic';

// POST /api/inventory/deduct - Process order deduction
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      throw new UnauthorizedError("process inventory deductions");
    }

    const rateLimitHeaders = enforceRateLimit(request, "inventory:deduct", {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = DeductInventorySchema.parse(await request.json());

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

    const responseWithHeaders = NextResponse.json(response);
    return applyRateLimitHeaders(responseWithHeaders, rateLimitHeaders);
  } catch (error) {
    errorLogger.log(error as Error);

    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: "Invalid request payload",
          details: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

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
