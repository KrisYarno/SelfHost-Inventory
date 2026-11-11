import { NextRequest, NextResponse } from "next/server";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import {
  createInventoryAdjustment,
  validateStockAvailability,
} from "@/lib/inventory";
import { lockFirst } from "@/lib/inventory/order-lock";
import { inventory_logs_logType } from "@prisma/client";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";
import { AdjustWithIntentSchema, parseAdjustShape } from "@/lib/validation/inventory";
import { refuse } from "@/lib/validation/refuse";
import { mapDeductionIntent } from "@/lib/inventory/intent";
import { resolveSelectedExternalOrderId } from "@/lib/orders/resolve-selected-order";
import {
  ORDER_ATTRIBUTION_SOURCE,
  resolveOrderReference,
  type OrderReferenceResolution,
} from "@/lib/orders/resolve-order-reference";
import { AppError } from "@/lib/error-handling";
import { applyRateLimitHeaders, enforceRateLimit } from "@/lib/rateLimit";
import { recordAttributionAttempt } from "@/lib/attribution/attempts";
import { classifyAdjust, type AdjustLocals } from "@/lib/attribution/classify";

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

  // Reconciliation Part 2 (pack CB3a-i.2/.4): WHAT this request is, decided
  // once by the request truth table — every cross-field refusal is a 400 with
  // its frozen sentence, before anything is read or written. From here on the
  // route reads `shape`, never `body`.
  const shape = parseAdjustShape(body);
  // `count` and `correction` PARSE through the full table and stop here: this
  // route does not implement them yet. A valid request of either kind gets one
  // honest 400 rather than a quiet ADJUSTMENT row.
  if (shape.kind !== "delta") refuse(["intent"], "this intent is not available yet");

  // CR-3: the auto-add flag is PARSED now, not read off the raw body. It carries
  // two consequences an approved caller must not be able to assert freely — the
  // INVENTORY_TRANSFER_AUTO_ADD actionType, and the suppression of the live
  // attribution attempt below — so it is a typed server contract with one
  // cross-field rule: an auto-add ADDS the shortfall a transfer needs. A
  // negative delta carrying it removed stock, filed a false "transfer auto-add"
  // audit event, and recorded no attempt at all. Refused at the route (house
  // rule 1 keeps `.refine` off the object schema), BEFORE any write — and
  // behind the truth table, which owns every other cell of this request.
  const autoAddForTransfer = shape.autoAddForTransfer === true;
  if (autoAddForTransfer && shape.delta < 0) {
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
  const intentMapping = mapDeductionIntent(shape.intent);

  // The order id is UNTRUSTED INPUT on a stock-writing route. It is resolved and
  // membership-checked BEFORE anything is written, so an unverifiable id aborts
  // the whole request rather than half of it (the 0b-2 posture, now shared via
  // the extracted resolver).
  //
  // Validation is driven by the id's PRESENCE, the stamp by the intent. Skipping
  // the check whenever the intent happened not to be `order` would let a forged
  // id ride through unexamined on its way to being ignored — an id we accept and
  // silently drop is exactly the "not evidence" problem in a quieter costume.
  // An `order` intent with NO id and NO typed reference resolves nothing and
  // stamps nothing; the operator's statement still lands in the audit event
  // below, never invented.
  const idSupplied = shape.selectedExternalOrderId !== undefined;
  const resolvedOrderId = shape.selectedExternalOrderId
    ? await resolveSelectedExternalOrderId(shape.selectedExternalOrderId, user)
    : null;
  const selectedStamp = intentMapping.attributesOrder ? resolvedOrderId : null;

  // REFERENCE RESOLUTION (pack CB3a-ii.3, the delta arm): the order number the
  // operator TYPED, on a removal under the `order` chip with no order picked.
  // The truth table admits a reference only under `order`, never beside a
  // picked id and never on an add, so this condition is the eligibility rule
  // spelled once for this route. Read OUTSIDE the transaction, like the picked
  // id above.
  //
  // DELIBERATE SECOND COPY of deduct-simple's resolution round: the failure
  // posture (app/api/inventory/deduct-simple/route.ts — the try/catch, the
  // redacted log, the swallow) and the resolver -> { kind } mapping below. The
  // extraction is registered for the hygiene round; no refactor of that
  // shipped route rides this one.
  //
  // Opportunistic enrichment, not the validation of a claim: a named decline
  // (unusable / unmatched / ambiguous / not-a-member) stamps nothing and the
  // removal commits; anything THROWN is an ops event — logged by failure class
  // only, never the typed text (free text is where customer names arrive) —
  // and the removal still commits, unstamped. A database hiccup never turns a
  // deduction that succeeds today into a 500.
  let referenceResolution: OrderReferenceResolution | null = null;
  let resolverThrew = false;
  if (
    shape.intent === "order" &&
    shape.delta < 0 &&
    shape.orderReference &&
    !shape.selectedExternalOrderId
  ) {
    try {
      referenceResolution = await resolveOrderReference(shape.orderReference, user);
    } catch {
      console.error(
        "[adjust] reference resolution failed (infrastructure); deduction proceeds unattributed"
      );
      referenceResolution = null;
      resolverThrew = true;
    }
  }

  // What the resolution round did, in the vocabulary the D2 classifier reads.
  const resolver: AdjustLocals["resolver"] = resolverThrew
    ? { kind: "threw" }
    : referenceResolution === null
      ? { kind: "skipped" }
      : referenceResolution.outcome === "resolved"
        ? { kind: "resolved" }
        : { kind: "declined", outcome: referenceResolution.outcome };

  // The stamp: the picked id, else the resolved order's STORED id — never the
  // typed text.
  const orderRecordId =
    selectedStamp ??
    (referenceResolution?.outcome === "resolved" ? referenceResolution.orderRecordId : null);

  // WHICH EVIDENCE stamped the row (B3-1 FR1, CR-2), spelled as deduct-simple
  // spells it. If the attempt insert is swallowed, the report derives this
  // batch's class instead — and the derivation reads this key FIRST (its R1),
  // so a resolved number is never re-read as a pick. Absent when nothing was
  // stamped, never null-filled.
  const orderAttributionSource =
    orderRecordId === null
      ? null
      : selectedStamp !== null
        ? ORDER_ATTRIBUTION_SOURCE.SELECTED
        : ORDER_ATTRIBUTION_SOURCE.REFERENCE_RESOLVED;

  // If removing stock, validate availability
  if (shape.delta < 0) {
    const validation = await validateStockAvailability(
      shape.productId,
      shape.locationId,
      Math.abs(shape.delta)
    );

    if (!validation.isValid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  }

  // Get product info for the change record
  const product = await prisma.product.findUnique({
    where: { id: shape.productId },
    select: { name: true },
  });
  const productName = product?.name ?? `Product ${shape.productId}`;

  // One batch id per request flow; recorded inside the adjustment's transaction.
  const batchId = newBatchId();

  // Create the adjustment with version checking. The change is recorded INSIDE
  // the same transaction as the stock write (via the record callback) so an
  // unrecordable adjustment never commits. An auto-add-for-transfer adjustment
  // preserves its dedicated actionType; every other adjustment records as
  // INVENTORY_ADJUSTMENT.
  const result = await createInventoryAdjustment(
    user.id,
    shape.productId,
    shape.locationId,
    shape.delta,
    {
      // Always the literal: a request's `logType` is IGNORED (pack CB3a-ii.3).
      // The schema only ever admitted ADJUSTMENT, and the server decides what
      // it writes.
      logType: inventory_logs_logType.ADJUSTMENT,
      expectedVersion: shape.expectedVersion,
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
      // Reconciliation Part 2 (spec §2.7(1), pack CB1b.5): when this adjustment
      // STAMPS an order, that order is locked as the transaction's first act.
      // The primitive owns the transaction (and retries it), so the lock rides
      // in as a hook and re-runs per attempt. An unstamped adjustment — the
      // journal's, a transfer auto-add — locks nothing.
      lockFirst:
        orderRecordId !== null ? (tx) => lockFirst(tx, { required: [orderRecordId] }) : undefined,
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
          entityId: shape.productId,
          action: autoAddForTransfer
            ? `Auto-added ${shape.delta} units of "${productName}" at location ${shape.locationId} to complete a transfer`
            : `Adjusted inventory for "${productName}" by ${shape.delta > 0 ? "+" : ""}${shape.delta}`,
          // Phase C (P-C5): persist the operator's own words when supplied — zod
          // used to strip these. Included only when present so no-reason callers
          // (transfer auto-add, workbench undo, journal) keep their lean details.
          details: {
            ...(autoAddForTransfer
              ? {
                  productId: shape.productId,
                  productName,
                  delta: shape.delta,
                  locationId: shape.locationId,
                }
              : { productName, delta: shape.delta, locationId: shape.locationId }),
            ...(shape.reason ? { reason: shape.reason } : {}),
            ...(shape.notes ? { notes: shape.notes } : {}),
            // W2-1: the operator's own statement, accrued verbatim. Included
            // ONLY when the chip was actually tapped — truthful-data north star:
            // an untapped chip is a structurally-absent key, never a null one,
            // because a null would be counted as a classification that happened.
            // This is also what keeps `order`-with-no-id from being a silent
            // no-op: the intent survives even when there is nothing to stamp.
            ...(shape.intent ? { intent: shape.intent } : {}),
            // Reconciliation Part 2 (pack CB3a-i.3): the order number the
            // operator TYPED, accrued verbatim whatever the resolver made of it
            // — resolved, declined, or failed — as deduct-simple accrues its
            // own. ABSENT when nothing was typed. It goes on this EVENT only:
            // the attempt row's details are a closed set and never carry it.
            ...(shape.orderReference ? { orderReference: shape.orderReference } : {}),
            ...(orderAttributionSource ? { orderAttributionSource } : {}),
            // NOT `selectedExternalOrderId`, unlike deduct-simple: derive's R3a reads it as "the packer picked this order", and here an `other`-chip id is validated but never stamped.
          },
          batchId,
        });

        // Reconciliation lane R-A (spec REV-7 D1/D2, pack C1b.3): an attempt row
        // ONLY for stock that left the building. A positive adjust restocks and
        // a transfer auto-add completes a move; neither had an attribution
        // question to answer, and recording "we could not attribute it" for them
        // would populate the report with movements that never asked.
        if (shape.delta < 0 && !autoAddForTransfer) {
          await recordAttributionAttempt(tx, {
            ...classifyAdjust({
              // The SELECTED stamp only; a reference-resolved stamp is the
              // resolver's row (3b), not row 1.
              stamped: idSupplied && orderRecordId !== null,
              idSupplied,
              intent: shape.intent,
              referenceTyped: shape.orderReference !== undefined,
              resolver,
            }),
            batchId,
            ledgerRowId: log.id,
            source: "live-adjust",
            actorUserId: user.id,
            orderRecordId,
            ...(shape.intent ? { details: { intent: shape.intent } } : {}),
          });
        }
      },
    }
  );

  const response = NextResponse.json({
    success: true,
    log: result.log,
    newVersion: result.newVersion,
    // Reconciliation Part 2 (pack CB1b.5): the batch this adjustment's ledger
    // row and audit event share, named on the wire so a caller can point at the
    // movement it just made.
    batchId,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
