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
  deriveFloors,
  observableClassesAt,
  classifyUnits,
  classifyOrder,
  matchHeuristicReferences,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/classify");

const {
  walkSnapshotSeries,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/snapshot-walk");

const {
  weekStartKey,
  monthKey,
} = require("../../../../scripts/diagnostics/inventory-accuracy/lib/date-buckets");

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
    anchorAt: POST_FLOOR,
    completedAt: POST_FLOOR,
    observations: [],
    tombstoned: { rowCount: 0, units: 0 },
    ledger: [],
    unmappedItems: { itemCount: 0, itemUnits: 0 },
    ...overrides,
  };
}

const obs = (productId, units, tombstonedAt = null) => ({ productId, units, tombstonedAt });
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

  test("--class-b-floor only accepts the two readings", () => {
    expect(parseArgs(["--out=/tmp/x", "--class-b-floor=spec"]).classBFloorMode).toBe("spec");
    expect(parseArgs(["--out=/tmp/x", "--class-b-floor=nonsense"]).classBFloorMode).toBe("evidence");
  });

  test("an unknown option is a hard error, never silently ignored", () => {
    expect(() => parseArgs(["--out=/tmp/x", "--wat=1"])).toThrow(/Unknown option/);
  });
});
