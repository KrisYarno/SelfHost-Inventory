import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { ZodError } from 'zod';
import { authOptions } from '@/lib/auth';
import {
  createInventoryAdjustment,
  validateStockAvailability,
  OptimisticLockError,
} from '@/lib/inventory';
import { inventory_logs_logType } from '@prisma/client';
import { auditService } from '@/lib/audit';
import prisma from '@/lib/prisma';
import { validateCSRFToken } from '@/lib/csrf';
import { InventoryAdjustmentSchema } from '@/lib/validation/inventory';
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, 'inventory:adjust', {
      identifier: session.user.id,
    });

    // Validate CSRF token
    const isValidCSRF = await validateCSRFToken(request);
    if (!isValidCSRF) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = InventoryAdjustmentSchema.parse(await request.json());

    // If removing stock, validate availability
    if (body.delta < 0) {
      const validation = await validateStockAvailability(
        body.productId,
        body.locationId,
        Math.abs(body.delta)
      );

      if (!validation.isValid) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 }
        );
      }
    }

    // Get product info for audit log
    const product = await prisma.product.findUnique({
      where: { id: body.productId },
      select: { name: true }
    });

    // Create the adjustment with version checking
    const result = await createInventoryAdjustment(
      session.user.id,
      body.productId,
      body.locationId,
      body.delta,
      body.logType || inventory_logs_logType.ADJUSTMENT,
      body.expectedVersion
    );

    // Log the inventory adjustment
    if (product) {
      await auditService.logInventoryAdjustment(
        parseInt(session.user.id),
        body.productId,
        product.name,
        body.delta,
        body.locationId
      );
    }

    const response = NextResponse.json({
      success: true,
      log: result.log,
      newVersion: result.newVersion,
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: error.headers }
      );
    }

    if (error instanceof ZodError) {
      return NextResponse.json(
        {
          error: 'Invalid request payload',
          details: error.flatten().fieldErrors,
        },
        { status: 400 }
      );
    }

    console.error('Error creating inventory adjustment:', error);
    
    // Handle optimistic lock errors specifically
    if (error instanceof OptimisticLockError) {
      return NextResponse.json(
        { 
          error: error.message,
          type: 'OPTIMISTIC_LOCK_ERROR',
          currentVersion: error.currentVersion,
          expectedVersion: error.expectedVersion
        },
        { status: 409 } // Conflict status code
      );
    }
    
    return NextResponse.json(
      { error: 'Failed to create inventory adjustment' },
      { status: 500 }
    );
  }
}
