//
// Phase 0a / D1 — the PURE reconciliation logic: observability floors, evidence
// classes, per-(order, product) unit classification, and the class (c) exact
// matcher. No DB, no I/O, no argv — everything here is pinned by
// __tests__/unit/scripts/diagnostics/inventory-accuracy-classify.test.js.
//
// The evidence classes are FROZEN by the spec (2026-08-12 REV-2, §D1):
//   (a) STRONG      — a ledger internal-order key. FULL-LANE ONLY; no such
//                     column exists at this repo tip. Its slot is emitted
//                     structurally-empty with a named reason so the classifier
//                     shape does not move when it arrives.
//   (b) FULFILL-PATH— external_orders.stockedOut/stockedOutAt/fulfilledQty plus
//                     the ledger batchId -> audit_logs.batchId join on
//                     EXTERNAL_ORDER_*FULFILLMENT events (entityId = the
//                     order). NO time fence — key evidence needs none.
//                     Unfulfillment CORRECTION rows join the same way and
//                     SUBTRACT (net semantics).
//   (c) HEURISTIC   — audit `details.orderReference` vs orderNumber, EXACT
//                     normalized equality, ONE integration, +/-7d window on
//                     THIS CLASS ONLY, >1 candidate => AMBIGUOUS (its own
//                     class, never matched).
//
const { normalizeOrderNumber, foldReferenceCase } = require("./normalize");
const { DAY_MS } = require("./date-buckets");

const EVIDENCE_CLASS = { A: "a", B: "b", C: "c" };

const ORDER_STATUS = {
  FULL: "full",
  PARTIAL: "partial",
  NONE: "none",
  OVER: "over",
  UNOBSERVABLE: "unobservable",
};

/** Migration 20260411_add_stocked_out — the stockedOut feature's DB arrival. */
const STOCKED_OUT_MIGRATION_AT = new Date("2026-04-11T00:00:00.000Z");

/** Class (c) window. Applies to THIS CLASS ONLY (spec §D1). */
const CLASS_C_WINDOW_DAYS = 7;

/**
 * The Woo status under which `unitsOnCompletedOrder` is non-zero. Every other
 * status resolves the observation to 0 units, so it is this value — and only
 * this value — that separates a real over-deduction from a deduction on an
 * order Woo never reported as completed (P0S-1).
 */
const WOO_COMPLETED_STATUS = "completed";

const DEFINITIONS = {
  observedUnits:
    "Sum of fulfillment_observations.unitsOnCompletedOrder for MAPPED products " +
    "(productId NOT NULL), tombstoned rows excluded. Woo shipped-truth is 'units " +
    "on a COMPLETED order' — never per-item fulfilled quantity. Bundle lines are " +
    "already expanded to one row per frozen component at write time. SCOPED to " +
    "orders counted toward gap totals: every excluded cohort " +
    "(historically_unobservable, no_completed_observation, unmapped_only, " +
    "deducted_order_not_completed) is out of this sum and carries its own order " +
    "count AND unit count in the disclosures.",
  deductedUnits:
    "NET units removed from the ledger by rows linked to this order = -SUM(" +
    "inventory_logs.delta) over linked rows. Unfulfillment restores are POSITIVE " +
    "deltas and therefore SUBTRACT from the deduction (net semantics). SCOPED to " +
    "orders counted toward gap totals — the excluded cohorts carry their units in " +
    "the disclosures, never in this sum.",
  observedOrderStatus:
    "The Woo order status(es) carried by this order's LIVE fulfillment_observations " +
    "rows, comma-joined when they disagree; null when the order has no live " +
    "observation row at all (unknown, NOT 'not completed').",
  internalStatus:
    "external_orders.internalStatus — the APP's own order state, written by the " +
    "app's own pipeline. Independent of the Woo status above: the app's " +
    "completed-push is expected-blocked in production, so an order can be " +
    "`fulfilled` here and still not `completed` at Woo, permanently.",
  overNotCompleted:
    "OVER-deduction on an order that NO live observation reports as Woo-completed. " +
    "unitsOnCompletedOrder is 0 for every non-completed status, so the comparison " +
    "reads as over-deduction by construction rather than by evidence. Its own " +
    "cohort: EXCLUDED from unitsOverDeducted, disclosed with its own order count " +
    "and unit count.",
  unitsUnscoped:
    "The same unit arithmetic computed for EVERY order, including the cohorts " +
    "excluded from gap totals — the unit count that rides beside each excluded " +
    "cohort's order count.",
  unitsDifference:
    "observedUnits - deductedUnits at order grain (positive = under-deducted).",
  unitsUnderDeducted:
    "SUM over products of max(0, observed - deducted) — under-deduction that does " +
    "NOT cancel against over-deduction elsewhere in the same order.",
  unitsOverDeducted:
    "SUM over products of max(0, deducted - observed) — over-deduction that does " +
    "NOT cancel against under-deduction elsewhere in the same order.",
  orderStatus:
    "WORST-CASE rollup of the per-(order, product) statuses: any 'over' => over; " +
    "else all 'full' => full; else all 'none' => none; else partial. Order-level " +
    "totals alone would let an under-deducted product cancel an over-deducted one. " +
    "A (product) bucket with neither observed units nor ledger movement is DROPPED " +
    "before the rollup: observation rows exist for orders in any status and resolve " +
    "to 0 units when the order is not `completed`, so keeping them would fill 'none' " +
    "with pending and refunded orders. An order left with no scorable bucket is " +
    "`unobservable` / no_completed_observation, never a gap.",
  floorAnchor:
    "Observation completedAt when present, else the order anchor " +
    "(externalCreatedAt ?? createdAt) — the order-pipeline precedent.",
  locationLabel:
    "Location is shown ONLY where matched ledger evidence supplies it. The ledger " +
    "is a store-less shared pool, so gaps are reported at store/integration grain " +
    "with location 'unknown'.",
};

// ---------------------------------------------------------------------------
// Observability floors
// ---------------------------------------------------------------------------

function laterOf(...dates) {
  const real = dates.filter((d) => d instanceof Date);
  if (real.length === 0) return null;
  return real.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
}

/**
 * Derive the per-evidence-class start dates from structural facts read off the
 * database. Orders whose anchor predates EVERY applicable class's start are
 * `historically_unobservable`: excluded from gap totals, disclosed with a named
 * reason (tier-2 precedent — unlinked cohorts are unavailable, never gaps).
 *
 * CLASS (b) CARRIES TWO READINGS, BOTH ALWAYS EMITTED:
 *   specFrozenFloor      — the spec's literal wording ("class b starts at the
 *                          stockedOut feature's deploy").
 *   evidenceCapableFloor — the date from which class-(b) EVIDENCE CAN EXIST:
 *                          the LATER of the stockedOut floor, the first ledger
 *                          row carrying a batchId (migration 20260710150000)
 *                          and the first EXTERNAL_ORDER_*FULFILLMENT audit row
 *                          (migration 20260709164143). The join half of class
 *                          (b) is structurally impossible before those, so the
 *                          frozen reading would score months of orders as gaps
 *                          for evidence that could not have been recorded.
 * `floor` binds one of them (default: evidence-capable); the other rides in the
 * same block so no reading is lost. See the SEAMS report — this is a declared
 * deviation, not an improvisation.
 *
 * @param {{earliestStockedOutAt: Date|null, earliestLedgerBatchAt: Date|null,
 *          earliestFulfillmentAuditAt: Date|null,
 *          earliestPersistedOrderReferenceAt: Date|null}} facts
 * @param {{classBFloorMode?: 'evidence'|'spec'}} [opts]
 */
function deriveFloors(facts, opts = {}) {
  const mode = opts.classBFloorMode === "spec" ? "spec" : "evidence";

  // --- class (a) -----------------------------------------------------------
  const a = {
    classId: EVIDENCE_CLASS.A,
    applicable: false,
    floor: null,
    derivation: "not_present_in_phase_0a",
    reason:
      "Evidence class (a) (STRONG) needs a ledger internal-order key column. No " +
      "such column exists at this repo tip — it is deferred to the full lane, so " +
      "this class contributes no evidence and no gaps in Phase 0a.",
    definition:
      "Class (a): inventory_logs -> external_orders.id via a first-class ledger " +
      "column. Structurally empty until the full lane ships it.",
  };

  // --- class (b) -----------------------------------------------------------
  const earliestStockedOutAt = facts.earliestStockedOutAt ?? null;
  let specFrozenFloor;
  let specFrozenDerivation;
  if (earliestStockedOutAt && earliestStockedOutAt.getTime() >= STOCKED_OUT_MIGRATION_AT.getTime()) {
    specFrozenFloor = earliestStockedOutAt;
    specFrozenDerivation = "earliest_stocked_out_at";
  } else {
    specFrozenFloor = STOCKED_OUT_MIGRATION_AT;
    specFrozenDerivation = "stocked_out_migration_date";
  }

  const components = {
    stockedOut: specFrozenFloor,
    ledgerBatchId: facts.earliestLedgerBatchAt ?? null,
    fulfillmentAudit: facts.earliestFulfillmentAuditAt ?? null,
  };
  const joinCapable = components.ledgerBatchId !== null && components.fulfillmentAudit !== null;
  const evidenceCapableFloor = joinCapable
    ? laterOf(components.stockedOut, components.ledgerBatchId, components.fulfillmentAudit)
    : null;

  const b = {
    classId: EVIDENCE_CLASS.B,
    specFrozenFloor,
    specFrozenDerivation,
    evidenceCapableFloor,
    components,
    boundReading: mode,
    definition:
      "Class (b): ledger rows joined to EXTERNAL_ORDER_*FULFILLMENT audit events " +
      "by batchId (entityId = the ExternalOrder id). No time fence.",
  };
  if (mode === "spec") {
    b.floor = specFrozenFloor;
    b.applicable = true;
    b.derivation = `spec_frozen:${specFrozenDerivation}`;
    b.reason =
      "Bound to the spec's literal floor (the stockedOut feature's deploy). The " +
      "evidence-capable floor is emitted alongside: the ledger<->audit join half " +
      "of this class cannot produce evidence before it.";
  } else if (!joinCapable) {
    b.floor = null;
    b.applicable = false;
    b.derivation = "no_join_capable_rows";
    b.reason =
      components.ledgerBatchId === null
        ? "No inventory_logs row carries a batchId, so the class (b) ledger<->audit " +
          "join can never resolve. Class (b) contributes no evidence."
        : "No EXTERNAL_ORDER_*FULFILLMENT audit row exists, so the class (b) " +
          "ledger<->audit join can never resolve. Class (b) contributes no evidence.";
  } else {
    b.floor = evidenceCapableFloor;
    b.applicable = true;
    b.derivation = "evidence_capable:latest_of_components";
    b.reason =
      "Bound to the LATER of the stockedOut floor, the first ledger row carrying a " +
      "batchId, and the first EXTERNAL_ORDER_*FULFILLMENT audit row — the date from " +
      "which class (b) evidence can physically exist. The spec's literal floor " +
      `(${specFrozenFloor.toISOString()}) is emitted alongside.`;
  }

  // --- class (c) -----------------------------------------------------------
  const earliestRef = facts.earliestPersistedOrderReferenceAt ?? null;
  const c = earliestRef
    ? {
        classId: EVIDENCE_CLASS.C,
        applicable: true,
        floor: earliestRef,
        derivation: "earliest_persisted_order_reference",
        reason: null,
        definition:
          "Class (c): audit details.orderReference vs external_orders.orderNumber, " +
          `exact normalized equality, one integration, +/-${CLASS_C_WINDOW_DAYS}d window.`,
      }
    : {
        classId: EVIDENCE_CLASS.C,
        applicable: false,
        floor: null,
        derivation: "no_persisted_reference",
        reason:
          "No audit_logs row carries details.orderReference: the workbench's " +
          "order-reference field is typed by staff and passed into metadata but was " +
          "NEVER persisted. Phase 0b-2 starts the accrual; until it deploys this " +
          "class is STRUCTURALLY EMPTY, not zero-valued.",
        definition:
          "Class (c): audit details.orderReference vs external_orders.orderNumber, " +
          `exact normalized equality, one integration, +/-${CLASS_C_WINDOW_DAYS}d window.`,
      };

  return { a, b, c };
}

/**
 * The earliest date at which ANY evidence class can produce evidence — i.e. the
 * lower bound of the window a gap-counted order can live in. Null when no class
 * is applicable at all (structurally empty, never 0).
 * @param {ReturnType<typeof deriveFloors>} floors
 * @returns {Date|null}
 */
function earliestApplicableFloor(floors) {
  const applicable = ["a", "b", "c"]
    .map((k) => floors[k])
    .filter((f) => f && f.applicable && f.floor instanceof Date)
    .map((f) => f.floor);
  if (applicable.length === 0) return null;
  return applicable.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

/**
 * Which evidence classes are in force for an order anchored at `anchorAt`.
 * Empty => historically_unobservable.
 * @param {Date} anchorAt
 * @param {ReturnType<typeof deriveFloors>} floors
 * @returns {string[]}
 */
function observableClassesAt(anchorAt, floors) {
  const t = anchorAt instanceof Date ? anchorAt.getTime() : null;
  if (t === null) return [];
  const out = [];
  for (const key of ["a", "b", "c"]) {
    const f = floors[key];
    if (f && f.applicable && f.floor instanceof Date && t >= f.floor.getTime()) {
      out.push(f.classId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Unit classification
// ---------------------------------------------------------------------------

/**
 * Classify one observed-vs-deducted unit pair. `deducted` is NET (an
 * over-restored pair goes negative and reads as 'none', never as a credit).
 * @param {number} observed
 * @param {number} deducted
 */
function classifyUnits(observed, deducted) {
  const o = Number(observed) || 0;
  const d = Number(deducted) || 0;
  let status;
  if (d > o) status = ORDER_STATUS.OVER;
  else if (d <= 0) status = ORDER_STATUS.NONE;
  else if (d >= o) status = ORDER_STATUS.FULL;
  else status = ORDER_STATUS.PARTIAL;
  return {
    status,
    observedUnits: o,
    deductedUnits: d,
    unitsDifference: o - d,
    unitsUnderDeducted: Math.max(0, o - d),
    unitsOverDeducted: Math.max(0, d - o),
  };
}

function rollupStatus(statuses) {
  if (statuses.length === 0) return ORDER_STATUS.NONE;
  if (statuses.includes(ORDER_STATUS.OVER)) return ORDER_STATUS.OVER;
  if (statuses.every((s) => s === ORDER_STATUS.FULL)) return ORDER_STATUS.FULL;
  if (statuses.every((s) => s === ORDER_STATUS.NONE)) return ORDER_STATUS.NONE;
  return ORDER_STATUS.PARTIAL;
}

/**
 * Classify ONE order at (order, product) grain, then roll up.
 *
 * @param {{orderId: string, companyId: string, integrationId: string,
 *          orderNumber: string|null, internalStatus: string|null, anchorAt: Date,
 *          completedAt: Date|null,
 *          observations: Array<{productId: number|null, units: number, tombstonedAt: Date|null,
 *                               orderStatus: string|null}>,
 *          ledger: Array<{productId: number, locationId: number|null, delta: number, evidenceClass: string}>,
 *          unmappedItems: {itemCount: number, itemUnits: number}}} order
 * @param {ReturnType<typeof deriveFloors>} floors
 */
function classifyOrder(order, floors) {
  const floorAnchorSource = order.completedAt instanceof Date ? "observation_completed_at" : "order_anchor";
  const floorAnchorAt = order.completedAt instanceof Date ? order.completedAt : order.anchorAt;
  const observableClasses = observableClassesAt(floorAnchorAt, floors);

  // Tombstoned observations are excluded from every unit total and disclosed.
  const allObs = Array.isArray(order.observations) ? order.observations : [];
  const liveObs = allObs.filter((o) => !(o.tombstonedAt instanceof Date));
  const tombstonedObs = allObs.filter((o) => o.tombstonedAt instanceof Date);
  // `rowCount` is optional on an entry: the runner pre-aggregates observations
  // per (order, product), so an entry may stand for several raw rows. Absent it,
  // an entry counts as one row (the fixture shape).
  const tombstonedExcluded = {
    rowCount: tombstonedObs.reduce((s, o) => s + (Number(o.rowCount) || 1), 0),
    units: tombstonedObs.reduce((s, o) => s + (Number(o.units) || 0), 0),
  };

  const unmappedObservationUnits = liveObs
    .filter((o) => o.productId === null || o.productId === undefined)
    .reduce((s, o) => s + (Number(o.units) || 0), 0);
  const unmappedItems = order.unmappedItems || { itemCount: 0, itemUnits: 0 };
  const unmapped = {
    observationUnits: unmappedObservationUnits,
    itemCount: Number(unmappedItems.itemCount) || 0,
    itemUnits: Number(unmappedItems.itemUnits) || 0,
  };

  const ledger = Array.isArray(order.ledger) ? order.ledger : [];
  const locationIds = Array.from(
    new Set(ledger.map((l) => l.locationId).filter((id) => id !== null && id !== undefined))
  ).sort((x, y) => x - y);
  const evidenceClassesUsed = Array.from(new Set(ledger.map((l) => l.evidenceClass))).sort();

  // P0S-1: the Woo status the observations were written under. `completed` is
  // the ONLY status under which unitsOnCompletedOrder is non-zero, so an order
  // no live observation reports as completed cannot be compared against Woo at
  // all — it reads as over-deduction by construction. Null (no live observation
  // row) is UNKNOWN, and unknown is not evidence either.
  const observedStatuses = Array.from(
    new Set(liveObs.map((o) => o.orderStatus).filter((s) => typeof s === "string" && s.length > 0))
  ).sort();
  const observedOrderStatus = observedStatuses.length > 0 ? observedStatuses.join(",") : null;
  const observedAsCompleted = observedStatuses.includes(WOO_COMPLETED_STATUS);

  // P0S-6: the unit arithmetic for EVERY order, scored or not — the unit count
  // that rides beside each excluded cohort's order count.
  const observedUnitsUnscoped = liveObs
    .filter((o) => o.productId !== null && o.productId !== undefined)
    .reduce((s, o) => s + (Number(o.units) || 0), 0);
  const deductedUnitsUnscoped = ledger.reduce((s, l) => s - (Number(l.delta) || 0), 0);

  const base = {
    orderId: order.orderId,
    companyId: order.companyId,
    integrationId: order.integrationId,
    internalStatus: typeof order.internalStatus === "string" ? order.internalStatus : null,
    observedOrderStatus,
    observedAsCompleted,
    observableClasses,
    evidenceClassesUsed,
    floorAnchorAt,
    floorAnchorSource,
    observedUnits: 0,
    deductedUnits: 0,
    observedUnitsUnscoped,
    deductedUnitsUnscoped,
    unitsDifference: 0,
    unitsUnderDeducted: 0,
    unitsOverDeducted: 0,
    perProduct: [],
    productStatusCounts: { full: 0, partial: 0, none: 0, over: 0 },
    unmapped,
    tombstonedExcluded,
    locationIds,
    locationLabel: locationIds.length > 0 ? locationIds.join(",") : "unknown",
    countsTowardGapTotals: false,
    statusReason: null,
  };

  // FLOOR: before every applicable class's start => never a gap.
  if (observableClasses.length === 0) {
    return {
      ...base,
      status: ORDER_STATUS.UNOBSERVABLE,
      statusReason: "historically_unobservable",
    };
  }

  // Per-(order, product) accumulation. A product enters the grain if it has
  // mapped observation units OR linked ledger movement.
  const byProduct = new Map();
  const bucket = (productId) => {
    if (!byProduct.has(productId)) {
      byProduct.set(productId, { productId, observed: 0, deducted: 0, locationIds: new Set() });
    }
    return byProduct.get(productId);
  };
  for (const o of liveObs) {
    if (o.productId === null || o.productId === undefined) continue;
    bucket(o.productId).observed += Number(o.units) || 0;
  }
  for (const l of ledger) {
    const b = bucket(l.productId);
    b.deducted += -(Number(l.delta) || 0);
    if (l.locationId !== null && l.locationId !== undefined) b.locationIds.add(l.locationId);
  }

  // A bucket with neither observed units nor ledger movement carries no
  // information. fulfillment_observations rows exist for orders in ANY status
  // and resolve to 0 units when the order is not `completed`, so keeping those
  // buckets would fill the `none` cohort with pending and refunded orders that
  // nobody was ever supposed to deduct for.
  const scored = Array.from(byProduct.values()).filter((p) => p.observed !== 0 || p.deducted !== 0);

  if (scored.length === 0) {
    const reason =
      unmapped.observationUnits > 0 || unmapped.itemCount > 0
        ? "unmapped_only"
        : "no_completed_observation";
    return { ...base, status: ORDER_STATUS.UNOBSERVABLE, statusReason: reason };
  }

  const perProduct = [];
  const counts = { full: 0, partial: 0, none: 0, over: 0 };
  let observedUnits = 0;
  let deductedUnits = 0;
  let under = 0;
  let over = 0;
  for (const p of scored.sort((x, y) => x.productId - y.productId)) {
    const c = classifyUnits(p.observed, p.deducted);
    counts[c.status] += 1;
    observedUnits += c.observedUnits;
    deductedUnits += c.deductedUnits;
    under += c.unitsUnderDeducted;
    over += c.unitsOverDeducted;
    perProduct.push({
      productId: p.productId,
      status: c.status,
      observedUnits: c.observedUnits,
      deductedUnits: c.deductedUnits,
      unitsDifference: c.unitsDifference,
      locationIds: Array.from(p.locationIds).sort((x, y) => x - y),
    });
  }

  const status = rollupStatus(perProduct.map((p) => p.status));

  // P0S-1 — SPLIT the over cohort. An `over` order that no live observation
  // reports as Woo-completed is not evidence of over-deduction: every one of its
  // observation rows resolves to 0 units BECAUSE of the status, so the ledger
  // necessarily exceeds it. The app's completed-push is expected-blocked in
  // production, so this is a persistent state, not an in-flight one. Excluded
  // from gap totals, kept visible as its own named cohort with its own units.
  const notCompletedOverCohort = status === ORDER_STATUS.OVER && !observedAsCompleted;

  return {
    ...base,
    status,
    statusReason: notCompletedOverCohort ? "deducted_order_not_completed" : null,
    observedUnits,
    deductedUnits,
    unitsDifference: observedUnits - deductedUnits,
    unitsUnderDeducted: under,
    unitsOverDeducted: over,
    perProduct,
    productStatusCounts: counts,
    countsTowardGapTotals: !notCompletedOverCohort,
  };
}

// ---------------------------------------------------------------------------
// Class (c) matching
// ---------------------------------------------------------------------------

/**
 * Match persisted order references to orders by EXACT normalized equality.
 * A reference is AMBIGUOUS (its own class, never matched) when its normalized
 * token resolves to candidates in more than one integration, or to more than
 * one order inside the window. The +/-7d window applies to THIS CLASS ONLY.
 *
 * @param {Array<{auditId: number, batchId: string|null, createdAt: Date, rawReference: unknown}>} references
 * @param {Array<{orderId: string, integrationId: string, orderNumber: string|null, anchorAt: Date}>} orders
 * @param {{windowDays?: number}} [opts]
 */
function matchHeuristicReferences(references, orders, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : CLASS_C_WINDOW_DAYS;
  const windowMs = windowDays * DAY_MS;

  const byExact = new Map();
  const byFolded = new Map();
  for (const o of orders) {
    const n = normalizeOrderNumber(o.orderNumber);
    if (n === null) continue;
    if (!byExact.has(n)) byExact.set(n, []);
    byExact.get(n).push(o);
    const folded = foldReferenceCase(n);
    if (!byFolded.has(folded)) byFolded.set(folded, []);
    byFolded.get(folded).push(o);
  }

  const matches = [];
  const ambiguous = [];
  const unmatched = [];
  const disclosures = {
    referencesScanned: references.length,
    unnormalizable: 0,
    noCandidate: 0,
    outOfWindow: 0,
    ambiguousMultiIntegration: 0,
    ambiguousMultiOrder: 0,
    caseInsensitiveOnlyCandidates: 0,
    windowDays,
  };

  for (const r of references) {
    const normalized = normalizeOrderNumber(r.rawReference);
    if (normalized === null) {
      disclosures.unnormalizable += 1;
      unmatched.push({ auditId: r.auditId, batchId: r.batchId ?? null, reason: "unnormalizable" });
      continue;
    }

    const candidates = byExact.get(normalized) || [];
    if (candidates.length === 0) {
      const folded = byFolded.get(foldReferenceCase(normalized)) || [];
      if (folded.length > 0) disclosures.caseInsensitiveOnlyCandidates += 1;
      disclosures.noCandidate += 1;
      unmatched.push({
        auditId: r.auditId,
        batchId: r.batchId ?? null,
        normalizedReference: normalized,
        reason: "no_candidate",
      });
      continue;
    }

    // "Scoped to ONE integration": a token living in two integrations cannot be
    // scoped, so it is AMBIGUOUS regardless of the window (cross-store number).
    const integrations = new Set(candidates.map((c) => c.integrationId));
    if (integrations.size > 1) {
      disclosures.ambiguousMultiIntegration += 1;
      ambiguous.push({
        auditId: r.auditId,
        batchId: r.batchId ?? null,
        normalizedReference: normalized,
        candidateCount: candidates.length,
        integrationCount: integrations.size,
        candidateOrderIds: candidates.map((c) => c.orderId),
        reason: "multi_integration",
      });
      continue;
    }

    const inWindow = candidates.filter(
      (c) => Math.abs(r.createdAt.getTime() - c.anchorAt.getTime()) <= windowMs
    );
    if (inWindow.length === 0) {
      disclosures.outOfWindow += 1;
      unmatched.push({
        auditId: r.auditId,
        batchId: r.batchId ?? null,
        normalizedReference: normalized,
        reason: "out_of_window",
      });
      continue;
    }
    if (inWindow.length > 1) {
      disclosures.ambiguousMultiOrder += 1;
      ambiguous.push({
        auditId: r.auditId,
        batchId: r.batchId ?? null,
        normalizedReference: normalized,
        candidateCount: inWindow.length,
        integrationCount: integrations.size,
        candidateOrderIds: inWindow.map((c) => c.orderId),
        reason: "multi_order_in_window",
      });
      continue;
    }

    matches.push({
      auditId: r.auditId,
      batchId: r.batchId ?? null,
      orderId: inWindow[0].orderId,
      integrationId: inWindow[0].integrationId,
      normalizedReference: normalized,
    });
  }

  return { matches, ambiguous, unmatched, disclosures };
}

module.exports = {
  EVIDENCE_CLASS,
  ORDER_STATUS,
  STOCKED_OUT_MIGRATION_AT,
  CLASS_C_WINDOW_DAYS,
  WOO_COMPLETED_STATUS,
  DEFINITIONS,
  deriveFloors,
  earliestApplicableFloor,
  observableClassesAt,
  classifyUnits,
  rollupStatus,
  classifyOrder,
  matchHeuristicReferences,
};
