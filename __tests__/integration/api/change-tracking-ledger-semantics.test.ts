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
