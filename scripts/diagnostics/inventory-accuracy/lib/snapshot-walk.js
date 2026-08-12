//
// Phase 0a / D3 — the PURE snapshot walk.
//
// Per (product, location, day): snapshot[d] - snapshot[d-1] vs SUM(ledger
// delta) that day. Only CALENDAR-ADJACENT snapshot pairs are compared; a gap in
// snapshot coverage is DISCLOSED, never interpolated (interpolating would
// invent a level nobody recorded, which is exactly the thing this lane exists
// to stop doing).
//
const { daysBetween } = require("./date-buckets");

/**
 * @param {{productId: number, locationId: number,
 *          snapshots: Array<{dayKey: string, quantity: number}>,
 *          ledgerByDay: Record<string, {delta: number, rowCount: number}>}} input
 */
function walkSnapshotSeries({ productId, locationId, snapshots, ledgerByDay }) {
  const series = [...(snapshots || [])].sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));
  const divergences = [];
  const coverageGaps = [];
  let comparedDays = 0;

  for (let i = 1; i < series.length; i += 1) {
    const prev = series[i - 1];
    const cur = series[i];
    const span = daysBetween(prev.dayKey, cur.dayKey);
    if (span !== 1) {
      coverageGaps.push({
        fromDayKey: prev.dayKey,
        toDayKey: cur.dayKey,
        missingDays: Math.max(0, span - 1),
      });
      continue;
    }
    comparedDays += 1;
    const snapshotDelta = cur.quantity - prev.quantity;
    const day = (ledgerByDay || {})[cur.dayKey] || { delta: 0, rowCount: 0 };
    const ledgerDelta = Number(day.delta) || 0;
    if (snapshotDelta !== ledgerDelta) {
      divergences.push({
        productId,
        locationId,
        dayKey: cur.dayKey,
        previousDayKey: prev.dayKey,
        snapshotDelta,
        ledgerDelta,
        difference: snapshotDelta - ledgerDelta,
        ledgerRowCount: Number(day.rowCount) || 0,
        openingQuantity: prev.quantity,
        closingQuantity: cur.quantity,
      });
    }
  }

  return { productId, locationId, comparedDays, divergences, coverageGaps, snapshotDays: series.length };
}

module.exports = { walkSnapshotSeries };
