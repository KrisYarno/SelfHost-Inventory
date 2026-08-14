import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { createInventoryTransaction } from "@/lib/inventory";
import { mapDeductionIntent } from "@/lib/inventory/intent";
import { resolveSelectedExternalOrderId } from "@/lib/orders/resolve-selected-order";
import {
  ORDER_ATTRIBUTION_SOURCE,
  isReferenceResolutionEligible,
  resolveOrderReference,
} from "@/lib/orders/resolve-order-reference";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";

// W2-1 (pack REV-11 T7): the 0b-2 resolver that used to live here is now
// lib/orders/resolve-selected-order.ts — the adjust surface's chip needs the
// identical membership-validated lookup, and two copies of "prove the caller may
// reference this order" is one copy too many. This route's behaviour across the
// extraction is UNCHANGED and pinned as such by the untouched 0b-2 suite in
// __tests__/integration/api/change-tracking-ledger-semantics.test.ts.

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

  // W2-1 (pack T7): the chip's TWO values on this surface. `damage-loss` never
  // arrives — the schema refuses it (see lib/validation/workbench.ts) — so the
  // reason is always null here; the mapping is still read through the shared
  // table rather than assumed, so the surfaces cannot drift apart.
  const intentMapping = mapDeductionIntent(body.intent);

  // The LEDGER stamp is the chip's decision: only an explicit `order` intent
  // puts the resolved id on the rows. 0b-2's AUDIT accrual below is deliberately
  // NOT gated on the chip — it predates it, it is the backfill's source, and
  // narrowing it would silently discard evidence that is already being written.
  const selectedStamp = intentMapping.attributesOrder ? selectedExternalOrderId ?? null : null;

  // REFERENCE RESOLUTION. The prod backfill proved 0b-2's premise unmet: the
  // structured id has never been sent, because packers TYPE the Woo order number
  // into `orderReference` instead — and every reference production has recorded
  // names exactly one order. So resolve it server-side, under three conditions:
  //
  //   (a) no structured id came — the stronger evidence always wins, and a
  //       SUPPLIED-but-unstampable id (chip said `other`) is that operator's
  //       answer, which the reference must not walk around;
  //   (b) no explicit NON-order intent — see isReferenceResolutionEligible for
  //       why an ABSENT chip is not the same as a stated `other` here;
  //   (c) the reference identifies exactly one order (the helper's bar).
  //
  // Anything else keeps today's behaviour exactly: the free text is accrued and
  // no column is stamped, which is what W3's matcher inherits. A membership
  // failure is in that group — the deduction is legal and commits; only the
  // attribution is withheld, and nothing about the declined order is recorded.
  const referenceResolution =
    body.selectedExternalOrderId === undefined && isReferenceResolutionEligible(body.intent)
      ? await resolveOrderReference(body.orderReference, user)
      : null;

  const orderRecordId =
    selectedStamp ??
    (referenceResolution?.outcome === "resolved" ? referenceResolution.orderRecordId : null);

  // WHICH EVIDENCE attributed this movement. A stamped row alone cannot say
  // whether an operator picked the order or a number they typed resolved to it,
  // and the two do not carry the same confidence — a reconciliation that reads
  // them as one thing is reading a number it cannot stand behind. Absent when
  // nothing was stamped, never null-filled (the house rule the two keys below
  // follow, for the same JSON-path-census reason).
  const orderAttributionSource =
    orderRecordId === null
      ? null
      : selectedStamp !== null
        ? ORDER_ATTRIBUTION_SOURCE.SELECTED
        : ORDER_ATTRIBUTION_SOURCE.REFERENCE_RESOLVED;

  // Transform items for inventory transaction
  const transactionItems = body.items.map((item) => ({
    productId: item.productId,
    locationId: body.locationId,
    quantityChange: -Math.abs(item.quantity),
    notes: body.notes,
    reasonCode: intentMapping.reasonCode,
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
          // W2-1: the chip, when the packer actually tapped it. ABSENT otherwise,
          // for the same reason as the two keys above — a null would be counted
          // as a classification that never happened.
          ...(body.intent ? { intent: body.intent } : {}),
          // The reference-resolution round: WHICH evidence stamped the ledger
          // rows this event describes, when anything did. Additive — no existing
          // key changes meaning, and the companion backfill names the same two
          // sources with the same two tokens.
          ...(orderAttributionSource ? { orderAttributionSource } : {}),
        },
        affectedCount: logs.length,
        batchId,
      });
    },
    // ER-C3: thread the event batchId so every DEDUCTION->SALE ledger row joins
    // this deduction's bulk-update event. W2-1 adds the order attribution, which
    // is null unless the chip said `order` AND the resolver returned an id.
    { batchId, orderRecordId }
  );

  const response = NextResponse.json({
    success: true,
    transactionId: result.transaction.id,
    itemsProcessed: result.logs.length,
    message: `Successfully processed ${result.logs.length} items`,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
