import { NextRequest, NextResponse } from "next/server";
import { Prisma, type inventory_logs } from "@prisma/client";
import { requireApproved, apiHandler, requireCSRF } from "@/lib/api-utils";
import { isTransientTxError } from "@/lib/inventory/tx-errors";
import prisma from "@/lib/prisma";
import { recordChange, newBatchId } from "@/lib/change-tracking";
import { recordAttributionAttempt } from "@/lib/attribution/attempts";
import { applyStockDelta, OptimisticLockError, STOCK_TX_OPTIONS } from "@/lib/inventory";
import { prelockKey, prelockProductLocations } from "@/lib/inventory/prelock";
import { AppError, ProductNotFoundError } from "@/lib/error-handling";
import { BatchInventoryAdjustmentSchema } from "@/lib/validation/inventory";
import { enforceRateLimit, applyRateLimitHeaders } from "@/lib/rateLimit";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireApproved();

  const rateLimitHeaders = enforceRateLimit(request, "inventory:batch-adjust", {
    identifier: user.id,
  });

  await requireCSRF(request);

  const { adjustments } = BatchInventoryAdjustmentSchema.parse(await request.json());

  // Get product names for audit logging
  const productIds = adjustments.map((adj) => adj.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true },
  });
  const productMap = new Map(products.map((p) => [p.id, p.name]));

  // An id no product answers to is refused HERE, on the read the audit line
  // already depends on (pack REV-22 F10). It used to travel: the row got
  // materialized by the prelock, the ledger row's FK check killed the whole
  // transaction, and the operator got a generic 500 naming nothing. The journal
  // cannot send this — it picks products from its own catalog — so the honest
  // answer to a hand-built request is a 400 that names the id.
  for (const adjustment of adjustments) {
    if (!productMap.has(adjustment.productId)) {
      // Fix-delta FDb-2: the HOUSE class, not a hand-rolled AppError —
      // `PRODUCT_NOT_FOUND` already means 404 + this exact sentence on two other
      // routes, and one code must not carry two statuses/wordings.
      throw new ProductNotFoundError(adjustment.productId);
    }
  }

  // One batch id per request flow, shared by every event in this transaction.
  const batchId = newBatchId();

  // Execute all adjustments in a transaction, on the covered writers' shared
  // budget (pack REV-22 F3): this route owns its own transaction over the same
  // prelocked rows the primitives take, so it spends the same maxWait/timeout
  // rather than Prisma's 2 s/5 s defaults.
  const results = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const logs: inventory_logs[] = [];
    const auditUpdates: Array<{ productId: number; productName: string; delta: number }> = [];

    // THE CANONICAL PRELOCK (spec §2.7(3), pack CB1a-ii.2), statements 1-2 of
    // this transaction: every key this request touches, materialized and
    // X-locked once in the canonical order, before anything reads a row. There
    // is no order lock here — the journal carries no order context of any kind.
    // The per-item `findFirst` is retired: these rows are what the guards read.
    const locked = await prelockProductLocations(
      tx,
      adjustments.map((adj) => ({ productId: adj.productId, locationId: adj.locationId }))
    );

    // THE WITHIN-TX TALLY (the same shape as createInventoryTransaction's). The
    // retired read saw this transaction's OWN uncommitted writes, so a request
    // naming one key twice had its second item see the first item's effect. The
    // prelock snapshot is taken once, so the tally reproduces that exactly:
    // seeded from the prelock, then advanced after each applyStockDelta.
    const tally = new Map<string, { quantity: number; version: number }>();
    locked.forEach((row, key) => tally.set(key, { quantity: row.quantity, version: row.version }));

    // GUARDS FIRST (pack REV-22 F1). Every adjustment's version check and stock
    // floor runs — in request order, version before floor, first failure wins —
    // over a SIMULATION of the tally, before this transaction writes anything.
    //
    // Why the pass exists: the prelock front-loads the `products` shared locks
    // that each ledger INSERT's FK check takes, so a request that wrote some
    // items and then refused a later one held `product_locations` X locks AND
    // `products` S locks while a sibling request refusing its own item held the
    // mirror image — a deadlock between two requests that both end in a typed
    // refusal. Refusing before the first write means a refused request holds
    // nothing but the prelock.
    //
    // Nothing observable moves: the error classes, their messages and the order
    // they fire in are unchanged, and a request whose last item is refused wrote
    // nothing on the wire either way (the transaction aborted the earlier ones).
    // The typed throws below are exactly the two the write loop's catch rethrows
    // untouched, so no per-item wrapping is lost by guarding out here.
    for (const adjustment of adjustments) {
      const key = prelockKey(adjustment.productId, adjustment.locationId);
      // The map-miss default is a type belt: after the materialize every asked
      // key has a row, and a never-stocked one reads the live column defaults.
      const current = tally.get(key) ?? { quantity: 0, version: 0 };

      // Check version if provided (optimistic locking). B1 behaviour change 1:
      // enforced on never-stocked keys too — the old absent-row branch skipped
      // it, so a stale journal submission against a row someone else had just
      // created won silently.
      if (
        adjustment.expectedVersion !== undefined &&
        current.version !== adjustment.expectedVersion
      ) {
        throw new OptimisticLockError(
          "Inventory has been modified by another user",
          current.version,
          adjustment.expectedVersion
        );
      }

      // The stock floor. B1 behaviour change 2: the old "No inventory found"
      // branch is dead (the row always exists post-materialize), so a negative
      // delta on a never-stocked key now refuses with `current 0` — and as an
      // AppError, because a plain Error reaches the wire as a generic 500 that
      // says nothing. These refusals are 400 INSUFFICIENT_STOCK from here on.
      if (current.quantity + adjustment.delta < 0) {
        throw new AppError(
          `Product ${adjustment.productId}: Insufficient inventory: current ${current.quantity}, trying to remove ${Math.abs(adjustment.delta)}`,
          "INSUFFICIENT_STOCK",
          400
        );
      }

      // Advance the SIMULATED tally, so a later adjustment naming the same key
      // is guarded against what this one will write — exactly what the retired
      // own-write-visible read gave it, computed before the writes rather than
      // between them.
      tally.set(key, {
        quantity: current.quantity + adjustment.delta,
        version: current.version + 1,
      });
    }

    // THE WRITE LOOP — reached only when EVERY adjustment passed above, so it
    // holds no guard of its own and reads nothing.
    for (const adjustment of adjustments) {
      try {
        // Atomic write path shared with the other stock routes:
        // log + product_locations upsert (quantity/version increment)
        // + Product.quantity mirror for location 1.
        const { log } = await applyStockDelta(tx, {
          userId: user.id,
          productId: adjustment.productId,
          locationId: adjustment.locationId,
          delta: adjustment.delta,
          logType: adjustment.logType,
          // Task 2 seam: the shared schema now accepts a per-item reasonCode;
          // persist it on the ledger row instead of silently dropping it.
          reasonCode: adjustment.reasonCode ?? null,
          // ER-C3: join every ledger row to this request's bulk-update event.
          batchId,
        });

        // applyStockDelta's log includes full relations (users incl.
        // passwordHash) — strip to scalars before exposing in the response.
        const { users: _u, products: _p, locations: _l, ...logScalars } = log;
        logs.push(logScalars);

        auditUpdates.push({
          productId: adjustment.productId,
          // The fallback is DEAD (fix-delta FDb-11): the pre-tx check above
          // guarantees every id is in the map. `??` not `||` (FDc-7): an
          // empty-string product name is a real name and must not be rewritten
          // as "Unknown Product" in an audit record.
          productName: productMap.get(adjustment.productId) ?? "Unknown Product",
          delta: adjustment.delta,
        });
      } catch (error) {
        // Preserve the typed conflict so apiHandler can map it to 409
        if (error instanceof OptimisticLockError) throw error;
        // Same reason, for the typed refusals: apiHandler maps an AppError to
        // its own code + status, and the message already names the product.
        if (error instanceof AppError) throw error;
        // And the TRANSIENT class (fix-delta FDc-1): a deadlock/budget loss
        // inside applyStockDelta — the loc-1 mirror is the lane's one OBSERVED
        // deadlock site — must reach apiHandler's 503 BUSY, not be destroyed
        // into a plain Error that reads as a generic 500.
        if (isTransientTxError(error)) {
          throw error;
        }
        throw new Error(
          `Product ${adjustment.productId}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    // Record the single bulk-update event INSIDE the same transaction as the
    // stock writes, so an unrecordable batch never commits.
    if (auditUpdates.length > 0) {
      await recordChange(tx, {
        actor: { userId: user.id },
        actionType: "INVENTORY_BULK_UPDATE",
        entityType: "INVENTORY",
        action: `Bulk updated inventory for ${auditUpdates.length} products`,
        details: { updates: auditUpdates, locationId: adjustments[0]?.locationId },
        affectedCount: auditUpdates.length,
        batchId,
      });
    }

    // Reconciliation lane R-A (spec REV-7 D1/D2, pack C1b.3): ONE attempt row
    // per batch, and only when the batch actually took stock OUT. The journal
    // offers no order context of any kind — no chip, no order id, no reference —
    // so the class is the constant none/no-order-context, recorded rather than
    // omitted so the report can tell "we asked and there was nothing to go on"
    // from "this batch is older than the lane". An all-positive batch writes no
    // attempt row even though the bulk-update event above still fires.
    const firstDeduction = logs.find((l) => l.delta < 0);
    if (firstDeduction) {
      await recordAttributionAttempt(tx, {
        outcome: "none",
        reason: "no-order-context",
        batchId,
        ledgerRowId: firstDeduction.id,
        source: "live-batch-adjust",
        actorUserId: user.id,
      });
    }

    return { logs, auditUpdates };
  }, STOCK_TX_OPTIONS);

  const response = NextResponse.json({
    success: true,
    logs: results.logs,
    count: results.logs.length,
  });
  return applyRateLimitHeaders(response, rateLimitHeaders);
});
