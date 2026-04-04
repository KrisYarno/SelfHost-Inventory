import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler } from "@/lib/api-utils";
import {
  createInventoryAdjustment,
  validateStockAvailability,
  OptimisticLockError,
} from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { auditService } from "@/lib/audit";
import prisma from "@/lib/prisma";
import { validateCSRFToken } from "@/lib/csrf";
import { InventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:adjust", {
    identifier: user.id,
  });

  // Validate CSRF token
  const isValidCSRF = await validateCSRFToken(request);
  if (!isValidCSRF) {
    return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
  }

  const rawBody = await request.json();
  const body = InventoryAdjustmentSchema.parse(rawBody);
  const autoAddForTransfer = rawBody?.autoAddForTransfer === true;

  // If removing stock, validate availability
  if (body.delta < 0) {
    const validation = await validateStockAvailability(
      body.productId,
      body.locationId,
      Math.abs(body.delta)
    );

    if (!validation.isValid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  // Get product info for audit log
  const product = await prisma.product.findUnique({
    where: { id: body.productId },
    select: { name: true },
  });

  // Create the adjustment with version checking
  const result = await createInventoryAdjustment(
    user.id,
    body.productId,
    body.locationId,
    body.delta,
    body.logType || inventory_logs_logType.ADJUSTMENT,
    body.expectedVersion
  );

  // Log only transfer auto-add in audit trail
  if (product && autoAddForTransfer) {
    await auditService.logInventoryTransferAutoAdd(
      user.id,
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
});
