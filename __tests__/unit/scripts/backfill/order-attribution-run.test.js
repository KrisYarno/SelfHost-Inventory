// @jest-environment node
//
// W2-2 fix round (codex W2 dual seam check) — pins for the backfill's RUNNER.
//
// plan.js decides; run.js is what actually reads the database, and two of the
// four seam findings live in that projection:
//
//   W2S-2 — the runner must REFUSE to run without `--until`, the W2 deploy
//           moment. Absent intent means "nowhere to record one" before it and
//           "the live route defaulted to `other`" after it; a backfill that
//           cannot tell the two apart attributes movements the route declined.
//   W2S-3 — JSON_UNQUOTE(JSON_EXTRACT(...)) renders every JSON scalar as a
//           string, so the planner's type guard is blind unless the runner also
//           selects JSON_TYPE(JSON_EXTRACT(...)).
//
// The fixtures below are DRIVER-SHAPED: rows exactly as the MySQL driver hands
// them back, fed through the real `runBackfill` with a stand-in prisma. No
// database is touched — the runner takes its client as an argument.
const {
  runBackfill,
  parseArgs,
  validate,
} = require("../../../../scripts/backfill/order-attribution/run");
const { SKIP_CLASS } = require("../../../../scripts/backfill/order-attribution/plan");

const ORDER_A = "cm0order0000000000000000a";
const BATCH_1 = "11111111-1111-4111-8111-111111111111";
const UNTIL = "2026-08-14T19:13:29Z";
const BEFORE = new Date("2026-08-13T12:00:00Z");
const AFTER = new Date("2026-08-15T09:00:00Z");

const opts = (over = {}) => ({ apply: false, since: null, until: UNTIL, json: null, ...over });

/**
 * A stand-in prisma that answers the runner's two SELECTs with driver-shaped
 * rows and records every statement it is asked to run.
 */
function fakePrisma({ eventRows = [], ledgerRows = [] } = {}) {
  const queries = [];
  const writes = [];
  return {
    queries,
    writes,
    $queryRawUnsafe: async (sql, ...params) => {
      queries.push({ sql, params });
      if (/FROM audit_logs/.test(sql)) return eventRows;
      if (/FROM inventory_logs/.test(sql)) {
        return ledgerRows.filter((r) => params.includes(r.batchId));
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    $executeRawUnsafe: async (sql, ...params) => {
      writes.push({ sql, params });
      return 1;
    },
  };
}

/** One audit row as MySQL returns it: BIGINT id, DATETIME createdAt, JSON_TYPEs. */
const eventRow = (over = {}) => ({
  id: 1n,
  batchId: BATCH_1,
  accruedOrderId: ORDER_A,
  accruedOrderIdType: "STRING",
  intent: null,
  intentType: null,
  createdAt: BEFORE,
  ...over,
});

const ledgerRow = (over = {}) => ({
  id: 10n,
  batchId: BATCH_1,
  logType: "SALE",
  orderRecordId: null,
  ...over,
});

// ---------------------------------------------------------------------------
// W2S-2 — the cutoff is not optional
// ---------------------------------------------------------------------------

describe("W2S-2 — the runner refuses to run without the W2 deploy moment", () => {
  it("PIN W2S-2g: no --until is a refusal that says WHY", () => {
    const errors = validate(opts({ until: null }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--until");
    // The reason, not just the rule: an operator who is told "required" will
    // pass today's date and silently re-attribute every stale-client event.
    expect(errors[0]).toMatch(/intent/i);
  });

  it("PIN W2S-2h: the refusal applies to BOTH modes — a dry run is not exempt", () => {
    expect(validate(opts({ until: null, apply: false }))).toHaveLength(1);
    expect(validate(opts({ until: null, apply: true }))).toHaveLength(1);
  });

  it("PIN W2S-2i: an unparseable --until is refused rather than coerced to an epoch", () => {
    expect(validate(opts({ until: "whenever" }))).toEqual([
      expect.stringContaining("--until"),
    ]);
    expect(validate(opts({ until: UNTIL }))).toEqual([]);
  });

  // W2FD-1 — the cutoff must carry its OWN timezone. `Date.parse` accepts a
  // timezone-less ISO string and resolves it in the HOST timezone, so the same
  // command classifies differently on an MDT laptop and a UTC server — a
  // six-hour window in which a stale no-intent event flips to "pre-cutoff" and
  // gets attributed. Locale forms and bare numbers parsed too. Strictness is
  // the fix: an instant with an explicit Z or numeric offset, nothing else.
  it("PIN W2FD-1a: a timezone-less --until is refused by name", () => {
    expect(validate(opts({ until: "2026-08-14T19:13:29" }))).toEqual([
      expect.stringContaining("offset"),
    ]);
  });

  it("PIN W2FD-1b: locale-formatted and bare-number forms are refused", () => {
    expect(validate(opts({ until: "08/14/2026 19:13:29" }))).toEqual([
      expect.stringContaining("--until"),
    ]);
    expect(validate(opts({ until: "0" }))).toEqual([
      expect.stringContaining("--until"),
    ]);
    expect(validate(opts({ until: "2026-08-14" }))).toEqual([
      expect.stringContaining("--until"),
    ]);
  });

  it("PIN W2FD-1c: explicit-offset instants are accepted, Z and numeric alike", () => {
    expect(validate(opts({ until: "2026-08-14T19:13:29Z" }))).toEqual([]);
    expect(validate(opts({ until: "2026-08-14T19:13:29.123Z" }))).toEqual([]);
    expect(validate(opts({ until: "2026-08-14T13:13:29-06:00" }))).toEqual([]);
  });

  it("PIN W2FD-1d: the cutoff Date the planner receives is host-timezone-independent", () => {
    const { parseCutoff } = require("../../../../scripts/backfill/order-attribution/run.js");
    expect(parseCutoff("2026-08-14T19:13:29Z").getTime()).toBe(
      Date.UTC(2026, 7, 14, 19, 13, 29)
    );
    expect(parseCutoff("2026-08-14T13:13:29-06:00").getTime()).toBe(
      Date.UTC(2026, 7, 14, 19, 13, 29)
    );
    expect(parseCutoff("2026-08-14T19:13:29")).toBeNull();
  });

  it("PIN W2S-2j: --until is parsed off argv and reported back in the summary", async () => {
    expect(parseArgs([`--until=${UNTIL}`])).toMatchObject({ until: UNTIL });

    const prisma = fakePrisma({
      eventRows: [eventRow()],
      ledgerRows: [ledgerRow()],
    });
    const report = await runBackfill(prisma, opts());

    expect(report.options.until).toBe(UNTIL);
  });

  it("PIN W2S-2k: a POST-cutoff stale-client event (order id, no intent) is skipped by name", async () => {
    const prisma = fakePrisma({
      eventRows: [eventRow({ createdAt: AFTER })],
      ledgerRows: [ledgerRow()],
    });

    const report = await runBackfill(prisma, opts({ apply: true }));

    expect(report.summary.rowsToFill).toBe(0);
    expect(report.summary.eventsSkippedByClass[SKIP_CLASS.POST_CUTOFF_NO_INTENT]).toBe(1);
    expect(prisma.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// W2S-3 — the type comes from the database, not from typeof
// ---------------------------------------------------------------------------

describe("W2S-3 — the runner projects JSON_TYPE alongside the value", () => {
  it("PIN W2S-3a: the accrual SELECT asks for the JSON_TYPE of both keys and the createdAt", async () => {
    const prisma = fakePrisma({ eventRows: [], ledgerRows: [] });
    await runBackfill(prisma, opts());

    const [{ sql }] = prisma.queries;
    expect(sql).toMatch(/JSON_TYPE\(JSON_EXTRACT\(details, '\$\."selectedExternalOrderId"'\)\)/);
    expect(sql).toMatch(/JSON_TYPE\(JSON_EXTRACT\(details, '\$\."intent"'\)\)/);
    expect(sql).toMatch(/createdAt/);
  });

  it.each([
    ["a JSON number", "42", "INTEGER"],
    ["a JSON boolean", "true", "BOOLEAN"],
    ["a JSON array", '["cm0order0000000000000000a"]', "ARRAY"],
    ["a JSON object", '{"id":"cm0order0000000000000000a"}', "OBJECT"],
    ["a JSON null", "null", "NULL"],
  ])(
    "PIN W2S-3b: %s survives JSON_UNQUOTE as a string and is still refused",
    async (_label, accruedOrderId, accruedOrderIdType) => {
      const prisma = fakePrisma({
        eventRows: [eventRow({ accruedOrderId, accruedOrderIdType })],
        ledgerRows: [ledgerRow()],
      });

      const report = await runBackfill(prisma, opts({ apply: true }));

      expect(report.summary.rowsToFill).toBe(0);
      expect(report.summary.eventsSkippedByClass[SKIP_CLASS.UNUSABLE_ACCRUED_ID]).toBe(1);
      expect(prisma.writes).toHaveLength(0);
    }
  );

  it("PIN W2S-3c: a JSON STRING id fills its rows, ids intact through the projection", async () => {
    const prisma = fakePrisma({
      eventRows: [eventRow()],
      ledgerRows: [ledgerRow({ id: 10n }), ledgerRow({ id: 11n })],
    });

    const report = await runBackfill(prisma, opts({ apply: true }));

    expect(report.summary.rowsToFill).toBe(2);
    expect(prisma.writes).toHaveLength(1);
    // The write carries the accrued id, the row ids, the batchId and the SALE
    // guard — the WHERE that makes the whole script idempotent.
    expect(prisma.writes[0].params).toEqual([ORDER_A, 10, 11, BATCH_1, "SALE"]);
    expect(prisma.writes[0].sql).toContain("orderRecordId IS NULL");
  });
});
