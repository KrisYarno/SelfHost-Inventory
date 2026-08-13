// @jest-environment node
/**
 * Phase C Task 3 — fulfillment-family ledger semantics (route level).
 *
 * These drive the routes this lane owns with a deep-mocked Prisma whose
 * $transaction hands the handler ONE `tx`. The REAL @/lib/change-tracking,
 * @/lib/inventory (createInventoryLog / applyStockDelta / createInventoryTransaction)
 * and @/lib/products/decline run against that tx, so every assertion is on the
 * ACTUAL inventory_logs.create + audit_logs.create payloads — proving:
 *   - fulfill deductions land as SALE, and details.items carry inventoryLogId (P-C8),
 *   - decline reversals land as CORRECTION on the SAME tx as the PRODUCT_DECLINE
 *     event (the seam fix — no separate-tx audit),
 *   - batch-adjust threads reasonCode + a request batchId onto every ledger row,
 *   - deduct-simple maps DEDUCTION -> SALE and threads its batchId,
 * and that in every case the ledger row's batchId equals its companion event's
 * batchId (P-C1 join completeness / ER-C3).
 *
 * The orders integration suite (change-tracking-orders.test.ts) MOCKS
 * createInventoryLog and so cannot observe SALE/batchId — this suite does not.
 */

import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireAdmin: jest.fn(),
  requireCompanyMembership: jest.fn(),
  requireCSRF: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
// Best-effort external side effects — mocked so nothing hits the network.
jest.mock("@/lib/external-orders/stock-sync", () => ({
  pushStockForProducts: jest.fn(async () => undefined),
}));
jest.mock("@/lib/external-orders/shared", () => ({
  pushOrderStatusToExternal: jest.fn(async () => ({ success: true })),
}));
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApproved,
  requireAdmin,
  requireCompanyMembership,
  requireCSRF,
} from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { SimpleDeductSchema } from "@/lib/validation/workbench";
import { POST as BATCH_ADJUST } from "@/app/api/inventory/batch-adjust/route";
import { POST as DEDUCT } from "@/app/api/inventory/deduct-simple/route";
import { POST as FULFILL } from "@/app/api/orders/[orderId]/fulfill/route";
import { POST as DECLINE } from "@/app/api/admin/products/[id]/decline/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_CUID = "cmdq7f3k80001s6h4p2n9wxyz";
const COMPANY_ID = "company-abc";

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

/** A fresh deep-mocked TransactionClient with the reads every path here needs. */
function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  tx.product_locations.findUnique.mockResolvedValue({ version: 1, quantity: 100 } as any);
  tx.product_locations.findFirst.mockResolvedValue({ id: 1, version: 1, quantity: 100 } as any);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  tx.inventory_logs.create.mockResolvedValue({
    id: 555,
    productId: 5,
    locationId: 2,
    delta: -3,
    products: { name: "Widget" },
  } as any);
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  tx.$executeRaw.mockResolvedValue(1 as any);
  return tx;
}

function driveTxWith(tx: ReturnType<typeof makeTx>) {
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: any) => cb(tx));
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireAdmin as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: true },
  });
  (requireCompanyMembership as jest.Mock).mockResolvedValue(undefined);
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// batch-adjust — ER-C3 batchId join + Task 2 reasonCode seam
// ---------------------------------------------------------------------------
describe("batch-adjust — reasonCode persisted + ledger rows join the event by batchId", () => {
  it("stamps each item's reasonCode (null when absent) and shares the event batchId", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product.findMany.mockResolvedValue([
      { id: 5, name: "Widget" },
      { id: 6, name: "Gadget" },
    ] as any);

    const res = await BATCH_ADJUST(
      post("http://x/api/inventory/batch-adjust", {
        adjustments: [
          { productId: 5, locationId: 2, delta: 10, reasonCode: "DAMAGE" },
          { productId: 6, locationId: 2, delta: -5 },
        ],
      })
    );
    expect(res.status).toBe(200);

    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const row0 = tx.inventory_logs.create.mock.calls[0][0].data;
    const row1 = tx.inventory_logs.create.mock.calls[1][0].data;
    const event = tx.auditLog.create.mock.calls[0][0].data;

    // reasonCode lands on the item that supplied it; the other is null.
    expect(row0.reasonCode).toBe("DAMAGE");
    expect(row1.reasonCode ?? null).toBeNull();

    // ER-C3: every ledger row joins the bulk-update event by batchId.
    expect(event.batchId).toMatch(UUID_RE);
    expect(row0.batchId).toBe(event.batchId);
    expect(row1.batchId).toBe(event.batchId);
  });
});

// ---------------------------------------------------------------------------
// deduct-simple — D6 DEDUCTION->SALE + ER-C3 batchId join
// ---------------------------------------------------------------------------
describe("deduct-simple — SALE ledger rows join the event by batchId", () => {
  it("writes SALE rows carrying the deduction event's batchId", async () => {
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
      })
    );
    expect(res.status).toBe(200);

    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const row = tx.inventory_logs.create.mock.calls[0][0].data;
    const event = tx.auditLog.create.mock.calls[0][0].data;

    // D6: manual-order fulfillment is a SALE (already live from the trunk).
    expect(row.logType).toBe("SALE");
    // ER-C3: the SALE row joins its bulk-update event.
    expect(event.batchId).toMatch(UUID_RE);
    expect(row.batchId).toBe(event.batchId);
  });
});

// ---------------------------------------------------------------------------
// Phase 0b-2 (spec 2026-08-12 REV-2 §"Phase 0b" / OC-1) — order-intent accrual.
//
// The 0a diagnosis: attribution is HISTORICALLY ABSENT. The workbench's manual
// leg deducts real stock (240 SALE rows in the 9-day observable window) that
// joins to no order, so nobody can say per-order whether packing skipped a
// deduction. deduct-simple now persists the intent the dialog ALREADY holds —
// `orderReference` (free text) and `selectedExternalOrderId` (the exact id) —
// into the audit event's details JSON, which the D1 reconciliation reads as
// evidence class (c). ZERO schema change: audit_logs.details is Json?, joined to
// the ledger rows by batchId.
//
// The id is UNTRUSTED INPUT on a stock-writing route, so it is resolved and
// membership-checked SERVER-SIDE before it is recorded. Recording an
// unvalidated id would manufacture exactly the false attribution this lane
// exists to eliminate — a forged id would make someone else's order look
// fulfilled by our stock.
// ---------------------------------------------------------------------------
describe("deduct-simple — 0b-2 order-intent accrual into audit details", () => {
  const FOREIGN_ORDER = "cmdq7f3k80099s6h4p2n9zzzz";

  function deductBody(extra: Record<string, unknown> = {}) {
    return { locationId: 2, items: [{ productId: 5, quantity: 3 }], ...extra };
  }

  function primeTx() {
    const tx = makeTx();
    tx.inventory_logs.create.mockResolvedValue({
      id: 1,
      productId: 5,
      delta: -3,
      products: { name: "Widget" },
    } as any);
    driveTxWith(tx);
    return tx;
  }

  it("records BOTH orderReference and selectedExternalOrderId when an order is selected", async () => {
    const tx = primeTx();
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    const res = await DEDUCT(
      post(
        "http://x/api/inventory/deduct-simple",
        deductBody({ orderReference: "12345", selectedExternalOrderId: ORDER_CUID })
      )
    );
    expect(res.status).toBe(200);

    const event = tx.auditLog.create.mock.calls[0][0].data;
    const details = event.details as Record<string, unknown>;
    // The exact key names D1 reads: `$.orderReference` (STRING) and
    // `$.selectedExternalOrderId`. Renaming either blinds evidence class (c).
    expect(details.orderReference).toBe("12345");
    expect(details.selectedExternalOrderId).toBe(ORDER_CUID);
    // Everything that was already there is untouched.
    expect(details.locationId).toBe(2);
    expect(Array.isArray(details.updates)).toBe(true);
  });

  it("membership is checked against the RESOLVED order's company, not the caller's claim", async () => {
    const tx = primeTx();
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);

    await DEDUCT(
      post("http://x/api/inventory/deduct-simple", deductBody({ selectedExternalOrderId: ORDER_CUID }))
    );

    expect(db.externalOrder.findUnique).toHaveBeenCalledWith({
      where: { id: ORDER_CUID },
      select: { companyId: true },
    });
    expect(requireCompanyMembership).toHaveBeenCalledWith(7, COMPANY_ID, false);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("records orderReference alone when no order is selected — the id key is ABSENT, not null", async () => {
    const tx = primeTx();

    const res = await DEDUCT(
      post("http://x/api/inventory/deduct-simple", deductBody({ orderReference: "walk-in 88" }))
    );
    expect(res.status).toBe(200);

    const details = tx.auditLog.create.mock.calls[0][0].data.details as Record<string, unknown>;
    expect(details.orderReference).toBe("walk-in 88");
    // Truthful-data north star: a structurally-absent field is ABSENT. A null
    // would be counted by D1's JSON_CONTAINS_PATH census as an accrued id.
    expect("selectedExternalOrderId" in details).toBe(false);
    expect(db.externalOrder.findUnique).not.toHaveBeenCalled();
  });

  it("records neither key when the caller supplies neither", async () => {
    const tx = primeTx();

    const res = await DEDUCT(post("http://x/api/inventory/deduct-simple", deductBody()));
    expect(res.status).toBe(200);

    const details = tx.auditLog.create.mock.calls[0][0].data.details as Record<string, unknown>;
    expect("orderReference" in details).toBe(false);
    expect("selectedExternalOrderId" in details).toBe(false);
  });

  it("REJECTS a foreign company's order id with 400 VALIDATION_ERROR and commits NOTHING", async () => {
    primeTx();
    db.externalOrder.findUnique.mockResolvedValue({ companyId: "company-other" } as any);
    (requireCompanyMembership as jest.Mock).mockRejectedValue(
      new AppError("Resource not found", "NOT_FOUND", 404)
    );

    // apiHandler is stubbed as a passthrough in this suite, so the AppError
    // surfaces directly; in production apiHandler maps it to a 400 body carrying
    // `code`. Asserting the AppError's own statusCode/code pins both.
    await expect(
      DEDUCT(
        post(
          "http://x/api/inventory/deduct-simple",
          deductBody({ selectedExternalOrderId: FOREIGN_ORDER })
        )
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    // The WHOLE write aborts — the deduction transaction never even opens, so
    // there is no stock write to roll back and no audit row.
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("REJECTS an id that resolves to no order at all (forgeability) with the SAME 400", async () => {
    primeTx();
    db.externalOrder.findUnique.mockResolvedValue(null as any);

    await expect(
      DEDUCT(
        post(
          "http://x/api/inventory/deduct-simple",
          deductBody({ selectedExternalOrderId: "not-a-real-order-id" })
        )
      )
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

    // Nonexistent and foreign are ONE outcome with ONE message. This route
    // writes stock; a 404/403 split on a body field would turn it into an
    // order-id existence oracle, and the fulfill route's 404 is for an order
    // addressed in the PATH, which is a different question.
    expect(requireCompanyMembership).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("SimpleDeductSchema — 0b-2 selectedExternalOrderId is OPTIONAL and bounded", () => {
  const base = { locationId: 2, items: [{ productId: 5, quantity: 3 }] };

  it("accepts a payload without the field (every pre-0b-2 caller)", () => {
    const parsed = SimpleDeductSchema.parse(base);
    expect(parsed.selectedExternalOrderId).toBeUndefined();
  });

  it("accepts a cuid-shaped id", () => {
    expect(SimpleDeductSchema.parse({ ...base, selectedExternalOrderId: ORDER_CUID })
      .selectedExternalOrderId).toBe(ORDER_CUID);
  });

  it("rejects an over-long id (external_orders.id is VarChar(191))", () => {
    expect(
      SimpleDeductSchema.safeParse({ ...base, selectedExternalOrderId: "x".repeat(192) }).success
    ).toBe(false);
    expect(
      SimpleDeductSchema.safeParse({ ...base, selectedExternalOrderId: "x".repeat(191) }).success
    ).toBe(true);
  });

  it("rejects an empty id rather than accruing a meaningless key", () => {
    expect(SimpleDeductSchema.safeParse({ ...base, selectedExternalOrderId: "" }).success).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// fulfill — SALE deductions + P-C8 details.items inventoryLogId
// ---------------------------------------------------------------------------
describe("fulfill — SALE ledger + details.items carry inventoryLogId (P-C8)", () => {
  function makeFulfillOrder() {
    return {
      id: ORDER_CUID,
      externalId: "ext-1",
      integrationId: "int-1",
      internalStatus: "pending",
      fulfilledAt: null,
      fulfilledBy: null,
      integration: { id: "int-1", platform: "WOOCOMMERCE", fulfillmentPushEnabled: false },
      items: [
        {
          id: "item-1",
          orderId: ORDER_CUID,
          quantity: 2,
          fulfilledQty: 0,
          name: "Widget A",
          sku: "WA-001",
          isMapped: true,
          productLink: {
            internalProduct: { id: 10, name: "Widget A" },
            isBundle: false,
            bundleComponents: [],
          },
        },
      ],
    };
  }

  it("deducts as SALE with the event batchId and echoes inventoryLogId into details.items", async () => {
    const tx = makeTx();
    tx.externalOrder.findUnique.mockResolvedValue(makeFulfillOrder() as any);
    tx.externalOrder.update.mockResolvedValue({} as any);
    tx.product.findUnique.mockResolvedValue({ name: "Widget A" } as any);
    tx.externalOrderItem.update.mockResolvedValue({} as any);
    tx.externalOrderItem.findMany.mockResolvedValue([{ quantity: 2, fulfilledQty: 2 }] as any);
    // createInventoryLog (real) returns this row; its id must surface in details.
    tx.inventory_logs.create.mockResolvedValue({ id: 777 } as any);
    driveTxWith(tx);

    // companyId preload + push lookup on the module-level client.
    db.externalOrder.findUnique.mockResolvedValue({ companyId: COMPANY_ID } as any);
    db.integration.findUnique.mockResolvedValue({ fulfillmentPushEnabled: false } as any);

    const res = await FULFILL(
      post(`http://x/api/orders/${ORDER_CUID}/fulfill`, {
        locationId: 5,
        items: [{ itemId: "item-1", quantity: 2 }],
      }),
      { params: { orderId: ORDER_CUID } } as any
    );
    expect(res.status).toBe(200);

    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const row = tx.inventory_logs.create.mock.calls[0][0].data;
    const event = tx.auditLog.create.mock.calls[0][0].data;

    // Deduction is a SALE joined to the fulfillment event.
    expect(row.logType).toBe("SALE");
    expect(event.batchId).toMatch(UUID_RE);
    expect(row.batchId).toBe(event.batchId);

    // P-C8: the non-bundle details.items entry carries the ledger row id.
    expect(event.actionType).toBe("EXTERNAL_ORDER_FULFILLMENT");
    const items = (event.details as any).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ productId: 10, quantity: 2, inventoryLogId: 777 });
  });
});

// ---------------------------------------------------------------------------
// decline — CORRECTION reversal + PRODUCT_DECLINE on the SAME tx (seam fix)
// ---------------------------------------------------------------------------
describe("decline — reversal is CORRECTION recorded atomically with the event", () => {
  it("records PRODUCT_DECLINE on the same tx as the CORRECTION reversal, joined by batchId", async () => {
    const tx = makeTx();
    tx.product.findUnique.mockResolvedValue({ id: 10, deletedAt: null } as any);
    tx.$queryRaw.mockResolvedValue([{ id: 1, locationId: 1, quantity: 5 }] as any);
    driveTxWith(tx);

    const res = await DECLINE(
      post("http://x/api/admin/products/10/decline", {}),
      { params: { id: "10" } } as any
    );
    expect(res.status).toBe(200);

    // Same-tx: the reversal ledger row AND the audit event fired on one tx.
    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const row = tx.inventory_logs.create.mock.calls[0][0].data;
    const event = tx.auditLog.create.mock.calls[0][0].data;

    // The reversal is a CORRECTION (with reasonCode), not a neutral adjustment.
    expect(row.logType).toBe("CORRECTION");
    expect(row.reasonCode).toBe("CORRECTION");
    expect(row.delta).toBe(-5);

    // The event is the PRODUCT_DECLINE, joined to the reversal by batchId.
    expect(event.actionType).toBe("PRODUCT_DECLINE");
    expect(event.entityType).toBe("PRODUCT");
    expect(event.entityId).toBe("10");
    expect(event.batchId).toMatch(UUID_RE);
    expect(row.batchId).toBe(event.batchId);
  });
});
