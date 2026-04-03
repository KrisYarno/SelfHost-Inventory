import { NextRequest, NextResponse } from "next/server";
import { requireApproved } from "@/lib/api-utils";
import { ZodError } from "zod";
import { createInventoryAdjustment } from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { AppError, errorLogger } from "@/lib/error-handling";
import { validateCSRFToken } from "@/lib/csrf";
import { StockInSchema } from "@/lib/validation/inventory";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { user } = await requireApproved();

    const rateLimitHeaders = enforceRateLimit(request, "inventory:stock-in", {
      identifier: user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = StockInSchema.parse(await request.json());

    // Create the stock-in adjustment
    const result = await createInventoryAdjustment(
      user.id,
      body.productId,
      body.locationId,
      body.quantity, // Positive for adding stock
      inventory_logs_logType.ADJUSTMENT
    );

    const response = NextResponse.json({
      success: true,
      log: result,
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
            code: error.code,
          },
        },
        { status: error.statusCode }
      );
    }

    return NextResponse.json(
      {
        error: {
          message: "Failed to add stock. Please try again.",
          code: "STOCK_IN_FAILED",
        },
      },
      { status: 500 }
    );
  }
}
