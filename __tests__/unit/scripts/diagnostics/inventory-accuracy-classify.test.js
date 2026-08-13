// @jest-environment node
//
// Phase 0a — unit tests for the inventory-accuracy diagnostic suite's PURE
// logic. The SQL runs ONLY against a StagingProduction restore (orchestrator
// only); everything decision-shaped lives in these modules so it can be pinned
// against authored fixtures here.
//
// Requiring these modules must be side-effect-free (no DB client, no argv
// parsing) — the runner is the only module that touches a connection.
const {
  normalizeOrderNumber,
  foldReferenceCase,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/normalize");

const {
  EVIDENCE_CLASS,
  ORDER_STATUS,
  STOCKED_OUT_MIGRATION_AT,
  WOO_COMPLETED_STATUS,
  DEFINITIONS,
  deriveFloors,
  earliestApplicableFloor,
  observableClassesAt,
  classifyUnits,
  classifyOrder,
  matchHeuristicReferences,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/classify");

const {
  walkSnapshotSeries,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/snapshot-walk");

const {
  buildClassBAttribution,
  selectClassCBatches,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/attribute");

const {
  rollupLineGrain,
  splitUnitsByLogType,
  summarizeUnattributedPool,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/rollups");

const {
  weekStartKey,
  monthKey,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/date-buckets");

const {
  MASS_UPDATE_LABEL,
  classifyMassUpdateBatch,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/mass-update");

// ---------------------------------------------------------------------------
// Fixture clock. Real structural dates from the repo's migration history:
//   2026-04-11 stockedOut columns   (20260411_add_stocked_out)
//   2026-07-09 change-tracking      (20260709164143_change_tracking_foundation)
//   2026-07-10 inventory_logs.batchId (20260710150000_inventory_logs_batch_id)
// ---------------------------------------------------------------------------
const D = (s) => new Date(s);

const FLOOR_INPUT_FULL = {
  earliestStockedOutAt: D("2026-04-20T00:00:00.000Z"),
  earliestLedgerBatchAt: D("2026-07-14T10:00:00.000Z"),
  earliestFulfillmentAuditAt: D("2026-07-14T09:00:00.000Z"),
  earliestPersistedOrderReferenceAt: null,
};

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------
describe("normalizeOrderNumber — trim + strip leading '#', nothing else (frozen)", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeOrderNumber("  12345 ")).toBe("12345");
  });

  test("strips leading '#' (including repeats) and re-trims", () => {
    expect(normalizeOrderNumber("#12345")).toBe("12345");
    expect(normalizeOrderNumber("  ## 12345")).toBe("12345");
  });

  test("does NOT fuzzy-parse: embedded numbers stay whole strings", () => {
    expect(normalizeOrderNumber("order 12345 for jane")).toBe("order 12345 for jane");
  });

  test("empty / non-string / whitespace-only => null (unnormalizable)", () => {
    expect(normalizeOrderNumber("")).toBeNull();
    expect(normalizeOrderNumber("   ")).toBeNull();
    expect(normalizeOrderNumber("#")).toBeNull();
    expect(normalizeOrderNumber(null)).toBeNull();
    expect(normalizeOrderNumber(undefined)).toBeNull();
    expect(normalizeOrderNumber(12345)).toBeNull();
  });

  test("case is PRESERVED — equality is exact, case-folding is disclosure only", () => {
    expect(normalizeOrderNumber("AR-100")).toBe("AR-100");
    expect(foldReferenceCase("AR-100")).toBe("ar-100");
    expect(foldReferenceCase(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// observability floors
// ---------------------------------------------------------------------------
describe("deriveFloors — per-evidence-class start dates", () => {
  test("class (a) is structurally empty in 0a with a named reason", () => {
    const f = deriveFloors(FLOOR_INPUT_FULL);
    expect(f.a.applicable).toBe(false);
    expect(f.a.floor).toBeNull();
    expect(typeof f.a.reason).toBe("string");
    expect(f.a.reason.length).toBeGreaterThan(0);
  });

  test("class (b) spec-frozen floor uses earliest stockedOutAt when it is at/after the migration", () => {
    const f = deriveFloors(FLOOR_INPUT_FULL);
    expect(f.b.specFrozenFloor).toEqual(D("2026-04-20T00:00:00.000Z"));
    expect(f.b.specFrozenDerivation).toBe("earliest_stocked_out_at");
  });

  test("class (b) spec-frozen floor falls back to the migration date when the earliest stockedOutAt precedes it (backfill contamination)", () => {
    const f = deriveFloors({
      ...FLOOR_INPUT_FULL,
      earliestStockedOutAt: D("2026-01-05T00:00:00.000Z"),
    });
    expect(f.b.specFrozenFloor).toEqual(STOCKED_OUT_MIGRATION_AT);
    expect(f.b.specFrozenDerivation).toBe("stocked_out_migration_date");
  });

  test("class (b) evidence-capable floor is the LATEST structural component (the ledger<->audit join)", () => {
    const f = deriveFloors(FLOOR_INPUT_FULL);
    expect(f.b.evidenceCapableFloor).toEqual(D("2026-07-14T10:00:00.000Z"));
    expect(f.b.floor).toEqual(f.b.evidenceCapableFloor); // default mode
    expect(f.b.applicable).toBe(true);
  });

  test("classBFloorMode:'spec' binds the frozen reading instead, keeping both on the record", () => {
    const f = deriveFloors(FLOOR_INPUT_FULL, { classBFloorMode: "spec" });
    expect(f.b.floor).toEqual(f.b.specFrozenFloor);
    expect(f.b.evidenceCapableFloor).toEqual(D("2026-07-14T10:00:00.000Z"));
  });

  test("class (b) is INAPPLICABLE when no ledger row ever carried a batchId", () => {
    const f = deriveFloors({ ...FLOOR_INPUT_FULL, earliestLedgerBatchAt: null });
    expect(f.b.applicable).toBe(false);
    expect(f.b.floor).toBeNull();
    expect(f.b.reason).toMatch(/batchId/i);
  });

  test("class (c) is empty pre-0b with a named reason", () => {
    const f = deriveFloors(FLOOR_INPUT_FULL);
    expect(f.c.applicable).toBe(false);
    expect(f.c.floor).toBeNull();
    expect(f.c.reason).toMatch(/orderReference/);
  });

  test("class (c) becomes applicable at the earliest persisted reference", () => {
    const f = deriveFloors({
      ...FLOOR_INPUT_FULL,
      earliestPersistedOrderReferenceAt: D("2026-09-01T00:00:00.000Z"),
    });
    expect(f.c.applicable).toBe(true);
    expect(f.c.floor).toEqual(D("2026-09-01T00:00:00.000Z"));
  });

  // P0S-3 — the unattributed-outbound pool is scoped to the window in which a
  // gap-counted order can live: the EARLIEST applicable class floor.
  test("earliestApplicableFloor is the earliest applicable class's floor", () => {
    const f = deriveFloors({
      ...FLOOR_INPUT_FULL,
      earliestPersistedOrderReferenceAt: D("2026-09-01T00:00:00.000Z"),
    });
    expect(earliestApplicableFloor(f)).toEqual(D("2026-07-14T10:00:00.000Z"));
  });

  test("earliestApplicableFloor is null when NO class is applicable (structurally empty, never 0)", () => {
    const f = deriveFloors({
      earliestStockedOutAt: null,
      earliestLedgerBatchAt: null,
      earliestFulfillmentAuditAt: null,
      earliestPersistedOrderReferenceAt: null,
    });
    expect(earliestApplicableFloor(f)).toBeNull();
  });

  test("observableClassesAt returns only classes whose floor has been reached", () => {
    const f = deriveFloors({
      ...FLOOR_INPUT_FULL,
      earliestPersistedOrderReferenceAt: D("2026-09-01T00:00:00.000Z"),
    });
    expect(observableClassesAt(D("2026-05-01T00:00:00.000Z"), f)).toEqual([]);
    expect(observableClassesAt(D("2026-07-20T00:00:00.000Z"), f)).toEqual([EVIDENCE_CLASS.B]);
    expect(observableClassesAt(D("2026-09-02T00:00:00.000Z"), f)).toEqual([
      EVIDENCE_CLASS.B,
      EVIDENCE_CLASS.C,
    ]);
  });
});

// ---------------------------------------------------------------------------
// unit classification
// ---------------------------------------------------------------------------
describe("classifyUnits — observed vs deducted, net semantics", () => {
  test.each([
    [10, 10, ORDER_STATUS.FULL],
    [10, 4, ORDER_STATUS.PARTIAL],
    [10, 0, ORDER_STATUS.NONE],
    [10, 12, ORDER_STATUS.OVER],
    [0, 3, ORDER_STATUS.OVER],
    [0, 0, ORDER_STATUS.NONE],
    [10, -2, ORDER_STATUS.NONE], // net RESTORE beyond the deduction
  ])("observed=%i deducted=%i => %s", (observed, deducted, expected) => {
    expect(classifyUnits(observed, deducted).status).toBe(expected);
  });

  test("carries non-cancelling under/over unit differences", () => {
    expect(classifyUnits(10, 4)).toMatchObject({
      unitsDifference: 6,
      unitsUnderDeducted: 6,
      unitsOverDeducted: 0,
    });
    expect(classifyUnits(10, 12)).toMatchObject({
      unitsDifference: -2,
      unitsUnderDeducted: 0,
      unitsOverDeducted: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// classifyOrder
// ---------------------------------------------------------------------------
const FLOORS = deriveFloors(FLOOR_INPUT_FULL);
const POST_FLOOR = D("2026-07-20T12:00:00.000Z");

function order(overrides) {
  return {
    orderId: "ord_1",
    companyId: "co_1",
    integrationId: "int_1",
    orderNumber: "1001",
    internalStatus: "fulfilled",
    anchorAt: POST_FLOOR,
    completedAt: POST_FLOOR,
    observations: [],
    tombstoned: { rowCount: 0, units: 0 },
    ledger: [],
    unmappedItems: { itemCount: 0, itemUnits: 0 },
    ...overrides,
  };
}

// An observation row carries the Woo order status it was written under:
// `unitsOnCompletedOrder` is 0 unless that status is `completed`, so the status
// is what separates a real over-deduction from a deduction on an order Woo
// never reported as completed (P0S-1).
const obs = (productId, units, tombstonedAt = null, orderStatus = WOO_COMPLETED_STATUS) => ({
  productId,
  units,
  tombstonedAt,
  orderStatus,
});
const led = (productId, delta, locationId = 1, evidenceClass = EVIDENCE_CLASS.B) => ({
  productId,
  locationId,
  delta,
  evidenceClass,
});

describe("classifyOrder", () => {
  test("PARTIAL fulfillment: 10 observed, 4 deducted", () => {
    const r = classifyOrder(
      order({ observations: [obs(7, 10)], ledger: [led(7, -4)] }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.PARTIAL);
    expect(r.observedUnits).toBe(10);
    expect(r.deductedUnits).toBe(4);
    expect(r.unitsUnderDeducted).toBe(6);
    expect(r.evidenceClassesUsed).toEqual([EVIDENCE_CLASS.B]);
    expect(r.locationIds).toEqual([1]);
  });

  test("FULL REVERSAL nets to zero => none, NOT full (net semantics)", () => {
    const r = classifyOrder(
      order({ observations: [obs(7, 5)], ledger: [led(7, -5), led(7, +5)] }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.NONE);
    expect(r.deductedUnits).toBe(0);
    expect(r.unitsUnderDeducted).toBe(5);
  });

  test("OVER-deduction: deducted exceeds observed", () => {
    const r = classifyOrder(
      order({ observations: [obs(7, 3)], ledger: [led(7, -8)] }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.OVER);
    expect(r.unitsOverDeducted).toBe(5);
  });

  test("deduction with NO observation at all => over, reason named", () => {
    const r = classifyOrder(order({ observations: [], ledger: [led(7, -2)] }), FLOORS);
    expect(r.status).toBe(ORDER_STATUS.OVER);
    expect(r.observedUnits).toBe(0);
    expect(r.deductedUnits).toBe(2);
    // P0S-1: nothing observed the order as COMPLETED, so this is not evidence of
    // over-deduction — it is a deduction we cannot confirm against Woo.
    expect(r.observedOrderStatus).toBeNull();
    expect(r.statusReason).toBe("deducted_order_not_completed");
    expect(r.countsTowardGapTotals).toBe(false);
  });

  test("mixed products roll up WORST-CASE, and unit differences do not cancel", () => {
    const r = classifyOrder(
      order({
        observations: [obs(7, 10), obs(8, 5)],
        ledger: [led(7, -10), led(8, 0)],
      }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.PARTIAL);
    expect(r.unitsUnderDeducted).toBe(5);
    expect(r.unitsOverDeducted).toBe(0);
    expect(r.productStatusCounts).toMatchObject({ full: 1, none: 1 });
  });

  test("one over-deducted product dominates an otherwise-full order", () => {
    const r = classifyOrder(
      order({
        observations: [obs(7, 10), obs(8, 5)],
        ledger: [led(7, -10), led(8, -9)],
      }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.OVER);
    expect(r.unitsOverDeducted).toBe(4);
    expect(r.unitsUnderDeducted).toBe(0);
  });

  test("TOMBSTONED observations are excluded from observed units and disclosed", () => {
    const r = classifyOrder(
      order({
        observations: [obs(7, 10), obs(7, 4, D("2026-07-25T00:00:00.000Z"))],
        ledger: [led(7, -10)],
      }),
      FLOORS
    );
    expect(r.observedUnits).toBe(10);
    expect(r.status).toBe(ORDER_STATUS.FULL);
    expect(r.tombstonedExcluded).toMatchObject({ rowCount: 1, units: 4 });
  });

  test("PRE-FLOOR order => unobservable/historically_unobservable, excluded from gap totals", () => {
    const r = classifyOrder(
      order({
        anchorAt: D("2026-05-01T00:00:00.000Z"),
        completedAt: D("2026-05-02T00:00:00.000Z"),
        observations: [obs(7, 10)],
        ledger: [],
      }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.UNOBSERVABLE);
    expect(r.statusReason).toBe("historically_unobservable");
    expect(r.countsTowardGapTotals).toBe(false);
  });

  // -------------------------------------------------------------------------
  // P0S-1 — the OVER cohort is SPLIT by whether Woo ever reported the order as
  // completed. The app's completed-push is expected-blocked in production, so a
  // deducted-but-not-completed order is a PERSISTENT state, not an in-flight one.
  // -------------------------------------------------------------------------
  describe("over cohort split (P0S-1)", () => {
    test("OVER on a Woo-COMPLETED order stays in the gap totals", () => {
      const r = classifyOrder(
        order({ observations: [obs(7, 3)], ledger: [led(7, -8)] }),
        FLOORS
      );
      expect(r.status).toBe(ORDER_STATUS.OVER);
      expect(r.observedOrderStatus).toBe("completed");
      expect(r.observedAsCompleted).toBe(true);
      expect(r.statusReason).toBeNull();
      expect(r.countsTowardGapTotals).toBe(true);
      expect(r.unitsOverDeducted).toBe(5);
    });

    test("deducted while Woo says the order is NOT completed => excluded from gap totals with a named reason", () => {
      const r = classifyOrder(
        order({
          internalStatus: "fulfilled",
          observations: [obs(7, 0, null, "processing")],
          ledger: [led(7, -6)],
        }),
        FLOORS
      );
      expect(r.status).toBe(ORDER_STATUS.OVER);
      expect(r.observedOrderStatus).toBe("processing");
      expect(r.observedAsCompleted).toBe(false);
      expect(r.statusReason).toBe("deducted_order_not_completed");
      expect(r.countsTowardGapTotals).toBe(false);
      // The units are still CARRIED (the cohort is disclosed with its own unit
      // count) — they are simply not folded into unitsOverDeducted.
      expect(r.deductedUnitsUnscoped).toBe(6);
      expect(r.observedUnitsUnscoped).toBe(0);
    });

    test("the observed Woo status and the app's internalStatus are BOTH carried onto the result", () => {
      const r = classifyOrder(
        order({
          internalStatus: "cancelled",
          observations: [obs(7, 10, null, "refunded")],
          ledger: [led(7, -10)],
        }),
        FLOORS
      );
      expect(r.internalStatus).toBe("cancelled");
      expect(r.observedOrderStatus).toBe("refunded");
    });

    test("a mixed observed status counts as completed when ANY live row says completed", () => {
      const r = classifyOrder(
        order({
          observations: [obs(7, 10, null, "completed"), obs(8, 0, null, "processing")],
          ledger: [led(7, -12)],
        }),
        FLOORS
      );
      expect(r.observedOrderStatus).toBe("completed,processing");
      expect(r.observedAsCompleted).toBe(true);
      expect(r.countsTowardGapTotals).toBe(true);
    });

    test("a NON-over order is never excluded by the completed test", () => {
      const r = classifyOrder(
        order({ observations: [obs(7, 10, null, "completed")], ledger: [led(7, -4)] }),
        FLOORS
      );
      expect(r.status).toBe(ORDER_STATUS.PARTIAL);
      expect(r.countsTowardGapTotals).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // P0S-6 — every excluded cohort needs a UNIT count beside its order count, so
  // the classifier carries UNSCOPED unit totals for orders it does not score.
  // -------------------------------------------------------------------------
  describe("unscoped unit totals for excluded cohorts (P0S-6)", () => {
    test("a pre-floor order carries its observed/deducted units unscoped, while the scored figures stay 0", () => {
      const r = classifyOrder(
        order({
          anchorAt: D("2026-05-01T00:00:00.000Z"),
          completedAt: D("2026-05-02T00:00:00.000Z"),
          observations: [obs(7, 10)],
          ledger: [led(7, -4)],
        }),
        FLOORS
      );
      expect(r.statusReason).toBe("historically_unobservable");
      expect(r.observedUnits).toBe(0);
      expect(r.deductedUnits).toBe(0);
      expect(r.observedUnitsUnscoped).toBe(10);
      expect(r.deductedUnitsUnscoped).toBe(4);
    });

    test("a no_completed_observation order is 0 units BY CONSTRUCTION, not by omission", () => {
      const r = classifyOrder(order({ completedAt: null, observations: [] }), FLOORS);
      expect(r.statusReason).toBe("no_completed_observation");
      expect(r.observedUnitsUnscoped).toBe(0);
      expect(r.deductedUnitsUnscoped).toBe(0);
    });

    test("an unmapped_only order carries its unmapped units", () => {
      const r = classifyOrder(
        order({ observations: [obs(null, 6)], unmappedItems: { itemCount: 1, itemUnits: 6 } }),
        FLOORS
      );
      expect(r.statusReason).toBe("unmapped_only");
      expect(r.observedUnitsUnscoped).toBe(0);
      expect(r.unmapped).toMatchObject({ observationUnits: 6, itemUnits: 6 });
    });

    test("a scored order's unscoped totals equal its scored totals", () => {
      const r = classifyOrder(
        order({ observations: [obs(7, 10)], ledger: [led(7, -4)] }),
        FLOORS
      );
      expect(r.observedUnitsUnscoped).toBe(r.observedUnits);
      expect(r.deductedUnitsUnscoped).toBe(r.deductedUnits);
    });
  });

  test("no completed observation and no ledger evidence => unobservable, not a gap", () => {
    const r = classifyOrder(order({ completedAt: null, observations: [] }), FLOORS);
    expect(r.status).toBe(ORDER_STATUS.UNOBSERVABLE);
    expect(r.statusReason).toBe("no_completed_observation");
    expect(r.countsTowardGapTotals).toBe(false);
  });

  test("observation rows carrying ZERO units are not a gap — a pending/refunded order is unobservable", () => {
    // fulfillment_observations rows exist for orders in ANY status and resolve to
    // 0 units when the order is not `completed`. Those must never inflate `none`.
    const r = classifyOrder(order({ observations: [obs(7, 0), obs(8, 0)], ledger: [] }), FLOORS);
    expect(r.status).toBe(ORDER_STATUS.UNOBSERVABLE);
    expect(r.statusReason).toBe("no_completed_observation");
    expect(r.countsTowardGapTotals).toBe(false);
    expect(r.perProduct).toHaveLength(0);
  });

  test("a zero-unit product alongside a real one is dropped, not scored as 'none'", () => {
    const r = classifyOrder(
      order({ observations: [obs(7, 10), obs(8, 0)], ledger: [led(7, -10)] }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.FULL);
    expect(r.perProduct.map((p) => p.productId)).toEqual([7]);
    expect(r.productStatusCounts).toMatchObject({ full: 1, none: 0 });
  });

  test("only UNMAPPED observation units => unobservable/unmapped_only, reported separately", () => {
    const r = classifyOrder(
      order({ observations: [obs(null, 6)], unmappedItems: { itemCount: 1, itemUnits: 6 } }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.UNOBSERVABLE);
    expect(r.statusReason).toBe("unmapped_only");
    expect(r.unmapped).toMatchObject({ observationUnits: 6, itemCount: 1, itemUnits: 6 });
    expect(r.observedUnits).toBe(0);
    expect(r.countsTowardGapTotals).toBe(false);
  });

  test("unmapped units never leak into observed units on a mapped order", () => {
    const r = classifyOrder(
      order({ observations: [obs(7, 10), obs(null, 6)], ledger: [led(7, -10)] }),
      FLOORS
    );
    expect(r.observedUnits).toBe(10);
    expect(r.status).toBe(ORDER_STATUS.FULL);
    expect(r.unmapped.observationUnits).toBe(6);
  });

  test("floor anchor falls back to the order anchor when completedAt is null", () => {
    const r = classifyOrder(
      order({
        completedAt: null,
        anchorAt: D("2026-05-01T00:00:00.000Z"),
        ledger: [led(7, -2)],
      }),
      FLOORS
    );
    expect(r.status).toBe(ORDER_STATUS.UNOBSERVABLE);
    expect(r.statusReason).toBe("historically_unobservable");
    expect(r.floorAnchorSource).toBe("order_anchor");
  });

  test("locations come ONLY from matched ledger evidence; unknown otherwise", () => {
    const gap = classifyOrder(order({ observations: [obs(7, 10)], ledger: [] }), FLOORS);
    expect(gap.status).toBe(ORDER_STATUS.NONE);
    expect(gap.locationIds).toEqual([]);
    expect(gap.locationLabel).toBe("unknown");

    const matched = classifyOrder(
      order({ observations: [obs(7, 10)], ledger: [led(7, -10, 3)] }),
      FLOORS
    );
    expect(matched.locationIds).toEqual([3]);
    expect(matched.locationLabel).toBe("3");
  });
});

// ---------------------------------------------------------------------------
// class (c) heuristic matching
// ---------------------------------------------------------------------------
const ORDERS_FOR_MATCH = [
  { orderId: "o_a", integrationId: "int_1", orderNumber: "1001", anchorAt: D("2026-09-01T00:00:00.000Z") },
  { orderId: "o_b", integrationId: "int_2", orderNumber: "1001", anchorAt: D("2026-09-01T00:00:00.000Z") },
  { orderId: "o_c", integrationId: "int_1", orderNumber: "2002", anchorAt: D("2026-09-01T00:00:00.000Z") },
  { orderId: "o_d", integrationId: "int_1", orderNumber: "3003", anchorAt: D("2026-01-01T00:00:00.000Z") },
  { orderId: "o_e", integrationId: "int_1", orderNumber: "AR-9", anchorAt: D("2026-09-01T00:00:00.000Z") },
  // Two orders in the SAME integration carrying the same number, both inside the
  // window: the other ambiguity branch (P0S-7a).
  { orderId: "o_f", integrationId: "int_1", orderNumber: "4004", anchorAt: D("2026-09-01T00:00:00.000Z") },
  { orderId: "o_g", integrationId: "int_1", orderNumber: "4004", anchorAt: D("2026-09-03T00:00:00.000Z") },
];

const ref = (id, raw, createdAt = D("2026-09-02T00:00:00.000Z")) => ({
  auditId: id,
  batchId: `batch_${id}`,
  createdAt,
  rawReference: raw,
});

describe("matchHeuristicReferences — exact normalized equality, ±7d, one integration", () => {
  test("exact match inside the window resolves to one order", () => {
    const out = matchHeuristicReferences([ref(1, "#2002")], ORDERS_FOR_MATCH);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({ auditId: 1, orderId: "o_c", normalizedReference: "2002" });
    expect(out.ambiguous).toHaveLength(0);
  });

  test("AMBIGUOUS: the same order number exists in two integrations (cross-store)", () => {
    const out = matchHeuristicReferences([ref(2, "1001")], ORDERS_FOR_MATCH);
    expect(out.matches).toHaveLength(0);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0]).toMatchObject({
      auditId: 2,
      normalizedReference: "1001",
      candidateCount: 2,
      integrationCount: 2,
      reason: "multi_integration",
    });
  });

  test("AMBIGUOUS: two orders in the SAME integration match inside the window (P0S-7a)", () => {
    const out = matchHeuristicReferences([ref(20, "4004")], ORDERS_FOR_MATCH);
    expect(out.matches).toHaveLength(0);
    expect(out.ambiguous).toHaveLength(1);
    expect(out.ambiguous[0]).toMatchObject({
      auditId: 20,
      normalizedReference: "4004",
      candidateCount: 2,
      integrationCount: 1,
      reason: "multi_order_in_window",
    });
    expect(out.ambiguous[0].candidateOrderIds.sort()).toEqual(["o_f", "o_g"]);
    expect(out.disclosures.ambiguousMultiOrder).toBe(1);
  });

  test("same-integration duplicates are NOT ambiguous when only ONE falls inside the window", () => {
    const out = matchHeuristicReferences(
      // 8 days from o_f (out of window), 6 days from o_g (inside it).
      [ref(21, "4004", D("2026-09-09T00:00:00.000Z"))],
      ORDERS_FOR_MATCH
    );
    expect(out.ambiguous).toHaveLength(0);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({ orderId: "o_g" });
  });

  test("OUT OF WINDOW: candidate exists but is more than 7 days from the audit row", () => {
    const out = matchHeuristicReferences([ref(3, "3003")], ORDERS_FOR_MATCH);
    expect(out.matches).toHaveLength(0);
    expect(out.unmatched[0]).toMatchObject({ auditId: 3, reason: "out_of_window" });
  });

  test("the ±7d window is inclusive at exactly 7 days", () => {
    const out = matchHeuristicReferences(
      [ref(4, "2002", D("2026-09-08T00:00:00.000Z"))],
      ORDERS_FOR_MATCH
    );
    expect(out.matches).toHaveLength(1);
  });

  test("no candidate at all", () => {
    const out = matchHeuristicReferences([ref(5, "999999")], ORDERS_FOR_MATCH);
    expect(out.unmatched[0]).toMatchObject({ auditId: 5, reason: "no_candidate" });
  });

  test("unnormalizable reference is its own reason, never a match", () => {
    const out = matchHeuristicReferences([ref(6, "  # ")], ORDERS_FOR_MATCH);
    expect(out.unmatched[0]).toMatchObject({ auditId: 6, reason: "unnormalizable" });
  });

  test("case-differing references do NOT match (frozen exact equality) but ARE disclosed", () => {
    const out = matchHeuristicReferences([ref(7, "ar-9")], ORDERS_FOR_MATCH);
    expect(out.matches).toHaveLength(0);
    expect(out.unmatched[0]).toMatchObject({ auditId: 7, reason: "no_candidate" });
    expect(out.disclosures.caseInsensitiveOnlyCandidates).toBe(1);
  });

  test("no fuzzy parsing: free text containing the number never matches", () => {
    const out = matchHeuristicReferences([ref(8, "order 2002 rush")], ORDERS_FOR_MATCH);
    expect(out.matches).toHaveLength(0);
    expect(out.unmatched[0].reason).toBe("no_candidate");
  });
});

// ---------------------------------------------------------------------------
// D1 attribution munging (P0S-4 / P0S-7b) — extracted from d1-reconciliation.js
// so every decision-shaped branch is pinned here instead of running only
// against a restore.
// ---------------------------------------------------------------------------
const ev = (auditId, batchId, orderId) => ({ auditId, batchId, orderId });
const KNOWN_ORDERS = new Set(["o_1", "o_2", "o_3"]);
const isKnown = (id) => KNOWN_ORDERS.has(id);

describe("buildClassBAttribution — batchId -> order, and what happens on conflict", () => {
  test("a batchId claimed by ONE order is attributed to it", () => {
    const out = buildClassBAttribution([ev(1, "b_1", "o_1")], isKnown);
    expect(out.batchToOrder.get("b_1")).toBe("o_1");
    expect(out.conflicts).toHaveLength(0);
  });

  test("several events from the SAME order on one batch are not a conflict", () => {
    const out = buildClassBAttribution(
      [ev(1, "b_1", "o_1"), ev(2, "b_1", "o_1"), ev(3, "b_1", "o_1")],
      isKnown
    );
    expect(out.batchToOrder.get("b_1")).toBe("o_1");
    expect(out.conflicts).toHaveLength(0);
  });

  test("P0S-4: a batchId claimed by TWO orders is dropped from BOTH — never first-wins", () => {
    const out = buildClassBAttribution([ev(1, "b_1", "o_1"), ev(2, "b_1", "o_2")], isKnown);
    expect(out.batchToOrder.has("b_1")).toBe(false);
    expect(out.conflicts).toEqual([{ batchId: "b_1", orderIds: ["o_1", "o_2"] }]);
    expect(out.conflictedBatchIds.has("b_1")).toBe(true);
  });

  test("a later event cannot RESURRECT a conflicted batchId", () => {
    const out = buildClassBAttribution(
      [ev(1, "b_1", "o_1"), ev(2, "b_1", "o_2"), ev(3, "b_1", "o_1"), ev(4, "b_1", "o_3")],
      isKnown
    );
    expect(out.batchToOrder.has("b_1")).toBe(false);
    expect(out.conflicts[0].orderIds).toEqual(["o_1", "o_2", "o_3"]);
  });

  test("a conflict on one batch never disturbs a clean one", () => {
    const out = buildClassBAttribution(
      [ev(1, "b_1", "o_1"), ev(2, "b_1", "o_2"), ev(3, "b_2", "o_3")],
      isKnown
    );
    expect(out.batchToOrder.get("b_2")).toBe("o_3");
    expect(out.batchToOrder.size).toBe(1);
  });

  test("events with NO batchId and events on unknown orders are counted, never attributed", () => {
    const out = buildClassBAttribution(
      [ev(1, null, "o_1"), ev(2, "", "o_1"), ev(3, "b_9", "o_gone"), ev(4, "b_1", "o_1")],
      isKnown
    );
    expect(out.eventsWithoutBatch).toBe(2);
    expect(out.eventsWithUnknownOrder).toBe(1);
    expect(Array.from(out.batchToOrder.keys())).toEqual(["b_1"]);
  });
});

describe("selectClassCBatches — class (c) never overrides the stronger class (b)", () => {
  const m = (batchId, orderId) => ({ batchId, orderId });

  test("a matched reference whose batch is already class (b) is skipped, never double-counted", () => {
    const out = selectClassCBatches([m("b_1", "o_2")], new Set(["b_1"]));
    expect(out.batchToOrder.size).toBe(0);
    expect(out.skippedAsClassB).toBe(1);
  });

  test("a free batch is attributed", () => {
    const out = selectClassCBatches([m("b_5", "o_2")], new Set(["b_1"]));
    expect(out.batchToOrder.get("b_5")).toBe("o_2");
  });

  test("two references claiming ONE batch for different orders drop both (same rule as class b)", () => {
    const out = selectClassCBatches([m("b_5", "o_1"), m("b_5", "o_2")], new Set());
    expect(out.batchToOrder.has("b_5")).toBe(false);
    expect(out.conflicts).toEqual([{ batchId: "b_5", orderIds: ["o_1", "o_2"] }]);
  });

  test("matches carrying no batchId are counted, never attributed", () => {
    const out = selectClassCBatches([m(null, "o_1")], new Set());
    expect(out.matchesWithoutBatch).toBe(1);
    expect(out.batchToOrder.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rollups (P0S-2 / P0S-3 / P0S-5)
// ---------------------------------------------------------------------------
describe("rollupLineGrain — observed vs app-recorded fulfilledQty, monthly (P0S-2)", () => {
  const pair = (o) => ({
    orderId: "ord_1",
    month: "2026-05",
    productId: 7,
    lineCount: 1,
    orderedUnits: 0,
    appFulfilledUnits: 0,
    observedUnits: 0,
    ...o,
  });

  test("drift does NOT cancel across pairs (house rule)", () => {
    const out = rollupLineGrain([
      pair({ orderId: "a", orderedUnits: 10, appFulfilledUnits: 0, observedUnits: 10 }),
      pair({ orderId: "b", productId: 8, orderedUnits: 4, appFulfilledUnits: 4, observedUnits: 0 }),
    ]);
    expect(out.totals.unitsObservedNotAppFulfilled).toBe(10);
    expect(out.totals.unitsAppFulfilledNotObserved).toBe(4);
    expect(out.totals.pairs).toBe(2);
    expect(out.totals.orders).toBe(2);
    expect(out.totals.pairsWithDrift).toBe(2);
  });

  test("a pair where the two agree contributes no drift", () => {
    const out = rollupLineGrain([pair({ orderedUnits: 5, appFulfilledUnits: 5, observedUnits: 5 })]);
    expect(out.totals.unitsObservedNotAppFulfilled).toBe(0);
    expect(out.totals.unitsAppFulfilledNotObserved).toBe(0);
    expect(out.totals.pairsWithDrift).toBe(0);
  });

  test("months are bucketed and sorted, and orders are counted DISTINCT per month", () => {
    const out = rollupLineGrain([
      pair({ orderId: "a", month: "2026-06", observedUnits: 3 }),
      pair({ orderId: "a", month: "2026-06", productId: 8, observedUnits: 2 }),
      pair({ orderId: "b", month: "2026-05", observedUnits: 1 }),
    ]);
    expect(out.byMonth.map((r) => r.month)).toEqual(["2026-05", "2026-06"]);
    expect(out.byMonth[1]).toMatchObject({
      month: "2026-06",
      pairs: 2,
      orders: 1,
      observedUnits: 5,
      unitsObservedNotAppFulfilled: 5,
    });
    expect(out.totals.orders).toBe(2);
  });

  test("an empty panel is empty, not zero-filled", () => {
    const out = rollupLineGrain([]);
    expect(out.byMonth).toEqual([]);
    expect(out.totals.pairs).toBe(0);
  });
});

describe("splitUnitsByLogType — D2 scope figures stop being pool-level (P0S-5)", () => {
  test("rows are carried per logType and the totals are their sum", () => {
    const out = splitUnitsByLogType([
      { logType: "TRANSFER", rowCount: 4, positiveUnits: 50, negativeUnits: 50 },
      { logType: "ADJUSTMENT", rowCount: 2, positiveUnits: 30, negativeUnits: 5 },
    ]);
    expect(out.rows.map((r) => r.logType)).toEqual(["ADJUSTMENT", "TRANSFER"]);
    expect(out.totals).toMatchObject({ rowCount: 6, positiveUnits: 80, negativeUnits: 55 });
  });

  test("TRANSFER legs are visible as their own row (the whole point of the split)", () => {
    const out = splitUnitsByLogType([
      { logType: "TRANSFER", rowCount: 4, positiveUnits: 50, negativeUnits: 50 },
    ]);
    expect(out.byLogType.TRANSFER).toMatchObject({ positiveUnits: 50, negativeUnits: 50 });
  });

  test("no rows => empty split and zero totals", () => {
    const out = splitUnitsByLogType([]);
    expect(out.rows).toEqual([]);
    expect(out.totals).toMatchObject({ rowCount: 0, positiveUnits: 0, negativeUnits: 0 });
  });
});

// ---------------------------------------------------------------------------
// D2 mass-update discriminator (extracted from d2-inbound.js so it can be
// pinned). Phase 0b-1 adds the FORWARD-COMPAT branch: post-deploy the route
// stamps logType COUNT, which identifies the operation directly.
// ---------------------------------------------------------------------------
describe("classifyMassUpdateBatch — historical audit shape + the 0b-1 COUNT branch", () => {
  const bulk = ["INVENTORY_BULK_UPDATE"];

  describe("the FROZEN historical discriminator (pre-0b-1 batches)", () => {
    test("INVENTORY_BULK_UPDATE + details.rows + no SALE row => mass update", () => {
      const out = classifyMassUpdateBatch({
        auditActionTypes: bulk,
        logTypes: ["ADJUSTMENT"],
        hasRowsShape: true,
      });
      expect(out.isMassUpdate).toBe(true);
      expect(out.isMassUpdateRowsOmitted).toBe(false);
      expect(out.evidence).toContain("audit-rows-shape");
    });

    test("a SALE row disqualifies it — deduct-simple writes the SAME actionType", () => {
      const out = classifyMassUpdateBatch({
        auditActionTypes: bulk,
        logTypes: ["SALE"],
        hasRowsShape: true,
      });
      expect(out.isMassUpdate).toBe(false);
      expect(out.evidence).toEqual([]);
    });

    test(">500 rows: details.rows is replaced by rowsOmitted, identified as its own case", () => {
      const out = classifyMassUpdateBatch({
        auditActionTypes: bulk,
        logTypes: ["ADJUSTMENT"],
        hasRowsShape: false,
        hasRowsOmitted: true,
      });
      expect(out.isMassUpdate).toBe(false);
      expect(out.isMassUpdateRowsOmitted).toBe(true);
      expect(out.evidence).toContain("audit-rows-omitted");
    });

    test("no audit event at all => not identified (the shape is the only pre-0b-1 evidence)", () => {
      const out = classifyMassUpdateBatch({
        auditActionTypes: [],
        logTypes: ["ADJUSTMENT"],
        hasRowsShape: true,
      });
      expect(out.isMassUpdate).toBe(false);
      expect(out.isMassUpdateRowsOmitted).toBe(false);
      expect(out.evidence).toEqual([]);
    });
  });

  describe("the 0b-1 FORWARD-COMPAT branch (post-deploy batches)", () => {
    test("COUNT ledger rows are mass-update evidence on their own", () => {
      const out = classifyMassUpdateBatch({
        auditActionTypes: [],
        logTypes: ["COUNT"],
        hasRowsShape: false,
      });
      expect(out.isMassUpdate).toBe(true);
      expect(out.evidence).toEqual(["count-logtype"]);
    });

    test("a post-0b-1 batch carries BOTH evidences, and both are disclosed", () => {
      const out = classifyMassUpdateBatch({
        auditActionTypes: bulk,
        logTypes: ["COUNT"],
        hasRowsShape: true,
      });
      expect(out.isMassUpdate).toBe(true);
      expect(out.evidence).toEqual(["audit-rows-shape", "count-logtype"]);
    });

    test("a >500-row post-0b-1 operation is a FULL identification, not the degraded case", () => {
      // Pre-0b-1 this batch could only be identified by the rowsOmitted fallback
      // and had to be labelled as such. The COUNT rows now identify it outright.
      const out = classifyMassUpdateBatch({
        auditActionTypes: bulk,
        logTypes: ["COUNT"],
        hasRowsShape: false,
        hasRowsOmitted: true,
      });
      expect(out.isMassUpdate).toBe(true);
      // Both branches matched, and both are named. The DEGRADED flag (the
      // "[rows omitted]" label suffix) is off: the ledger identifies it outright,
      // so it no longer needs the caveat that only the fallback saw it.
      expect(out.evidence).toEqual(["audit-rows-omitted", "count-logtype"]);
      expect(out.isMassUpdateRowsOmitted).toBe(false);
    });

    test("COUNT survives a MISSING summary event — the audit write is best-effort (P-B1)", () => {
      // mass-update records its summary via recordIngestion AFTER the stock
      // batches commit, and a failed summary must not 500 the operation. Such a
      // batch has ledger rows and no audit row: invisible to the frozen rule,
      // identified by the ledger from 0b-1 on.
      const out = classifyMassUpdateBatch({ logTypes: ["COUNT"] });
      expect(out.isMassUpdate).toBe(true);
      expect(out.evidence).toEqual(["count-logtype"]);
    });

    test("ADJUSTMENT-only batches are NOT swept in — the branch keys on COUNT alone", () => {
      const out = classifyMassUpdateBatch({ auditActionTypes: [], logTypes: ["ADJUSTMENT"] });
      expect(out.isMassUpdate).toBe(false);
      expect(out.evidence).toEqual([]);
    });
  });

  test("the frozen label is never softened to 'baseline' (G2-7)", () => {
    expect(MASS_UPDATE_LABEL).toMatch(/overwrite\/count-event dates/);
    expect(MASS_UPDATE_LABEL).not.toMatch(/baseline/i);
  });
});

describe("summarizeUnattributedPool — outbound units no evidence class reached (P0S-3)", () => {
  test("unattributed = total - attributed, per logType", () => {
    const out = summarizeUnattributedPool(
      [
        { logType: "SALE", rowCount: 10, units: 100, rowsWithoutBatch: 2, unitsWithoutBatch: 20 },
        { logType: "ADJUSTMENT", rowCount: 5, units: 50, rowsWithoutBatch: 0, unitsWithoutBatch: 0 },
      ],
      [{ logType: "SALE", rowCount: 6, units: 70 }]
    );
    expect(out.byLogType.SALE).toMatchObject({
      units: 100,
      attributedUnits: 70,
      unattributedUnits: 30,
      unattributedRowCount: 4,
      unitsWithoutBatch: 20,
    });
    expect(out.byLogType.ADJUSTMENT).toMatchObject({ attributedUnits: 0, unattributedUnits: 50 });
    expect(out.totals).toMatchObject({ units: 150, attributedUnits: 70, unattributedUnits: 80 });
  });

  test("a logType with NO negative rows is absent, not zero-filled", () => {
    const out = summarizeUnattributedPool([{ logType: "SALE", rowCount: 1, units: 1 }], []);
    expect(out.byLogType.TRANSFER).toBeUndefined();
    expect(out.rows.map((r) => r.logType)).toEqual(["SALE"]);
  });

  test("nothing attributed => the whole pool is unattributed", () => {
    const out = summarizeUnattributedPool([{ logType: "SALE", rowCount: 3, units: 12 }], []);
    expect(out.byLogType.SALE.unattributedUnits).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// D3 snapshot walk
// ---------------------------------------------------------------------------
describe("walkSnapshotSeries — snapshot delta vs ledger delta, gaps disclosed", () => {
  test("adjacent days with equal deltas produce no divergence", () => {
    const out = walkSnapshotSeries({
      productId: 1,
      locationId: 1,
      snapshots: [
        { dayKey: "2026-08-01", quantity: 100 },
        { dayKey: "2026-08-02", quantity: 90 },
      ],
      ledgerByDay: { "2026-08-02": { delta: -10, rowCount: 2 } },
    });
    expect(out.divergences).toHaveLength(0);
    expect(out.comparedDays).toBe(1);
  });

  test("stock moved with no ledger row => divergence carrying both deltas", () => {
    const out = walkSnapshotSeries({
      productId: 1,
      locationId: 1,
      snapshots: [
        { dayKey: "2026-08-01", quantity: 100 },
        { dayKey: "2026-08-02", quantity: 93 },
      ],
      ledgerByDay: {},
    });
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0]).toMatchObject({
      dayKey: "2026-08-02",
      snapshotDelta: -7,
      ledgerDelta: 0,
      difference: -7,
      ledgerRowCount: 0,
    });
  });

  test("NON-adjacent snapshot days are a coverage gap — disclosed, never interpolated", () => {
    const out = walkSnapshotSeries({
      productId: 1,
      locationId: 1,
      snapshots: [
        { dayKey: "2026-08-01", quantity: 100 },
        { dayKey: "2026-08-05", quantity: 60 },
      ],
      ledgerByDay: { "2026-08-05": { delta: -1, rowCount: 1 } },
    });
    expect(out.divergences).toHaveLength(0);
    expect(out.comparedDays).toBe(0);
    expect(out.coverageGaps).toEqual([
      { fromDayKey: "2026-08-01", toDayKey: "2026-08-05", missingDays: 3 },
    ]);
  });

  test("a single snapshot day yields nothing comparable (no prior day)", () => {
    const out = walkSnapshotSeries({
      productId: 1,
      locationId: 1,
      snapshots: [{ dayKey: "2026-08-01", quantity: 100 }],
      ledgerByDay: {},
    });
    expect(out.comparedDays).toBe(0);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverageGaps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D4 buckets (repo convention: ISO week keyed by its UTC Monday)
// ---------------------------------------------------------------------------
describe("date buckets", () => {
  test("weekStartKey returns the UTC Monday of the week", () => {
    expect(weekStartKey("2026-07-14")).toBe("2026-07-13"); // Tue -> Mon
    expect(weekStartKey("2026-07-13")).toBe("2026-07-13"); // Mon -> itself
    expect(weekStartKey("2026-07-19")).toBe("2026-07-13"); // Sun -> that Monday
  });

  test("monthKey slices YYYY-MM", () => {
    expect(monthKey("2026-07-19")).toBe("2026-07");
  });
});

// ---------------------------------------------------------------------------
// Artifact house rules + runner argv. Pinned because the SEAMS report hands the
// orchestrator an exact invocation, and because a number without a definition
// must not be able to reach an artifact.
// ---------------------------------------------------------------------------
const {
  figure,
  emptySlot,
  disclosure,
  table,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/artifact");

const {
  parseArgs,
  validate,
  DEFAULTS,
  MODULES,
} = require("../../../../scripts/diagnostics/inventory-accuracy/run");

describe("definition strings (P0S-6)", () => {
  test("the observed/deducted unit definitions NAME their scope: orders counted toward gap totals", () => {
    expect(DEFINITIONS.observedUnits).toMatch(/counted toward gap totals/i);
    expect(DEFINITIONS.deductedUnits).toMatch(/counted toward gap totals/i);
  });
});

describe("artifact house rules", () => {
  test("a figure without a definition string is refused", () => {
    expect(() => figure(5, "")).toThrow(/definition/);
    expect(() => table([], "")).toThrow(/definition/);
  });

  test("a structurally-empty slot is null + a named reason, never 0", () => {
    const s = emptySlot("class (a) has no ledger column in Phase 0a", "class (a) rows");
    expect(s.value).toBeNull();
    expect(s.structurallyEmpty).toBe(true);
    expect(s.reason).toMatch(/class \(a\)/);
    expect(() => emptySlot("", "def")).toThrow(/reason/);
  });

  test("disclosures ride ON the figure they qualify", () => {
    const f = figure(12, "units", [disclosure("excluded", 3, "pre-floor orders")]);
    expect(f.disclosures).toHaveLength(1);
    expect(f.disclosures[0]).toMatchObject({ label: "excluded", value: 3 });
    expect(() => disclosure("x", 1, "")).toThrow(/reason/);
  });
});

describe("runner argv", () => {
  test("--out is required", () => {
    expect(validate(parseArgs([]))).toEqual(
      expect.arrayContaining([expect.stringContaining("--out")])
    );
  });

  test("the documented invocation parses clean", () => {
    const opts = parseArgs([
      "--out=/tmp/phase0a",
      "--checks=d1,d2,d3,d4",
      "--window-days=90",
      "--top=50",
      "--class-b-floor=evidence",
    ]);
    expect(validate(opts)).toEqual([]);
    expect(opts).toMatchObject({
      out: "/tmp/phase0a",
      checks: ["d1", "d2", "d3", "d4"],
      windowDays: 90,
      top: 50,
      classBFloorMode: "evidence",
    });
  });

  test("defaults cover every check the suite ships", () => {
    expect(DEFAULTS.checks).toEqual(MODULES.map((m) => m.check.slice(0, 2)));
    expect(MODULES.every((m) => typeof m.run === "function")).toBe(true);
    expect(MODULES.every((m) => typeof m.purpose === "string" && m.purpose.length > 0)).toBe(true);
  });

  test("unknown check ids and nonsense numbers are rejected, not coerced", () => {
    expect(validate(parseArgs(["--out=/tmp/x", "--checks=d1,d9"]))).toEqual(
      expect.arrayContaining([expect.stringContaining("d9")])
    );
    expect(validate(parseArgs(["--out=/tmp/x", "--top=zero"]))).toEqual(
      expect.arrayContaining([expect.stringContaining("--top")])
    );
    expect(validate(parseArgs(["--out=/tmp/x", "--census-since=july"]))).toEqual(
      expect.arrayContaining([expect.stringContaining("--census-since")])
    );
  });

  // P0S-8: the old behavior SILENTLY COERCED an unrecognised value to the
  // evidence floor — a typo'd flag bound a different reading and the artifact
  // said nothing about it. It is now a validation error.
  test("--class-b-floor accepts exactly the two readings and REJECTS anything else", () => {
    expect(parseArgs(["--out=/tmp/x", "--class-b-floor=spec"]).classBFloorMode).toBe("spec");
    expect(validate(parseArgs(["--out=/tmp/x", "--class-b-floor=spec"]))).toEqual([]);
    expect(validate(parseArgs(["--out=/tmp/x", "--class-b-floor=evidence"]))).toEqual([]);
    expect(parseArgs(["--out=/tmp/x", "--class-b-floor=nonsense"]).classBFloorMode).toBe("nonsense");
    expect(validate(parseArgs(["--out=/tmp/x", "--class-b-floor=nonsense"]))).toEqual(
      expect.arrayContaining([expect.stringContaining("--class-b-floor")])
    );
    // Case matters: the two readings are exact tokens, not a fuzzy match.
    expect(validate(parseArgs(["--out=/tmp/x", "--class-b-floor=Evidence"]))).toEqual(
      expect.arrayContaining([expect.stringContaining("--class-b-floor")])
    );
    expect(validate(parseArgs(["--out=/tmp/x", "--class-b-floor="]))).toEqual(
      expect.arrayContaining([expect.stringContaining("--class-b-floor")])
    );
  });

  test("an unknown option is a hard error, never silently ignored", () => {
    expect(() => parseArgs(["--out=/tmp/x", "--wat=1"])).toThrow(/Unknown option/);
  });
});
