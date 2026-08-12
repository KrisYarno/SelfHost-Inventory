//
// Phase 0a — the PURE rollups behind three supplemental panels. No DB, no I/O;
// every branch is pinned by
// __tests__/unit/scripts/diagnostics/inventory-accuracy-classify.test.js.
//
//  - rollupLineGrain (P0S-2)        — observed units vs the app's own
//                                     fulfilledQty, per (order, product), with a
//                                     monthly time shape. NO ledger join, so it
//                                     covers the FULL history and is the only
//                                     panel that can date pre-July drift.
//  - splitUnitsByLogType (P0S-5)    — D2's window scope figures split by
//                                     logType so TRANSFER legs stop inflating
//                                     pool-level inbound/outbound.
//  - summarizeUnattributedPool      — outbound ledger units in the post-floor
//    (P0S-3)                          window that NO evidence class reached.
//
// House rule throughout: differences are NON-CANCELLING (an under and an over
// elsewhere never net each other out), mirroring lib/classify.js.
//

const num = (v) => Number(v) || 0;

/**
 * Roll up per-(order, product) line-grain pairs into totals plus a monthly
 * series. `month` is a 'YYYY-MM' UTC key (lib/date-buckets.monthKey) so the
 * buckets match the house convention.
 *
 * @param {Array<{orderId: string, month: string, productId: number,
 *                lineCount: number, orderedUnits: number,
 *                appFulfilledUnits: number, observedUnits: number}>} pairs
 */
function rollupLineGrain(pairs) {
  const emptyBucket = (month) => ({
    month,
    pairs: 0,
    orders: 0,
    lineCount: 0,
    orderedUnits: 0,
    appFulfilledUnits: 0,
    observedUnits: 0,
    unitsObservedNotAppFulfilled: 0,
    unitsAppFulfilledNotObserved: 0,
    pairsWithDrift: 0,
  });

  const buckets = new Map();
  const ordersByMonth = new Map();
  const allOrders = new Set();
  const totals = emptyBucket(null);

  for (const p of pairs) {
    const observed = num(p.observedUnits);
    const fulfilled = num(p.appFulfilledUnits);
    const observedNotFulfilled = Math.max(0, observed - fulfilled);
    const fulfilledNotObserved = Math.max(0, fulfilled - observed);

    const month = p.month ?? null;
    if (!buckets.has(month)) {
      buckets.set(month, emptyBucket(month));
      ordersByMonth.set(month, new Set());
    }
    const b = buckets.get(month);
    ordersByMonth.get(month).add(p.orderId);
    allOrders.add(p.orderId);

    for (const t of [b, totals]) {
      t.pairs += 1;
      t.lineCount += num(p.lineCount);
      t.orderedUnits += num(p.orderedUnits);
      t.appFulfilledUnits += fulfilled;
      t.observedUnits += observed;
      t.unitsObservedNotAppFulfilled += observedNotFulfilled;
      t.unitsAppFulfilledNotObserved += fulfilledNotObserved;
      if (observedNotFulfilled > 0 || fulfilledNotObserved > 0) t.pairsWithDrift += 1;
    }
  }

  totals.orders = allOrders.size;
  const byMonth = Array.from(buckets.values())
    .map((b) => ({ ...b, orders: ordersByMonth.get(b.month).size }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

  delete totals.month;
  return { totals, byMonth };
}

/**
 * Split census-shaped rows by logType (the D4 census shape, reused) and carry
 * the pool-level totals alongside — the totals stay available, they just stop
 * being the ONLY reading.
 *
 * @param {Array<{logType: string, rowCount: number, positiveUnits: number,
 *                negativeUnits: number}>} rows
 */
function splitUnitsByLogType(rows) {
  const byLogType = {};
  const totals = { rowCount: 0, positiveUnits: 0, negativeUnits: 0 };
  for (const r of rows) {
    if (!byLogType[r.logType]) {
      byLogType[r.logType] = {
        logType: r.logType,
        rowCount: 0,
        positiveUnits: 0,
        negativeUnits: 0,
      };
    }
    const b = byLogType[r.logType];
    b.rowCount += num(r.rowCount);
    b.positiveUnits += num(r.positiveUnits);
    b.negativeUnits += num(r.negativeUnits);
    totals.rowCount += num(r.rowCount);
    totals.positiveUnits += num(r.positiveUnits);
    totals.negativeUnits += num(r.negativeUnits);
  }
  const sorted = Object.values(byLogType).sort((a, b) => a.logType.localeCompare(b.logType));
  return { rows: sorted, byLogType, totals };
}

/**
 * Outbound units NO evidence class reached: the per-logType total minus the
 * portion whose batchId was attributed to an order.
 *
 * A logType with no negative rows in the window is ABSENT from the result — an
 * absent logType is unknown/not-applicable, never a zero.
 *
 * @param {Array<{logType: string, rowCount: number, units: number,
 *                rowsWithoutBatch?: number, unitsWithoutBatch?: number}>} totalRows
 * @param {Array<{logType: string, rowCount: number, units: number}>} attributedRows
 */
function summarizeUnattributedPool(totalRows, attributedRows) {
  const byLogType = {};
  for (const r of totalRows) {
    byLogType[r.logType] = {
      logType: r.logType,
      rowCount: num(r.rowCount),
      units: num(r.units),
      rowsWithoutBatch: num(r.rowsWithoutBatch),
      unitsWithoutBatch: num(r.unitsWithoutBatch),
      attributedRowCount: 0,
      attributedUnits: 0,
      unattributedRowCount: 0,
      unattributedUnits: 0,
    };
  }
  for (const r of attributedRows) {
    // An attributed logType absent from the totals would mean the two queries
    // disagree; carry it rather than dropping it silently.
    if (!byLogType[r.logType]) {
      byLogType[r.logType] = {
        logType: r.logType,
        rowCount: 0,
        units: 0,
        rowsWithoutBatch: 0,
        unitsWithoutBatch: 0,
        attributedRowCount: 0,
        attributedUnits: 0,
        unattributedRowCount: 0,
        unattributedUnits: 0,
      };
    }
    byLogType[r.logType].attributedRowCount += num(r.rowCount);
    byLogType[r.logType].attributedUnits += num(r.units);
  }

  const totals = {
    rowCount: 0,
    units: 0,
    attributedRowCount: 0,
    attributedUnits: 0,
    unattributedRowCount: 0,
    unattributedUnits: 0,
    rowsWithoutBatch: 0,
    unitsWithoutBatch: 0,
  };
  for (const b of Object.values(byLogType)) {
    b.unattributedRowCount = b.rowCount - b.attributedRowCount;
    b.unattributedUnits = b.units - b.attributedUnits;
    for (const k of Object.keys(totals)) totals[k] += b[k];
  }

  const rows = Object.values(byLogType).sort((a, b) => a.logType.localeCompare(b.logType));
  return { rows, byLogType, totals };
}

module.exports = { rollupLineGrain, splitUnitsByLogType, summarizeUnattributedPool };
