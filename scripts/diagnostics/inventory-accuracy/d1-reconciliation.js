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
  classifyOrder,
  matchHeuristicReferences,
} = require("./lib/classify");

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
  const liveObsRows = await query(
    prisma,
    `SELECT eo.id AS orderId, fo.productId,
            SUM(fo.unitsOnCompletedOrder) AS units,
            COUNT(*) AS rowCount,
            MAX(fo.completedAt) AS completedAt,
            SUM(CASE WHEN fo.hasPartialRefund = 1 THEN 1 ELSE 0 END) AS partialRefundRows,
            SUM(CASE WHEN fo.isFullyRefunded = 1 THEN 1 ELSE 0 END) AS fullyRefundedRows
       FROM fulfillment_observations fo
       JOIN external_orders eo
         ON eo.integrationId = fo.integrationId AND eo.externalId = fo.externalOrderId
      WHERE fo.tombstonedAt IS NULL
      GROUP BY eo.id, fo.productId`
  );
  let partialRefundRows = 0;
  let fullyRefundedRows = 0;
  for (const r of liveObsRows) {
    const o = orders.get(r.orderId);
    if (!o) continue;
    o.observations.push({
      productId: r.productId === null ? null : int(r.productId),
      units: int(r.units),
      rowCount: int(r.rowCount),
      tombstonedAt: null,
    });
    const completedAt = date(r.completedAt);
    if (completedAt && (!o.completedAt || completedAt > o.completedAt)) o.completedAt = completedAt;
    partialRefundRows += int(r.partialRefundRows);
    fullyRefundedRows += int(r.fullyRefundedRows);
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
  const classBBatchToOrder = new Map();
  let fulfillAuditWithoutBatch = 0;
  let fulfillAuditUnknownOrder = 0;
  const batchMultiOrder = [];
  for (const r of fulfillAudit) {
    if (!r.batchId) {
      fulfillAuditWithoutBatch += 1;
      continue;
    }
    if (!orders.has(r.orderId)) {
      fulfillAuditUnknownOrder += 1;
      continue;
    }
    const existing = classBBatchToOrder.get(r.batchId);
    if (existing && existing !== r.orderId) {
      batchMultiOrder.push({ batchId: r.batchId, orderA: existing, orderB: r.orderId });
      continue;
    }
    classBBatchToOrder.set(r.batchId, r.orderId);
  }

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

  let classCBatchesSkippedAsClassB = 0;
  const classCBatchToOrder = new Map();
  for (const m of matchResult.matches) {
    if (!m.batchId) continue;
    if (classBBatchToOrder.has(m.batchId)) {
      classCBatchesSkippedAsClassB += 1;
      continue;
    }
    classCBatchToOrder.set(m.batchId, m.orderId);
  }
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

  // ---- classify ------------------------------------------------------------
  const results = [];
  for (const o of orders.values()) results.push(classifyOrder(o, floors));

  const statusTotals = { full: 0, partial: 0, none: 0, over: 0, unobservable: 0 };
  const unobservableReasons = {
    historically_unobservable: 0,
    no_completed_observation: 0,
    unmapped_only: 0,
  };
  const byStore = new Map();
  let unitsUnderDeducted = 0;
  let unitsOverDeducted = 0;
  let observedUnitsTotal = 0;
  let deductedUnitsTotal = 0;

  for (const r of results) {
    statusTotals[r.status] += 1;
    if (r.status === ORDER_STATUS.UNOBSERVABLE && r.statusReason in unobservableReasons) {
      unobservableReasons[r.statusReason] += 1;
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
        unitsObserved: 0,
        unitsDeducted: 0,
        unitsUnderDeducted: 0,
        unitsOverDeducted: 0,
        unmappedItemUnits: 0,
      });
    }
    const s = byStore.get(key);
    s.orders += 1;
    s[r.status] += 1;
    s.unmappedItemUnits += r.unmapped.itemUnits;
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

  // ---- the standing disclosures that ride with every gap number -----------
  const gapDisclosures = [
    disclosure(
      "historically_unobservable_orders",
      unobservableReasons.historically_unobservable,
      "Anchored before every applicable evidence class's start date — no evidence " +
        "could have been recorded. EXCLUDED from gap totals (unavailable, never a gap)."
    ),
    disclosure(
      "no_completed_observation_orders",
      unobservableReasons.no_completed_observation,
      "No non-tombstoned fulfillment observation and no linked ledger movement — " +
        "the order is not observable as shipped. EXCLUDED from gap totals."
    ),
    disclosure(
      "unmapped_only_orders",
      unobservableReasons.unmapped_only,
      "Every observed unit is on an UNMAPPED line (productId IS NULL / isMapped=0) — " +
        "structurally undeductable. Counted in the unmapped-lines section, EXCLUDED " +
        "from gap totals."
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

  const sections = {
    scope: {
      ordersScanned: figure(
        orders.size,
        "Rows in external_orders. Projection is ids, dates, quantities and status " +
          "fields only — no customer fields, no rawPayload."
      ),
      observationGroupsScanned: figure(
        liveObsRows.length + tombstonedObsRows.length,
        "(order, product) groups in fulfillment_observations, live plus tombstoned."
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
            "batchIds claimed by fulfillment events on more than one order — dropped, " +
              "never attributed to either."
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
          unobservable:
            "Orders excluded from gap totals (pre-floor, no completed observation, or " +
            "unmapped-only). See the disclosures on orderStatus.totals for the split.",
          unmappedItemUnits:
            "Units on external_order_items rows with isMapped=0 for this store's orders.",
        }
      ),
    },

    gapTotals: {
      unitsUnderDeducted: figure(
        unitsUnderDeducted,
        DEFINITIONS.unitsUnderDeducted,
        gapDisclosures
      ),
      unitsOverDeducted: figure(unitsOverDeducted, DEFINITIONS.unitsOverDeducted, gapDisclosures),
      unitsObserved: figure(observedUnitsTotal, DEFINITIONS.observedUnits, [
        disclosure(
          "partial_refund_observation_groups",
          partialRefundRows,
          "Observation groups flagged hasPartialRefund. Woo's per-line refund quantities " +
            "are documented-buggy, so refunded units are NOT netted out here."
        ),
        disclosure(
          "fully_refunded_observation_groups",
          fullyRefundedRows,
          "Observation groups flagged isFullyRefunded. A fully-refunded order is not " +
            "`completed`, so it already resolves to 0 units."
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

    orderDetail: table(
      detailRows,
      "The gap cohort (none | partial | over), ranked by total unit difference. " +
        "Unobservable orders are absent by construction.",
      {
        evidenceClasses: "Which evidence classes supplied the linked ledger rows.",
        location: DEFINITIONS.locationLabel,
        anchorSource: DEFINITIONS.floorAnchor,
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

  return { sections, notes, meta: { orderCount: orders.size, gapCohort: gapCohort.length } };
}

module.exports = { check, title, purpose, run, FULFILLMENT_ACTION_TYPES };
