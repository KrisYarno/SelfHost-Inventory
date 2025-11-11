import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import { createInventoryTransaction } from "@/lib/inventory";
import { 
  AppError, 
  UnauthorizedError, 
  errorLogger
} from "@/lib/error-handling";
import { validateCSRFToken } from "@/lib/csrf";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      throw new UnauthorizedError("process inventory deductions");
    }

    const rateLimitHeaders = enforceRateLimit(request, "inventory:deduct-simple", {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = SimpleDeductSchema.parse(await request.json());

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

    const response = NextResponse.json({
      success: true,
      transactionId: result.transaction.id,
      itemsProcessed: result.logs.length,
      message: `Successfully processed ${result.logs.length} items`,
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
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
