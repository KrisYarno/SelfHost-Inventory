//
// Phase 0a / D3 — ledger-vs-snapshot walk.
//
// Per (product, location, day): snapshot[d] - snapshot[d-1] vs SUM(ledger delta)
// that day. Snapshot coverage gaps are DISCLOSED, never interpolated.
//
// READ THE INTERPRETATION DISCLOSURE BEFORE USING THIS PANEL. The spec frames
// D3 as the "something else" detector — stock changing without a ledger row. At
// this repo tip product_stock_snapshots is NOT an independent observation of
// stock: lib/analytics/rebuild-snapshots.ts RECONSTRUCTS every level backward
// from the CURRENT product_locations.quantity using the ledger itself
// (level(D) = current - SUM(delta where changeTime >= nextDayStart(D))). A
// divergence therefore cannot prove an out-of-band stock write; it proves the
// snapshot rows and the ledger disagree, which happens when the ledger changed
// after the rebuild ran, when a pair was flagged/floored, or when coverage is
// stale. That is still worth finding — it is just not the claim the panel's
// name makes. Reported, not silently reinterpreted.
//
const { query, int, date } = require("./lib/db");
const { figure, disclosure, table } = require("./lib/artifact");
const { walkSnapshotSeries } = require("./lib/snapshot-walk");

const check = "d3-snapshot-walk";
const title = "Ledger-vs-snapshot walk";
const purpose =
  "Per (product, location, day), compare the change in the stored snapshot level against " +
  "the ledger's own movement that day, and report every cell where they disagree. " +
  "Snapshot coverage gaps are disclosed, never interpolated. See the interpretation " +
  "disclosure: snapshots at this repo tip are ledger-DERIVED, so a divergence is evidence " +
  "about the rebuild rather than proof of an out-of-band stock write.";

const SNAPSHOT_DERIVATION_DISCLOSURE = disclosure(
  "snapshots_are_ledger_derived",
  "lib/analytics/rebuild-snapshots.ts",
  "product_stock_snapshots levels are RECONSTRUCTED from the ledger backward from " +
    "the current product_locations.quantity — they are not independent stock " +
    "observations. A divergence is evidence about the rebuild (staleness, backdated " +
    "ledger rows, flagged or floored pairs), NOT proof of an out-of-band write. The " +
    "spec's 'something else' framing does not survive this fact; it is reported here " +
    "rather than reinterpreted."
);

async function run(ctx) {
  const { prisma, opts } = ctx;
  const notes = [];
  const fromDayKey = new Date(Date.now() - opts.snapshotWindowDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const countRows = await query(
    prisma,
    "SELECT COUNT(*) AS n FROM product_stock_snapshots WHERE dayKey >= ?",
    [fromDayKey]
  );
  const snapshotRowCount = int(countRows[0]?.n);
  if (snapshotRowCount > opts.snapshotMaxRows) {
    throw new Error(
      `D3 would load ${snapshotRowCount} snapshot rows (cap ${opts.snapshotMaxRows}). ` +
        "Narrow --snapshot-window-days or raise --snapshot-max-rows deliberately — " +
        "this check will not silently truncate its own input."
    );
  }

  const snapshotRows = await query(
    prisma,
    `SELECT s.productId, s.locationId, s.dayKey, s.quantity
       FROM product_stock_snapshots s
      WHERE s.dayKey >= ?
      ORDER BY s.productId, s.locationId, s.dayKey`,
    [fromDayKey]
  );

  const ledgerRows = await query(
    prisma,
    `SELECT il.productId, il.locationId,
            DATE_FORMAT(il.changeTime, '%Y-%m-%d') AS dayKey,
            SUM(il.delta) AS delta, COUNT(*) AS rowCount
       FROM inventory_logs il
      WHERE il.locationId IS NOT NULL AND il.changeTime >= ?
      GROUP BY il.productId, il.locationId, DATE_FORMAT(il.changeTime, '%Y-%m-%d')`,
    [`${fromDayKey} 00:00:00`]
  );

  const ledgerByPair = new Map();
  for (const r of ledgerRows) {
    const key = `${int(r.productId)}|${int(r.locationId)}`;
    if (!ledgerByPair.has(key)) ledgerByPair.set(key, {});
    ledgerByPair.get(key)[r.dayKey] = { delta: int(r.delta), rowCount: int(r.rowCount) };
  }

  const seriesByPair = new Map();
  for (const r of snapshotRows) {
    const key = `${int(r.productId)}|${int(r.locationId)}`;
    if (!seriesByPair.has(key)) seriesByPair.set(key, []);
    seriesByPair.get(key).push({ dayKey: r.dayKey, quantity: int(r.quantity) });
  }

  let comparedDays = 0;
  let coverageGapCount = 0;
  let coverageMissingDays = 0;
  const divergences = [];
  for (const [key, series] of seriesByPair.entries()) {
    const [productId, locationId] = key.split("|").map(Number);
    const out = walkSnapshotSeries({
      productId,
      locationId,
      snapshots: series,
      ledgerByDay: ledgerByPair.get(key) || {},
    });
    comparedDays += out.comparedDays;
    coverageGapCount += out.coverageGaps.length;
    for (const g of out.coverageGaps) coverageMissingDays += g.missingDays;
    divergences.push(...out.divergences);
  }

  // Pairs that move in the ledger but have NO snapshot rows at all: invisible to
  // the walk, so they are disclosed rather than assumed clean.
  let pairsWithLedgerNoSnapshots = 0;
  for (const key of ledgerByPair.keys()) {
    if (!seriesByPair.has(key)) pairsWithLedgerNoSnapshots += 1;
  }

  const nullLocationRows = await query(
    prisma,
    `SELECT COUNT(*) AS rowCount, COALESCE(SUM(il.delta), 0) AS netDelta,
            MAX(il.changeTime) AS lastChangeTime
       FROM inventory_logs il
      WHERE il.locationId IS NULL AND il.delta <> 0`
  );

  const snapshotFrontier = await query(
    prisma,
    "SELECT MAX(dayKey) AS maxDayKey, MIN(dayKey) AS minDayKey FROM product_stock_snapshots"
  );

  const coverageDisclosures = [
    SNAPSHOT_DERIVATION_DISCLOSURE,
    disclosure(
      "snapshot_coverage_gaps",
      coverageGapCount,
      `Non-adjacent snapshot day pairs inside the window, spanning ${coverageMissingDays} ` +
        "missing days in total. Those spans are NOT compared and NOT interpolated."
    ),
    disclosure(
      "pairs_with_ledger_but_no_snapshots",
      pairsWithLedgerNoSnapshots,
      "(product, location) pairs with ledger movement in the window but no snapshot rows " +
        "at all — invisible to this walk. Snapshot rows exist only for pairs present in " +
        "product_locations at rebuild time, and the rebuild skips pairs whose " +
        "reconstruction went negative."
    ),
    disclosure(
      "null_location_ledger_rows",
      int(nullLocationRows[0]?.rowCount),
      `Legacy ledger rows with locationId NULL and a nonzero delta (net ` +
        `${int(nullLocationRows[0]?.netDelta)} units, last at ` +
        `${date(nullLocationRows[0]?.lastChangeTime)?.toISOString() ?? "n/a"}). They cannot be ` +
        "attributed to a per-location grain, and the snapshot rebuild floors its own " +
        "backfill just after the last one."
    ),
    disclosure(
      "snapshot_frontier",
      `${snapshotFrontier[0]?.minDayKey ?? "none"} .. ${snapshotFrontier[0]?.maxDayKey ?? "none"}`,
      "The snapshot table's own dayKey range. Days after the frontier have no snapshot " +
        "row, so recent ledger movement is unwalkable until the next rebuild."
    ),
  ];

  const ranked = divergences
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference))
    .slice(0, opts.top);

  const sections = {
    scope: {
      windowDays: figure(
        opts.snapshotWindowDays,
        "Trailing window in days (--snapshot-window-days, default 90)."
      ),
      fromDayKey: figure(fromDayKey, "Inclusive lower bound on product_stock_snapshots.dayKey."),
      snapshotRows: figure(
        snapshotRowCount,
        "product_stock_snapshots rows loaded for the window.",
        coverageDisclosures
      ),
      pairsWalked: figure(
        seriesByPair.size,
        "(product, location) pairs with at least one snapshot row in the window."
      ),
      comparedDays: figure(
        comparedDays,
        "Calendar-ADJACENT snapshot day pairs actually compared. Non-adjacent pairs are " +
          "coverage gaps and are skipped.",
        coverageDisclosures
      ),
    },

    divergence: {
      divergentDays: figure(
        divergences.length,
        "Compared (product, location, day) cells where snapshot[d] - snapshot[d-1] != " +
          "SUM(ledger delta on day d).",
        coverageDisclosures
      ),
      divergentUnitsAbsolute: figure(
        divergences.reduce((s, d) => s + Math.abs(d.difference), 0),
        "SUM of |snapshotDelta - ledgerDelta| over divergent cells. Absolute so opposing " +
          "divergences cannot cancel into a comforting zero.",
        coverageDisclosures
      ),
      top: table(
        ranked,
        `The ${opts.top} largest divergences by absolute difference.`,
        {
          snapshotDelta: "snapshot[d].quantity - snapshot[d-1].quantity.",
          ledgerDelta: "SUM(inventory_logs.delta) for that (product, location) on day d, UTC.",
          difference: "snapshotDelta - ledgerDelta.",
          ledgerRowCount: "How many ledger rows that day — 0 means the ledger says nothing happened.",
        },
        coverageDisclosures
      ),
    },
  };

  notes.push(
    "Day bucketing is UTC on both sides: snapshot dayKeys are UTC calendar days " +
      "(lib/analytics/dates.ts) and the ledger side uses DATE_FORMAT(changeTime, " +
      "'%Y-%m-%d') on values Prisma stores in UTC."
  );

  return { sections, notes, meta: { divergentDays: divergences.length } };
}

module.exports = { check, title, purpose, run };
