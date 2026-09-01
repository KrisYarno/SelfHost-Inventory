// @jest-environment node
//
// W2-1 (contract pack REV-11 T7 / design REV-2 "Stamping") — fulfill, unfulfill
// and deduct-simple write `inventory_logs.orderRecordId`.
//
// The columns have been live since W1; nothing has ever written the order one.
// These are STATE assertions on the row each route actually hands
// `inventory_logs.create`, because the whole point of the column is that a
// later reconciliation can join a ledger row to the order it moved for. A test
// that only proved "the route still 200s" would prove nothing about that join.
//
// FORGEABILITY: none of the three routes trusts a client for the id it stamps.
// fulfill/unfulfill stamp the order they ALREADY resolved from the path and
// membership-checked; deduct-simple stamps only what the extracted resolver
// returned. The pins below assert the SOURCE, not just the value.
import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireCompanyMembership: jest.fn(),
  requireCSRF: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/external-orders/stock-sync", () => ({
  pushStockForProducts: jest.fn(async () => undefined),
}));
jest.mock("@/lib/external-orders/shared", () => ({
  pushOrderStatusToExternal: jest.fn(async () => ({ success: true })),
}));
// See w2-intent-chip.test.ts: `mockDeep` is hoist-safe by name, so the factory
// needs no require().
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireCompanyMembership, requireCSRF } from "@/lib/api-utils";
import { POST as FULFILL } from "@/app/api/orders/[orderId]/fulfill/route";
import { POST as UNFULFILL } from "@/app/api/orders/[orderId]/unfulfill/route";
import { POST as DEDUCT } from "@/app/api/inventory/deduct-simple/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const ORDER_CUID = "cmdq7f3k80001s6h4p2n9wxyz";
const COMPANY_ID = "company-abc";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

// ---------------------------------------------------------------------------
// THE RECORDING RAW TRIO (pack CB0.3, the per-suite paragraph).
//
// This suite declares its OWN `@/lib/prisma` factory, so the global harness's
// trio never reaches it, and it builds a FRESH tx per test — so the trio is
// installed on each tx `makeTx()` hands out, at the point it is built (the
// REV-15 OC-4 placement rule: never somewhere a later rebuild would discard).
//
// Two layers: the OUTER fn always records and then delegates to an INNER
// behaviour fn (`rawBehavior`), which is what a test configures — so an
// override can never silently switch the recording off. The suite's existing
// `$executeRaw`/`$executeRawUnsafe` stubs are kept as exactly that: inner
// behaviours. B1.5: fulfil issues NO unsafe statement any more (the per-item
// savepoints never worked on MySQL — ER 1295), so that stub is dead weight on
// the fulfil path; it stays because other paths on this tx may still use it.
// ---------------------------------------------------------------------------
type RawCall = { kind: "query" | "execute" | "executeUnsafe"; sql: string; at: number };

/** Every raw statement the test under way has spent, in call order. */
const rawCalls: RawCall[] = [];
/** The INNER behaviour fns, by method name — what a test configures. */
const rawBehavior: Record<string, jest.Mock> = {};
/** The OUTER recording fns — for `invocationCallOrder` against the delegates. */
const rawFns: Record<string, jest.Mock> = {};
let rawSeq = 0;

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === "object" && typeof (arg as { sql?: unknown }).sql === "string"
    ? (arg as { sql: string }).sql
    : String(arg);
}

function installRecordingRaw(target: Record<string, unknown>): void {
  const install = (kind: RawCall["kind"], method: string, make: () => unknown) => {
    const behavior = jest.fn((..._args: unknown[]) => Promise.resolve(make()));
    const recording = jest.fn((...args: unknown[]) => {
      rawCalls.push({ kind, sql: sqlTextOf(args[0]), at: rawSeq++ });
      return behavior(...args);
    });
    rawBehavior[method] = behavior;
    rawFns[method] = recording;
    target[method] = recording;
  };
  install("query", "$queryRaw", () => []);
  install("execute", "$executeRaw", () => 0);
  install("executeUnsafe", "$executeRawUnsafe", () => 0);
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes("FROM product_locations") && sql.includes("(productId, locationId) IN");
}

/**
 * The order lock's SELECT (lib/inventory/order-lock.ts), by its text — the
 * statement every stock-writing route now spends FIRST when it names an order
 * (pack CB1b). A route whose lock finds nothing answers 409 ORDER_GONE, so the
 * orders these tests drive have to be here.
 */
function isOrderLockSelect(sql: string): boolean {
  return sql.includes("FROM external_orders") && sql.includes("FOR UPDATE");
}

/** The orders these routes lock, as the lock reads them back. */
const LOCKED_ORDERS = [{ id: ORDER_CUID, orderNumber: "12345" }];

/**
 * What the prelock's returning SELECT hands back. The primitives' per-key
 * `product_locations.findUnique` retired with the prelock (pack CB1a-i), so
 * the fixture that read { quantity: 100, version: 1 } is spelled here as the
 * materialized rows the version guard and the stock floor now read.
 *
 * The order lock's rows ride the same dispatcher (pack CB1b): one raw read
 * answers both statements, told apart by their text.
 */
function prelocked(
  rows: Array<{ productId: number; locationId: number; quantity: number; version: number }>
): void {
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const sql = sqlTextOf(args[0]);
    if (isOrderLockSelect(sql)) return LOCKED_ORDERS;
    return isPrelockSelect(sql) ? rows : [];
  });
}

/**
 * Every prelocked key the three routes here touch: stocked, at version 1. The
 * manual deduction's (5,2); fulfil/unfulfill's single line (10,5); and the
 * bundle's components (21,5) and (22,5) — unfulfill prelocks per COMPONENT
 * (pack CB1b.3), never the bundle line's own product.
 */
const STOCKED = [
  { productId: 5, locationId: 2, quantity: 100, version: 1 },
  { productId: 10, locationId: 5, quantity: 100, version: 1 },
  { productId: 21, locationId: 5, quantity: 100, version: 1 },
  { productId: 22, locationId: 5, quantity: 100, version: 1 },
];

function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  installRecordingRaw(tx as unknown as Record<string, unknown>);
  prelocked(STOCKED);
  tx.product_locations.findUnique.mockResolvedValue({ version: 1, quantity: 100 } as any);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  tx.product_locations.create.mockResolvedValue({} as any);
  // The bundle path pre-flights every component's stock in ONE findMany.
  tx.product_locations.findMany.mockResolvedValue([
    { productId: 21, quantity: 100 },
    { productId: 22, quantity: 100 },
  ] as any);
  tx.inventory_logs.create.mockResolvedValue({ id: 777, products: { name: "Widget A" } } as any);
  tx.product.findUnique.mockResolvedValue({ id: 10, name: "Widget A", deletedAt: null } as any);
  // B1.5 (pack CB1.5a-i.2): the ONE batched `products` read — it proves every
  // survivor id AND supplies the name the result entry carries, so it answers
  // { id, name }. The per-item `product.findUnique` retired with it.
  (tx.product.findMany as unknown as jest.Mock).mockImplementation(async (args: any) =>
    ((args?.where?.id?.in ?? []) as number[]).map((id) => ({ id, name: `Product ${id}` }))
  );
  tx.product.update.mockResolvedValue({} as any);
  // OC-4: the location the prelock's INSERT names in `fk_pl_location`, proved
  // beside the products. Absent = the whole request is a 400.
  (tx.location.findUnique as unknown as jest.Mock).mockImplementation(async (args: any) => ({
    id: args?.where?.id,
  }));
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  tx.externalOrder.update.mockResolvedValue({} as any);
  tx.externalOrderItem.update.mockResolvedValue({} as any);
  tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 2, fulfilledQty: 2 }] as any);
  // Kept verbatim, now as INNER behaviours: the fulfil/unfulfill paths read
  // these as their atomic UPDATEs' affected-row counts. (The unsafe stub is
  // DEAD for fulfil since B1.5 — see the note above.)
  rawBehavior.$executeRaw.mockResolvedValue(1 as any);
  rawBehavior.$executeRawUnsafe.mockResolvedValue(1 as any);
  return tx;
}

function driveTxWith(tx: ReturnType<typeof makeTx>) {
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
}

/** One single-mapped, unfulfilled line — the plain (non-bundle) path. */
function singleLine(over: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    orderId: ORDER_CUID,
    quantity: 2,
    fulfilledQty: 0,
    name: "Widget A",
    sku: "WA-001",
    isMapped: true,
    productLink: {
      internalProductId: 10,
      internalProduct: { id: 10, name: "Widget A" },
      isBundle: false,
      bundleComponents: [],
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  rawCalls.length = 0;
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);
  db.integration.findUnique.mockResolvedValue({ fulfillmentPushEnabled: false } as any);
  db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
  db.product.findUnique.mockResolvedValue({ name: "Widget A" } as any);
});

describe("fulfill — the SALE row names the order it moved for", () => {
  it("stamps orderRecordId with the order resolved from the PATH, not from the body", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [singleLine()],
    } as any);
    driveTxWith(tx);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        // A forged annotation on the body must not reach the ledger.
        orderRecordId: "cmforgedforgedforgedforged",
        items: [{ itemId: "item-1", quantity: 2 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    const row = tx.inventory_logs.create.mock.calls[0][0].data as any;
    expect(row.logType).toBe("SALE");
    expect(row.orderRecordId).toBe(ORDER_CUID);
  });

  it("stamps every BUNDLE COMPONENT row with the same order", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [
        singleLine({
          id: "item-bundle",
          bundleComponentSnapshot: null,
          productLink: {
            internalProductId: 10,
            internalProduct: { id: 10, name: "Bundle" },
            isBundle: true,
            bundleComponents: [
              { internalProductId: 21, quantity: 1, sortOrder: 0 },
              { internalProductId: 22, quantity: 2, sortOrder: 1 },
            ],
          },
        }),
      ],
    } as any);
    driveTxWith(tx);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        items: [{ itemId: "item-bundle", quantity: 1 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    const rows = tx.inventory_logs.create.mock.calls.map((c) => c[0].data as any);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.orderRecordId).toBe(ORDER_CUID);
    }
  });
});

describe("unfulfill — the CORRECTION row names the same order", () => {
  it("stamps orderRecordId on the restoration row", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "processing",
      integration: { id: "int-1", fulfillmentPushEnabled: false },
      items: [singleLine({ fulfilledQty: 2 })],
    } as any);
    driveTxWith(tx);

    const res = await UNFULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/unfulfill`, {
        items: [{ itemId: "item-1", productId: 10, quantity: 2, locationId: 5 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    const row = tx.inventory_logs.create.mock.calls[0][0].data as any;
    // The reversal keeps its CORRECTION identity AND gains the attribution.
    expect(row.logType).toBe("CORRECTION");
    expect(row.reasonCode).toBe("CORRECTION");
    expect(row.orderRecordId).toBe(ORDER_CUID);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation lane R-A (spec REV-7 D1/D2, pack C1b.3): the ATTEMPT ROW.
//
// These are the pins that make an UNWIRED writer fail. `mockDeep()` fabricates
// every delegate lazily, so `tx.orderAttributionAttempt.create` exists whether
// or not the route ever calls it — a route that silently stopped recording
// would keep this suite green without them. Each asserts the EXACT row, because
// the columns are the contract: a wrong `evidence` is a report that lies about
// how a batch got attributed.
// ---------------------------------------------------------------------------

/** The one attempt row the route wrote, or a failure naming the miss. */
function soleAttempt(tx: ReturnType<typeof makeTx>) {
  expect(tx.orderAttributionAttempt.create).toHaveBeenCalledTimes(1);
  return (tx.orderAttributionAttempt.create.mock.calls[0][0] as any).data;
}

describe("fulfill — the ATTEMPT row says fulfillment attributed it", () => {
  it("records attributed/fulfillment against the first ledger row", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [singleLine()],
    } as any);
    driveTxWith(tx);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        items: [{ itemId: "item-1", quantity: 2 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    expect(soleAttempt(tx)).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 777,
      outcome: "attributed",
      evidence: "fulfillment",
      reason: null,
      orderRecordId: ORDER_CUID,
      previousOrderRecordId: null,
      source: "fulfillment",
      actorUserId: 7,
    });
  });

  it("a BUNDLE-ONLY fulfillment records ledgerRowId NULL, never the -1 sentinel", async () => {
    // Bundle lines expand into component deductions and carry the sentinel log
    // id; a -1 in ledgerRowId would be a soft ref to a row that does not exist.
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [
        singleLine({
          id: "item-bundle",
          bundleComponentSnapshot: null,
          productLink: {
            internalProductId: 10,
            internalProduct: { id: 10, name: "Bundle" },
            isBundle: true,
            bundleComponents: [
              { internalProductId: 21, quantity: 1, sortOrder: 0 },
              { internalProductId: 22, quantity: 2, sortOrder: 1 },
            ],
          },
        }),
      ],
    } as any);
    driveTxWith(tx);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        items: [{ itemId: "item-bundle", quantity: 1 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    const row = soleAttempt(tx);
    expect(row.ledgerRowId).toBeNull();
    expect(row.evidence).toBe("fulfillment");
  });
});

describe("deduct-simple — only the RESOLVED id is ever stamped", () => {
  it("stamps nothing when the resolver was never reached", async () => {
    const tx = makeTx();
    tx.inventory_logs.create.mockResolvedValue({
      id: 1,
      productId: 5,
      delta: -3,
      products: { name: "Widget" },
    } as any);
    driveTxWith(tx);

    const res = await DEDUCT(
      post("http://x/api/inventory/deduct-simple", {
        locationId: 2,
        items: [{ productId: 5, quantity: 3 }],
        intent: "order",
      })
    );
    expect(res.status).toBe(200);

    const row = tx.inventory_logs.create.mock.calls[0][0].data as any;
    expect(row.orderRecordId ?? null).toBeNull();
    expect(db.externalOrder.findUnique).not.toHaveBeenCalled();
  });
});

describe("deduct-simple — the ATTEMPT row records WHICH evidence, or why none", () => {
  /** Drive one manual deduction; hand back the attempt row it wrote. */
  async function deductAttempt(body: Record<string, unknown>) {
    const tx = makeTx();
    tx.inventory_logs.create.mockResolvedValue({
      id: 4242,
      productId: 5,
      delta: -3,
      products: { name: "Widget" },
    } as any);
    driveTxWith(tx);

    const res = await DEDUCT(
      post("http://x/api/inventory/deduct-simple", {
        locationId: 2,
        items: [{ productId: 5, quantity: 3 }],
        ...body,
      })
    );
    expect(res.status).toBe(200);
    return soleAttempt(tx);
  }

  it("a SELECTED order -> attributed/selected, carrying the chip in details", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    expect(
      await deductAttempt({ intent: "order", selectedExternalOrderId: ORDER_CUID })
    ).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 4242,
      outcome: "attributed",
      evidence: "selected",
      reason: null,
      orderRecordId: ORDER_CUID,
      previousOrderRecordId: null,
      source: "live-deduct",
      actorUserId: 7,
      details: { intent: "order" },
    });
  });

  it("a TYPED reference that resolved -> attributed/reference-resolved", async () => {
    // The reference round, not the selection: the two do not carry the same
    // confidence, and a report that reads them as one thing is reading a number
    // it cannot stand behind.
    db.externalOrder.findMany.mockResolvedValue([
      { id: ORDER_CUID, orderNumber: "12345", companyId: COMPANY_ID },
    ] as any);

    expect(await deductAttempt({ orderReference: "12345" })).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 4242,
      outcome: "attributed",
      evidence: "reference-resolved",
      reason: null,
      orderRecordId: ORDER_CUID,
      previousOrderRecordId: null,
      source: "live-deduct",
      actorUserId: 7,
    });
  });

  it("NOTHING typed and no id -> none/no-reference-typed, not a decline", async () => {
    expect(await deductAttempt({})).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 4242,
      outcome: "none",
      evidence: null,
      reason: "no-reference-typed",
      orderRecordId: null,
      previousOrderRecordId: null,
      source: "live-deduct",
      actorUserId: 7,
    });
  });
});

// ---------------------------------------------------------------------------
// THE LOCK DISCIPLINE (reconciliation Part 2, spec §2.7; pack CB1b.1/.2)
//
// Same three routes, one level down: not WHICH order they stamp but WHEN they
// take it. The order lock is statement 1, the prelock follows it, and the first
// stock write follows both — so two requests packing the same order serialize
// on `external_orders` before either has touched a ledger row. An UNSTAMPED
// deduction has no order to serialize on and spends nothing.
// ---------------------------------------------------------------------------

describe("the lock discipline — the order lock, then the prelock, then the writes", () => {
  /** The raw statements this request spent, in call order. */
  const kinds = () => rawCalls.map((c) => c.kind);

  function driveManualDeduct(tx: ReturnType<typeof makeTx>, body: Record<string, unknown>) {
    tx.inventory_logs.create.mockResolvedValue({
      id: 4242,
      productId: 5,
      delta: -3,
      products: { name: "Widget" },
    } as any);
    driveTxWith(tx);
    return DEDUCT(
      post("http://x/api/inventory/deduct-simple", {
        locationId: 2,
        items: [{ productId: 5, quantity: 3 }],
        ...body,
      })
    );
  }

  it("deduct-simple STAMPED: the lock SELECT precedes the prelock, which precedes the first write", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);
    const tx = makeTx();

    const res = await driveManualDeduct(tx, {
      intent: "order",
      selectedExternalOrderId: ORDER_CUID,
    });
    expect(res.status).toBe(200);

    // lock SELECT · prelock INSERT · prelock SELECT — and nothing before them.
    expect(kinds().slice(0, 3)).toEqual(["query", "execute", "query"]);
    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true);
    expect(rawCalls[1].sql).toContain("INSERT INTO product_locations");
    expect(isPrelockSelect(rawCalls[2].sql)).toBe(true);
    // The lock names the id being STAMPED.
    expect((rawFns.$queryRaw.mock.calls[0][0] as any).values).toEqual([ORDER_CUID]);
    // ...and every raw statement precedes the first ledger write.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.inventory_logs.create.mock.invocationCallOrder[0]
    );
  });

  it("deduct-simple UNSTAMPED: ZERO order-lock statements, the prelock alone", async () => {
    const tx = makeTx();

    const res = await driveManualDeduct(tx, {});
    expect(res.status).toBe(200);

    expect(rawCalls.filter((c) => isOrderLockSelect(c.sql))).toHaveLength(0);
    expect(kinds().slice(0, 2)).toEqual(["execute", "query"]);
    expect(rawCalls[0].sql).toContain("INSERT INTO product_locations");
  });

  it("deduct-simple answers with the batch it wrote under", async () => {
    const tx = makeTx();
    const res = await driveManualDeduct(tx, {});
    const body = await res.json();

    expect(typeof body.batchId).toBe("string");
    // The SAME batch the ledger rows and the audit event carry.
    expect(tx.inventory_logs.create.mock.calls[0][0].data.batchId).toBe(body.batchId);
    expect((tx.auditLog.create.mock.calls[0][0] as any).data.batchId).toBe(body.batchId);
  });

  it("fulfil: the lock is statement 1, asked with the id from the PATH", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [singleLine()],
    } as any);
    driveTxWith(tx);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        items: [{ itemId: "item-1", quantity: 2 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true);
    expect((rawFns.$queryRaw.mock.calls[0][0] as any).values).toEqual([ORDER_CUID]);
    // The lock precedes the order read this transaction's view opens on.
    expect(rawFns.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.externalOrder.findUnique.mock.invocationCallOrder[0]
    );

    // ...and the response names the batch its SALE rows carry.
    const body = await res.json();
    expect(typeof body.batchId).toBe("string");
    expect(tx.inventory_logs.create.mock.calls[0][0].data.batchId).toBe(body.batchId);
  });

  it("fulfil: an ALL-SKIPPED request answers batchId null (pack REV-22 F8)", async () => {
    // The id is minted before the deduction runs, so a fulfilment that moved
    // nothing used to hand the client a batch naming no ledger row at all — an
    // Undo target that cannot exist. Non-null now means "at least one item was
    // fulfilled".
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [singleLine({ isMapped: false, productLink: null })],
    } as any);
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 2, fulfilledQty: 0 }] as any);
    driveTxWith(tx);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        items: [{ itemId: "item-1", quantity: 2, skipUnmapped: true }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.fulfillmentStatus).toBe("none");
    expect(body.summary).toMatchObject({ fulfilled: 0, skipped: 1 });
    expect(body.batchId).toBeNull();
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it("unfulfill: the lock, then pass 1, then the prelock, then the restorations", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue({
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "processing",
      integration: { id: "int-1", fulfillmentPushEnabled: false },
      items: [singleLine({ fulfilledQty: 2 })],
    } as any);
    driveTxWith(tx);

    const res = await UNFULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/unfulfill`, {
        items: [{ itemId: "item-1", productId: 10, quantity: 2, locationId: 5 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true);
    expect(rawCalls[1].sql).toContain("UPDATE external_order_items");
    expect(rawCalls[2].sql).toContain("INSERT INTO product_locations");
    expect(isPrelockSelect(rawCalls[3].sql)).toBe(true);
    expect(rawCalls[4].sql).toContain("UPDATE product_locations");
    // The materialized row is always there — the create fallback is gone.
    expect(tx.product_locations.create).not.toHaveBeenCalled();
  });
});
