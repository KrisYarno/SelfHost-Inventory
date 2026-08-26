import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import {
  createInventoryAdjustment,
  validateStockAvailability,
} from "@/lib/inventory";
import { inventory_logs_logType } from "@prisma/client";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";
import { AdjustWithIntentSchema } from "@/lib/validation/inventory";
import { mapDeductionIntent } from "@/lib/inventory/intent";
import { resolveSelectedExternalOrderId } from "@/lib/orders/resolve-selected-order";
import { AppError } from "@/lib/error-handling";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { recordAttributionAttempt } from "@/lib/attribution/attempts";
import { classifyAdjust } from "@/lib/attribution/classify";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:adjust", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const rawBody = await request.json();

  // W2-1 (pack REV-11 T7): the intent chip REPLACED the coded-reason select on
  // this surface, so the old vocabulary must no longer ARRIVE here — there is no
  // double-entry path in which an operator states an intent and a reason code
  // that disagree. Refused explicitly, BEFORE the parse, because zod's default
  // strip would swallow the field and let a stale client believe it had recorded
  // something. Pinned at the ROUTE, per the pack — not at the mapper.
  //
  // Scoped to THIS route on purpose: batch-adjust (the journal) still carries a
  // legitimate per-item reasonCode and shares the underlying schema.
  if (rawBody?.reasonCode !== undefined) {
    throw new AppError(
      "reasonCode is no longer accepted here — send `intent` (order | damage-loss | other)",
      "VALIDATION_ERROR",
      400
    );
  }

  const body = AdjustWithIntentSchema.parse(rawBody);

  // CR-3: the auto-add flag is PARSED now, not read off the raw body. It carries
  // two consequences an approved caller must not be able to assert freely — the
  // INVENTORY_TRANSFER_AUTO_ADD actionType, and the suppression of the live
  // attribution attempt below — so it is a typed server contract with one
  // cross-field rule: an auto-add ADDS the shortfall a transfer needs. A
  // negative delta carrying it removed stock, filed a false "transfer auto-add"
  // audit event, and recorded no attempt at all. Refused at the route (house
  // rule 1 keeps `.refine` off the object schema), BEFORE any write.
  const autoAddForTransfer = body.autoAddForTransfer === true;
  if (autoAddForTransfer && body.delta < 0) {
    throw new AppError(
      "auto-add-for-transfer is an ADD — a negative delta cannot carry it",
      "VALIDATION_ERROR",
      400
    );
  }

  // T7 mapping table, applied once: `order` -> the resolved order id and NO
  // reason; `damage-loss` -> reasonCode DAMAGE and no order; `other` (also the
  // untapped default) -> neither, and above all NEVER CORRECTION, which would
  // silently drop this depletion out of the LOCKED reorder-demand predicate.
  const intentMapping = mapDeductionIntent(body.intent);

  // The order id is UNTRUSTED INPUT on a stock-writing route. It is resolved and
  // membership-checked BEFORE anything is written, so an unverifiable id aborts
  // the whole request rather than half of it (the 0b-2 posture, now shared via
  // the extracted resolver).
  //
  // Validation is driven by the id's PRESENCE, the stamp by the intent. Skipping
  // the check whenever the intent happened not to be `order` would let a forged
  // id ride through unexamined on its way to being ignored — an id we accept and
  // silently drop is exactly the "not evidence" problem in a quieter costume.
  // An `order` intent with NO id resolves nothing and stamps nothing; the
  // operator's statement still lands in the audit event below, never invented.
  const resolvedOrderId = body.selectedExternalOrderId
    ? await resolveSelectedExternalOrderId(body.selectedExternalOrderId, user)
    : null;
  const orderRecordId = intentMapping.attributesOrder ? resolvedOrderId : null;

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

  // Get product info for the change record
  const product = await prisma.product.findUnique({
    where: { id: body.productId },
    select: { name: true },
  });
  const productName = product?.name ?? `Product ${body.productId}`;

  // One batch id per request flow; recorded inside the adjustment's transaction.
  const batchId = newBatchId();

  // Create the adjustment with version checking. The change is recorded INSIDE
  // the same transaction as the stock write (via the record callback) so an
  // unrecordable adjustment never commits. An auto-add-for-transfer adjustment
  // preserves its dedicated actionType; every other adjustment records as
  // INVENTORY_ADJUSTMENT.
  const result = await createInventoryAdjustment(
    user.id,
    body.productId,
    body.locationId,
    body.delta,
    {
      logType: body.logType || inventory_logs_logType.ADJUSTMENT,
      expectedVersion: body.expectedVersion,
      // Phase C (P-C5/P-C1): the coded reason rides onto the ledger row; the same
      // batchId stamps the row so it joins the audit event; the free-text reason /
      // notes ride onto the audit event details (below).
      //
      // W2-1: the reason is now DERIVED from the chip, never taken from the body
      // (which cannot carry one — refused above). `null` for every value except
      // damage-loss, which is what makes the row show up in getShrinkageSummary.
      reasonCode: intentMapping.reasonCode,
      orderRecordId,
      batchId,
      // Reconciliation lane R-A: the closure now takes the LOG the primitive
      // just wrote, so the attempt row can name the ledger row it describes.
      // createInventoryAdjustment has always passed `{ log, newVersion }` — this
      // is a call-site widening, not a lib change.
      record: async (tx, { log }) => {
        await recordChange(tx, {
          actor: { userId: user.id },
          actionType: autoAddForTransfer
            ? "INVENTORY_TRANSFER_AUTO_ADD"
            : "INVENTORY_ADJUSTMENT",
          entityType: "INVENTORY",
          entityId: body.productId,
          action: autoAddForTransfer
            ? `Auto-added ${body.delta} units of "${productName}" at location ${body.locationId} to complete a transfer`
            : `Adjusted inventory for "${productName}" by ${body.delta > 0 ? "+" : ""}${body.delta}`,
          // Phase C (P-C5): persist the operator's own words when supplied — zod
          // used to strip these. Included only when present so no-reason callers
          // (transfer auto-add, workbench undo, journal) keep their lean details.
          details: {
            ...(autoAddForTransfer
              ? {
                  productId: body.productId,
                  productName,
                  delta: body.delta,
                  locationId: body.locationId,
                }
              : { productName, delta: body.delta, locationId: body.locationId }),
            ...(body.reason ? { reason: body.reason } : {}),
            ...(body.notes ? { notes: body.notes } : {}),
            // W2-1: the operator's own statement, accrued verbatim. Included
            // ONLY when the chip was actually tapped — truthful-data north star:
            // an untapped chip is a structurally-absent key, never a null one,
            // because a null would be counted as a classification that happened.
            // This is also what keeps `order`-with-no-id from being a silent
            // no-op: the intent survives even when there is nothing to stamp.
            ...(body.intent ? { intent: body.intent } : {}),
          },
          batchId,
        });

        // Reconciliation lane R-A (spec REV-7 D1/D2, pack C1b.3): an attempt row
        // ONLY for stock that left the building. A positive adjust restocks and
        // a transfer auto-add completes a move; neither had an attribution
        // question to answer, and recording "we could not attribute it" for them
        // would populate the report with movements that never asked.
        if (body.delta < 0 && !autoAddForTransfer) {
          await recordAttributionAttempt(tx, {
            ...classifyAdjust({
              stamped: orderRecordId !== null,
              idSupplied: body.selectedExternalOrderId !== undefined,
              intent: body.intent,
            }),
            batchId,
            ledgerRowId: log.id,
            source: "live-adjust",
            actorUserId: user.id,
            orderRecordId,
            ...(body.intent ? { details: { intent: body.intent } } : {}),
          });
        }
      },
    }
  );

  const response = NextResponse.json({
    success: true,
    log: result.log,
    newVersion: result.newVersion,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
