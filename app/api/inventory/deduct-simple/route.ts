import { NextRequest, NextResponse } from "next/server";
import {
  requireApproved,
  requireCompanyMembership,
  apiHandler,
  requireCSRF,
} from "@/lib/api-utils";
import { createInventoryTransaction } from "@/lib/inventory";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { AppError } from "@/lib/error-handling";
import prisma from "@/lib/prisma";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

/**
 * Phase 0b-2 (spec REV-2 / OC-1 / G2-5): resolve the packer's selected external
 * order and prove the caller may reference it, BEFORE its id is written into the
 * audit event's details JSON.
 *
 * A client-supplied id is not evidence. Recording it unvalidated would
 * manufacture the exact false attribution this lane exists to remove — a forged
 * id would make another company's order look fulfilled out of our stock, and the
 * D1 reconciliation would read it as class-(c) evidence and believe it.
 *
 * BOTH failure modes — an id that resolves to nothing, and one that resolves to a
 * company the caller is not a member of — collapse into ONE 400 VALIDATION_ERROR.
 * Deliberate, and a departure from the fulfill route's 404s: there the order is
 * the addressed resource in the PATH, so "not found" is the honest answer. Here
 * it is an annotation on a body that WRITES STOCK, so the honest answer is "this
 * payload is not valid" — and one uniform outcome keeps the route from becoming
 * an order-id existence oracle for an approved user of another company. Never a
 * silent drop: an intent we cannot verify must fail the request, not ride along
 * as if it were true.
 *
 * The membership decision itself stays in `requireCompanyMembership` (the ONE
 * membership predicate — never re-implemented here); only its documented failure
 * signal is translated. A non-AppError (a DB fault) propagates untouched.
 */
async function resolveSelectedExternalOrderId(
  selectedExternalOrderId: string,
  user: { id: number; isAdmin: boolean }
): Promise<string> {
  const order = await prisma.externalOrder.findUnique({
    where: { id: selectedExternalOrderId },
    select: { companyId: true },
  });

  if (order) {
    try {
      await requireCompanyMembership(user.id, order.companyId, user.isAdmin);
      return selectedExternalOrderId;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }

  throw new AppError(
    "selectedExternalOrderId does not reference an order you can access",
    "VALIDATION_ERROR",
    400
  );
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:deduct-simple", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const body = SimpleDeductSchema.parse(await request.json());

  // 0b-2: validate the order intent BEFORE anything is written, so an
  // unverifiable id aborts the whole request rather than half of it.
  const selectedExternalOrderId = body.selectedExternalOrderId
    ? await resolveSelectedExternalOrderId(body.selectedExternalOrderId, user)
    : undefined;

  // Transform items for inventory transaction
  const transactionItems = body.items.map((item) => ({
    productId: item.productId,
    locationId: body.locationId,
    quantityChange: -Math.abs(item.quantity),
    notes: body.notes,
  }));

  const operationId = randomUUID();

  const batchId = newBatchId();

  // Create the deduction transaction. The bulk-update event is recorded INSIDE
  // the same transaction as the deduction writes (via the record callback), so
  // an unrecordable deduction never commits.
  const result = await createInventoryTransaction(
    "DEDUCTION",
    user.id,
    transactionItems,
    {
      orderReference: body.orderReference,
      notes: body.notes,
      operationId,
    },
    async (tx, logs) => {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "INVENTORY_BULK_UPDATE",
        entityType: "INVENTORY",
        action: `Bulk updated inventory for ${logs.length} products`,
        details: {
          updates: logs.map((log) => ({
            productId: log.productId,
            productName: log.products?.name ?? `Product ${log.productId}`,
            delta: log.delta,
          })),
          locationId: body.locationId,
          // 0b-2: the packer's order intent, accrued for later attribution.
          // ABSENT when not supplied — never null-filled: D1 counts these keys by
          // JSON path presence, so a null would read as an accrued reference that
          // does not exist.
          ...(body.orderReference ? { orderReference: body.orderReference } : {}),
          ...(selectedExternalOrderId ? { selectedExternalOrderId } : {}),
        },
        affectedCount: logs.length,
        batchId,
      });
    },
    // ER-C3: thread the event batchId so every DEDUCTION->SALE ledger row joins
    // this deduction's bulk-update event.
    { batchId }
  );

  const response = NextResponse.json({
    success: true,
    transactionId: result.transaction.id,
    itemsProcessed: result.logs.length,
    message: `Successfully processed ${result.logs.length} items`,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
