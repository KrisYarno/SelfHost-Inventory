// @jest-environment node
//
// W2-2 (design REV-2 §W2 "Backfill", pack seam S6) — unit pins for the
// order-attribution backfill's PURE core.
//
// The script itself only ever runs against a real database, by the orchestrator.
// Everything decision-shaped therefore lives in `plan.js` so it can be pinned
// here against authored fixtures: which events are usable, which batches are
// ambiguous, which rows get filled, and — the load-bearing one — that a second
// run writes nothing.
//
// Requiring the module must be side-effect-free: no Prisma client, no argv, no
// connection. The runner is the only file that touches a database.
const {
  ACCRUAL_ACTION_TYPE,
  ACCRUAL_DETAILS_KEY,
  ACCRUAL_LOG_TYPE,
  SKIP_CLASS,
  buildBackfillPlan,
  executeBackfillPlan,
} = require("../../../../scripts/backfill/order-attribution/plan");

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Fixtures. Ids only — the real thing projects ids only too (PII discipline).
// ---------------------------------------------------------------------------

const ORDER_A = "cm0order0000000000000000a";
const ORDER_B = "cm0order0000000000000000b";
const BATCH_1 = "11111111-1111-4111-8111-111111111111";
const BATCH_2 = "22222222-2222-4222-8222-222222222222";

/**
 * W2S-2: the W2 deploy moment. Every plan below is built against it, because
 * "was there an intent key?" only means something relative to the deploy that
 * started sending one.
 */
const CUTOFF = new Date("2026-08-14T19:13:29Z");
const BEFORE_CUTOFF = new Date("2026-08-13T12:00:00Z");
const AFTER_CUTOFF = new Date("2026-08-15T09:00:00Z");

/** Build a plan against the standing cutoff (the runner always supplies one). */
const buildPlan = (input) => buildBackfillPlan({ cutoff: CUTOFF, ...input });

/**
 * One 0b-2 accrual event, in the shape the runner projects: the JSON_UNQUOTEd
 * values AND their JSON_TYPEs (W2S-3), plus the event's own createdAt (W2S-2).
 */
const event = (over = {}) => ({
  auditLogId: 1,
  batchId: BATCH_1,
  accruedOrderId: ORDER_A,
  accruedOrderIdType: "STRING",
  intent: null,
  intentType: null,
  createdAt: BEFORE_CUTOFF,
  ...over,
});

/** One ledger row as the runner projects it. */
const row = (over = {}) => ({
  id: 1,
  batchId: BATCH_1,
  logType: ACCRUAL_LOG_TYPE,
  orderRecordId: null,
  ...over,
});

/**
 * An in-memory ledger that enforces the SAME predicate the SQL does. This is
 * what makes the idempotency pin a proof rather than a restatement: the fake
 * refuses to overwrite a stamped row exactly as `WHERE orderRecordId IS NULL`
 * refuses to match one.
 */
function fakeLedger(rows) {
  const store = rows.map((r) => ({ ...r }));
  return {
    rows: store,
    updateRows: async ({ logIds, orderRecordId }) => {
      let affected = 0;
      for (const r of store) {
        if (!logIds.includes(r.id)) continue;
        if (r.orderRecordId !== null && r.orderRecordId !== undefined) continue; // the fill-only WHERE
        r.orderRecordId = orderRecordId;
        affected += 1;
      }
      return affected;
    },
  };
}

// ---------------------------------------------------------------------------
// The seam this script reads (S6): the accrual's own shape, in the route.
// ---------------------------------------------------------------------------

describe("S6 — the accrual shape the backfill reads is the one deduct-simple writes", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../../../../app/api/inventory/deduct-simple/route.ts"),
    "utf8"
  );

  it("pins the actionType, the details key and the batchId linkage", () => {
    expect(routeSource).toContain(`actionType: "${ACCRUAL_ACTION_TYPE}"`);
    expect(routeSource).toContain(ACCRUAL_DETAILS_KEY);
    // The link from the audit event to the rows it describes is the batchId,
    // stamped on both sides in the same transaction. If either side stops
    // carrying it, this backfill can no longer map anything and must fail loudly
    // here rather than quietly filling nothing.
    expect(routeSource).toContain("batchId");
  });
});

// ---------------------------------------------------------------------------
// Fill-only
// ---------------------------------------------------------------------------

describe("fill-only — a stamped row is never overwritten", () => {
  it("fills the NULL row and leaves the stamped one alone", () => {
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [
        row({ id: 10, orderRecordId: null }),
        row({ id: 11, orderRecordId: ORDER_A }),
      ],
    });

    expect(plan.fills).toEqual([
      { batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] },
    ]);
    expect(plan.summary.rowsToFill).toBe(1);
    expect(plan.summary.rowsAlreadyStamped).toBe(1);
  });

  it("plans nothing at all for a batch whose rows are all stamped", () => {
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [row({ id: 10, orderRecordId: ORDER_A })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.rowsToFill).toBe(0);
    expect(plan.summary.rowsAlreadyStamped).toBe(1);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.ALREADY_STAMPED]).toBe(1);
  });

  it("counts a row stamped with a DIFFERENT id, and still does not touch it", () => {
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [row({ id: 10, orderRecordId: ORDER_B })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.rowsAlreadyStamped).toBe(1);
    // Named separately because it is a SIGNAL: the live stamp and the accrual
    // disagree about the same rows. Reported, never resolved by this script.
    expect(plan.summary.rowsAlreadyStampedDiffering).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — by construction
// ---------------------------------------------------------------------------

describe("idempotency — running twice is running once", () => {
  it("second pass plans zero fills and writes zero rows", async () => {
    const events = [event({ auditLogId: 1, batchId: BATCH_1, accruedOrderId: ORDER_A })];
    const ledger = fakeLedger([
      row({ id: 10 }),
      row({ id: 11 }),
      row({ id: 12, orderRecordId: ORDER_A }),
    ]);

    const first = buildPlan({ events, ledgerRows: ledger.rows });
    const firstRun = await executeBackfillPlan(first, {
      apply: true,
      updateRows: ledger.updateRows,
    });
    expect(firstRun.rowsWritten).toBe(2);
    expect(firstRun.rowsRaced).toBe(0);

    // Re-read the world exactly as a second invocation would.
    const second = buildPlan({ events, ledgerRows: ledger.rows });
    const secondRun = await executeBackfillPlan(second, {
      apply: true,
      updateRows: ledger.updateRows,
    });

    expect(second.fills).toEqual([]);
    expect(second.summary.rowsToFill).toBe(0);
    expect(secondRun.rowsWritten).toBe(0);
    expect(ledger.rows.map((r) => r.orderRecordId)).toEqual([ORDER_A, ORDER_A, ORDER_A]);
  });

  it("reports rows that were stamped by someone else between plan and write", async () => {
    const ledger = fakeLedger([row({ id: 10 }), row({ id: 11 })]);
    const plan = buildPlan({ events: [event()], ledgerRows: ledger.rows });

    // The live W2-1 path stamps one of them after the SELECT and before the
    // UPDATE. The fill-only WHERE drops it; the summary says so.
    ledger.rows[0].orderRecordId = ORDER_A;

    const result = await executeBackfillPlan(plan, {
      apply: true,
      updateRows: ledger.updateRows,
    });

    expect(result.rowsWritten).toBe(1);
    expect(result.rowsRaced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("dry run — the default writes nothing", () => {
  it("never calls the writer and reports zero", async () => {
    const updateRows = jest.fn();
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [row({ id: 10 })],
    });

    const result = await executeBackfillPlan(plan, { apply: false, updateRows });

    expect(updateRows).not.toHaveBeenCalled();
    expect(result).toMatchObject({ applied: false, rowsWritten: 0, batchesWritten: 0 });
    // The PLAN still says what it would have done — that is the whole point of
    // a dry run.
    expect(plan.summary.rowsToFill).toBe(1);
  });

  it("omitting the flag entirely is a dry run", async () => {
    const updateRows = jest.fn();
    const plan = buildPlan({ events: [event()], ledgerRows: [row({ id: 10 })] });

    const result = await executeBackfillPlan(plan, { updateRows });

    expect(updateRows).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it("apply issues exactly one write per planned batch, carrying its own ids", async () => {
    const updateRows = jest.fn(async ({ logIds }) => logIds.length);
    const plan = buildPlan({
      events: [
        event({ auditLogId: 1, batchId: BATCH_1, accruedOrderId: ORDER_A }),
        event({ auditLogId: 2, batchId: BATCH_2, accruedOrderId: ORDER_B }),
      ],
      ledgerRows: [
        row({ id: 10, batchId: BATCH_1 }),
        row({ id: 11, batchId: BATCH_1 }),
        row({ id: 20, batchId: BATCH_2 }),
      ],
    });

    const result = await executeBackfillPlan(plan, { apply: true, updateRows });

    expect(updateRows).toHaveBeenCalledTimes(2);
    expect(updateRows).toHaveBeenCalledWith({
      batchId: BATCH_1,
      orderRecordId: ORDER_A,
      logIds: [10, 11],
    });
    expect(updateRows).toHaveBeenCalledWith({
      batchId: BATCH_2,
      orderRecordId: ORDER_B,
      logIds: [20],
    });
    expect(result).toMatchObject({ applied: true, rowsWritten: 3, batchesWritten: 2 });
  });
});

// ---------------------------------------------------------------------------
// Ambiguity — skip and REPORT, never guess
// ---------------------------------------------------------------------------

describe("ambiguity — an unmappable event is skipped by name", () => {
  it("an event with no batchId links to nothing", () => {
    const plan = buildPlan({
      events: [event({ batchId: null })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.NO_BATCH_ID]).toBe(1);
    expect(plan.skips.some((s) => s.class === SKIP_CLASS.NO_BATCH_ID)).toBe(true);
  });

  it("two events on one batch naming DIFFERENT orders skip the whole batch", () => {
    const plan = buildPlan({
      events: [
        event({ auditLogId: 1, accruedOrderId: ORDER_A }),
        event({ auditLogId: 2, accruedOrderId: ORDER_B }),
      ],
      ledgerRows: [row({ id: 10 }), row({ id: 11 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.CONFLICTING_ACCRUAL]).toBe(1);
    expect(plan.summary.rowsSkipped).toBe(2);
    const skip = plan.skips.find((s) => s.class === SKIP_CLASS.CONFLICTING_ACCRUAL);
    expect(skip.auditLogIds).toEqual([1, 2]);
  });

  it("two events on one batch naming the SAME order are not a conflict", () => {
    const plan = buildPlan({
      events: [event({ auditLogId: 1 }), event({ auditLogId: 2 })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([
      { batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] },
    ]);
  });

  it("a batch with no ledger rows at all is reported, not silently dropped", () => {
    const plan = buildPlan({ events: [event()], ledgerRows: [] });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.NO_LEDGER_ROWS]).toBe(1);
  });

  it("a batch carrying any non-SALE row is not the accrual class — skipped whole", () => {
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [row({ id: 10 }), row({ id: 11, logType: "ADJUSTMENT" })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.FOREIGN_ROWS_IN_BATCH]).toBe(1);
    expect(plan.summary.rowsSkipped).toBe(2);
  });

  it.each([[""], ["null"], [null], [undefined], [42]])(
    "an accrued id of %p is unusable, never coerced",
    (accruedOrderId) => {
      const plan = buildPlan({
        events: [event({ accruedOrderId })],
        ledgerRows: [row({ id: 10 })],
      });

      expect(plan.fills).toEqual([]);
      expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.UNUSABLE_ACCRUED_ID]).toBe(1);
    }
  );
});

// ---------------------------------------------------------------------------
// The operator's stated intent outranks the accrual
// ---------------------------------------------------------------------------

describe("a stated non-order intent is a decision, not a gap", () => {
  it("skips a batch whose operator classified the movement as `other`", () => {
    const plan = buildPlan({
      events: [event({ intent: "other" })],
      ledgerRows: [row({ id: 10 }), row({ id: 11 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT]).toBe(1);
    // The spared rows are COUNTED. A class that reports itself as zero rows
    // while sparing two is the kind of summary this lane exists to stop.
    expect(plan.summary.rowsSkippedByClass[SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT]).toBe(2);
    expect(plan.summary.rowsSkipped).toBe(2);
  });

  it("a stated `other` settles the batch even when the accruals also conflict", () => {
    const plan = buildPlan({
      events: [
        event({ auditLogId: 1, accruedOrderId: ORDER_A, intent: "other" }),
        event({ auditLogId: 2, accruedOrderId: ORDER_B, intent: null }),
      ],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT]).toBe(1);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.CONFLICTING_ACCRUAL]).toBeUndefined();
    // Counted once, under one class — never twice.
    expect(plan.summary.rowsSkipped).toBe(1);
  });

  it("fills an event with an explicit `order` intent", () => {
    const plan = buildPlan({
      events: [event({ intent: "order" })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toHaveLength(1);
  });

  it("fills a pre-chip event, which is the whole reason this script exists", () => {
    const plan = buildPlan({
      events: [event({ intent: null })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toHaveLength(1);
    expect(plan.summary.eventsExamined).toBe(1);
    expect(plan.summary.eventsLinkable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("plan shape", () => {
  it("is deterministic and never mutates its inputs", () => {
    const events = [
      event({ auditLogId: 2, batchId: BATCH_2, accruedOrderId: ORDER_B }),
      event({ auditLogId: 1, batchId: BATCH_1, accruedOrderId: ORDER_A }),
    ];
    const ledgerRows = [
      row({ id: 20, batchId: BATCH_2 }),
      row({ id: 11, batchId: BATCH_1 }),
      row({ id: 10, batchId: BATCH_1 }),
    ];
    const snapshot = JSON.stringify({ events, ledgerRows });

    const a = buildPlan({ events, ledgerRows });
    const b = buildPlan({ events, ledgerRows });

    expect(a).toEqual(b);
    expect(a.fills.map((f) => f.batchId)).toEqual([BATCH_1, BATCH_2]);
    expect(a.fills[0].logIds).toEqual([10, 11]);
    expect(JSON.stringify({ events, ledgerRows })).toBe(snapshot);
  });

  it("carries no PII — ids, counts and class names only", () => {
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [row({ id: 10 })],
    });
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toMatch(/@/);
    for (const key of ["productName", "customerEmail", "customerName", "notes", "action"]) {
      expect(serialized).not.toContain(key);
    }
  });

  it("freezes the skip vocabulary", () => {
    expect(Object.isFrozen(SKIP_CLASS)).toBe(true);
    expect(Object.values(SKIP_CLASS)).toEqual(
      expect.arrayContaining([
        "no-batch-id",
        "unusable-accrued-id",
        "explicit-non-order-intent",
        "conflicting-accrual",
        "no-ledger-rows",
        "foreign-rows-in-batch",
        "already-stamped",
        "post-cutoff-no-intent",
        "stamped-conflict",
      ])
    );
  });

  it("handles an empty world without inventing a summary", () => {
    const plan = buildPlan({ events: [], ledgerRows: [] });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsExamined).toBe(0);
    expect(plan.summary.rowsToFill).toBe(0);
    expect(plan.skips).toEqual([]);
  });

  it("refuses to apply without a writer rather than reporting a phantom success", async () => {
    const plan = buildPlan({ events: [event()], ledgerRows: [row({ id: 10 })] });

    await expect(executeBackfillPlan(plan, { apply: true })).rejects.toThrow(/updateRows/);
  });
});

// ---------------------------------------------------------------------------
// W2S-2 (codex W2 dual seam check, MED) — the W2 deploy is a semantic boundary.
//
// Before W2-1 shipped the chip, deduct-simple accrued an order id and said
// nothing about intent: absent intent meant "we had nowhere to record one", and
// filling those rows is the whole reason this script exists. AFTER the chip
// shipped, the live route defaults to `other` and leaves the movement
// UNATTRIBUTED — so an event that still arrives with an order id and NO intent
// key is a stale client, and the live route already decided not to attribute it.
// Backfilling it would manufacture the attribution the route declined.
//
// The two eras are told apart by ONE timestamp the operator must supply.
// ---------------------------------------------------------------------------

describe("W2S-2 — absent intent means different things either side of the cutoff", () => {
  it("PIN W2S-2a: a POST-cutoff event with no intent key is skipped by name", () => {
    const plan = buildPlan({
      events: [event({ auditLogId: 9, createdAt: AFTER_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBe(1);
    const skip = plan.skips.find((s) => s.class === SKIP_CLASS.POST_CUTOFF_NO_INTENT);
    expect(skip).toMatchObject({ batchId: BATCH_1, auditLogIds: [9] });
    // Nothing was filled, so the summary must not claim a linkable event either.
    expect(plan.summary.eventsLinkable).toBe(0);
  });

  it("PIN W2S-2b: a PRE-cutoff event with no intent key is eligible — the script's whole point", () => {
    const plan = buildPlan({
      events: [event({ createdAt: BEFORE_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([
      { batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] },
    ]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBeUndefined();
  });

  it("PIN W2S-2c: an event CARRYING intent=order is eligible whatever its date", () => {
    const plan = buildPlan({
      events: [event({ intent: "order", intentType: "STRING", createdAt: AFTER_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toHaveLength(1);
  });

  it("PIN W2S-2d: a post-cutoff event carrying a NON-order intent is the operator's answer, not a cutoff skip", () => {
    const plan = buildPlan({
      events: [event({ intent: "other", intentType: "STRING", createdAt: AFTER_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT]).toBe(1);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBeUndefined();
  });

  it("PIN W2S-2e: an event whose createdAt cannot be read is not PROVEN pre-cutoff", () => {
    const plan = buildPlan({
      events: [event({ createdAt: null })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBe(1);
  });

  it("PIN W2S-2f: the planner refuses to classify anything without a cutoff", () => {
    expect(() =>
      buildBackfillPlan({ events: [event()], ledgerRows: [row({ id: 10 })] })
    ).toThrow(/cutoff/i);
    expect(() =>
      buildBackfillPlan({ events: [], ledgerRows: [], cutoff: new Date("nonsense") })
    ).toThrow(/cutoff/i);
  });
});

// ---------------------------------------------------------------------------
// W2S-3 (codex W2 dual seam check, MED) — JSON_UNQUOTE hands everything over as
// a string, so `typeof value === "string"` cannot tell an order id from a JSON
// number, boolean, array or object. The TYPE has to come from the database too.
//
// Fixtures below are DRIVER-SHAPED: exactly what MySQL returns for
// JSON_UNQUOTE(JSON_EXTRACT(...)) paired with JSON_TYPE(JSON_EXTRACT(...)).
// ---------------------------------------------------------------------------

describe("W2S-3 — only a JSON STRING is an order id", () => {
  it.each([
    ["a JSON null", "null", "NULL"],
    ["a JSON number", "42", "INTEGER"],
    ["a JSON double", "4.5", "DOUBLE"],
    ["a JSON boolean", "true", "BOOLEAN"],
    ["a JSON array", '["cm0order0000000000000000a"]', "ARRAY"],
    ["a JSON object", '{"id": "cm0order0000000000000000a"}', "OBJECT"],
  ])("PIN W2S-3: %s never reaches the ledger", (_label, accruedOrderId, accruedOrderIdType) => {
    const plan = buildPlan({
      events: [event({ accruedOrderId, accruedOrderIdType })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.UNUSABLE_ACCRUED_ID]).toBe(1);
  });

  it("PIN W2S-3: a JSON STRING is the one shape that plans", () => {
    const plan = buildPlan({
      events: [event({ accruedOrderId: ORDER_A, accruedOrderIdType: "STRING" })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([
      { batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] },
    ]);
  });

  it("PIN W2S-3: an event with no type at all is unusable, not assumed", () => {
    const plan = buildPlan({
      events: [event({ accruedOrderIdType: undefined })],
      ledgerRows: [row({ id: 10 })],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.UNUSABLE_ACCRUED_ID]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// W2S-4 (codex W2 dual seam check, MED) — one request, one order.
//
// A batch is ONE deduct-simple request. If a row in it already carries a
// DIFFERENT order id than the accrual names, the two sources disagree about
// that request — and filling the null siblings would split one request across
// two orders, which is a state the live path can never produce. The batch is
// left whole and reported.
// ---------------------------------------------------------------------------

describe("W2S-4 — a conflicted batch is never split across two orders", () => {
  it("PIN W2S-4: one row stamped B under an A accrual skips the WHOLE batch, null sibling included", () => {
    const plan = buildPlan({
      events: [event({ auditLogId: 3, accruedOrderId: ORDER_A })],
      ledgerRows: [
        row({ id: 10, orderRecordId: ORDER_B }),
        row({ id: 11, orderRecordId: null }),
      ],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.rowsToFill).toBe(0);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.STAMPED_CONFLICT]).toBe(1);
    expect(plan.summary.rowsSkippedByClass[SKIP_CLASS.STAMPED_CONFLICT]).toBe(2);
    expect(plan.summary.rowsSkipped).toBe(2);
    // The disagreement is still reported as the signal it is.
    expect(plan.summary.rowsAlreadyStampedDiffering).toBe(1);
    const skip = plan.skips.find((s) => s.class === SKIP_CLASS.STAMPED_CONFLICT);
    expect(skip).toMatchObject({ batchId: BATCH_1, auditLogIds: [3], rowCount: 2 });
  });

  it("PIN W2S-4: stamps that AGREE with the accrual still let the null siblings fill", () => {
    const plan = buildPlan({
      events: [event()],
      ledgerRows: [
        row({ id: 10, orderRecordId: ORDER_A }),
        row({ id: 11, orderRecordId: null }),
      ],
    });

    expect(plan.fills).toEqual([
      { batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [11] },
    ]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.STAMPED_CONFLICT]).toBeUndefined();
  });
});
