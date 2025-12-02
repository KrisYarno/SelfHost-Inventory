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
import { BatchTransferSchema } from "@/lib/validation/inventory";
import { auditService } from "@/lib/audit";
import { validateCSRFToken } from "@/lib/csrf";
import { applyRateLimitHeaders, enforceRateLimit, RateLimitError } from "@/lib/rateLimit";
import type { BatchTransferResult } from "@/types/inventory";

export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/transfer/batch
 * Execute multiple transfers from various source locations to a single destination
 * Used by the Stock In feature on the Stocker page
 */
export async function POST(request: NextRequest) {
  let batchStarted = false;

  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !session.user.isApproved) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const rateLimitHeaders = enforceRateLimit(request, "inventory:transfer:batch", {
      identifier: session.user.id,
    });

    const csrfOk = await validateCSRFToken(request);
    if (!csrfOk) {
      return NextResponse.json({ error: "Invalid CSRF token" }, { status: 403 });
    }

    const body = BatchTransferSchema.parse(await request.json());

    // Validate that none of the source locations match the destination
    const invalidTransfers = body.transfers.filter(
      (t) => t.fromLocationId === body.toLocationId
    );
    if (invalidTransfers.length > 0) {
      return NextResponse.json(
        {
          error: "Source location cannot be the same as destination",
          invalidLocations: invalidTransfers.map((t) => t.fromLocationId),
        },
        { status: 400 }
      );
    }

    // Get product and destination location info
    const [product, toLocation] = await Promise.all([
      prisma.product.findFirst({
        where: { id: body.productId, deletedAt: null },
        select: { id: true, name: true },
      }),
      prisma.location.findUnique({
        where: { id: body.toLocationId },
        select: { id: true, name: true },
      }),
    ]);

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    if (!toLocation) {
      return NextResponse.json({ error: "Destination location not found" }, { status: 404 });
    }

    // Get all source locations
    const sourceLocationIds = body.transfers.map((t) => t.fromLocationId);
    const sourceLocations = await prisma.location.findMany({
      where: { id: { in: sourceLocationIds } },
      select: { id: true, name: true },
    });
    const sourceLocationMap = new Map<number, { id: number; name: string }>();
    for (const l of sourceLocations) {
      sourceLocationMap.set(l.id, l);
    }

    // Validate all source locations exist
    const missingLocations = sourceLocationIds.filter((id) => !sourceLocationMap.has(id));
    if (missingLocations.length > 0) {
      return NextResponse.json(
        { error: "Some source locations not found", missingLocations },
        { status: 404 }
      );
    }

    // Pre-validate stock availability for all transfers
    const availabilityChecks = await Promise.all(
      body.transfers.map(async (t) => ({
        fromLocationId: t.fromLocationId,
        quantity: t.quantity,
        availability: await validateStockAvailability(body.productId, t.fromLocationId, t.quantity),
      }))
    );

    const insufficientStock = availabilityChecks.filter((c) => !c.availability.isValid);
    if (insufficientStock.length > 0) {
      return NextResponse.json(
        {
          error: "Insufficient stock at one or more source locations",
          code: "INVENTORY_INSUFFICIENT_STOCK",
          details: insufficientStock.map((c) => ({
            fromLocationId: c.fromLocationId,
            fromLocationName: sourceLocationMap.get(c.fromLocationId)?.name,
            currentQuantity: c.availability.currentQuantity,
            requestedQuantity: c.quantity,
            shortfall: c.availability.shortfall,
          })),
        },
        { status: 400 }
      );
    }

    // Start audit batch
    const batchId = auditService.startBatch();
    batchStarted = true;

    // Execute transfers sequentially (within the same audit batch)
    const results: BatchTransferResult["results"] = [];
    let totalTransferred = 0;

    for (const transfer of body.transfers) {
      try {
        const result = await createInventoryTransfer({
          userId: session.user.id,
          productId: body.productId,
          fromLocationId: transfer.fromLocationId,
          toLocationId: body.toLocationId,
          quantity: transfer.quantity,
          expectedFromVersion: transfer.expectedVersion,
        });

        // Log the transfer
        const fromLocation = sourceLocationMap.get(transfer.fromLocationId)!;
        await auditService.logInventoryTransfer(
          Number(session.user.id),
          product.id,
          product.name,
          transfer.quantity,
          fromLocation.id,
          fromLocation.name,
          toLocation.id,
          toLocation.name,
          batchId
        );

        results.push({
          fromLocationId: transfer.fromLocationId,
          quantity: transfer.quantity,
          success: true,
        });
        totalTransferred += transfer.quantity;
      } catch (error) {
        // Record the failure but continue with remaining transfers
        const errorMessage =
          error instanceof OptimisticLockError
            ? "Inventory was modified by another user"
            : error instanceof Error
              ? error.message
              : "Unknown error";

        results.push({
          fromLocationId: transfer.fromLocationId,
          quantity: transfer.quantity,
          success: false,
          error: errorMessage,
        });
      }
    }

    const allSucceeded = results.every((r) => r.success);
    const response: BatchTransferResult = {
      success: allSucceeded,
      results,
      totalTransferred,
      batchId,
    };

    const httpResponse = NextResponse.json(response, {
      status: allSucceeded ? 200 : 207, // 207 Multi-Status for partial success
    });
    return applyRateLimitHeaders(httpResponse, rateLimitHeaders);
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

    console.error("Error performing batch inventory transfer:", error);
    return NextResponse.json(
      { error: "Failed to perform batch inventory transfer" },
      { status: 500 }
    );
  } finally {
    if (batchStarted) {
      auditService.endBatch();
    }
  }
}
