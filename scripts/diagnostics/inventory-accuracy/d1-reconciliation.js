//
// Phase 0a / D1 — unit-grain order-vs-ledger reconciliation (the centerpiece).
//
// Per (order, product): observed mapped units (fulfillment_observations, already
// bundle-expanded at write time) vs NET linked ledger movement, classified
// full | partial | none | over | unobservable WITH unit differences — never a
// boolean "attributed".
//
// Evidence classes are frozen in lib/classify.js. Class (a) is full-lane only
// and is emitted here as a structurally-empty slot with a named reason.
//
const { query, queryChunkedIn, int, date, bool } = require("./lib/db");
const { figure, emptySlot, disclosure, table } = require("./lib/artifact");
const {
  EVIDENCE_CLASS,
  ORDER_STATUS,
  DEFINITIONS,
  deriveFloors,
  earliestApplicableFloor,
  classifyOrder,
  matchHeuristicReferences,
} = require("./lib/classify");
const { buildClassBAttribution, selectClassCBatches } = require("./lib/attribute");
const { rollupLineGrain, summarizeUnattributedPool } = require("./lib/rollups");
const { monthKey } = require("./lib/date-buckets");

const FULFILLMENT_ACTION_TYPES = [
  "EXTERNAL_ORDER_FULFILLMENT",
  "EXTERNAL_ORDER_PARTIAL_FULFILLMENT",
  "EXTERNAL_ORDER_UNFULFILLMENT",
];

const check = "d1-reconciliation";
const title = "Unit-grain order-vs-ledger reconciliation";
const purpose =
  "For every external order, compare the units Woo says went out on a completed order " +
  "against the NET units the ledger says were removed for that order, and classify the " +
  "difference. Orders that could not have produced evidence are excluded from gap totals " +
  "and disclosed with a named reason; unmapped lines are counted as their own leak " +
  "category; ambiguous reference matches are never resolved in either direction.";

async function scalarDate(prisma, sql) {
  const rows = await query(prisma, sql);
  return rows.length > 0 ? date(rows[0].v) : null;
}

async function run(ctx) {
  const { prisma, opts } = ctx;
  const notes = [];

  // ---- structural facts behind the observability floors --------------------
  const earliestStockedOutAt = await scalarDate(
    prisma,
    "SELECT MIN(stockedOutAt) AS v FROM external_orders WHERE stockedOutAt IS NOT NULL"
  );
  const earliestLedgerBatchAt = await scalarDate(
    prisma,
    "SELECT MIN(changeTime) AS v FROM inventory_logs WHERE batchId IS NOT NULL"
  );
  const earliestFulfillmentAuditAt = await scalarDate(
    prisma,
    `SELECT MIN(createdAt) AS v FROM audit_logs
      WHERE entityType = 'ORDER'
        AND actionType IN ('${FULFILLMENT_ACTION_TYPES.join("','")}')`
  );
  const earliestPersistedOrderReferenceAt = await scalarDate(
    prisma,
    `SELECT MIN(createdAt) AS v FROM audit_logs
      WHERE JSON_TYPE(JSON_EXTRACT(details, '$.orderReference')) = 'STRING'`
  );

  const floors = deriveFloors(
    {
      earliestStockedOutAt,
      earliestLedgerBatchAt,
      earliestFulfillmentAuditAt,
      earliestPersistedOrderReferenceAt,
    },
    { classBFloorMode: opts.classBFloorMode }
  );

  // ---- orders (ids, dates, status/enum fields, quantities ONLY) ------------
  const orderRows = await query(
    prisma,
    `SELECT eo.id AS orderId, eo.companyId, eo.integrationId, eo.orderNumber,
            eo.internalStatus, eo.stockedOut, eo.stockedOutAt,
            eo.externalCreatedAt, eo.createdAt
       FROM external_orders eo`
  );
  const orders = new Map();
  for (const r of orderRows) {
    const anchorAt = date(r.externalCreatedAt) ?? date(r.createdAt);
    orders.set(r.orderId, {
      orderId: r.orderId,
      companyId: r.companyId,
      integrationId: r.integrationId,
      orderNumber: r.orderNumber,
      internalStatus: r.internalStatus,
      stockedOut: bool(r.stockedOut),
      anchorAt,
      completedAt: null,
      observations: [],
      ledger: [],
      unmappedItems: { itemCount: 0, itemUnits: 0 },
    });
  }

  // ---- observations, pre-aggregated per (order, product) -------------------
  // orderStatus joins the grain (P0S-1): `unitsOnCompletedOrder` is 0 for every
  // status but `completed`, so the status is what separates a real
  // over-deduction from a deduction on an order Woo never reported as completed.
  // Grouping by it splits no units — the classifier sums per (order, product).
  const liveObsRows = await query(
    prisma,
    `SELECT eo.id AS orderId, fo.productId, fo.orderStatus,
            SUM(fo.unitsOnCompletedOrder) AS units,
            COUNT(*) AS rowCount,
            MAX(fo.completedAt) AS completedAt,
            SUM(CASE WHEN fo.hasPartialRefund = 1 THEN 1 ELSE 0 END) AS partialRefundRows,
            SUM(CASE WHEN fo.isFullyRefunded = 1 THEN 1 ELSE 0 END) AS fullyRefundedRows
       FROM fulfillment_observations fo
       JOIN external_orders eo
         ON eo.integrationId = fo.integrationId AND eo.externalId = fo.externalOrderId
      WHERE fo.tombstonedAt IS NULL
      GROUP BY eo.id, fo.productId, fo.orderStatus`
  );
  let partialRefundRowTotal = 0;
  let fullyRefundedRowTotal = 0;
  const observedUnitsByOrderProduct = new Map();
  for (const r of liveObsRows) {
    const o = orders.get(r.orderId);
    if (!o) continue;
    const productId = r.productId === null ? null : int(r.productId);
    const units = int(r.units);
    o.observations.push({
      productId,
      units,
      rowCount: int(r.rowCount),
      orderStatus: r.orderStatus,
      tombstonedAt: null,
    });
    if (productId !== null) {
      const key = `${r.orderId}|${productId}`;
      observedUnitsByOrderProduct.set(key, (observedUnitsByOrderProduct.get(key) ?? 0) + units);
    }
    const completedAt = date(r.completedAt);
    if (completedAt && (!o.completedAt || completedAt > o.completedAt)) o.completedAt = completedAt;
    partialRefundRowTotal += int(r.partialRefundRows);
    fullyRefundedRowTotal += int(r.fullyRefundedRows);
  }

  const tombstonedObsRows = await query(
    prisma,
    `SELECT eo.id AS orderId, fo.productId,
            SUM(fo.unitsOnCompletedOrder) AS units, COUNT(*) AS rowCount,
            MAX(fo.tombstonedAt) AS tombstonedAt
       FROM fulfillment_observations fo
       JOIN external_orders eo
         ON eo.integrationId = fo.integrationId AND eo.externalId = fo.externalOrderId
      WHERE fo.tombstonedAt IS NOT NULL
      GROUP BY eo.id, fo.productId`
  );
  let tombstonedRowTotal = 0;
  let tombstonedUnitTotal = 0;
  for (const r of tombstonedObsRows) {
    const o = orders.get(r.orderId);
    tombstonedRowTotal += int(r.rowCount);
    tombstonedUnitTotal += int(r.units);
    if (!o) continue;
    o.observations.push({
      productId: r.productId === null ? null : int(r.productId),
      units: int(r.units),
      rowCount: int(r.rowCount),
      tombstonedAt: date(r.tombstonedAt),
    });
  }

  const orphanObsRows = await query(
    prisma,
    `SELECT COUNT(*) AS rowCount, COALESCE(SUM(fo.unitsOnCompletedOrder), 0) AS units
       FROM fulfillment_observations fo
       LEFT JOIN external_orders eo
         ON eo.integrationId = fo.integrationId AND eo.externalId = fo.externalOrderId
      WHERE fo.tombstonedAt IS NULL AND eo.id IS NULL`
  );
  const orphanObservations = {
    rowCount: int(orphanObsRows[0]?.rowCount),
    units: int(orphanObsRows[0]?.units),
  };

  // ---- unmapped lines (a first-class leak category) ------------------------
  const unmappedByOrder = await query(
    prisma,
    `SELECT eoi.orderId, COUNT(*) AS itemCount, COALESCE(SUM(eoi.quantity), 0) AS itemUnits
       FROM external_order_items eoi
      WHERE eoi.isMapped = 0
      GROUP BY eoi.orderId`
  );
  for (const r of unmappedByOrder) {
    const o = orders.get(r.orderId);
    if (!o) continue;
    o.unmappedItems = { itemCount: int(r.itemCount), itemUnits: int(r.itemUnits) };
  }

  const unmappedByStore = await query(
    prisma,
    `SELECT eo.companyId, eo.integrationId,
            COUNT(*) AS itemCount, COALESCE(SUM(eoi.quantity), 0) AS itemUnits,
            COUNT(DISTINCT eo.id) AS orderCount
       FROM external_order_items eoi
       JOIN external_orders eo ON eo.id = eoi.orderId
      WHERE eoi.isMapped = 0
      GROUP BY eo.companyId, eo.integrationId`
  );
  const unmappedObsByStore = await query(
    prisma,
    `SELECT fo.integrationId, COUNT(*) AS rowCount,
            COALESCE(SUM(fo.unitsOnCompletedOrder), 0) AS units
       FROM fulfillment_observations fo
      WHERE fo.productId IS NULL AND fo.tombstonedAt IS NULL
      GROUP BY fo.integrationId`
  );

  // ---- evidence class (b): the fulfill path -------------------------------
  const fulfillAudit = await query(
    prisma,
    `SELECT a.id AS auditId, a.batchId, a.entityId AS orderId, a.actionType,
            a.createdAt, a.userId, a.affectedCount
       FROM audit_logs a
      WHERE a.entityType = 'ORDER'
        AND a.actionType IN ('${FULFILLMENT_ACTION_TYPES.join("','")}')`
  );
  // P0S-4/P0S-7b: the munging lives in lib/attribute.js so every branch is
  // pinned by fixtures. A batchId claimed by more than one order is dropped from
  // BOTH — the code now matches the disclosure that always said so.
  const classB = buildClassBAttribution(
    fulfillAudit.map((r) => ({ auditId: int(r.auditId), batchId: r.batchId, orderId: r.orderId })),
    (orderId) => orders.has(orderId)
  );
  const classBBatchToOrder = classB.batchToOrder;
  const fulfillAuditWithoutBatch = classB.eventsWithoutBatch;
  const fulfillAuditUnknownOrder = classB.eventsWithUnknownOrder;
  const batchMultiOrder = classB.conflicts;

  const LEDGER_BY_BATCH_SQL = `
    SELECT il.batchId, il.productId, il.locationId, il.logType,
           SUM(il.delta) AS netDelta, COUNT(*) AS rowCount
      FROM inventory_logs il
     WHERE il.batchId IN (__IN__)
     GROUP BY il.batchId, il.productId, il.locationId, il.logType`;

  const classBLedger = await queryChunkedIn(
    prisma,
    LEDGER_BY_BATCH_SQL,
    Array.from(classBBatchToOrder.keys())
  );
  let classBLedgerRows = 0;
  const classBBatchesWithLedger = new Set();
  for (const r of classBLedger) {
    const orderId = classBBatchToOrder.get(r.batchId);
    const o = orders.get(orderId);
    if (!o) continue;
    classBBatchesWithLedger.add(r.batchId);
    classBLedgerRows += int(r.rowCount);
    o.ledger.push({
      productId: int(r.productId),
      locationId: r.locationId === null ? null : int(r.locationId),
      delta: int(r.netDelta),
      evidenceClass: EVIDENCE_CLASS.B,
      logType: r.logType,
    });
  }
  const classBBatchesWithoutLedger =
    classBBatchToOrder.size - classBBatchesWithLedger.size;

  // ---- evidence class (c): persisted reference text ------------------------
  const referenceRows = await query(
    prisma,
    `SELECT a.id AS auditId, a.batchId, a.createdAt,
            JSON_UNQUOTE(JSON_EXTRACT(a.details, '$.orderReference')) AS orderReference
       FROM audit_logs a
      WHERE JSON_TYPE(JSON_EXTRACT(a.details, '$.orderReference')) = 'STRING'`
  );
  const references = referenceRows.map((r) => ({
    auditId: int(r.auditId),
    batchId: r.batchId,
    createdAt: date(r.createdAt),
    rawReference: r.orderReference,
  }));

  const classCApplicable = floors.c.applicable;
  const matchInput = Array.from(orders.values()).map((o) => ({
    orderId: o.orderId,
    integrationId: o.integrationId,
    orderNumber: o.orderNumber,
    anchorAt: o.anchorAt,
  }));
  const matchResult = classCApplicable
    ? matchHeuristicReferences(references, matchInput)
    : { matches: [], ambiguous: [], unmatched: [], disclosures: { referencesScanned: references.length } };

  const classC = selectClassCBatches(matchResult.matches, classBBatchToOrder);
  const classCBatchToOrder = classC.batchToOrder;
  const classCBatchesSkippedAsClassB = classC.skippedAsClassB;
  const classCLedger = await queryChunkedIn(
    prisma,
    LEDGER_BY_BATCH_SQL,
    Array.from(classCBatchToOrder.keys())
  );
  let classCLedgerRows = 0;
  for (const r of classCLedger) {
    const o = orders.get(classCBatchToOrder.get(r.batchId));
    if (!o) continue;
    classCLedgerRows += int(r.rowCount);
    o.ledger.push({
      productId: int(r.productId),
      locationId: r.locationId === null ? null : int(r.locationId),
      delta: int(r.netDelta),
      evidenceClass: EVIDENCE_CLASS.C,
      logType: r.logType,
    });
  }

  const selectedIdRows = await query(
    prisma,
    `SELECT COUNT(*) AS n FROM audit_logs a
      WHERE a.details IS NOT NULL
        AND JSON_CONTAINS_PATH(a.details, 'one', '$.selectedExternalOrderId') = 1`
  );
  const selectedExternalOrderIdRows = int(selectedIdRows[0]?.n);

  // ---- P0S-3: the UNATTRIBUTED OUTBOUND POOL -------------------------------
  // Negative-delta ledger units inside the post-floor window that NO evidence
  // class reached. It upper-bounds how much of the under-deduction gap could be
  // unlinked-not-missing: any of these units could BE the deduction for an order
  // scored here as under-deducted, we simply cannot prove the link.
  const poolFloor = earliestApplicableFloor(floors);
  const attributedBatchIds = Array.from(
    new Set([...classBBatchToOrder.keys(), ...classCBatchToOrder.keys()])
  );
  let unattributedPool = null;
  if (poolFloor) {
    const poolFloorIso = poolFloor.toISOString().slice(0, 19).replace("T", " ");
    const negativeTotals = await query(
      prisma,
      `SELECT il.logType, COUNT(*) AS rowCount, COALESCE(SUM(-il.delta), 0) AS units,
              SUM(CASE WHEN il.batchId IS NULL THEN 1 ELSE 0 END) AS rowsWithoutBatch,
              COALESCE(SUM(CASE WHEN il.batchId IS NULL THEN -il.delta ELSE 0 END), 0)
                AS unitsWithoutBatch
         FROM inventory_logs il
        WHERE il.delta < 0 AND il.changeTime >= ?
        GROUP BY il.logType`,
      [poolFloorIso]
    );
    const negativeAttributed = await queryChunkedIn(
      prisma,
      `SELECT il.logType, COUNT(*) AS rowCount, COALESCE(SUM(-il.delta), 0) AS units
         FROM inventory_logs il
        WHERE il.delta < 0 AND il.changeTime >= ? AND il.batchId IN (__IN__)
        GROUP BY il.logType`,
      attributedBatchIds,
      500,
      [poolFloorIso]
    );
    unattributedPool = summarizeUnattributedPool(
      negativeTotals.map((r) => ({
        logType: r.logType,
        rowCount: int(r.rowCount),
        units: int(r.units),
        rowsWithoutBatch: int(r.rowsWithoutBatch),
        unitsWithoutBatch: int(r.unitsWithoutBatch),
      })),
      negativeAttributed.map((r) => ({
        logType: r.logType,
        rowCount: int(r.rowCount),
        units: int(r.units),
      }))
    );
  }
  const poolSaleUnits = unattributedPool?.byLogType?.SALE?.unattributedUnits ?? null;
  const poolAdjustmentUnits = unattributedPool?.byLogType?.ADJUSTMENT?.unattributedUnits ?? null;

  // ---- P0S-2: line-grain observed-vs-fulfilledQty ---------------------------
  // NO ledger join and NO observability floor: this panel covers the FULL
  // history and is the only one that can date pre-July drift. Bundle-linked and
  // unmapped lines are EXCLUDED and counted — a bundle line's quantity is
  // line-grain while its observations are component-grain, so the two are not
  // unit-comparable.
  const lineRows = await query(
    prisma,
    `SELECT eoi.orderId, pl.internalProductId AS productId,
            eo.companyId, eo.integrationId,
            DATE_FORMAT(COALESCE(eo.externalCreatedAt, eo.createdAt), '%Y-%m-%d') AS anchorDayKey,
            COUNT(*) AS lineCount,
            COALESCE(SUM(eoi.quantity), 0) AS orderedUnits,
            COALESCE(SUM(eoi.fulfilledQty), 0) AS appFulfilledUnits
       FROM external_order_items eoi
       JOIN external_orders eo ON eo.id = eoi.orderId
       JOIN product_links pl ON pl.id = eoi.productLinkId
      WHERE eoi.isMapped = 1 AND pl.isBundle = 0 AND pl.internalProductId IS NOT NULL
      GROUP BY eoi.orderId, pl.internalProductId, eo.companyId, eo.integrationId,
               DATE_FORMAT(COALESCE(eo.externalCreatedAt, eo.createdAt), '%Y-%m-%d')`
  );
  const linePairs = lineRows.map((r) => {
    const productId = int(r.productId);
    return {
      orderId: r.orderId,
      productId,
      companyId: r.companyId,
      integrationId: r.integrationId,
      month: r.anchorDayKey ? monthKey(r.anchorDayKey) : null,
      lineCount: int(r.lineCount),
      orderedUnits: int(r.orderedUnits),
      appFulfilledUnits: int(r.appFulfilledUnits),
      observedUnits: observedUnitsByOrderProduct.get(`${r.orderId}|${productId}`) ?? 0,
    };
  });
  const lineGrain = rollupLineGrain(linePairs);

  const lineExclusionRows = await query(
    prisma,
    `SELECT COUNT(*) AS lineCount, COALESCE(SUM(eoi.quantity), 0) AS orderedUnits,
            COUNT(DISTINCT eoi.orderId) AS orderCount,
            SUM(CASE WHEN eoi.isMapped = 0 THEN 1 ELSE 0 END) AS unmappedLines,
            SUM(CASE WHEN eoi.isMapped = 1 AND pl.isBundle = 1 THEN 1 ELSE 0 END) AS bundleLines,
            COALESCE(SUM(CASE WHEN eoi.isMapped = 1 AND pl.isBundle = 1 THEN eoi.quantity ELSE 0 END), 0)
              AS bundleUnits,
            SUM(CASE WHEN eoi.isMapped = 1 AND pl.id IS NOT NULL AND pl.isBundle = 0
                       AND pl.internalProductId IS NULL THEN 1 ELSE 0 END) AS linkWithoutProduct
       FROM external_order_items eoi
       LEFT JOIN product_links pl ON pl.id = eoi.productLinkId`
  );
  const lineExclusions = {
    lineCount: int(lineExclusionRows[0]?.lineCount),
    orderedUnits: int(lineExclusionRows[0]?.orderedUnits),
    orderCount: int(lineExclusionRows[0]?.orderCount),
    unmappedLines: int(lineExclusionRows[0]?.unmappedLines),
    bundleLines: int(lineExclusionRows[0]?.bundleLines),
    bundleUnits: int(lineExclusionRows[0]?.bundleUnits),
    linkWithoutProduct: int(lineExclusionRows[0]?.linkWithoutProduct),
  };

  const LINE_GRAIN_CAVEAT = disclosure(
    "fulfilled_qty_is_app_only",
    "external_order_items.fulfilledQty",
    "CAVEAT, binding on every figure in this panel: fulfilledQty is written ONLY " +
      "by the app's own fulfill path (lib/fulfillment.ts increments it; nothing " +
      "else writes it). A zero fulfilledQty therefore means 'not fulfilled THROUGH " +
      "THE APP's fulfill flow' — it NEVER means 'not shipped'. The business fulfils " +
      "in WooCommerce, so this panel dates WHEN app-recorded fulfillment diverged " +
      "from Woo-observed shipping, at line grain. It is not a shipping record and " +
      "no unit here is evidence of a stock movement."
  );
  const LINE_GRAIN_EXCLUSIONS = [
    disclosure(
      "bundle_lines_excluded",
      lineExclusions.bundleLines,
      `Order lines whose product link is a BUNDLE, carrying ${lineExclusions.bundleUnits} ` +
        "ordered units. A bundle line's quantity is LINE grain while its observations " +
        "are component grain (one row per frozen component), so the two are not " +
        "unit-comparable. Excluded from this panel and counted here."
    ),
    disclosure(
      "unmapped_lines_excluded",
      lineExclusions.unmappedLines,
      "Order lines with isMapped = 0: no internal product to compare against. " +
        "Counted in the unmappedLines section; excluded from this panel."
    ),
    disclosure(
      "mapped_lines_without_internal_product",
      lineExclusions.linkWithoutProduct,
      "Lines whose product link exists but carries no internalProductId — mapped to " +
        "a link, not to a product. Excluded (nothing to compare), never counted as 0."
    ),
    disclosure(
      "order_lines_scanned",
      lineExclusions.lineCount,
      `All external_order_items rows (${lineExclusions.orderCount} orders, ` +
        `${lineExclusions.orderedUnits} ordered units) — the denominator this panel's ` +
        "comparable subset is drawn from."
    ),
    disclosure(
      "no_ledger_join_and_no_floor",
      "full history",
      "This panel joins NO ledger rows and applies NO observability floor: it " +
        "compares two order-side columns only. That is what lets it cover the full " +
        "history — every other D1 figure is fenced by the class floors."
    ),
  ];

  // ---- classify ------------------------------------------------------------
  const results = [];
  for (const o of orders.values()) results.push(classifyOrder(o, floors));

  const statusTotals = { full: 0, partial: 0, none: 0, over: 0, unobservable: 0 };
  // P0S-6: every EXCLUDED cohort carries a unit count beside its order count.
  // The units come from the classifier's UNSCOPED totals (computed for every
  // order, scored or not) so an excluded cohort is never reported as an order
  // count with no magnitude.
  const emptyCohort = () => ({ orders: 0, observedUnits: 0, deductedUnits: 0 });
  const excludedCohorts = {
    historically_unobservable: emptyCohort(),
    no_completed_observation: emptyCohort(),
    unmapped_only: emptyCohort(),
    deducted_order_not_completed: emptyCohort(),
  };
  let unmappedOnlyObservationUnits = 0;
  let unmappedOnlyItemUnits = 0;
  let notCompletedWithoutObservation = 0;
  const byStore = new Map();
  let unitsUnderDeducted = 0;
  let unitsOverDeducted = 0;
  let observedUnitsTotal = 0;
  let deductedUnitsTotal = 0;
  let overOnCompletedOrders = 0;
  let overOnCompletedUnits = 0;

  for (const r of results) {
    statusTotals[r.status] += 1;
    if (r.statusReason && r.statusReason in excludedCohorts) {
      const c = excludedCohorts[r.statusReason];
      c.orders += 1;
      c.observedUnits += r.observedUnitsUnscoped;
      c.deductedUnits += r.deductedUnitsUnscoped;
      if (r.statusReason === "unmapped_only") {
        unmappedOnlyObservationUnits += r.unmapped.observationUnits;
        unmappedOnlyItemUnits += r.unmapped.itemUnits;
      }
      if (r.statusReason === "deducted_order_not_completed" && r.observedOrderStatus === null) {
        notCompletedWithoutObservation += 1;
      }
    }
    if (r.status === ORDER_STATUS.OVER && r.countsTowardGapTotals) {
      overOnCompletedOrders += 1;
      overOnCompletedUnits += r.unitsOverDeducted;
    }
    const key = `${r.companyId}|${r.integrationId}`;
    if (!byStore.has(key)) {
      byStore.set(key, {
        companyId: r.companyId,
        integrationId: r.integrationId,
        location: "unknown",
        orders: 0,
        full: 0,
        partial: 0,
        none: 0,
        over: 0,
        unobservable: 0,
        overNotCompleted: 0,
        unitsObserved: 0,
        unitsDeducted: 0,
        unitsUnderDeducted: 0,
        unitsOverDeducted: 0,
        unitsDeductedNotCompleted: 0,
        unmappedItemUnits: 0,
      });
    }
    const s = byStore.get(key);
    s.orders += 1;
    s[r.status] += 1;
    s.unmappedItemUnits += r.unmapped.itemUnits;
    if (r.statusReason === "deducted_order_not_completed") {
      s.overNotCompleted += 1;
      s.unitsDeductedNotCompleted += r.deductedUnitsUnscoped;
    }
    if (r.countsTowardGapTotals) {
      s.unitsObserved += r.observedUnits;
      s.unitsDeducted += r.deductedUnits;
      s.unitsUnderDeducted += r.unitsUnderDeducted;
      s.unitsOverDeducted += r.unitsOverDeducted;
      observedUnitsTotal += r.observedUnits;
      deductedUnitsTotal += r.deductedUnits;
      unitsUnderDeducted += r.unitsUnderDeducted;
      unitsOverDeducted += r.unitsOverDeducted;
    }
  }

  const gapCohort = results
    .filter(
      (r) =>
        r.countsTowardGapTotals &&
        (r.status === ORDER_STATUS.NONE ||
          r.status === ORDER_STATUS.PARTIAL ||
          r.status === ORDER_STATUS.OVER)
    )
    .sort((a, b) => b.unitsUnderDeducted + b.unitsOverDeducted - (a.unitsUnderDeducted + a.unitsOverDeducted));
  const detailCap = opts.orderRows;
  const detailRows = gapCohort.slice(0, detailCap).map((r) => ({
    orderId: r.orderId,
    companyId: r.companyId,
    integrationId: r.integrationId,
    status: r.status,
    observedOrderStatus: r.observedOrderStatus,
    internalStatus: r.internalStatus,
    observedUnits: r.observedUnits,
    deductedUnits: r.deductedUnits,
    unitsUnderDeducted: r.unitsUnderDeducted,
    unitsOverDeducted: r.unitsOverDeducted,
    evidenceClasses: r.evidenceClassesUsed.join(",") || "none",
    location: r.locationLabel,
    anchorAt: r.floorAnchorAt ? r.floorAnchorAt.toISOString() : null,
    anchorSource: r.floorAnchorSource,
    unmappedItemUnits: r.unmapped.itemCount > 0 ? r.unmapped.itemUnits : 0,
  }));

  // P0S-1: the excluded not-completed cohort keeps its own detail table — it is
  // out of the gap totals, not out of sight.
  const notCompletedCohort = results
    .filter((r) => r.statusReason === "deducted_order_not_completed")
    .sort((a, b) => b.deductedUnitsUnscoped - a.deductedUnitsUnscoped);
  const notCompletedRows = notCompletedCohort.slice(0, detailCap).map((r) => ({
    orderId: r.orderId,
    companyId: r.companyId,
    integrationId: r.integrationId,
    observedOrderStatus: r.observedOrderStatus,
    internalStatus: r.internalStatus,
    deductedUnits: r.deductedUnitsUnscoped,
    observedUnits: r.observedUnitsUnscoped,
    evidenceClasses: r.evidenceClassesUsed.join(",") || "none",
    location: r.locationLabel,
    anchorAt: r.floorAnchorAt ? r.floorAnchorAt.toISOString() : null,
  }));

  // ---- the standing disclosures that ride with every gap number -----------
  const gapDisclosures = [
    disclosure(
      "historically_unobservable_orders",
      excludedCohorts.historically_unobservable.orders,
      "Anchored before every applicable evidence class's start date — no evidence " +
        "could have been recorded. EXCLUDED from gap totals (unavailable, never a gap)."
    ),
    disclosure(
      "historically_unobservable_units",
      excludedCohorts.historically_unobservable.observedUnits,
      `Observed (mapped, live) units on those orders, against ` +
        `${excludedCohorts.historically_unobservable.deductedUnits} linked deducted units. ` +
        "The MAGNITUDE of the pre-floor cohort: none of it is in the gap totals above, " +
        "and none of it is evidence of a leak — it is simply unobservable."
    ),
    disclosure(
      "no_completed_observation_orders",
      excludedCohorts.no_completed_observation.orders,
      "No non-tombstoned fulfillment observation and no linked ledger movement — " +
        "the order is not observable as shipped. EXCLUDED from gap totals."
    ),
    disclosure(
      "no_completed_observation_units",
      excludedCohorts.no_completed_observation.observedUnits,
      "0 BY CONSTRUCTION, not by omission: this cohort is DEFINED as having neither " +
        "mapped observed units nor linked ledger movement. The zero is the definition, " +
        "not a missing measurement."
    ),
    disclosure(
      "unmapped_only_orders",
      excludedCohorts.unmapped_only.orders,
      "Every observed unit is on an UNMAPPED line (productId IS NULL / isMapped=0) — " +
        "structurally undeductable. Counted in the unmapped-lines section, EXCLUDED " +
        "from gap totals."
    ),
    disclosure(
      "unmapped_only_units",
      unmappedOnlyObservationUnits,
      `Unmapped OBSERVATION units on those orders (alongside ${unmappedOnlyItemUnits} ` +
        "ordered units on their unmapped order lines). Structurally undeductable: there " +
        "is no product to move, so these units can never appear in a gap total."
    ),
    disclosure(
      "deducted_order_not_completed_orders",
      excludedCohorts.deducted_order_not_completed.orders,
      DEFINITIONS.overNotCompleted
    ),
    disclosure(
      "deducted_order_not_completed_units",
      excludedCohorts.deducted_order_not_completed.deductedUnits,
      "NET ledger units deducted for those orders. EXCLUDED from unitsOverDeducted: " +
        "with the order not `completed` at Woo, every observation row resolves to 0 " +
        "units, so the comparison would read as over-deduction by construction rather " +
        `than by evidence. ${notCompletedWithoutObservation} of these orders have no ` +
        "live observation row at all (status UNKNOWN, which is not evidence either)."
    ),
    disclosure(
      "ambiguous_class_c_references",
      matchResult.ambiguous.length,
      "Order references whose normalized token resolved to more than one candidate " +
        "(or to more than one integration). AMBIGUOUS is its own class and is NEVER " +
        "matched — these contribute no evidence in either direction."
    ),
    disclosure(
      "class_b_batches_without_ledger_rows",
      classBBatchesWithoutLedger,
      "Fulfillment audit events whose batchId matched no inventory_logs row — the " +
        "audit event exists but its ledger rows do not carry the batchId."
    ),
    disclosure(
      "fulfillment_audit_events_without_batchid",
      fulfillAuditWithoutBatch,
      "EXTERNAL_ORDER_*FULFILLMENT audit events with a NULL batchId: unjoinable to " +
        "the ledger, so their orders can only be scored by another class."
    ),
  ];

  // P0S-3 — the confound rides ON the under-deduction figure, not in a footnote.
  const POOL_WINDOW_TEXT = poolFloor
    ? `the post-floor window (inventory_logs.changeTime >= ${poolFloor.toISOString()})`
    : "the post-floor window";
  const underDeductionConfound = poolFloor
    ? [
        disclosure(
          "unattributed_outbound_pool_sale_units",
          poolSaleUnits,
          `CONFOUND, stated explicitly: negative-delta SALE ledger units in ` +
            `${POOL_WINDOW_TEXT} that NO evidence class reached (their batchId was ` +
            "never attributed to an order, or they carry none). Any of them could BE " +
            "the deduction for an order counted above as under-deducted, which would " +
            "make that order unlinked rather than never-deducted. This figure therefore " +
            "UPPER-BOUNDS how much of the under-deduction gap is unlinked-not-missing; " +
            "the gap above is an upper bound on missing deductions. null = the logType " +
            "has no negative rows in the window (unknown, not zero)."
        ),
        disclosure(
          "unattributed_outbound_pool_adjustment_units",
          poolAdjustmentUnits,
          `The same measure over negative-delta ADJUSTMENT rows in ${POOL_WINDOW_TEXT}, ` +
            "reported SEPARATELY because generic adjustments are not order-shaped: " +
            "counted here so the SALE figure is not read as the whole unlinked outbound " +
            "pool. null = no negative ADJUSTMENT rows in the window."
        ),
      ]
    : [
        disclosure(
          "unattributed_outbound_pool",
          null,
          "Not computed: no evidence class is applicable, so there is no post-floor " +
            "window to scope the pool to. STRUCTURALLY EMPTY, never 0."
        ),
      ];

  const sections = {
    scope: {
      ordersScanned: figure(
        orders.size,
        "Rows in external_orders. Projection is ids, dates, quantities and status " +
          "fields only — no customer fields, no rawPayload."
      ),
      observationGroupsScanned: figure(
        liveObsRows.length + tombstonedObsRows.length,
        "Pre-aggregated observation groups in fulfillment_observations, live plus " +
          "tombstoned. The live grain is (order, product, orderStatus) — the status " +
          "joins the grain so the over cohort can be split by it (P0S-1); the " +
          "tombstoned grain is (order, product). Groups, NOT rows: one group can " +
          "stand for several observation rows."
      ),
      fulfillmentAuditEvents: figure(
        fulfillAudit.length,
        `audit_logs rows with entityType='ORDER' and actionType in ${FULFILLMENT_ACTION_TYPES.join("/")}.`,
        [
          disclosure(
            "unknown_order_entity",
            fulfillAuditUnknownOrder,
            "Audit events whose entityId is not a current external_orders id (deleted " +
              "or re-provisioned orders) — unjoinable."
          ),
        ]
      ),
      persistedOrderReferences: figure(
        references.length,
        "audit_logs rows whose details JSON carries a STRING at $.orderReference. " +
          "Only that one path is read out of details.",
        [
          disclosure(
            "selected_external_order_id_rows",
            selectedExternalOrderIdRows,
            "Audit rows carrying $.selectedExternalOrderId (Phase 0b-2's direct id). " +
              "NO evidence class is frozen for it in Phase 0a, so it is counted and " +
              "NOT used — recorded for the full-lane design."
          ),
        ]
      ),
    },

    observabilityFloors: {
      classA: emptySlot(floors.a.reason, floors.a.definition),
      classB: figure(
        floors.b.floor ? floors.b.floor.toISOString() : null,
        `${floors.b.definition} Bound reading: ${floors.b.boundReading}. Derivation: ${floors.b.derivation}.`,
        [
          disclosure(
            "spec_frozen_floor",
            floors.b.specFrozenFloor ? floors.b.specFrozenFloor.toISOString() : null,
            `The spec's literal floor (the stockedOut feature's deploy), derived as ` +
              `${floors.b.specFrozenDerivation}. Earliest stockedOutAt in data: ` +
              `${earliestStockedOutAt ? earliestStockedOutAt.toISOString() : "none"} — note that ` +
              `migration 20260411_add_stocked_out BACKFILLED stockedOutAt from fulfilledAt, ` +
              `so a value before 2026-04-11 is backfill, not observation.`
          ),
          disclosure(
            "evidence_capable_floor",
            floors.b.evidenceCapableFloor ? floors.b.evidenceCapableFloor.toISOString() : null,
            "The date from which class (b) evidence can physically exist: the LATER of " +
              "the stockedOut floor, the first ledger row carrying a batchId " +
              "(migration 20260710150000) and the first EXTERNAL_ORDER_*FULFILLMENT " +
              "audit row (migration 20260709164143)."
          ),
          disclosure(
            "earliest_ledger_batchid_at",
            earliestLedgerBatchAt ? earliestLedgerBatchAt.toISOString() : null,
            "MIN(inventory_logs.changeTime) where batchId IS NOT NULL."
          ),
          disclosure(
            "earliest_fulfillment_audit_at",
            earliestFulfillmentAuditAt ? earliestFulfillmentAuditAt.toISOString() : null,
            "MIN(audit_logs.createdAt) over the three EXTERNAL_ORDER_*FULFILLMENT actionTypes."
          ),
          disclosure("floor_reason", floors.b.reason ?? "n/a", "Why this floor binds."),
        ]
      ),
      classC: floors.c.applicable
        ? figure(floors.c.floor.toISOString(), floors.c.definition)
        : emptySlot(floors.c.reason, floors.c.definition),
    },

    evidence: {
      classA: emptySlot(
        floors.a.reason,
        "Ledger rows attributed to an order through a first-class ledger order key."
      ),
      classBLedgerRows: figure(
        classBLedgerRows,
        "inventory_logs rows reached through the class (b) join " +
          "(ledger.batchId = audit_logs.batchId on EXTERNAL_ORDER_*FULFILLMENT events, " +
          "entityId = the order). No time fence. Unfulfillment rows join the same way " +
          "and SUBTRACT.",
        [
          disclosure(
            "batchid_shared_by_multiple_orders",
            batchMultiOrder.length,
            "batchIds claimed by fulfillment events on more than one order — dropped " +
              "from BOTH attributions, never attributed to either. Not first-wins: the " +
              "ledger rows behind a shared batch are excluded from every order's " +
              "deducted units and land in the unattributed outbound pool instead."
          ),
        ]
      ),
      classCMatches: classCApplicable
        ? figure(
            matchResult.matches.length,
            "Persisted order references matched to exactly one order by EXACT " +
              "normalized equality (trim, strip leading '#'), scoped to one " +
              "integration, inside a +/-7d window (this class only).",
            [
              disclosure(
                "ambiguous",
                matchResult.ambiguous.length,
                "More than one candidate, or candidates in more than one integration."
              ),
              disclosure(
                "out_of_window",
                matchResult.disclosures.outOfWindow ?? 0,
                "Exact-token candidate existed but fell outside +/-7d."
              ),
              disclosure(
                "no_candidate",
                matchResult.disclosures.noCandidate ?? 0,
                "No order carries that exact normalized number."
              ),
              disclosure(
                "unnormalizable",
                matchResult.disclosures.unnormalizable ?? 0,
                "Reference was empty after trim + '#' strip."
              ),
              disclosure(
                "case_insensitive_only_candidates",
                matchResult.disclosures.caseInsensitiveOnlyCandidates ?? 0,
                "Would have matched under case-folding. NOT matched — the frozen rule " +
                  "is exact equality. Recorded so the full lane can decide."
              ),
              disclosure(
                "batches_already_attributed_by_class_b",
                classCBatchesSkippedAsClassB,
                "Matched references whose batchId was already attributed by the stronger " +
                  "class (b) — skipped, never double-counted."
              ),
              disclosure(
                "class_c_batchid_shared_by_multiple_orders",
                classC.conflicts.length,
                "batchIds that two matched references claimed for DIFFERENT orders — " +
                  "dropped from both, the same rule class (b) applies. Without it the " +
                  "later match would silently overwrite the earlier one."
              ),
              disclosure(
                "matches_without_batchid",
                classC.matchesWithoutBatch,
                "Matched references on audit rows carrying no batchId: nothing to join to " +
                  "the ledger, so the match yields no evidence."
              ),
            ]
          )
        : emptySlot(
            floors.c.reason,
            "Ledger rows attributed to an order through a persisted order reference."
          ),
      classCLedgerRows: classCApplicable
        ? figure(classCLedgerRows, "inventory_logs rows reached through class (c) matches.")
        : emptySlot(floors.c.reason, "inventory_logs rows reached through class (c) matches."),
    },

    orderStatus: {
      totals: figure(
        statusTotals,
        `Order counts by status. ${DEFINITIONS.orderStatus}`,
        gapDisclosures
      ),
      overCohort: {
        overOnCompletedOrder: figure(
          overOnCompletedOrders,
          "Orders classified `over` whose observations report the Woo order as " +
            "COMPLETED — the only over-deduction reading backed by evidence on both " +
            "sides. These are the ones inside unitsOverDeducted.",
          [
            disclosure(
              "units",
              overOnCompletedUnits,
              "Non-cancelling over-deducted units on those orders — the whole of " +
                "gapTotals.unitsOverDeducted."
            ),
          ]
        ),
        deductedOrderNotCompleted: figure(
          excludedCohorts.deducted_order_not_completed.orders,
          DEFINITIONS.overNotCompleted,
          [
            disclosure(
              "units",
              excludedCohorts.deducted_order_not_completed.deductedUnits,
              "NET ledger units deducted for this cohort. NOT part of " +
                "gapTotals.unitsOverDeducted."
            ),
            disclosure(
              "orders_without_any_observation_row",
              notCompletedWithoutObservation,
              "The sub-slice with NO live observation row at all: the Woo status is " +
                "UNKNOWN rather than known-not-completed. Unknown is not evidence of " +
                "over-deduction either, so it sits in the same excluded cohort."
            ),
            disclosure(
              "why_persistent",
              "completed-push expected-blocked",
              "This is not an in-flight state. The app's order-status push to Woo is " +
                "expected-blocked in production (egress lockdown), so an order the app " +
                "fulfilled and deducted can stay non-completed at Woo permanently."
            ),
          ]
        ),
      },
      byStore: table(
        Array.from(byStore.values()).sort((a, b) => b.unitsUnderDeducted - a.unitsUnderDeducted),
        "Order-side grain is the STORE (companyId + integrationId). The ledger is a " +
          "store-less shared pool and is NEVER split by store, so `location` here is " +
          "'unknown' by construction; per-order location appears only where matched " +
          "ledger evidence supplies it.",
        {
          unitsObserved: DEFINITIONS.observedUnits,
          unitsDeducted: DEFINITIONS.deductedUnits,
          unitsUnderDeducted: DEFINITIONS.unitsUnderDeducted,
          unitsOverDeducted: DEFINITIONS.unitsOverDeducted,
          over:
            "Orders classified `over`, INCLUDING the not-completed cohort broken out in " +
            "`overNotCompleted` — the status count is the raw classification.",
          overNotCompleted: DEFINITIONS.overNotCompleted,
          unitsDeductedNotCompleted:
            "NET ledger units on this store's `overNotCompleted` orders. Excluded from " +
            "unitsOverDeducted in the same row.",
          unobservable:
            "Orders excluded from gap totals (pre-floor, no completed observation, or " +
            "unmapped-only). See the disclosures on orderStatus.totals for the split.",
          unmappedItemUnits:
            "Units on external_order_items rows with isMapped=0 for this store's orders.",
        }
      ),
    },

    gapTotals: {
      unitsUnderDeducted: figure(unitsUnderDeducted, DEFINITIONS.unitsUnderDeducted, [
        ...underDeductionConfound,
        ...gapDisclosures,
      ]),
      unitsOverDeducted: figure(unitsOverDeducted, DEFINITIONS.unitsOverDeducted, [
        disclosure(
          "excludes_deducted_order_not_completed",
          excludedCohorts.deducted_order_not_completed.deductedUnits,
          `Units NOT in this figure: ${excludedCohorts.deducted_order_not_completed.orders} ` +
            "orders were deducted while no observation reports them as Woo-completed. " +
            `${DEFINITIONS.overNotCompleted} See orderStatus.overCohort.`
        ),
        ...gapDisclosures,
      ]),
      unitsObserved: figure(observedUnitsTotal, DEFINITIONS.observedUnits, [
        disclosure(
          "partial_refund_observation_rows",
          partialRefundRowTotal,
          "Observation ROWS flagged hasPartialRefund (live rows only; this is a row " +
            "count, SUM over the flag, not a count of groups or orders). Woo's per-line " +
            "refund quantities are documented-buggy, so refunded units are NOT netted " +
            "out here."
        ),
        disclosure(
          "fully_refunded_observation_rows",
          fullyRefundedRowTotal,
          "Observation ROWS flagged isFullyRefunded (live rows only; a row count, not a " +
            "count of groups or orders). A fully-refunded order is not `completed`, so " +
            "it already resolves to 0 units."
        ),
        disclosure(
          "tombstoned_observation_rows_excluded",
          tombstonedRowTotal,
          `Observation rows tombstoned (order vanished from the platform), carrying ` +
            `${tombstonedUnitTotal} units. Excluded from every unit total.`
        ),
        disclosure(
          "orphan_observation_rows",
          orphanObservations.rowCount,
          `Live observation rows with no matching external_orders row on ` +
            `(integrationId, externalId), carrying ${orphanObservations.units} units. ` +
            `Unattributable to an order.`
        ),
      ]),
      unitsDeducted: figure(deductedUnitsTotal, DEFINITIONS.deductedUnits),
    },

    unmappedLines: {
      byStore: table(
        unmappedByStore.map((r) => ({
          companyId: r.companyId,
          integrationId: r.integrationId,
          orderCount: int(r.orderCount),
          itemCount: int(r.itemCount),
          itemUnits: int(r.itemUnits),
        })),
        "UNMAPPED order lines are a first-class leak category, not a gap: with no " +
          "product mapping there is nothing to deduct. Counted historically, reported " +
          "separately, never folded into the gap totals.",
        {
          itemCount: "external_order_items rows with isMapped = 0.",
          itemUnits: "SUM(external_order_items.quantity) over those rows (ordered, not shipped).",
        }
      ),
      unmappedObservationsByIntegration: table(
        unmappedObsByStore.map((r) => ({
          integrationId: r.integrationId,
          rowCount: int(r.rowCount),
          units: int(r.units),
        })),
        "fulfillment_observations rows with productId IS NULL (unmapped at observation " +
          "time), tombstoned excluded. productId null means UNMAPPED — coverage, NOT zero.",
        { units: "SUM(unitsOnCompletedOrder) on unmapped observation rows." }
      ),
    },

    // P0S-3 — the outbound units no evidence class reached.
    unattributedOutbound: unattributedPool
      ? {
          windowStart: figure(
            poolFloor.toISOString(),
            "Inclusive lower bound: the EARLIEST applicable evidence-class floor — the " +
              "window a gap-counted order can live in. Ledger rows before it belong to " +
              "orders that are historically unobservable anyway."
          ),
          saleUnits: figure(poolSaleUnits, underDeductionConfound[0].reason),
          adjustmentUnits: figure(poolAdjustmentUnits, underDeductionConfound[1].reason),
          byLogType: table(
            unattributedPool.rows,
            "Negative-delta ledger units in the window, split by logType into the part " +
              "an evidence class REACHED (its batchId was attributed to an order) and " +
              "the part it did not. A logType with no negative rows in the window is " +
              "ABSENT from this table — absent means not applicable, never 0.",
            {
              units: "SUM(-delta) over negative rows of that logType in the window.",
              attributedUnits:
                "The part whose batchId was attributed to an order by class (b) or (c). " +
                "Batches DROPPED for claiming two orders count as unattributed.",
              unattributedUnits: "units - attributedUnits: reached by no evidence class.",
              unitsWithoutBatch:
                "Of `units`, the part on rows carrying NO batchId at all — unattributable " +
                "by construction, a subset of unattributedUnits.",
            },
            [
              disclosure(
                "attributed_batches",
                attributedBatchIds.length,
                "Distinct batchIds attributed to an order by class (b) or class (c) — the " +
                  "set this split is computed against."
              ),
            ]
          ),
        }
      : {
          saleUnits: emptySlot(
            "No evidence class is applicable, so there is no post-floor window to scope " +
              "the pool to.",
            "Negative-delta SALE ledger units reached by no evidence class."
          ),
        },

    // P0S-2 — the only panel that can date pre-July drift.
    lineGrainObservedVsFulfilled: {
      pairsCompared: figure(
        lineGrain.totals.pairs,
        "(order, product) pairs where a MAPPED, non-bundle order line resolves to an " +
          "internal product. The comparison is order-side only: external_order_items " +
          "(quantity, fulfilledQty) against fulfillment_observations units. NO ledger " +
          "join, NO observability floor, FULL history.",
        [LINE_GRAIN_CAVEAT, ...LINE_GRAIN_EXCLUSIONS]
      ),
      orderedUnits: figure(
        lineGrain.totals.orderedUnits,
        "SUM(external_order_items.quantity) over the compared pairs — units ORDERED, " +
          "never units shipped.",
        [LINE_GRAIN_CAVEAT]
      ),
      appFulfilledUnits: figure(
        lineGrain.totals.appFulfilledUnits,
        "SUM(external_order_items.fulfilledQty) over the compared pairs — units the " +
          "APP recorded as fulfilled through its own fulfill flow.",
        [LINE_GRAIN_CAVEAT]
      ),
      observedUnits: figure(
        lineGrain.totals.observedUnits,
        "SUM(fulfillment_observations.unitsOnCompletedOrder) for the same (order, " +
          "product) pairs, live rows only — what Woo reports as shipped on a completed " +
          "order.",
        [LINE_GRAIN_CAVEAT]
      ),
      unitsObservedNotAppFulfilled: figure(
        lineGrain.totals.unitsObservedNotAppFulfilled,
        "SUM over pairs of max(0, observed - appFulfilled) — non-cancelling. Woo says " +
          "the units went out on a completed order and the app never recorded fulfilling " +
          "them ITSELF. This is the drift the panel exists to date; it is NOT a stock " +
          "gap (the deduction may have happened by another path).",
        [LINE_GRAIN_CAVEAT]
      ),
      unitsAppFulfilledNotObserved: figure(
        lineGrain.totals.unitsAppFulfilledNotObserved,
        "SUM over pairs of max(0, appFulfilled - observed) — non-cancelling. The app " +
          "recorded fulfilling units that Woo does not report on a completed order: the " +
          "order-side twin of the deducted-but-not-completed cohort above.",
        [LINE_GRAIN_CAVEAT]
      ),
      byMonth: table(
        lineGrain.byMonth,
        "The same comparison bucketed by the ORDER's own anchor month " +
          "(COALESCE(externalCreatedAt, createdAt), UTC 'YYYY-MM' — the house " +
          "convention in lib/analytics/date-grain.ts). This is the TIME SHAPE: it dates " +
          "when app-recorded fulfillment diverged from Woo-observed shipping, at line " +
          "grain, across the full history.",
        {
          orders: "DISTINCT orders contributing a compared pair in that month.",
          pairs: "(order, product) pairs compared in that month.",
          pairsWithDrift: "Pairs where the two sides disagree in either direction.",
          unitsObservedNotAppFulfilled:
            "max(0, observed - appFulfilled) summed over that month's pairs.",
          unitsAppFulfilledNotObserved:
            "max(0, appFulfilled - observed) summed over that month's pairs.",
        },
        [LINE_GRAIN_CAVEAT, ...LINE_GRAIN_EXCLUSIONS]
      ),
    },

    orderDetail: table(
      detailRows,
      "The gap cohort (none | partial | over), ranked by total unit difference. " +
        "Unobservable orders and the deducted-but-not-completed cohort are absent by " +
        "construction — the latter has its own table below.",
      {
        evidenceClasses: "Which evidence classes supplied the linked ledger rows.",
        location: DEFINITIONS.locationLabel,
        anchorSource: DEFINITIONS.floorAnchor,
        observedOrderStatus: DEFINITIONS.observedOrderStatus,
        internalStatus: DEFINITIONS.internalStatus,
      },
      [
        disclosure(
          "gap_cohort_total",
          gapCohort.length,
          `Full gap cohort size; this table shows at most ${detailCap} rows ` +
            `(--order-rows). The aggregate figures above cover the FULL population.`
        ),
      ]
    ),

    orderDetailDeductedNotCompleted: table(
      notCompletedRows,
      "The EXCLUDED not-completed cohort, ranked by deducted units. Out of the gap " +
        "totals, not out of sight: these orders were deducted while no observation " +
        "reports them as Woo-completed.",
      {
        observedOrderStatus: DEFINITIONS.observedOrderStatus,
        internalStatus: DEFINITIONS.internalStatus,
        deductedUnits:
          "NET linked ledger units for the order, computed UNSCOPED (the order is not " +
          "in the gap totals, so its scored figures are 0 by design).",
        observedUnits:
          "Mapped, live observed units — 0 for every non-completed status by " +
          "construction, which is exactly why the order is here.",
        location: DEFINITIONS.locationLabel,
      },
      [
        disclosure(
          "cohort_total",
          notCompletedCohort.length,
          `Full cohort size; this table shows at most ${detailCap} rows (--order-rows).`
        ),
      ]
    ),
  };

  notes.push(
    "Evidence class (a) (a ledger internal-order key) does not exist at this repo tip; " +
      "its slots are structurally empty with a named reason, so the classifier's shape " +
      "does not move when the full lane adds it."
  );
  notes.push(
    "Class (b) carries TWO floor readings and binds one (default: evidence-capable). " +
      "The spec's literal floor is the stockedOut deploy, but class (b) ALSO needs the " +
      "ledger<->audit batchId join, which did not exist until 2026-07-10 " +
      "(20260710150000_inventory_logs_batch_id) / 2026-07-09 " +
      "(20260709164143_change_tracking_foundation). Binding the literal floor would " +
      "score months of orders as gaps for evidence that could not have been recorded. " +
      "Re-run with --class-b-floor=spec to see the literal reading."
  );
  if (!classCApplicable) {
    notes.push(
      "Class (c) is STRUCTURALLY EMPTY: no audit row carries details.orderReference. " +
        "The workbench reference has never been persisted; Phase 0b-2 starts the accrual."
    );
  }

  notes.push(
    "The OVER cohort is SPLIT (P0S-1). `unitsOnCompletedOrder` is 0 for every Woo " +
      "status but `completed`, and the app's completed-push is expected-blocked in " +
      "production — so an order the app fulfilled and deducted can sit non-completed " +
      "at Woo permanently and read as over-deduction by construction. Those orders are " +
      "excluded from unitsOverDeducted and reported as their own cohort with their own " +
      "unit count; only `over` on a Woo-completed order is evidence of over-deduction."
  );
  notes.push(
    "The line-grain panel (P0S-2) is the only one covering the FULL history: it joins " +
      "no ledger rows and applies no observability floor. Read it as a DIVERGENCE DATE " +
      "between two order-side records, never as a shipping record — fulfilledQty is " +
      "written only by the app's own fulfill path, so 0 there means 'not fulfilled " +
      "through this app', not 'not shipped'."
  );
  notes.push(
    "The under-deduction gap carries a CONFOUND (P0S-3): unlinked outbound ledger units " +
      "in the same window could be the missing deductions, merely unattributable. The " +
      "unattributedOutbound section upper-bounds that; the gap figure is an upper bound " +
      "on missing deductions, not a measurement of them."
  );

  return {
    sections,
    notes,
    meta: {
      orderCount: orders.size,
      gapCohort: gapCohort.length,
      deductedOrderNotCompleted: notCompletedCohort.length,
      lineGrainPairs: lineGrain.totals.pairs,
    },
  };
}

module.exports = { check, title, purpose, run, FULFILLMENT_ACTION_TYPES };
