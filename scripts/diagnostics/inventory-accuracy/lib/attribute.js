//
// Phase 0a / D1 — the PURE attribution munging: which ledger batchId belongs to
// which order, and what happens when the evidence contradicts itself.
//
// FROZEN RULE (P0S-4): a batchId claimed by more than one order is dropped from
// BOTH attributions and disclosed. Never first-wins, never last-wins. The
// alternative silently attributes another order's ledger movement to whichever
// audit row the database happened to return first — a wrong number the artifact
// would present with the same confidence as a right one.
//
// No DB, no I/O: every branch here is pinned by
// __tests__/unit/scripts/diagnostics/inventory-accuracy-classify.test.js.
//

/**
 * Group claims by batchId and drop every batch more than one order claims.
 * Shared by both evidence classes so the two cannot drift apart.
 *
 * @param {Array<{batchId: string|null, orderId: string}>} claims
 * @returns {{batchToOrder: Map<string, string>,
 *            conflicts: Array<{batchId: string, orderIds: string[]}>,
 *            conflictedBatchIds: Set<string>}}
 */
function resolveClaims(claims) {
  const claimants = new Map();
  const order = [];
  for (const c of claims) {
    if (!claimants.has(c.batchId)) {
      claimants.set(c.batchId, new Set());
      order.push(c.batchId);
    }
    claimants.get(c.batchId).add(c.orderId);
  }

  const batchToOrder = new Map();
  const conflicts = [];
  const conflictedBatchIds = new Set();
  for (const batchId of order) {
    const orderIds = Array.from(claimants.get(batchId)).sort();
    if (orderIds.length > 1) {
      conflictedBatchIds.add(batchId);
      conflicts.push({ batchId, orderIds });
      continue;
    }
    batchToOrder.set(batchId, orderIds[0]);
  }
  return { batchToOrder, conflicts, conflictedBatchIds };
}

/**
 * Evidence class (b): EXTERNAL_ORDER_*FULFILLMENT audit events carry the order
 * as entityId and the batchId the ledger rows were written under.
 *
 * @param {Array<{auditId?: number, batchId: string|null, orderId: string}>} events
 * @param {(orderId: string) => boolean} isKnownOrder current external_orders ids
 */
function buildClassBAttribution(events, isKnownOrder) {
  const claims = [];
  let eventsWithoutBatch = 0;
  let eventsWithUnknownOrder = 0;
  for (const e of events) {
    if (!e.batchId) {
      eventsWithoutBatch += 1;
      continue;
    }
    if (!isKnownOrder(e.orderId)) {
      eventsWithUnknownOrder += 1;
      continue;
    }
    claims.push({ batchId: e.batchId, orderId: e.orderId });
  }
  return { ...resolveClaims(claims), eventsWithoutBatch, eventsWithUnknownOrder };
}

/**
 * Evidence class (c): matched order references. A batch already attributed by
 * the STRONGER class (b) is skipped — never double-counted, never overridden —
 * and the drop-both conflict rule applies within this class too.
 *
 * @param {Array<{batchId: string|null, orderId: string}>} matches
 * @param {{has: (batchId: string) => boolean}} classBBatchIds Set or Map of class (b) batches
 */
function selectClassCBatches(matches, classBBatchIds) {
  const claims = [];
  let skippedAsClassB = 0;
  let matchesWithoutBatch = 0;
  for (const m of matches) {
    if (!m.batchId) {
      matchesWithoutBatch += 1;
      continue;
    }
    if (classBBatchIds && classBBatchIds.has(m.batchId)) {
      skippedAsClassB += 1;
      continue;
    }
    claims.push({ batchId: m.batchId, orderId: m.orderId });
  }
  return { ...resolveClaims(claims), skippedAsClassB, matchesWithoutBatch };
}

module.exports = { resolveClaims, buildClassBAttribution, selectClassCBatches };
