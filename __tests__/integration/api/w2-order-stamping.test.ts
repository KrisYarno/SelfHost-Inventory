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
// `$executeRaw`/`$executeRawUnsafe` stubs (the fulfil/unfulfill paths' atomic
// UPDATEs and savepoints) are kept as exactly that: inner behaviours.
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
 * What the prelock's returning SELECT hands back. The primitives' per-key
 * `product_locations.findUnique` retired with the prelock (pack CB1a-i), so
 * the fixture that read { quantity: 100, version: 1 } is spelled here as the
 * materialized rows the version guard and the stock floor now read.
 */
function prelocked(
  rows: Array<{ productId: number; locationId: number; quantity: number; version: number }>
): void {
  rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) =>
    isPrelockSelect(sqlTextOf(args[0])) ? rows : []
  );
}

/** The prelocked key the manual deduction touches: stocked, at version 1. */
const STOCKED = [{ productId: 5, locationId: 2, quantity: 100, version: 1 }];

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
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  tx.externalOrder.update.mockResolvedValue({} as any);
  tx.externalOrderItem.update.mockResolvedValue({} as any);
  tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 2, fulfilledQty: 2 }] as any);
  // Kept verbatim, now as INNER behaviours: the fulfil/unfulfill paths read
  // these as their atomic UPDATEs' affected-row counts.
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
