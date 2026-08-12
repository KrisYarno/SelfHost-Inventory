//
// Phase 0a / D2 — inbound review + overwrite-event dates.
//
// The counts-too-high symptom implicates INBOUND as much as outbound: all
// receiving is generic ADJUSTMENT today (STOCK_IN/COUNT are never written). This
// check ranks the largest positive-adjustment batches in a trailing window,
// names their actor/location/batch, and labels the mass-update operations for
// what they actually are — overwrite/count-event DATES, touched rows only.
//
// The label is deliberate and frozen: a mass update is NOT a baseline. It proves
// somebody set N rows to a value on a day. It proves nothing about the rows it
// did not touch, and nothing about whether a physical count happened at all.
//
const { query, queryChunkedIn, int, date, bool } = require("./lib/db");
const { figure, disclosure, table } = require("./lib/artifact");
const { splitUnitsByLogType } = require("./lib/rollups");

const check = "d2-inbound";
const title = "Inbound review + overwrite/count-event dates";
const purpose =
  "Surface the largest positive-adjustment batches in a trailing window with their actor, " +
  "location and batch id, so receiving can be reviewed by a human; and identify the " +
  "mass-update operations for what they are — dates on which rows were overwritten, " +
  "silent about untouched rows and about whether a physical count happened at all.";

/** FROZEN label (spec §D2 / G2-7). Never "baselines". */
const MASS_UPDATE_LABEL =
  "overwrite/count-event dates — touched rows only; physical-count coverage unknown";

/** Migration 20260710150000_inventory_logs_batch_id — batchId's DB arrival. */
const BATCH_ID_MIGRATION = "2026-07-10 (20260710150000_inventory_logs_batch_id)";

async function run(ctx) {
  const { prisma, opts } = ctx;
  const notes = [];
  const since = new Date(Date.now() - opts.windowDays * 86_400_000);
  const sinceIso = since.toISOString().slice(0, 19).replace("T", " ");

  // ---- per-batch ledger aggregate over the window -------------------------
  const batchRows = await query(
    prisma,
    `SELECT il.batchId,
            SUM(il.delta) AS netDelta,
            SUM(CASE WHEN il.delta > 0 THEN il.delta ELSE 0 END) AS positiveUnits,
            SUM(CASE WHEN il.delta < 0 THEN -il.delta ELSE 0 END) AS negativeUnits,
            COUNT(*) AS rowCount,
            COUNT(DISTINCT il.productId) AS productCount,
            COUNT(DISTINCT il.locationId) AS locationCount,
            MIN(il.changeTime) AS firstChangeTime,
            MAX(il.changeTime) AS lastChangeTime
       FROM inventory_logs il
      WHERE il.batchId IS NOT NULL AND il.changeTime >= ?
      GROUP BY il.batchId`,
    [sinceIso]
  );

  const batches = new Map();
  for (const r of batchRows) {
    batches.set(r.batchId, {
      batchId: r.batchId,
      netDelta: int(r.netDelta),
      positiveUnits: int(r.positiveUnits),
      negativeUnits: int(r.negativeUnits),
      rowCount: int(r.rowCount),
      productCount: int(r.productCount),
      locationCount: int(r.locationCount),
      firstChangeTime: date(r.firstChangeTime),
      lastChangeTime: date(r.lastChangeTime),
      logTypes: new Set(),
      reasonCodes: new Set(),
      locationIds: new Set(),
      actorUserIds: new Set(),
      auditActionTypes: new Set(),
      auditActorUserIds: new Set(),
      hasRowsShape: false,
      hasRowsOmitted: false,
      auditEventCount: 0,
      affectedCount: 0,
    });
  }

  const batchIds = Array.from(batches.keys());

  // ---- drill: logType / reasonCode / location / actor per batch -----------
  const drillRows = await queryChunkedIn(
    prisma,
    `SELECT il.batchId, il.logType, il.reasonCode, il.locationId, il.userId,
            COUNT(*) AS rowCount, SUM(il.delta) AS netDelta
       FROM inventory_logs il
      WHERE il.batchId IN (__IN__)
      GROUP BY il.batchId, il.logType, il.reasonCode, il.locationId, il.userId`,
    batchIds
  );
  for (const r of drillRows) {
    const b = batches.get(r.batchId);
    if (!b) continue;
    b.logTypes.add(r.logType);
    if (r.reasonCode) b.reasonCodes.add(r.reasonCode);
    if (r.locationId !== null && r.locationId !== undefined) b.locationIds.add(int(r.locationId));
    if (r.userId !== null && r.userId !== undefined) b.actorUserIds.add(int(r.userId));
  }

  // ---- the mass-update shape discriminator --------------------------------
  // audit_logs.details is read ONLY through JSON path PREDICATES here: whether
  // `$.rows` exists (the historical mass-update shape) and whether
  // `$.rowsOmitted` exists (the >500-row fallback). No value is projected.
  const auditRows = await queryChunkedIn(
    prisma,
    `SELECT a.id AS auditId, a.batchId, a.actionType, a.entityType, a.entityId,
            a.userId, a.actorKind, a.affectedCount, a.createdAt,
            JSON_CONTAINS_PATH(a.details, 'one', '$.rows') AS hasRowsShape,
            JSON_CONTAINS_PATH(a.details, 'one', '$.rowsOmitted') AS hasRowsOmitted
       FROM audit_logs a
      WHERE a.batchId IN (__IN__)`,
    batchIds
  );
  for (const r of auditRows) {
    const b = batches.get(r.batchId);
    if (!b) continue;
    b.auditEventCount += 1;
    b.auditActionTypes.add(r.actionType);
    if (r.userId !== null && r.userId !== undefined) b.auditActorUserIds.add(int(r.userId));
    b.affectedCount += int(r.affectedCount);
    if (bool(r.hasRowsShape)) b.hasRowsShape = true;
    if (bool(r.hasRowsOmitted)) b.hasRowsOmitted = true;
  }

  // FROZEN discriminator: INVENTORY_BULK_UPDATE + the `details.rows` shape,
  // MINUS batches carrying SALE ledger rows (deduct-simple writes the same
  // actionType and is disambiguated by row logType).
  let massUpdateBatches = 0;
  let rowsOmittedBatches = 0;
  for (const b of batches.values()) {
    const bulk = b.auditActionTypes.has("INVENTORY_BULK_UPDATE");
    const hasSale = b.logTypes.has("SALE");
    b.isMassUpdate = bulk && b.hasRowsShape && !hasSale;
    b.isMassUpdateRowsOmitted = bulk && !b.hasRowsShape && b.hasRowsOmitted && !hasSale;
    if (b.isMassUpdate) massUpdateBatches += 1;
    if (b.isMassUpdateRowsOmitted) rowsOmittedBatches += 1;
  }

  const toRow = (b) => ({
    batchId: b.batchId,
    firstChangeTime: b.firstChangeTime ? b.firstChangeTime.toISOString() : null,
    netDelta: b.netDelta,
    positiveUnits: b.positiveUnits,
    negativeUnits: b.negativeUnits,
    ledgerRows: b.rowCount,
    products: b.productCount,
    locationIds: Array.from(b.locationIds).sort((x, y) => x - y).join(",") || "null",
    actorUserIds: Array.from(b.actorUserIds).sort((x, y) => x - y).join(",") || "null",
    logTypes: Array.from(b.logTypes).sort().join(",") || "none",
    reasonCodes: Array.from(b.reasonCodes).sort().join(",") || "none",
    auditActionTypes: Array.from(b.auditActionTypes).sort().join(",") || "none",
    classification: b.isMassUpdate
      ? MASS_UPDATE_LABEL
      : b.isMassUpdateRowsOmitted
        ? `${MASS_UPDATE_LABEL} [rows omitted from audit details — see disclosure]`
        : "not identified as a mass-update operation",
  });

  const all = Array.from(batches.values());
  const topPositive = all
    .filter((b) => b.netDelta > 0)
    .sort((a, b) => b.netDelta - a.netDelta)
    .slice(0, opts.top)
    .map(toRow);
  const topNegativeMass = all
    .filter((b) => b.netDelta < 0 && (b.isMassUpdate || b.isMassUpdateRowsOmitted))
    .sort((a, b) => a.netDelta - b.netDelta)
    .slice(0, opts.top)
    .map(toRow);
  const massUpdateDates = all
    .filter((b) => b.isMassUpdate || b.isMassUpdateRowsOmitted)
    .sort((a, b) => (a.firstChangeTime?.getTime() ?? 0) - (b.firstChangeTime?.getTime() ?? 0))
    .map((b) => ({
      dayKey: b.firstChangeTime ? b.firstChangeTime.toISOString().slice(0, 10) : null,
      batchId: b.batchId,
      touchedProducts: b.productCount,
      ledgerRows: b.rowCount,
      netDelta: b.netDelta,
      positiveUnits: b.positiveUnits,
      negativeUnits: b.negativeUnits,
      actorUserIds: Array.from(b.actorUserIds).sort((x, y) => x - y).join(",") || "null",
      locationIds: Array.from(b.locationIds).sort((x, y) => x - y).join(",") || "null",
      auditDetailsShape: b.hasRowsShape ? "rows" : b.hasRowsOmitted ? "rowsOmitted" : "neither",
    }));

  // ---- coverage disclosures ------------------------------------------------
  const noBatchRows = await query(
    prisma,
    `SELECT COUNT(*) AS rowCount, COALESCE(SUM(il.delta), 0) AS netDelta,
            MIN(il.changeTime) AS firstChangeTime, MAX(il.changeTime) AS lastChangeTime
       FROM inventory_logs il
      WHERE il.batchId IS NULL AND il.changeTime >= ?`,
    [sinceIso]
  );
  const unbatched = {
    rowCount: int(noBatchRows[0]?.rowCount),
    netDelta: int(noBatchRows[0]?.netDelta),
    firstChangeTime: date(noBatchRows[0]?.firstChangeTime),
    lastChangeTime: date(noBatchRows[0]?.lastChangeTime),
  };

  // P0S-5: the window scope figures are split BY LOGTYPE (the D4 census shape,
  // reused). A TRANSFER writes a negative leg and a positive leg for the same
  // physical units, so a pool-level positive/negative total counts every
  // transfer as both an inbound and an outbound event.
  const windowByLogType = await query(
    prisma,
    `SELECT il.logType, COUNT(*) AS rowCount,
            COALESCE(SUM(CASE WHEN il.delta > 0 THEN il.delta ELSE 0 END), 0) AS positiveUnits,
            COALESCE(SUM(CASE WHEN il.delta < 0 THEN -il.delta ELSE 0 END), 0) AS negativeUnits
       FROM inventory_logs il
      WHERE il.changeTime >= ?
      GROUP BY il.logType`,
    [sinceIso]
  );
  const windowSplit = splitUnitsByLogType(
    windowByLogType.map((r) => ({
      logType: r.logType,
      rowCount: int(r.rowCount),
      positiveUnits: int(r.positiveUnits),
      negativeUnits: int(r.negativeUnits),
    }))
  );
  const transferUnits = windowSplit.byLogType.TRANSFER ?? null;
  const TRANSFER_CONFOUND = disclosure(
    "transfer_legs_in_this_total",
    transferUnits ? transferUnits.positiveUnits : null,
    transferUnits
      ? "TRANSFER units inside the pool-level total. A transfer writes a negative leg " +
        `and a positive leg for the SAME physical units (${transferUnits.negativeUnits} ` +
        `out, ${transferUnits.positiveUnits} in), so it inflates both directions ` +
        "without any stock entering or leaving the business. Use the byLogType split " +
        "below, not this total, to reason about real inbound/outbound."
      : "No TRANSFER rows in the window, so this total carries no transfer legs. null " +
        "= the logType is absent from the window (unknown/not applicable, not 0 units)."
  );

  const coverageDisclosures = [
    disclosure(
      "unbatched_ledger_rows_in_window",
      unbatched.rowCount,
      `inventory_logs rows in the window with NO batchId (net ${unbatched.netDelta} units, ` +
        `${unbatched.firstChangeTime ? unbatched.firstChangeTime.toISOString() : "n/a"} .. ` +
        `${unbatched.lastChangeTime ? unbatched.lastChangeTime.toISOString() : "n/a"}). ` +
        `They cannot be grouped into a batch at all. batchId only exists from ${BATCH_ID_MIGRATION}.`
    ),
    disclosure(
      "mass_update_batches_with_rows_omitted",
      rowsOmittedBatches,
      "Mass-update operations of MORE than 500 rows: the route replaces details.rows " +
        "with rowCount + rowsOmitted, so the frozen `details.rows` discriminator cannot " +
        "see them. They are identified here by the rowsOmitted shape and labelled " +
        "separately so the frozen rule stays visible."
    ),
    disclosure(
      "batch_id_floor",
      BATCH_ID_MIGRATION,
      "The mass-update identification is POST-PHASE-C ONLY: before batchId existed there " +
        "is no batch to identify, so absence of a labelled operation before this date is " +
        "not evidence that none happened."
    ),
  ];

  const sections = {
    scope: {
      windowDays: figure(
        opts.windowDays,
        "Trailing window in days (--window-days, default 90). Ranking is over batches " +
          "whose ledger rows fall inside it."
      ),
      windowStart: figure(since.toISOString(), "Inclusive lower bound on inventory_logs.changeTime."),
      batchesInWindow: figure(
        batches.size,
        "Distinct inventory_logs.batchId values with at least one row in the window.",
        coverageDisclosures
      ),
      ledgerRowsInWindow: figure(
        windowSplit.totals.rowCount,
        "All inventory_logs rows in the window, batched or not."
      ),
      positiveUnitsInWindow: figure(
        windowSplit.totals.positiveUnits,
        "SUM(delta) over positive-delta rows in the window — every unit that entered a " +
          "stock POOL by any path. NOT 'units received': transfer legs and correction " +
          "restores are in here too. See unitsByLogType.",
        [TRANSFER_CONFOUND]
      ),
      negativeUnitsInWindow: figure(
        windowSplit.totals.negativeUnits,
        "SUM(-delta) over negative-delta rows in the window — every unit that left a " +
          "stock POOL by any path, transfer legs included. See unitsByLogType.",
        [TRANSFER_CONFOUND]
      ),
      unitsByLogType: table(
        windowSplit.rows,
        "The window's units SPLIT BY LOGTYPE (same shape as D4's census). This is the " +
          "reading to reason from: a TRANSFER's two legs are one physical movement " +
          "inside the business, an ADJUSTMENT is generic receiving-or-anything, and a " +
          "SALE is the order-linked path. The pool-level totals above sum this table.",
        {
          rowCount: "inventory_logs rows of that logType in the window.",
          positiveUnits: "SUM(delta) over that logType's positive rows.",
          negativeUnits: "SUM(-delta) over that logType's negative rows.",
        },
        [TRANSFER_CONFOUND]
      ),
    },

    topPositiveBatches: table(
      topPositive,
      `Top ${opts.top} batches by NET positive units in the window (ranking DEFINED: ` +
        "top-N by absolute units, net of any negative rows in the same batch). This is " +
        "the inbound review queue.",
      {
        netDelta: "SUM(delta) across the batch's ledger rows.",
        positiveUnits: "SUM(delta) over the batch's positive rows only.",
        negativeUnits: "SUM(-delta) over the batch's negative rows only.",
        actorUserIds: "inventory_logs.userId values. IDs only — names/emails are never selected.",
        locationIds: "Distinct inventory_logs.locationId; 'null' means location-less rows.",
        classification: `Either the frozen label "${MASS_UPDATE_LABEL}" or a statement that ` +
          "the batch was not identified as a mass update.",
      },
      coverageDisclosures
    ),

    negativeCorrectionMassBatches: table(
      topNegativeMass,
      `Top ${opts.top} mass-update batches with NEGATIVE net units. A count that LOWERS ` +
        "stock is still a count event, so these belong in the same review as the inbound " +
        "ones.",
      {
        classification: `The frozen label: "${MASS_UPDATE_LABEL}".`,
      },
      coverageDisclosures
    ),

    massUpdateOperationDates: table(
      massUpdateDates,
      `${MASS_UPDATE_LABEL}. Identified by the FROZEN discriminator: actionType ` +
        "INVENTORY_BULK_UPDATE + the historical `details.rows` audit shape, MINUS batches " +
        "carrying SALE ledger rows (deduct-simple writes the same actionType and is " +
        "disambiguated by row logType). These are DATES on which rows were overwritten — " +
        "NOT baselines, NOT proof a physical count occurred, and silent about every row " +
        "the operation did not touch.",
      {
        touchedProducts: "COUNT(DISTINCT productId) in the batch — the coverage of the operation.",
        auditDetailsShape:
          "'rows' = the frozen discriminator matched; 'rowsOmitted' = a >500-row operation " +
          "the frozen discriminator cannot see; 'neither' = shape absent.",
      },
      coverageDisclosures
    ),

    identification: {
      massUpdateBatches: figure(
        massUpdateBatches,
        `Batches matching the FROZEN discriminator. Labelled: "${MASS_UPDATE_LABEL}".`,
        coverageDisclosures
      ),
    },
  };

  notes.push(
    "Mass update is the deliberate exception to single-transaction writes: it commits in " +
      "batches of 50 and records ONE post-hoc summary event via recordIngestion, reusing " +
      "the operation-wide batchId. It also writes NEITHER the products.quantity mirror NOR " +
      "a version increment (see D4's mirror-gap check)."
  );
  notes.push(
    "Every ledger row written by mass-update carries logType ADJUSTMENT at this repo tip. " +
      "Phase 0b-1 changes that to COUNT + reasonCode COUNT; re-running D2 after that deploy " +
      "will show the new operations self-labelling."
  );

  return { sections, notes, meta: { batches: batches.size, massUpdateBatches } };
}

module.exports = { check, title, purpose, run, MASS_UPDATE_LABEL };
