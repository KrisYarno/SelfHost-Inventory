import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import prisma from "@/lib/prisma";
import {
  createInventoryTransfer,
  validateStockAvailability,
  OptimisticLockError,
} from "@/lib/inventory";
import { TransferSchema } from "@/lib/validation/inventory";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  let batchStarted = false;

  try {
    const { user } = await requireApproved();

    const rateLimitHeaders = enforceRateLimit(request, "inventory:transfer", {
      identifier: user.id,
    });

    const csrfOk = await validateCSRFToken(request);
    if (!csrfOk) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = TransferSchema.parse(await request.json());

    // Early availability check for better UX
    const availability = await validateStockAvailability(
      body.productId,
      body.fromLocationId,
      body.quantity
    );
    if (!availability.isValid) {
      return NextResponse.json(
        {
          error: {
            message: availability.error || "Insufficient stock at source location",
            code: "INVENTORY_INSUFFICIENT_STOCK",
            context: {
              productId: body.productId,
              fromLocationId: body.fromLocationId,
              currentQuantity: availability.currentQuantity,
              requestedQuantity: availability.requestedQuantity,
              shortfall: availability.shortfall,
            },
          },
        },
        { status: 400 }
      );
    }

    const [product, fromLocation, toLocation] = await Promise.all([
      prisma.product.findUnique({
        where: { id: body.productId },
        select: { id: true, name: true },
      }),
      prisma.location.findUnique({
        where: { id: body.fromLocationId },
        select: { id: true, name: true },
      }),
      prisma.location.findUnique({
        where: { id: body.toLocationId },
        select: { id: true, name: true },
      }),
    ]);

    if (!product || !fromLocation || !toLocation) {
      return NextResponse.json({ error: "Product or location not found" }, { status: 404 });
    }

    const batchId = auditService.startBatch();
    batchStarted = true;

    const result = await createInventoryTransfer({
      userId: user.id,
      productId: body.productId,
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      quantity: body.quantity,
      expectedFromVersion: body.expectedFromVersion,
      expectedToVersion: body.expectedToVersion,
    });

    await auditService.logInventoryTransfer(
      user.id,
      product.id,
      product.name,
      body.quantity,
      fromLocation.id,
      fromLocation.name,
      toLocation.id,
      toLocation.name,
      batchId
    );

    const response = NextResponse.json({
      success: true,
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      quantity: body.quantity,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      logs: result.logs,
      batchId,
    });
    return applyRateLimitHeaders(response, rateLimitHeaders);
  } finally {
    if (batchStarted) {
      auditService.endBatch();
    }
  }
});
