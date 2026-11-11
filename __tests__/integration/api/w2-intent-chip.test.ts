// @jest-environment node
//
// W2-1 (contract pack REV-11 T7) — THE INTENT CHIP'S MAPPING TABLE, pinned AT
// THE ROUTE.
//
//   | value       | reasonCode | orderRecordId          | surfaces          |
//   | order       | none       | via extracted resolver | adjust + workbench |
//   | damage-loss | DAMAGE     | none                   | ADJUST ONLY       |
//   | other       | none       | none                   | both; NEVER CORRECTION |
//
// Every pin here drives the REAL route against a deep-mocked Prisma and reads
// the payload the route actually handed `inventory_logs.create`. The pack is
// explicit that the mapping is pinned at the ROUTE LEVEL, not at the mapper: a
// pure-function test would keep passing if a route stopped calling the mapper,
// and `other -> CORRECTION` is precisely the mistake that would silently remove
// rows from the LOCKED reorder-demand predicate.
//
// The two downstream consequences are pinned against the SAME row the route
// wrote (the mass-update-count-stamp.test.ts idiom), never against a fixture:
//   - a damage-loss row is INSIDE getShrinkageSummary's domain and classifies
//     as DAMAGE (the shrinkage-jump the disclosure warns about);
//   - an `other` row is NOT a CORRECTION and therefore STAYS in reorder demand.
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
// `mockDeep` is referenced directly rather than re-required inside the factory:
// jest's hoist plugin allows out-of-scope bindings whose names begin with
// `mock`, so this keeps the file free of the require() the lint profile forbids.
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));
// Reconciliation Part 2 (P2-B3-1): the T7 mapper is WRAPPED, never replaced —
// every route here still maps through the real table — so the wire-refusal
// pins can prove a refused `count` / `correction` never reaches it.
jest.mock("@/lib/inventory/intent", () => {
  const actual =
    jest.requireActual<typeof import("@/lib/inventory/intent")>("@/lib/inventory/intent");
  return { ...actual, mapDeductionIntent: jest.fn(actual.mapDeductionIntent) };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireCompanyMembership, requireCSRF } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { mapDeductionIntent } from "@/lib/inventory/intent";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { AdjustWithIntentSchema } from "@/lib/validation/inventory";
import { isReorderDemandRow, shrinkageReasonOf } from "@/lib/reports/metrics-contract";
import { POST as ADJUST } from "@/app/api/inventory/adjust/route";
import { POST as DEDUCT } from "@/app/api/inventory/deduct-simple/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const ORDER_CUID = "cmdq7f3k80001s6h4p2n9wxyz";
const COMPANY_ID = "company-abc";

/**
 * The adjust route behind the REAL `apiHandler` — what an API caller actually
 * receives. The mock above makes `apiHandler` a pass-through so most pins can
 * read the thrown error; the wire pins need the 400 body the wrapper renders
 * (`{ error, code: 'VALIDATION_ERROR' }`, lib/api-utils.ts).
 */
const ADJUST_WIRE = jest
  .requireActual<typeof import("@/lib/api-utils")>("@/lib/api-utils")
  .apiHandler(ADJUST);

/**
 * getShrinkageSummary's `domain` (lib/analytics/queries.ts): the logTypes the
 * shrinkage read looks at AT ALL, plus its `delta < 0`. Copied deliberately —
 * importing queries.ts would drag the analytics module graph into a route test,
 * and lane3-operations-queries.test.ts already pins the constant against the
 * real query.
 */
const SHRINKAGE_DOMAIN_LOGTYPES = ["ADJUSTMENT", "CORRECTION"];

type LedgerRowData = {
  delta: number;
  logType: string;
  reasonCode: string | null;
  orderRecordId: string | null;
  batchId: string | null;
};

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
// override can never silently switch the recording off.
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

/** The prelocked key both surfaces touch: stocked, at version 1. */
const STOCKED = [{ productId: 5, locationId: 2, quantity: 100, version: 1 }];

function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  installRecordingRaw(tx as unknown as Record<string, unknown>);
  prelocked(STOCKED);
  tx.product_locations.findUnique.mockResolvedValue({ version: 1, quantity: 100 } as any);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  tx.inventory_logs.create.mockResolvedValue({
    id: 555,
    productId: 5,
    locationId: 2,
    delta: -3,
    products: { name: "Widget" },
  } as any);
  tx.product.findUnique.mockResolvedValue({ id: 5, name: "Widget" } as any);
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  return tx;
}

function driveTxWith(tx: ReturnType<typeof makeTx>) {
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
}

beforeEach(() => {
  jest.clearAllMocks();
  rawCalls.length = 0;
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  // Stock floor for the adjust route's pre-transaction availability check.
  db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
  db.product.findUnique.mockResolvedValue({ name: "Widget" } as any);
});

// ---------------------------------------------------------------------------
// The adjust surface — all THREE chip values live here
// ---------------------------------------------------------------------------

/** Drive one adjustment through the REAL route; hand back what it wrote. */
async function adjustRow(body: Record<string, unknown>) {
  const tx = makeTx();
  driveTxWith(tx);
  const res = await ADJUST(
    post("http://x/api/inventory/adjust", {
      productId: 5,
      locationId: 2,
      delta: -3,
      reason: "operator words",
      ...body,
    })
  );
  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  return {
    row: tx.inventory_logs.create.mock.calls[0][0].data as unknown as LedgerRowData,
    details: tx.auditLog.create.mock.calls[0][0].data.details as Record<string, unknown>,
  };
}

describe("adjust route — T7 mapping table, row by row", () => {
  it("order -> NO reasonCode, orderRecordId from the extracted resolver", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await adjustRow({
      intent: "order",
      selectedExternalOrderId: ORDER_CUID,
    });

    expect(row.reasonCode ?? null).toBeNull();
    expect(row.orderRecordId).toBe(ORDER_CUID);
    // Membership is proven against the RESOLVED order's company, never a claim.
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
    expect(details.intent).toBe("order");
  });

  it("damage-loss -> reasonCode DAMAGE and NO orderRecordId", async () => {
    const { row } = await adjustRow({ intent: "damage-loss" });

    expect(row.reasonCode).toBe("DAMAGE");
    expect(row.orderRecordId ?? null).toBeNull();
  });

  it("other -> nothing at all, and above all NEVER CORRECTION", async () => {
    const { row } = await adjustRow({ intent: "other" });

    expect(row.reasonCode ?? null).toBeNull();
    expect(row.orderRecordId ?? null).toBeNull();
    // The LOCKED reorder-demand predicate excludes reasonCode === 'CORRECTION'.
    // Mapping `other` there would silently delete this depletion from demand.
    expect(row.reasonCode).not.toBe("CORRECTION");
  });

  it("still VALIDATES an id sent with a non-order intent, then declines to stamp it", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row } = await adjustRow({
      intent: "other",
      selectedExternalOrderId: ORDER_CUID,
    });

    // Checked (so a forgery cannot ride through unexamined)...
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
    // ...and not stamped, because `other` attributes nothing.
    expect(row.orderRecordId ?? null).toBeNull();
  });

  it("an order intent with NO id resolves nothing and stamps nothing (never invented)", async () => {
    const { row, details } = await adjustRow({ intent: "order" });

    expect(row.orderRecordId ?? null).toBeNull();
    expect(db.externalOrder.findUnique).not.toHaveBeenCalled();
    // The operator's statement is still accrued — never a silent drop.
    expect(details.intent).toBe("order");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation lane R-A (spec REV-7 D1/D2, pack C1b.3): the ATTEMPT ROW.
//
// `mockDeep()` fabricates `tx.orderAttributionAttempt.create` lazily, so a route
// that never calls it looks identical to one that does — these pins are what
// make an unwired writer fail. The NEGATIVE pins matter just as much: a positive
// adjust and a transfer auto-add move nothing out of the building, so recording
// "we could not attribute it" would put rows in the report for movements that
// never had an attribution question.
// ---------------------------------------------------------------------------

describe("adjust route — the ATTEMPT row, and the two cases that write none", () => {
  async function adjustAttempt(body: Record<string, unknown>) {
    const tx = makeTx();
    driveTxWith(tx);
    const res = await ADJUST(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        ...body,
      })
    );
    expect(res.status).toBe(200);
    return tx;
  }

  it("a negative adjust naming an order -> attributed/selected on the LOG's row id", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const tx = await adjustAttempt({ intent: "order", selectedExternalOrderId: ORDER_CUID });

    expect(tx.orderAttributionAttempt.create).toHaveBeenCalledTimes(1);
    expect((tx.orderAttributionAttempt.create.mock.calls[0][0] as any).data).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 555,
      outcome: "attributed",
      evidence: "selected",
      reason: null,
      orderRecordId: ORDER_CUID,
      previousOrderRecordId: null,
      source: "live-adjust",
      actorUserId: 7,
      details: { intent: "order" },
    });
  });

  it("a negative adjust with NO chip -> none/no-order-context (nothing was stated)", async () => {
    const tx = await adjustAttempt({});

    expect((tx.orderAttributionAttempt.create.mock.calls[0][0] as any).data).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 555,
      outcome: "none",
      evidence: null,
      reason: "no-order-context",
      orderRecordId: null,
      previousOrderRecordId: null,
      source: "live-adjust",
      actorUserId: 7,
    });
  });

  it("a POSITIVE adjust writes NO attempt row at all", async () => {
    const tx = await adjustAttempt({ delta: 3, intent: "order" });

    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });

  it("a transfer AUTO-ADD writes no attempt row either (it is an ADD — a positive delta)", async () => {
    const tx = await adjustAttempt({ delta: 4, autoAddForTransfer: true });

    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });

  // CR-3: the flag used to be read off the RAW body, outside zod, and its only
  // effect on a NEGATIVE delta was to suppress the attempt row. So an approved,
  // CSRF-bearing caller could remove stock, file it as a "transfer auto-add",
  // and leave the attribution report with no record that the question was ever
  // asked. It is a parsed field now, and the combination is refused outright.
  it("REFUSES a NEGATIVE delta carrying autoAddForTransfer (400) and writes nothing", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    await expect(
      ADJUST(
        post("http://x/api/inventory/adjust", {
          productId: 5,
          locationId: 2,
          delta: -5,
          autoAddForTransfer: true,
        })
      )
    ).rejects.toMatchObject({
      message: "auto-add-for-transfer is an ADD — a negative delta cannot carry it",
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });

    // Refused BEFORE any write opens.
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });

  it("REFUSES a non-boolean autoAddForTransfer at the parse (it is a server contract now)", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    await expect(
      ADJUST(
        post("http://x/api/inventory/adjust", {
          productId: 5,
          locationId: 2,
          delta: 4,
          autoAddForTransfer: "yes",
        })
      )
    ).rejects.toThrow();

    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("adjust route — the chip NEVER blocks (design friction ceiling)", () => {
  it("submits legally with no chip interaction at all, landing as other/nothing", async () => {
    const { row, details } = await adjustRow({});

    expect(row.reasonCode ?? null).toBeNull();
    expect(row.orderRecordId ?? null).toBeNull();
    // Truthful-data north star: an untapped chip is an ABSENT key, not a null
    // one — a null would read as a recorded classification that never happened.
    expect("intent" in details).toBe(false);
  });
});

describe("adjust route — the old reason vocabulary no longer arrives", () => {
  it.each(["COUNT", "DAMAGE", "THEFT", "EXPIRY", "CORRECTION"])(
    "REFUSES a legacy reasonCode %s with 400 VALIDATION_ERROR and writes nothing",
    async (reasonCode) => {
      const tx = makeTx();
      driveTxWith(tx);

      await expect(
        ADJUST(
          post("http://x/api/inventory/adjust", {
            productId: 5,
            locationId: 2,
            delta: -3,
            reason: "operator words",
            reasonCode,
          })
        )
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

      // Refused BEFORE any write opens — zod's default strip would have
      // swallowed the field silently, which is the double-entry path the pack
      // closes at the ROUTE, not at the mapper.
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );
});

describe("adjust route — forged order ids abort the whole request (0b-2 posture)", () => {
  it("REJECTS an id that resolves to no order with 400 and commits nothing", async () => {
    db.externalOrder.findUnique.mockResolvedValue(null as any);

    await expect(
      adjustRow({ intent: "order", selectedExternalOrderId: "not-a-real-order-id" })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    expect(requireCompanyMembership).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("REJECTS a foreign company's order id with the SAME 400", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-other" } as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    await expect(
      adjustRow({ intent: "order", selectedExternalOrderId: ORDER_CUID })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Downstream consequences, read off the row the ROUTE wrote
// ---------------------------------------------------------------------------

describe("chip consequences — the same row, read by the classifiers that matter", () => {
  it("a chip-DAMAGE row is INSIDE getShrinkageSummary's domain and classifies as DAMAGE", async () => {
    const { row } = await adjustRow({ intent: "damage-loss" });

    // The domain narrows on logType and delta BEFORE any reason is classified.
    expect(SHRINKAGE_DOMAIN_LOGTYPES).toContain(row.logType);
    expect(row.delta).toBeLessThan(0);
    // ...and inside the domain the shared rule buckets it as loss.
    expect(shrinkageReasonOf(row.reasonCode)).toBe("DAMAGE");
  });

  it("an `other` row STAYS in the LOCKED reorder-demand predicate", async () => {
    const { row } = await adjustRow({ intent: "other" });

    expect(
      isReorderDemandRow({
        delta: row.delta,
        logType: row.logType,
        reasonCode: row.reasonCode,
      })
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The workbench manual leg — TWO values only (PLG1-1)
// ---------------------------------------------------------------------------

/** Drive one manual deduction through the REAL route; hand back what it wrote. */
async function deductRow(body: Record<string, unknown>) {
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
      ...body,
    })
  );
  expect(res.status).toBe(200);
  expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
  return {
    row: tx.inventory_logs.create.mock.calls[0][0].data as unknown as LedgerRowData,
    details: tx.auditLog.create.mock.calls[0][0].data.details as Record<string, unknown>,
  };
}

describe("deduct-simple — the workbench offers NO damage-loss (PLG1-1)", () => {
  it("the schema itself refuses the value", () => {
    const base = { locationId: 2, items: [{ productId: 5, quantity: 3 }] };
    expect(SimpleDeductSchema.safeParse({ ...base, intent: "damage-loss" }).success).toBe(false);
    expect(SimpleDeductSchema.safeParse({ ...base, intent: "order" }).success).toBe(true);
    expect(SimpleDeductSchema.safeParse({ ...base, intent: "other" }).success).toBe(true);
  });

  it("the ROUTE refuses it too, and writes nothing", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    await expect(
      DEDUCT(
        post("http://x/api/inventory/deduct-simple", {
          locationId: 2,
          items: [{ productId: 5, quantity: 3 }],
          intent: "damage-loss",
        })
      )
    ).rejects.toThrow();

    // The manual leg books SALE rows; a SALE+DAMAGE row would be invisible to
    // getShrinkageSummary (its domain is ADJUSTMENT/CORRECTION only), so the
    // loss would be recorded and then never counted. Refuse, don't half-record.
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("deduct-simple — T7 mapping on the manual leg", () => {
  it("order + a validated id -> orderRecordId stamped on the SALE row", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await deductRow({
      intent: "order",
      selectedExternalOrderId: ORDER_CUID,
    });

    expect(row.logType).toBe("SALE");
    expect(row.orderRecordId).toBe(ORDER_CUID);
    expect(row.reasonCode ?? null).toBeNull();
    // 0b-2's audit accrual is UNCHANGED and rides alongside the new column.
    expect(details.selectedExternalOrderId).toBe(ORDER_CUID);
    expect(details.intent).toBe("order");
  });

  it("other -> nothing stamped, even when an order id is present", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const { row, details } = await deductRow({
      intent: "other",
      selectedExternalOrderId: ORDER_CUID,
    });

    expect(row.orderRecordId ?? null).toBeNull();
    expect(row.reasonCode ?? null).toBeNull();
    // The id was still RESOLVED and membership-checked, and 0b-2's accrual is
    // untouched — the chip decides the LEDGER stamp, not the audit trail.
    expect(details.selectedExternalOrderId).toBe(ORDER_CUID);
  });

  it("an absent key -> legal submit, other/nothing, key ABSENT in the accrual", async () => {
    const { row, details } = await deductRow({});

    expect(row.orderRecordId ?? null).toBeNull();
    expect(row.reasonCode ?? null).toBeNull();
    expect("intent" in details).toBe(false);
  });

  // W2-2 RIDER (pack REV-12): the pin above is a WIRE contract, not a statement
  // about the workbench. Since the rider, that surface PRE-SELECTS `order`
  // whenever a WC order is selected, so it no longer produces a key-absent body
  // in that case (pinned in __tests__/unit/components/workbench-intent-chip.test.tsx).
  // The route's own reading of an absent key is unchanged and still exercised —
  // by a non-WC workbench cart and by any other client of this endpoint — which
  // is exactly why the pin stays.
  it("the ROUTE's default is untouched by the surface's default", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    // The shape the workbench now sends: an explicit `order` alongside the id.
    const stated = await deductRow({ intent: "order", selectedExternalOrderId: ORDER_CUID });
    expect(stated.row.orderRecordId).toBe(ORDER_CUID);

    // The shape it sends with no order in play: nothing stated, nothing stamped.
    const unstated = await deductRow({});
    expect(unstated.row.orderRecordId ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Schema shape (the adjust surface's chip carrier)
// ---------------------------------------------------------------------------

describe("AdjustWithIntentSchema — the chip is optional and closed-vocabulary", () => {
  const base = { productId: 5, locationId: 2, delta: -3 };

  it("accepts every payload that predates the chip", () => {
    expect(AdjustWithIntentSchema.safeParse(base).success).toBe(true);
  });

  it("the SCHEMA accepts the three chip values and the two request-only intents, nothing else", () => {
    // `count` / `correction` PARSE here (P2-B3-1). The schema accepting them is
    // not the ROUTE accepting them: the request truth table and the route's
    // guard decide that (the wire pins below; adjust-shape.test.ts).
    for (const intent of ["order", "damage-loss", "other", "count", "correction"]) {
      expect(AdjustWithIntentSchema.safeParse({ ...base, intent }).success).toBe(true);
    }
    expect(AdjustWithIntentSchema.safeParse({ ...base, intent: "recount" }).success).toBe(false);
    expect(AdjustWithIntentSchema.safeParse({ ...base, intent: "receiving" }).success).toBe(false);
    // NEVER a CORRECTION alias — the value does not exist in the vocabulary.
    expect(AdjustWithIntentSchema.safeParse({ ...base, intent: "CORRECTION" }).success).toBe(false);
  });

  it("bounds the order id to external_orders.id's native VarChar(191)", () => {
    expect(
      AdjustWithIntentSchema.safeParse({ ...base, selectedExternalOrderId: "x".repeat(192) }).success
    ).toBe(false);
    expect(
      AdjustWithIntentSchema.safeParse({ ...base, selectedExternalOrderId: "x".repeat(191) }).success
    ).toBe(true);
    expect(
      AdjustWithIntentSchema.safeParse({ ...base, selectedExternalOrderId: "" }).success
    ).toBe(false);
  });

  // CR-3: the auto-add flag is a SEMANTIC server contract, not an unparsed hint
  // read off the raw body. Zod strips unknown keys, so a schema that did not
  // carry it left the field entirely unvalidated on a stock-writing route.
  it("carries autoAddForTransfer as a parsed optional boolean", () => {
    expect(AdjustWithIntentSchema.safeParse({ ...base, autoAddForTransfer: true }).success).toBe(
      true
    );
    expect(AdjustWithIntentSchema.safeParse({ ...base, autoAddForTransfer: false }).success).toBe(
      true
    );
    expect(AdjustWithIntentSchema.parse({ ...base }).autoAddForTransfer).toBeUndefined();
    expect(AdjustWithIntentSchema.safeParse({ ...base, autoAddForTransfer: "yes" }).success).toBe(
      false
    );
    expect(AdjustWithIntentSchema.safeParse({ ...base, autoAddForTransfer: 1 }).success).toBe(
      false
    );
    // It survives the parse — a stripped field is exactly the silent no-op the
    // truthful-data rule exists to prevent.
    expect(
      AdjustWithIntentSchema.parse({ ...base, autoAddForTransfer: true }).autoAddForTransfer
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE LOCK DISCIPLINE on the adjust surface (spec §2.7(1); pack CB1b.5)
// ---------------------------------------------------------------------------

describe("adjust route — the order lock rides the primitive's hook", () => {
  it("STAMPED: the lock SELECT is the transaction's first statement, asked with the stamped id", async () => {
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        intent: "order",
        selectedExternalOrderId: ORDER_CUID,
      })
    );
    expect(res.status).toBe(200);

    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true);
    expect((rawFns.$queryRaw.mock.calls[0][0] as any).values).toEqual([ORDER_CUID]);
    // ...before the prelock, which is before the ledger write.
    expect(rawCalls[1].sql).toContain("INSERT INTO product_locations");
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.inventory_logs.create.mock.invocationCallOrder[0]
    );
  });

  // Reconciliation Part 2 (pack CB3a-ii.3): the NEW stamp source. The typed
  // number is resolved OUTSIDE the transaction; what the lock asks for is the
  // order's STORED id the resolver returned, never the text the operator typed.
  it("REFERENCE-RESOLVED: the lock SELECT is statement 1, asked with the RESOLVED stored id", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      { id: ORDER_CUID, orderNumber: "12345", companyId: COMPANY_ID },
    ] as any);
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        intent: "order",
        orderReference: "12345",
      })
    );
    expect(res.status).toBe(200);

    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true);
    expect((rawFns.$queryRaw.mock.calls[0][0] as any).values).toEqual([ORDER_CUID]);
    expect((rawFns.$queryRaw.mock.calls[0][0] as any).values).not.toContain("12345");
    // ...before the prelock, which is before the ledger write.
    expect(rawCalls[1].sql).toContain("INSERT INTO product_locations");
    expect(rawFns.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.inventory_logs.create.mock.invocationCallOrder[0]
    );
    // The resolution itself was read OUTSIDE the transaction, before it opened.
    expect(db.externalOrder.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      (db.$transaction as unknown as jest.Mock).mock.invocationCallOrder[0]
    );
    expect((tx.inventory_logs.create.mock.calls[0][0].data as any).orderRecordId).toBe(ORDER_CUID);
  });

  it("ORDER_GONE: the resolved order vanished before the lock -> 409, and nothing is written", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      { id: ORDER_CUID, orderNumber: "12345", companyId: COMPANY_ID },
    ] as any);
    const tx = makeTx();
    // The order existed when the reference was resolved and is gone when the
    // lock reads it: the lock finds no row for a REQUIRED id.
    rawBehavior.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const sql = sqlTextOf(args[0]);
      if (isOrderLockSelect(sql)) return [];
      return isPrelockSelect(sql) ? STOCKED : [];
    });
    driveTxWith(tx);

    await expect(
      ADJUST(
        post("http://x/api/inventory/adjust", {
          productId: 5,
          locationId: 2,
          delta: -3,
          intent: "order",
          orderReference: "12345",
        })
      )
    ).rejects.toMatchObject({ code: "ORDER_GONE", statusCode: 409 });

    // The lock was the transaction's ONE statement: no prelock, no ledger row,
    // no stock write, no audit event, no attempt row.
    expect(rawCalls).toHaveLength(1);
    expect(isOrderLockSelect(rawCalls[0].sql)).toBe(true);
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.product_locations.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });

  it("UNSTAMPED: no order, no lock — the prelock is the first statement", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        intent: "damage-loss",
      })
    );
    expect(res.status).toBe(200);

    expect(rawCalls.filter((c) => isOrderLockSelect(c.sql))).toHaveLength(0);
    expect(rawCalls[0].sql).toContain("INSERT INTO product_locations");
  });

  it("answers with the batch its ledger row and audit event share", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST(
      post("http://x/api/inventory/adjust", { productId: 5, locationId: 2, delta: -3 })
    );
    const body = await res.json();

    expect(typeof body.batchId).toBe("string");
    expect((tx.inventory_logs.create.mock.calls[0][0].data as any).batchId).toBe(body.batchId);
    expect((tx.auditLog.create.mock.calls[0][0] as any).data.batchId).toBe(body.batchId);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation Part 2 — P2-B3-1 (pack CB3a-i.3 + CB3a-ii.3, the delta arm):
// THE TYPED REFERENCE on the adjust surface, over EVERY resolver outcome.
//
// Under the `order` chip a removal may carry the order number the operator
// TYPED. The route resolves it OUTSIDE the transaction with deduct-simple's
// posture: a named decline stamps nothing, a thrown lookup stamps nothing, and
// in every case the removal COMMITS (200) — the deduction was legal before the
// field existed and it stays legal. Each outcome records its own class; the
// typed text rides on the audit EVENT and never on the attempt row.
// ---------------------------------------------------------------------------

describe("adjust route — the typed reference, every resolver outcome", () => {
  const REF = "12345";
  const ORDER_B = "cmdq7f3k80099s6h4p2n9zzzz";
  const FOREIGN_COMPANY = "company-other";

  type ResolverCase = {
    name: string;
    body: Record<string, unknown>;
    arrange: () => void;
    outcome: "attributed" | "declined" | "none";
    evidence: string | null;
    reason: string | null;
    stamp: string | null;
    /** The `details.orderReference` the event must carry — absent when undefined. */
    typed: string | undefined;
    /** Whether the reference lookup may run at all. */
    looksUp: boolean;
  };

  const CASES: ResolverCase[] = [
    {
      name: "skipped (the order chip, nothing typed) -> none/order-intent-no-id, unstamped",
      body: { intent: "order" },
      arrange: () => {},
      outcome: "none",
      evidence: null,
      reason: "order-intent-no-id",
      stamp: null,
      typed: undefined,
      looksUp: false,
    },
    {
      name: "threw (the lookup's infrastructure failed) -> declined/resolver-error, unstamped, still 200",
      body: { intent: "order", orderReference: REF },
      arrange: () => {
        db.externalOrder.findMany.mockRejectedValue(new Error(`connection lost ${REF}`));
      },
      outcome: "declined",
      evidence: null,
      reason: "resolver-error",
      stamp: null,
      typed: REF,
      looksUp: true,
    },
    {
      name: "resolved (one order the operator may see) -> attributed/reference-resolved, stamped",
      body: { intent: "order", orderReference: REF },
      arrange: () => {
        db.externalOrder.findMany.mockResolvedValue([
          { id: ORDER_CUID, orderNumber: REF, companyId: COMPANY_ID },
        ] as any);
      },
      outcome: "attributed",
      evidence: "reference-resolved",
      reason: null,
      stamp: ORDER_CUID,
      typed: REF,
      looksUp: true,
    },
    {
      name: "unusable (not an order number) -> declined/unusable, never reaches the database",
      body: { intent: "order", orderReference: "walk-in 88" },
      arrange: () => {},
      outcome: "declined",
      evidence: null,
      reason: "unusable",
      stamp: null,
      typed: "walk-in 88",
      looksUp: false,
    },
    {
      name: "unmatched (no order has that number) -> declined/unmatched",
      body: { intent: "order", orderReference: "99999" },
      arrange: () => {
        db.externalOrder.findMany.mockResolvedValue([] as any);
      },
      outcome: "declined",
      evidence: null,
      reason: "unmatched",
      stamp: null,
      typed: "99999",
      looksUp: true,
    },
    {
      name: "ambiguous (two orders share the number) -> declined/ambiguous",
      body: { intent: "order", orderReference: REF },
      arrange: () => {
        db.externalOrder.findMany.mockResolvedValue([
          { id: ORDER_CUID, orderNumber: REF, companyId: COMPANY_ID },
          { id: ORDER_B, orderNumber: REF, companyId: FOREIGN_COMPANY },
        ] as any);
      },
      outcome: "declined",
      evidence: null,
      reason: "ambiguous",
      stamp: null,
      typed: REF,
      looksUp: true,
    },
    {
      name: "not-a-member (the one order is another company's) -> declined/not-a-member",
      body: { intent: "order", orderReference: REF },
      arrange: () => {
        db.externalOrder.findMany.mockResolvedValue([
          { id: ORDER_B, orderNumber: REF, companyId: FOREIGN_COMPANY },
        ] as any);
        (requireCompanyMembership as jest.Mock).mockRejectedValue(
          new AppError("Resource not found", "NOT_FOUND", 404)
        );
      },
      outcome: "declined",
      evidence: null,
      reason: "not-a-member",
      stamp: null,
      typed: REF,
      looksUp: true,
    },
    {
      name: "selected (a picked order) -> attributed/selected, stamped, the resolver never runs",
      body: { intent: "order", selectedExternalOrderId: ORDER_CUID },
      arrange: () => {
        db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);
      },
      outcome: "attributed",
      evidence: "selected",
      reason: null,
      stamp: ORDER_CUID,
      typed: undefined,
      looksUp: false,
    },
  ];

  let consoleError: jest.SpyInstance;
  beforeEach(() => {
    // The `threw` case logs its redacted ops line; keep the run quiet and
    // readable by the redaction pin below.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it.each(CASES)("$name", async (c) => {
    c.arrange();
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST(
      post("http://x/api/inventory/adjust", { productId: 5, locationId: 2, delta: -3, ...c.body })
    );

    // The removal COMMITS in every case — including when the lookup threw.
    expect(res.status).toBe(200);
    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);

    // The ledger write carries the stamp: the picked or the resolved STORED id.
    const row = tx.inventory_logs.create.mock.calls[0][0].data as unknown as LedgerRowData;
    expect(row.orderRecordId ?? null).toBe(c.stamp);
    expect(row.logType).toBe("ADJUSTMENT");

    // The typed text is accrued on the audit EVENT, whatever became of it.
    const event = tx.auditLog.create.mock.calls[0][0].data as any;
    expect(event.actionType).toBe("INVENTORY_ADJUSTMENT");
    if (c.typed === undefined) {
      expect("orderReference" in event.details).toBe(false);
    } else {
      expect(event.details.orderReference).toBe(c.typed);
    }
    expect(event.details.intent).toBe("order");

    // The attempt row: its class, its stamp — and never the typed text.
    expect(tx.orderAttributionAttempt.create).toHaveBeenCalledTimes(1);
    const attempt = (tx.orderAttributionAttempt.create.mock.calls[0][0] as any).data;
    expect(attempt).toEqual({
      batchId: expect.any(String),
      ledgerRowId: 555,
      outcome: c.outcome,
      evidence: c.evidence,
      reason: c.reason,
      orderRecordId: c.stamp,
      previousOrderRecordId: null,
      source: "live-adjust",
      actorUserId: 7,
      details: { intent: "order" },
    });
    if (c.typed !== undefined) expect(JSON.stringify(attempt)).not.toContain(c.typed);

    // A declined order is never named back: not on the event, not on the attempt.
    if (c.stamp === null) {
      expect(JSON.stringify(event)).not.toContain(ORDER_B);
      expect(JSON.stringify(event)).not.toContain(FOREIGN_COMPANY);
    }

    if (!c.looksUp) expect(db.externalOrder.findMany).not.toHaveBeenCalled();
  });

  it("threw: the redacted ops line names the failure class, never the typed text", async () => {
    db.externalOrder.findMany.mockRejectedValue(new Error(`boom ${REF} boom`));
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        intent: "order",
        orderReference: REF,
      })
    );
    expect(res.status).toBe(200);

    const logged = consoleError.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).toContain("reference resolution");
    expect(logged).not.toContain(REF);
  });

  it("not-a-member: the membership probe is asked of the RESOLVED order's company", async () => {
    db.externalOrder.findMany.mockResolvedValue([
      { id: ORDER_CUID, orderNumber: REF, companyId: COMPANY_ID },
    ] as any);
    const tx = makeTx();
    driveTxWith(tx);

    await ADJUST(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        intent: "order",
        orderReference: `  ${REF}  `,
      })
    );

    // Trimmed at the parse, looked up by the trimmed value, probed against
    // the company the database returned — never a company the caller named.
    expect(db.externalOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderNumber: REF } })
    );
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
  });
});

// ---------------------------------------------------------------------------
// P2-B3-1 (pack CB3a-i.2/.4): what the request truth table and the route's
// guard refuse, as an API caller receives it — one 400, the frozen sentence,
// `code: 'VALIDATION_ERROR'`, and nothing read past the parse or written.
// ---------------------------------------------------------------------------

describe("adjust route — the request truth table and the guard, on the wire", () => {
  function expectNothingWritten(tx: ReturnType<typeof makeTx>) {
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
    // Nothing past the parse ran: no order resolved, no stock checked.
    expect(db.externalOrder.findUnique).not.toHaveBeenCalled();
    expect(db.externalOrder.findMany).not.toHaveBeenCalled();
    expect(db.product_locations.findUnique).not.toHaveBeenCalled();
  }

  it.each([
    [
      "a VALID count",
      { productId: 5, locationId: 2, intent: "count", countedQuantity: 7, expectedVersion: 1 },
    ],
    [
      "a VALID correction",
      {
        productId: 5,
        locationId: 2,
        intent: "correction",
        delta: 2,
        reversesBatchId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
        reason: "put back",
      },
    ],
  ])(
    "%s body -> 400 'this intent is not available yet', never mapped, nothing written",
    async (_label, body) => {
      const tx = makeTx();
      driveTxWith(tx);

      const res = await ADJUST_WIRE(post("http://x/api/inventory/adjust", body));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "this intent is not available yet",
        code: "VALIDATION_ERROR",
      });
      // The T7 mapper never saw it: no half-state in which a count books an
      // ADJUSTMENT row through the old path.
      expect(mapDeductionIntent).not.toHaveBeenCalled();
      expectNothingWritten(tx);
    }
  );

  it("an API-sent POSITIVE delta with a typed reference -> 400 with its sentence", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST_WIRE(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: 3,
        intent: "order",
        orderReference: "12345",
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "a reference attributes stock that left — put stock back with a correction",
      code: "VALIDATION_ERROR",
    });
    expectNothingWritten(tx);
  });

  it("a picked id AND a typed reference -> 400, and no event is written", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST_WIRE(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        intent: "order",
        selectedExternalOrderId: ORDER_CUID,
        orderReference: "12345",
      })
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "pick the order or type the reference, not both",
      code: "VALIDATION_ERROR",
    });
    expectNothingWritten(tx);
  });

  it("body.logType is IGNORED: the ledger row is the literal ADJUSTMENT", async () => {
    const sent = await adjustRow({ intent: "other", logType: "ADJUSTMENT" });
    expect(sent.row.logType).toBe("ADJUSTMENT");

    const absent = await adjustRow({ intent: "other" });
    expect(absent.row.logType).toBe("ADJUSTMENT");
  });

  it("a forged logType still never reaches the route (the schema's literal pin)", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    const res = await ADJUST_WIRE(
      post("http://x/api/inventory/adjust", {
        productId: 5,
        locationId: 2,
        delta: -3,
        logType: "CORRECTION",
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("VALIDATION_ERROR");
    expectNothingWritten(tx);
  });
});
