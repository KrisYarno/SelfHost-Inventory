// @jest-environment node
/* eslint-disable @typescript-eslint/no-require-imports --
 * A CJS test for a CJS script. The two sibling backfill suites carry the same
 * requires as raw lint errors; disabling the rule here keeps the repo's error
 * baseline flat rather than growing it by one more accepted exception. */
//
// REFERENCE-RESOLUTION ROUND — the COMPANION accrual source, pinned on the
// backfill's pure core.
//
// WHY THIS EXISTS. The 0b-2 structured path (`details.selectedExternalOrderId`)
// has NEVER fired in production: 0 of 1,897 all-time accrual events carry the
// key, and the prod backfill run was a clean zero three passes running. What
// packers actually do is TYPE the Woo order number into the workbench's free
// text field, which lands as `details.orderReference` — and 10 of 10 distinct
// prod references resolve exactly against `external_orders.orderNumber`. The
// attribution evidence exists; it is in the other field.
//
// THE EVIDENCE BAR IS DIFFERENT, AND THAT IS THE WHOLE POINT. The structured id
// was resolved and membership-checked BEFORE it was written, which is why the
// backfill copies it without re-validating. Free text was never validated by
// anything: it is a string a human typed while packing. So the reference source
// carries its own bar, and it is deliberately the strictest one that still
// recovers the prod data — the trimmed reference must be a plausible order
// number AND equal exactly ONE `external_orders.orderNumber`. Zero matches,
// two matches, or a shape that is not an order number are each skipped BY NAME.
// Everything W3's matcher inherits is therefore named in the summary rather
// than guessed at here.
//
// Every OTHER guarantee is shared with the structured path and asserted as
// shared below: fill-only, the --until cutoff, batch linkage, stamped-conflict,
// foreign rows, dry-run-by-default, ids-only output.
const {
  SKIP_CLASS,
  ATTRIBUTION_SOURCE,
  ORDER_REFERENCE_SHAPE,
  isUsableOrderReference,
  buildBackfillPlan,
  executeBackfillPlan,
} = require("../../../../scripts/backfill/order-attribution/plan");

const ORDER_A = "cm0order0000000000000000a";
const ORDER_B = "cm0order0000000000000000b";
const BATCH_1 = "11111111-1111-4111-8111-111111111111";
const BATCH_2 = "22222222-2222-4222-8222-222222222222";
const REF_A = "12345";
const REF_B = "67890";

const CUTOFF = new Date("2026-08-14T19:13:29Z");
const BEFORE_CUTOFF = new Date("2026-08-13T12:00:00Z");
const AFTER_CUTOFF = new Date("2026-08-15T09:00:00Z");

const buildPlan = (input) => buildBackfillPlan({ cutoff: CUTOFF, ...input });

/**
 * A REFERENCE-source accrual event: the free-text key present, the structured
 * key ABSENT on both the value and the type (that absence is what hands the
 * event to this source — see the precedence pin at the bottom).
 */
const refEvent = (over = {}) => ({
  auditLogId: 1,
  batchId: BATCH_1,
  accruedOrderId: null,
  accruedOrderIdType: null,
  orderReference: REF_A,
  orderReferenceType: "STRING",
  intent: null,
  intentType: null,
  createdAt: BEFORE_CUTOFF,
  ...over,
});

/** A STRUCTURED-source accrual event, exactly as the 0b-2 suite fixtures it. */
const idEvent = (over = {}) => ({
  auditLogId: 1,
  batchId: BATCH_1,
  accruedOrderId: ORDER_A,
  accruedOrderIdType: "STRING",
  orderReference: null,
  orderReferenceType: null,
  intent: null,
  intentType: null,
  createdAt: BEFORE_CUTOFF,
  ...over,
});

const row = (over = {}) => ({ id: 1, batchId: BATCH_1, logType: "SALE", orderRecordId: null, ...over });

/** One `external_orders` candidate row, as the runner projects it. */
const match = (orderNumber, orderId) => ({ orderNumber, orderId });

/** The default world: REF_A names exactly one order. */
const UNIQUE_A = [match(REF_A, ORDER_A)];

function fakeLedger(rows) {
  const store = rows.map((r) => ({ ...r }));
  return {
    rows: store,
    updateRows: async ({ logIds, orderRecordId }) => {
      let affected = 0;
      for (const r of store) {
        if (!logIds.includes(r.id)) continue;
        if (r.orderRecordId !== null && r.orderRecordId !== undefined) continue;
        r.orderRecordId = orderRecordId;
        affected += 1;
      }
      return affected;
    },
  };
}

// ---------------------------------------------------------------------------
// PIN 5 — the exact-unique evidence bar
// ---------------------------------------------------------------------------

describe("PIN 5 — a reference is evidence only when it matches EXACTLY ONE order", () => {
  it("fills from a unique exact match, and names the source", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 }), row({ id: 11 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([{ batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10, 11] }]);
    expect(plan.evidence).toEqual([
      {
        batchId: BATCH_1,
        source: ATTRIBUTION_SOURCE.REFERENCE_RESOLVED,
        orderRecordId: ORDER_A,
        auditLogIds: [1],
        rowCount: 2,
      },
    ]);
  });

  it("ZERO matches is `reference-unmatched` — never a guess, never a partial", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: [],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_UNMATCHED]).toBe(1);
    expect(plan.skips).toContainEqual({
      class: SKIP_CLASS.REFERENCE_UNMATCHED,
      batchId: BATCH_1,
      auditLogIds: [1],
      rowCount: 0,
    });
  });

  it("TWO matching orders is `reference-ambiguous` — the number is not unique", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 })],
      // The same human-facing number in two shops. Nothing here can say which.
      orderNumberMatches: [match(REF_A, ORDER_A), match(REF_A, ORDER_B)],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_AMBIGUOUS]).toBe(1);
  });

  it("counts the SAME order twice as one match, not as ambiguity", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: [match(REF_A, ORDER_A), match(REF_A, ORDER_A)],
    });

    expect(plan.fills).toHaveLength(1);
  });

  it.each([
    ["free text with words", "walk-in 88"],
    ["a prefixed number", "#12345"],
    ["a shop-prefixed number", "WC-123"],
    ["an inner space", "12 345"],
    ["letters", "abc"],
    ["the empty string", ""],
    ["whitespace only", "   "],
    ["the JSON-null token", "null"],
    ["an implausibly long digit run", "1".repeat(21)],
  ])("PIN 5: %s is `reference-unusable` and never reaches a lookup", (_label, orderReference) => {
    const plan = buildPlan({
      events: [refEvent({ orderReference })],
      ledgerRows: [row({ id: 10 })],
      // Even a world in which the raw text WOULD match: the shape bar is first.
      orderNumberMatches: [match(orderReference, ORDER_A)],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_UNUSABLE]).toBe(1);
  });

  it("PIN 5: a non-STRING JSON reference is unusable, exactly as W2S-3 rules the id", () => {
    // JSON_UNQUOTE renders a JSON number as the string "12345"; only JSON_TYPE
    // can tell them apart, and a number is not what the route writes.
    const plan = buildPlan({
      events: [refEvent({ orderReference: REF_A, orderReferenceType: "INTEGER" })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_UNUSABLE]).toBe(1);
  });

  it("PIN 5: surrounding whitespace is trimmed, and only trimmed", () => {
    const plan = buildPlan({
      events: [refEvent({ orderReference: `  ${REF_A}\n` })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([{ batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] }]);
  });

  it("PIN 5: the match is EXACT — a collation-equal candidate is not an exact one", () => {
    // MySQL's default collation is case- and pad-insensitive, so the runner's
    // `IN (...)` is a CANDIDATE fetch. Uniqueness is decided here, on bytes.
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: [match(`${REF_A} `, ORDER_A)],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_UNMATCHED]).toBe(1);
  });

  it("exposes the shape rule it applies, rather than hiding it in a branch", () => {
    expect(ORDER_REFERENCE_SHAPE.test("12345")).toBe(true);
    expect(isUsableOrderReference(" 12345 ", "STRING")).toBe(true);
    expect(isUsableOrderReference("12345", "INTEGER")).toBe(false);
    expect(isUsableOrderReference("#12345", "STRING")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PIN 6 — the W2S-2 cutoff rule reaches the new source
// ---------------------------------------------------------------------------

describe("PIN 6 — a post-cutoff reference event with no intent is skipped by name", () => {
  it("skips it as post-cutoff-no-intent, not as anything reference-shaped", () => {
    const plan = buildPlan({
      events: [refEvent({ auditLogId: 9, createdAt: AFTER_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBe(1);
    expect(plan.summary.eventsLinkable).toBe(0);
  });

  it("a PRE-cutoff reference event with no intent is eligible", () => {
    const plan = buildPlan({
      events: [refEvent({ createdAt: BEFORE_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toHaveLength(1);
  });

  it("a reference event CARRYING intent=order is eligible whatever its date", () => {
    const plan = buildPlan({
      events: [refEvent({ intent: "order", intentType: "STRING", createdAt: AFTER_CUTOFF })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toHaveLength(1);
  });

  it("an unreadable createdAt is not PROVEN pre-cutoff for a reference either", () => {
    const plan = buildPlan({
      events: [refEvent({ createdAt: null })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The stated intent still outranks the evidence
// ---------------------------------------------------------------------------

describe("a stated non-order intent settles a reference batch too", () => {
  it("skips a unique-matching reference whose operator said `other`", () => {
    const plan = buildPlan({
      events: [refEvent({ intent: "other", intentType: "STRING" })],
      ledgerRows: [row({ id: 10 }), row({ id: 11 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT]).toBe(1);
    expect(plan.summary.rowsSkippedByClass[SKIP_CLASS.EXPLICIT_NON_ORDER_INTENT]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Everything else is SHARED with the structured path — asserted, not assumed
// ---------------------------------------------------------------------------

describe("the shared guarantees hold for the reference source", () => {
  it("fill-only: a stamped row is left alone and its null sibling still fills", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10, orderRecordId: ORDER_A }), row({ id: 11 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([{ batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [11] }]);
    expect(plan.summary.rowsAlreadyStamped).toBe(1);
  });

  it("stamped-conflict: a row naming a DIFFERENT order skips the whole batch", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10, orderRecordId: ORDER_B }), row({ id: 11 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.STAMPED_CONFLICT]).toBe(1);
    expect(plan.summary.rowsSkippedByClass[SKIP_CLASS.STAMPED_CONFLICT]).toBe(2);
  });

  it("foreign rows: a batch holding a non-SALE row is skipped whole", () => {
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 }), row({ id: 11, logType: "ADJUSTMENT" })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.FOREIGN_ROWS_IN_BATCH]).toBe(1);
  });

  it("batch linkage: a reference event with no batchId links to nothing", () => {
    const plan = buildPlan({
      events: [refEvent({ batchId: null })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.NO_BATCH_ID]).toBe(1);
  });

  it("dry run is still the default: the writer is never called", async () => {
    const updateRows = jest.fn();
    const plan = buildPlan({
      events: [refEvent()],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    const result = await executeBackfillPlan(plan, { updateRows });

    expect(updateRows).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(plan.summary.rowsToFill).toBe(1);
  });

  it("idempotency: the second pass over a reference-filled batch writes nothing", async () => {
    const events = [refEvent()];
    const ledger = fakeLedger([row({ id: 10 }), row({ id: 11 })]);

    const first = buildPlan({ events, ledgerRows: ledger.rows, orderNumberMatches: UNIQUE_A });
    const firstRun = await executeBackfillPlan(first, { apply: true, updateRows: ledger.updateRows });
    expect(firstRun.rowsWritten).toBe(2);

    const second = buildPlan({ events, ledgerRows: ledger.rows, orderNumberMatches: UNIQUE_A });
    const secondRun = await executeBackfillPlan(second, { apply: true, updateRows: ledger.updateRows });

    expect(second.fills).toEqual([]);
    expect(secondRun.rowsWritten).toBe(0);
  });

  it("no-ledger-rows is still reported rather than silently dropped", () => {
    const plan = buildPlan({ events: [refEvent()], ledgerRows: [], orderNumberMatches: UNIQUE_A });

    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.NO_LEDGER_ROWS]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PIN 7 — the two sources are reported SEPARATELY
// ---------------------------------------------------------------------------

describe("PIN 7 — an operator can see WHICH evidence stamped each batch", () => {
  it("splits the planned batches and rows by source", () => {
    const plan = buildPlan({
      events: [
        idEvent({ auditLogId: 1, batchId: BATCH_1, accruedOrderId: ORDER_A }),
        refEvent({ auditLogId: 2, batchId: BATCH_2, orderReference: REF_B }),
      ],
      ledgerRows: [
        row({ id: 10, batchId: BATCH_1 }),
        row({ id: 20, batchId: BATCH_2 }),
        row({ id: 21, batchId: BATCH_2 }),
      ],
      orderNumberMatches: [match(REF_B, ORDER_B)],
    });

    expect(plan.summary.batchesPlanned).toBe(2);
    expect(plan.summary.rowsToFill).toBe(3);
    expect(plan.summary.batchesPlannedBySource).toEqual({
      [ATTRIBUTION_SOURCE.SELECTED]: 1,
      [ATTRIBUTION_SOURCE.REFERENCE_RESOLVED]: 1,
    });
    expect(plan.summary.rowsToFillBySource).toEqual({
      [ATTRIBUTION_SOURCE.SELECTED]: 1,
      [ATTRIBUTION_SOURCE.REFERENCE_RESOLVED]: 2,
    });
    expect(plan.summary.eventsLinkableBySource).toEqual({
      [ATTRIBUTION_SOURCE.SELECTED]: 1,
      [ATTRIBUTION_SOURCE.REFERENCE_RESOLVED]: 1,
    });
  });

  it("names every planned batch's evidence, batch by batch", () => {
    const plan = buildPlan({
      events: [
        idEvent({ auditLogId: 1, batchId: BATCH_1 }),
        refEvent({ auditLogId: 2, batchId: BATCH_2, orderReference: REF_B }),
      ],
      ledgerRows: [row({ id: 10, batchId: BATCH_1 }), row({ id: 20, batchId: BATCH_2 })],
      orderNumberMatches: [match(REF_B, ORDER_B)],
    });

    expect(plan.evidence.map((e) => [e.batchId, e.source])).toEqual([
      [BATCH_1, ATTRIBUTION_SOURCE.SELECTED],
      [BATCH_2, ATTRIBUTION_SOURCE.REFERENCE_RESOLVED],
    ]);
  });

  it("freezes the source vocabulary at exactly two values", () => {
    expect(Object.isFrozen(ATTRIBUTION_SOURCE)).toBe(true);
    expect(Object.values(ATTRIBUTION_SOURCE)).toEqual(["selected", "reference-resolved"]);
  });

  it("names the three new skip classes", () => {
    expect(Object.values(SKIP_CLASS)).toEqual(
      expect.arrayContaining(["reference-unmatched", "reference-ambiguous", "reference-unusable"])
    );
  });
});

// ---------------------------------------------------------------------------
// PIN 8 — the structured path is byte-stable
// ---------------------------------------------------------------------------

describe("PIN 8 — the structured path is untouched by the companion source", () => {
  it("hands the writer the SAME three-key fill it always did", () => {
    const plan = buildPlan({
      events: [idEvent()],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    // Not `toMatchObject`: an extra key here would change what every existing
    // `toHaveBeenCalledWith` in the 0b-2 suite is asserting against.
    expect(Object.keys(plan.fills[0])).toEqual(["batchId", "orderRecordId", "logIds"]);
  });

  it("plans identically whether or not an order-number index was supplied", () => {
    const events = [idEvent()];
    const ledgerRows = [row({ id: 10 })];

    const withIndex = buildPlan({ events, ledgerRows, orderNumberMatches: UNIQUE_A });
    const withoutIndex = buildPlan({ events, ledgerRows });

    expect(withIndex.fills).toEqual(withoutIndex.fills);
    expect(withIndex.summary).toEqual(withoutIndex.summary);
  });

  it("PRECEDENCE: an event carrying BOTH keys is judged as structured evidence", () => {
    // The id was validated at write; the free text never was. When both are
    // present the stronger evidence decides, and the reference is not consulted
    // at all — not even to disagree.
    const plan = buildPlan({
      events: [idEvent({ accruedOrderId: ORDER_A, orderReference: REF_B, orderReferenceType: "STRING" })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: [match(REF_B, ORDER_B)],
    });

    expect(plan.fills).toEqual([{ batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] }]);
    expect(plan.evidence[0].source).toBe(ATTRIBUTION_SOURCE.SELECTED);
  });

  it("PRECEDENCE: an UNUSABLE structured id does not fall through to the free text", () => {
    // Corrupt structured evidence is a signal, not a licence to substitute a
    // weaker source. The event is still `unusable-accrued-id`, as it always was.
    const plan = buildPlan({
      events: [
        idEvent({
          accruedOrderId: "42",
          accruedOrderIdType: "INTEGER",
          orderReference: REF_A,
          orderReferenceType: "STRING",
        }),
      ],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.eventsSkippedByClass[SKIP_CLASS.UNUSABLE_ACCRUED_ID]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Two events, one batch
// ---------------------------------------------------------------------------

describe("a batch fed by both sources", () => {
  it("agreeing on ONE order fills once and reports the stronger evidence", () => {
    const plan = buildPlan({
      events: [idEvent({ auditLogId: 1 }), refEvent({ auditLogId: 2 })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: UNIQUE_A,
    });

    expect(plan.fills).toEqual([{ batchId: BATCH_1, orderRecordId: ORDER_A, logIds: [10] }]);
    expect(plan.evidence[0]).toMatchObject({
      source: ATTRIBUTION_SOURCE.SELECTED,
      auditLogIds: [1, 2],
    });
  });

  it("naming DIFFERENT orders is a conflicting accrual, whatever the sources", () => {
    const plan = buildPlan({
      events: [idEvent({ auditLogId: 1, accruedOrderId: ORDER_A }), refEvent({ auditLogId: 2, orderReference: REF_B })],
      ledgerRows: [row({ id: 10 })],
      orderNumberMatches: [match(REF_B, ORDER_B)],
    });

    expect(plan.fills).toEqual([]);
    expect(plan.summary.batchesSkippedByClass[SKIP_CLASS.CONFLICTING_ACCRUAL]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// PII — a free-text field is exactly where a customer name would arrive
// ---------------------------------------------------------------------------

describe("the plan never carries the reference text", () => {
  it("keeps the typed string out of every skip, fill and summary", () => {
    const typed = "9999999999";
    const plan = buildPlan({
      events: [
        refEvent({ auditLogId: 1, orderReference: typed }),
        refEvent({ auditLogId: 2, batchId: BATCH_2, orderReference: "walk-in bob" }),
      ],
      ledgerRows: [row({ id: 10 }), row({ id: 20, batchId: BATCH_2 })],
      orderNumberMatches: [],
    });

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(typed);
    expect(serialized).not.toContain("walk-in bob");
    expect(serialized).not.toContain("orderReference");
  });

  it("does not mutate the events it was handed", () => {
    const events = [refEvent({ orderReference: `  ${REF_A}  ` })];
    const snapshot = JSON.stringify(events);

    buildPlan({ events, ledgerRows: [row({ id: 10 })], orderNumberMatches: UNIQUE_A });

    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
