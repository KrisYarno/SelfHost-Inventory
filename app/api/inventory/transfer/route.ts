import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ZodError } from "zod";
import { authOptions } from "@/lib/auth";
import prisma from "@/lib/prisma";
import {
  createInventoryTransfer,
  validateStockAvailability,
  OptimisticLockError,
} from "@/lib/inventory";
import { TransferSchema } from "@/lib/validation/inventory";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let batchStarted = false;

  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !session.user.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, "inventory:transfer", {
      identifier: session.user.id,
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
      userId: session.user.id,
      productId: body.productId,
      fromLocationId: body.fromLocationId,
      toLocationId: body.toLocationId,
      quantity: body.quantity,
      expectedFromVersion: body.expectedFromVersion,
      expectedToVersion: body.expectedToVersion,
    });

    await auditService.logInventoryTransfer(
      session.user.id,
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
  } catch (error: unknown) {
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

    if (error instanceof OptimisticLockError) {
      return NextResponse.json(
        {
          error: error.message,
          type: "OPTIMISTIC_LOCK_ERROR",
          currentVersion: error.currentVersion,
          expectedVersion: error.expectedVersion,
        },
        { status: 409 }
      );
    }

    console.error("Error performing inventory transfer:", error);
    return NextResponse.json({ error: "Failed to perform inventory transfer" }, { status: 500 });
  } finally {
    if (batchStarted) {
      auditService.endBatch();
    }
  }
}
