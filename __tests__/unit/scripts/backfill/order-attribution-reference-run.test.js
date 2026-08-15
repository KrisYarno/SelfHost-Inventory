// @jest-environment node
/* eslint-disable @typescript-eslint/no-require-imports --
 * A CJS test for a CJS script; see the sibling reference suite's note. */
//
// REFERENCE-RESOLUTION ROUND — the companion source, pinned on the backfill's
// RUNNER.
//
// plan.js decides; run.js is what reads the database, and the new source adds
// exactly two things to it: the accrual projection has to WIDEN (an event
// carrying only `details.orderReference` was previously not selected at all),
// and the exact-unique bar needs candidate order numbers, which means one more
// read — a bounded `IN (...)` over `external_orders`.
//
// The byte-stability requirement lands here too: a world with no usable
// reference must issue the SAME statements it issued before this round, which
// is why the candidate read is skipped entirely rather than run with an empty
// list.
const {
  runBackfill,
  formatSummary,
} = require("../../../../scripts/backfill/order-attribution/run");
const { SKIP_CLASS, ATTRIBUTION_SOURCE } = require("../../../../scripts/backfill/order-attribution/plan");

const ORDER_A = "cm0order0000000000000000a";
const ORDER_B = "cm0order0000000000000000b";
const BATCH_1 = "11111111-1111-4111-8111-111111111111";
const REF_A = "12345";
const UNTIL = "2026-08-14T19:13:29Z";
const BEFORE = new Date("2026-08-13T12:00:00Z");

const opts = (over = {}) => ({ apply: false, since: null, until: UNTIL, json: null, ...over });

function fakePrisma({ eventRows = [], ledgerRows = [], orderRows = [] } = {}) {
  const queries = [];
  const writes = [];
  return {
    queries,
    writes,
    $queryRawUnsafe: async (sql, ...params) => {
      queries.push({ sql, params });
      if (/FROM audit_logs/.test(sql)) return eventRows;
      if (/FROM external_orders/.test(sql)) {
        return orderRows.filter((r) => params.includes(r.orderNumber));
      }
      if (/FROM inventory_logs/.test(sql)) {
        return ledgerRows.filter((r) => params.includes(r.batchId));
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    $executeRawUnsafe: async (sql, ...params) => {
      writes.push({ sql, params });
      return params.filter((p) => typeof p === "number").length;
    },
  };
}

/** A free-text accrual event as MySQL returns it: the id keys NULL throughout. */
const refEventRow = (over = {}) => ({
  id: 1n,
  batchId: BATCH_1,
  accruedOrderId: null,
  accruedOrderIdType: null,
  orderReference: REF_A,
  orderReferenceType: "STRING",
  intent: null,
  intentType: null,
  createdAt: BEFORE,
  ...over,
});

const idEventRow = (over = {}) => ({
  id: 2n,
  batchId: BATCH_1,
  accruedOrderId: ORDER_A,
  accruedOrderIdType: "STRING",
  orderReference: null,
  orderReferenceType: null,
  intent: null,
  intentType: null,
  createdAt: BEFORE,
  ...over,
});

const ledgerRow = (over = {}) => ({ id: 10n, batchId: BATCH_1, logType: "SALE", orderRecordId: null, ...over });
const orderRow = (orderNumber, id) => ({ id, orderNumber });

describe("the accrual projection widens to BOTH evidence keys", () => {
  it("selects events carrying EITHER key, and projects the reference with its JSON_TYPE", async () => {
    const prisma = fakePrisma();
    await runBackfill(prisma, opts());

    const [{ sql }] = prisma.queries;
    expect(sql).toMatch(/JSON_UNQUOTE\(JSON_EXTRACT\(details, '\$\."orderReference"'\)\)/);
    expect(sql).toMatch(/JSON_TYPE\(JSON_EXTRACT\(details, '\$\."orderReference"'\)\)/);
    // Both keys still project, and the WHERE now admits an event carrying only
    // the free-text one — which in production is EVERY one of them.
    expect(sql).toMatch(/JSON_TYPE\(JSON_EXTRACT\(details, '\$\."selectedExternalOrderId"'\)\)/);
    expect(sql).toMatch(/OR JSON_EXTRACT\(details, '\$\."orderReference"'\) IS NOT NULL/);
  });
});

describe("the candidate read is bounded, and skipped when nothing needs it", () => {
  it("asks external_orders for the trimmed references it actually has", async () => {
    const prisma = fakePrisma({
      eventRows: [refEventRow({ orderReference: `  ${REF_A} ` })],
      ledgerRows: [ledgerRow()],
      orderRows: [orderRow(REF_A, ORDER_A)],
    });

    await runBackfill(prisma, opts());

    const candidate = prisma.queries.find((q) => /FROM external_orders/.test(q.sql));
    expect(candidate).toBeDefined();
    expect(candidate.params).toEqual([REF_A]);
    expect(candidate.sql).toMatch(/orderNumber IN/);
  });

  it("issues NO candidate read at all when no event carries a usable reference", async () => {
    const prisma = fakePrisma({ eventRows: [idEventRow()], ledgerRows: [ledgerRow()] });

    await runBackfill(prisma, opts());

    expect(prisma.queries.some((q) => /FROM external_orders/.test(q.sql))).toBe(false);
  });

  it("RR-2: issues NO candidate read for an event whose STRUCTURED key is present — its reference is ignored, so it must not be asked about", async () => {
    const prisma = fakePrisma({
      eventRows: [idEventRow({ orderReference: "23645", orderReferenceType: "STRING" })],
      ledgerRows: [ledgerRow()],
    });

    await runBackfill(prisma, opts());

    expect(prisma.queries.some((q) => /FROM external_orders/.test(q.sql))).toBe(false);
  });

  it("issues NO candidate read for references that fail the shape bar", async () => {
    const prisma = fakePrisma({
      eventRows: [refEventRow({ orderReference: "walk-in 88" })],
      ledgerRows: [ledgerRow()],
    });

    const report = await runBackfill(prisma, opts());

    expect(prisma.queries.some((q) => /FROM external_orders/.test(q.sql))).toBe(false);
    expect(report.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_UNUSABLE]).toBe(1);
  });
});

describe("end to end, through the real runner", () => {
  it("a unique match writes the resolved id with the fill-only WHERE", async () => {
    const prisma = fakePrisma({
      eventRows: [refEventRow()],
      ledgerRows: [ledgerRow({ id: 10n }), ledgerRow({ id: 11n })],
      orderRows: [orderRow(REF_A, ORDER_A)],
    });

    const report = await runBackfill(prisma, opts({ apply: true }));

    expect(report.summary.rowsToFill).toBe(2);
    expect(prisma.writes).toHaveLength(1);
    expect(prisma.writes[0].params).toEqual([ORDER_A, 10, 11, BATCH_1, "SALE"]);
    expect(prisma.writes[0].sql).toContain("orderRecordId IS NULL");
    expect(report.summary.rowsToFillBySource[ATTRIBUTION_SOURCE.REFERENCE_RESOLVED]).toBe(2);
  });

  it("two candidate orders sharing the number write NOTHING", async () => {
    const prisma = fakePrisma({
      eventRows: [refEventRow()],
      ledgerRows: [ledgerRow()],
      orderRows: [orderRow(REF_A, ORDER_A), orderRow(REF_A, ORDER_B)],
    });

    const report = await runBackfill(prisma, opts({ apply: true }));

    expect(prisma.writes).toHaveLength(0);
    expect(report.summary.eventsSkippedByClass[SKIP_CLASS.REFERENCE_AMBIGUOUS]).toBe(1);
  });

  it("names the reference key in the report's accrual block", async () => {
    const prisma = fakePrisma();
    const report = await runBackfill(prisma, opts());

    expect(report.accrual.referenceKey).toBe("orderReference");
  });
});

describe("the summary tells the operator which evidence stamped what", () => {
  it("prints both sources, separately", async () => {
    const prisma = fakePrisma({
      eventRows: [
        refEventRow({ id: 1n }),
        idEventRow({ id: 2n, batchId: "33333333-3333-4333-8333-333333333333" }),
      ],
      ledgerRows: [
        ledgerRow({ id: 10n }),
        ledgerRow({ id: 30n, batchId: "33333333-3333-4333-8333-333333333333" }),
      ],
      orderRows: [orderRow(REF_A, ORDER_A)],
    });

    const report = await runBackfill(prisma, opts());
    const text = formatSummary(report);

    expect(text).toContain(ATTRIBUTION_SOURCE.REFERENCE_RESOLVED);
    expect(text).toContain(ATTRIBUTION_SOURCE.SELECTED);
    expect(text).toMatch(/reference-resolved[^\n]*1/);
  });

  it("never prints or serializes the typed reference", async () => {
    const prisma = fakePrisma({
      eventRows: [refEventRow({ orderReference: "walk-in bob" })],
      ledgerRows: [ledgerRow()],
    });

    const report = await runBackfill(prisma, opts());

    expect(JSON.stringify(report)).not.toContain("walk-in bob");
    expect(formatSummary(report)).not.toContain("walk-in bob");
  });
});
