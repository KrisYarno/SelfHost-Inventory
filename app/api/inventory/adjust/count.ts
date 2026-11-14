import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { AppError } from "@/lib/error-handling";
import { STOCK_TX_OPTIONS, withDeadlockRetry } from "@/lib/inventory";
import { countAtLocation, type CountResult } from "@/lib/inventory/count";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { applyRateLimitHeaders, type RateLimitHeaders } from "@/lib/rateLimit";
import type { AdjustShape } from "@/lib/validation/inventory";

type CountShape = Extract<AdjustShape, { kind: "count" }>;

/**
 * THE ADJUST ROUTE'S COUNT ARM (reconciliation Part 2, pack § P2-B3-2 C2-2).
 *
 * The route dispatches here once the request truth table has said this is a
 * count — the rate limit, the CSRF guard, the `reasonCode` refusal and the
 * parse have all run. A count is not an attribution: no attempt row is
 * written, and neither the T7 mapper nor the D2 classifier is reached.
 *
 * The two existence reads run BEFORE the transaction, so an unknown product or
 * location is a named 404 rather than the prelock's materialize INSERT dying on
 * its foreign key as a bare 500. The batch id is minted on BOTH arms: a
 * confirmed count has no ledger row, and its audit event still needs a batch.
 */
export async function countResponse(
  shape: CountShape,
  user: { id: number },
  rateLimitHeaders: RateLimitHeaders
): Promise<NextResponse> {
  const { productId, locationId, countedQuantity, expectedVersion } = shape;

  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null },
    select: { name: true },
  });
  if (!product) throw new AppError("Product not found", "NOT_FOUND", 404);

  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { name: true },
  });
  if (!location) throw new AppError("Location not found", "NOT_FOUND", 404);

  const productName = product.name;
  const locationName = location.name;
  const batchId = newBatchId();

  // ONE event per count, in the count's own transaction: a set count's event
  // sits beside its COUNT row; a confirmed count's event IS the record that the
  // count happened. INVENTORY_ADJUSTMENT keyed by product, so the product
  // History renders it whether or not a ledger row exists, and its Note keeps
  // the existing audience rule.
  const onRecord = async (tx: Prisma.TransactionClient, result: CountResult): Promise<void> => {
    await recordChange(tx, {
      actor: { userId: user.id },
      actionType: "INVENTORY_ADJUSTMENT",
      entityType: "INVENTORY",
      entityId: productId,
      action: result.changed
        ? `Counted ${countedQuantity} (was ${result.previousQuantity}) for "${productName}" at ${locationName}`
        : `Confirmed count of ${countedQuantity} for "${productName}" at ${locationName}`,
      details: {
        productName,
        intent: "count",
        countedQuantity,
        previousQuantity: result.previousQuantity,
        delta: result.changed ? result.delta : 0,
        locationId,
        // The operator's own words, ONLY when supplied — an absent Note is an
        // absent key, never `notes: undefined`.
        ...(shape.reason ? { reason: shape.reason } : {}),
        ...(shape.notes ? { notes: shape.notes } : {}),
      },
      batchId,
    });
  };

  const result = await withDeadlockRetry(() =>
    prisma.$transaction(
      (tx) =>
        countAtLocation(
          tx,
          { userId: user.id, productId, locationId, countedQuantity, expectedVersion, batchId },
          onRecord
        ),
      STOCK_TX_OPTIONS
    )
  );

  const response = NextResponse.json(
    result.changed
      ? {
          success: true,
          changed: true,
          batchId,
          countedQuantity,
          previousQuantity: result.previousQuantity,
          delta: result.delta,
          newVersion: result.newVersion,
          log: result.log,
        }
      : {
          success: true,
          changed: false,
          batchId,
          countedQuantity,
          previousQuantity: result.previousQuantity,
          delta: 0,
          newVersion: result.version,
        }
  );
  return applyRateLimitHeaders(response, rateLimitHeaders);
}
