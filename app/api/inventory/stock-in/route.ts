import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { createInventoryAdjustment } from '@/lib/inventory';
import { inventory_logs_logType } from '@prisma/client';
import type { StockInRequest } from '@/types/inventory';
import { 
  AppError, 
  UnauthorizedError, 
  InvalidQuantityError,
  errorLogger
} from "@/lib/error-handling";
import { validateCSRFToken } from '@/lib/csrf';
import { withRateLimitHandler } from '@/lib/rate-limit/route-handler';

export const dynamic = 'force-dynamic';

export const POST = withRateLimitHandler(
  async (request: NextRequest) => {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.isApproved) {
      throw new UnauthorizedError("add stock to inventory");
    }

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body: StockInRequest = await request.json();
    
    // Validate request
    if (!body.productId || !body.locationId || !body.quantity) {
      throw new AppError(
        "Missing required fields: productId, locationId, and quantity",
        "MISSING_REQUIRED_FIELDS",
        400
      );
    }

    if (body.quantity <= 0 || !Number.isInteger(body.quantity)) {
      throw new InvalidQuantityError(
        `Invalid quantity for Product ID ${body.productId}: ${body.quantity}`
      );
    }

    // Create the stock-in adjustment
    const result = await createInventoryAdjustment(
      session.user.id,
      body.productId,
      body.locationId,
      body.quantity, // Positive for adding stock
      inventory_logs_logType.ADJUSTMENT
    );

    return NextResponse.json({
      success: true,
      log: result,
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
    
    return NextResponse.json(
      { 
        error: {
          message: "Failed to add stock. Please try again.",
          code: "STOCK_IN_FAILED"
        }
      },
      { status: 500 }
    );
  }
  },
  { 
    type: 'user', // Use user-based rate limiting for authenticated operations
    configPath: '/api/inventory' // Use inventory rate limit config
  }
);