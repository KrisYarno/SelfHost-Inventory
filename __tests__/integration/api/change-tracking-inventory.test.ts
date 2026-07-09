// @jest-environment node
/**
 * Change-tracking Task 8 — inventory call-site migration characterization tests.
 *
 * Every inventory mutation now records its change through `recordChange` INSIDE
 * the SAME transaction as the stock write (via lib/inventory's optional `record`
 * callback, or — for batch-adjust — directly in the route's own tx). These tests
 * pin, per route:
 *   - the event is created via the SAME tx mock instance as the stock write
 *     (both `tx.inventory_logs.create` and `tx.auditLog.create` fire on one tx),
 *   - actionType / entityType fidelity vs the pre-migration auditService calls,
 *   - entityId string fidelity (numeric productId -> "5", bulk ops -> null),
 *   - a single newBatchId() per request flow, shared across multi-event flows.
 *
 * The REAL @/lib/change-tracking is used (not mocked) so entityId normalization
 * and the details payload are exercised end-to-end; only Prisma is mocked
 * (jest-mock-extended). Handlers run with apiHandler stubbed to a passthrough.
 */

import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import type { Prisma } from "@prisma/client";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(),
  requireAdmin: jest.fn(),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireAdmin } from "@/lib/api-utils";
import { POST as ADJUST } from "@/app/api/inventory/adjust/route";
import { POST as STOCK_IN } from "@/app/api/inventory/stock-in/route";
import { POST as BATCH_ADJUST } from "@/app/api/inventory/batch-adjust/route";
import { POST as DEDUCT } from "@/app/api/inventory/deduct-simple/route";
import { POST as TRANSFER } from "@/app/api/inventory/transfer/route";
import { POST as TRANSFER_BATCH } from "@/app/api/inventory/transfer/batch/route";
import { POST as MASS_UPDATE } from "@/app/api/admin/inventory/mass-update/route";
import { GET as TRANSFERS } from "@/app/api/inventory/transfers/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function post(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

/** A fresh deep-mocked TransactionClient with the reads every stock path needs. */
function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  tx.product_locations.findUnique.mockResolvedValue({ version: 1, quantity: 100 } as any);
  tx.product_locations.findFirst.mockResolvedValue({ id: 1, version: 1, quantity: 100 } as any);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as any);
  tx.inventory_logs.create.mockResolvedValue({
    id: 1,
    productId: 5,
    locationId: 2,
    delta: 10,
    products: { name: "Widget" },
  } as any);
  tx.product.update.mockResolvedValue({} as any);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as any);
  return tx;
}

/** Wire prisma.$transaction to drive its callback with our tx mock. */
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
});

describe("adjust — INVENTORY_ADJUSTMENT recorded in the stock-write tx", () => {
  it("records the event on the SAME tx as the stock write, with string entityId + batchId", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product.findUnique.mockResolvedValue({ name: "Widget" } as any);

    const res = await ADJUST(post("http://x/api/inventory/adjust", {
      productId: 5,
      locationId: 2,
      delta: 10,
    }));
    expect(res.status).toBe(200);

    // Same tx instance carried both writes.
    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_ADJUSTMENT");
    expect(data.entityType).toBe("INVENTORY");
    expect(data.entityId).toBe("5"); // numeric productId normalized to string
    expect(typeof data.batchId).toBe("string");
    expect(data.batchId).toMatch(UUID_RE);
    expect((data.details as any).delta).toBe(10);
  });

  it("auto-add-for-transfer preserves the INVENTORY_TRANSFER_AUTO_ADD actionType", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product.findUnique.mockResolvedValue({ name: "Widget" } as any);

    const res = await ADJUST(post("http://x/api/inventory/adjust", {
      productId: 5,
      locationId: 2,
      delta: 3,
      autoAddForTransfer: true,
    }));
    expect(res.status).toBe(200);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_TRANSFER_AUTO_ADD");
    expect(data.entityId).toBe("5");
  });
});

describe("stock-in — records as INVENTORY_ADJUSTMENT with a stock-in marker", () => {
  it("records in the stock-write tx with details.source = 'stock-in'", async () => {
    const tx = makeTx();
    driveTxWith(tx);

    const res = await STOCK_IN(post("http://x/api/inventory/stock-in", {
      productId: 5,
      locationId: 2,
      quantity: 12,
    }));
    expect(res.status).toBe(200);
    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_ADJUSTMENT");
    expect(data.entityType).toBe("INVENTORY");
    expect(data.entityId).toBe("5");
    expect((data.details as any).source).toBe("stock-in");
  });
});

describe("batch-adjust — ONE bulk event inside the route transaction", () => {
  it("records a single INVENTORY_BULK_UPDATE on the same tx as the writes", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product.findMany.mockResolvedValue([
      { id: 5, name: "Widget" },
      { id: 6, name: "Gadget" },
    ] as any);

    const res = await BATCH_ADJUST(post("http://x/api/inventory/batch-adjust", {
      adjustments: [
        { productId: 5, locationId: 2, delta: 10 },
        { productId: 6, locationId: 2, delta: -5 },
      ],
    }));
    expect(res.status).toBe(200);

    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_BULK_UPDATE");
    expect(data.entityId).toBeNull(); // bulk op is unaddressed
    expect(data.affectedCount).toBe(2);
    expect((data.details as any).updates).toHaveLength(2);
    expect(data.batchId).toMatch(UUID_RE);
  });
});

describe("deduct-simple — bulk event routed through createInventoryTransaction seam", () => {
  it("records INVENTORY_BULK_UPDATE in the deduction tx with product names from the logs", async () => {
    const tx = makeTx();
    tx.inventory_logs.create.mockResolvedValue({
      id: 1,
      productId: 5,
      delta: -3,
      products: { name: "Widget" },
    } as any);
    driveTxWith(tx);

    const res = await DEDUCT(post("http://x/api/inventory/deduct-simple", {
      locationId: 2,
      items: [{ productId: 5, quantity: 3 }],
    }));
    expect(res.status).toBe(200);

    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_BULK_UPDATE");
    expect((data.details as any).updates[0]).toMatchObject({
      productId: 5,
      productName: "Widget",
      delta: -3,
    });
    expect(data.batchId).toMatch(UUID_RE);
  });
});

describe("transfer — single INVENTORY_TRANSFER inside the transfer tx", () => {
  it("records on the same tx as both legs, with location names in details", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
    db.product.findUnique.mockResolvedValue({ id: 5, name: "Widget" } as any);
    db.location.findUnique
      .mockResolvedValueOnce({ id: 2, name: "From" } as any)
      .mockResolvedValueOnce({ id: 3, name: "To" } as any);

    const res = await TRANSFER(post("http://x/api/inventory/transfer", {
      productId: 5,
      fromLocationId: 2,
      toLocationId: 3,
      quantity: 4,
    }));
    expect(res.status).toBe(200);

    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(2); // both legs
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_TRANSFER");
    expect(data.entityId).toBe("5");
    expect((data.details as any).fromLocationName).toBe("From");
    expect((data.details as any).toLocationName).toBe("To");
    expect(data.batchId).toMatch(UUID_RE);
  });
});

describe("transfer/batch — one shared batchId across every transfer's event", () => {
  it("records one INVENTORY_TRANSFER per transfer, all sharing one batchId", async () => {
    const tx = makeTx();
    driveTxWith(tx);
    db.product_locations.findUnique.mockResolvedValue({ quantity: 100, version: 1 } as any);
    db.product.findFirst.mockResolvedValue({ id: 5, name: "Widget" } as any);
    db.location.findUnique.mockResolvedValue({ id: 9, name: "Dest" } as any);
    db.location.findMany.mockResolvedValue([
      { id: 2, name: "Src A" },
      { id: 3, name: "Src B" },
    ] as any);

    const res = await TRANSFER_BATCH(post("http://x/api/inventory/transfer/batch", {
      productId: 5,
      toLocationId: 9,
      transfers: [
        { fromLocationId: 2, quantity: 4 },
        { fromLocationId: 3, quantity: 6 },
      ],
    }));
    expect([200, 207]).toContain(res.status);

    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    const b0 = tx.auditLog.create.mock.calls[0][0].data.batchId;
    const b1 = tx.auditLog.create.mock.calls[1][0].data.batchId;
    expect(b0).toMatch(UUID_RE);
    expect(b0).toBe(b1); // shared across the flow
    tx.auditLog.create.mock.calls.forEach(([{ data }]: any) => {
      expect(data.actionType).toBe("INVENTORY_TRANSFER");
      expect(data.entityId).toBe("5");
    });
  });
});

describe("mass-update — ONE INVENTORY_BULK_UPDATE with R-D14 per-row from/to", () => {
  it("records details.rows {entityId, changes:{quantity:{from,to}}} for <=500 rows", async () => {
    const tx = makeTx();
    tx.product.findUnique.mockResolvedValue({ id: 5, name: "Widget", deletedAt: null } as any);
    tx.location.findUnique.mockResolvedValue({ id: 2, name: "Shelf" } as any);
    tx.product_locations.findUnique.mockResolvedValue({ quantity: 10 } as any);
    driveTxWith(tx);

    const res = await MASS_UPDATE(post("http://x/api/admin/inventory/mass-update", {
      changes: [{ productId: 5, locationId: 2, newQuantity: 4, delta: 100 }],
    }));
    expect(res.status).toBe(200);

    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.actionType).toBe("INVENTORY_BULK_UPDATE");
    expect(data.affectedCount).toBe(1);
    const rows = (data.details as any).rows;
    expect(rows).toHaveLength(1);
    // server-truthful from/to: current 10 -> newQuantity 4 (client delta ignored)
    expect(rows[0]).toEqual({ entityId: "5", changes: { quantity: { from: 10, to: 4 } } });
  });

  it("falls back to summary+count (no rows) beyond 500 changed rows", async () => {
    const tx = makeTx();
    tx.product.findUnique.mockResolvedValue({ id: 5, name: "Widget", deletedAt: null } as any);
    tx.location.findUnique.mockResolvedValue({ id: 2, name: "Shelf" } as any);
    tx.product_locations.findUnique.mockResolvedValue({ quantity: 0 } as any);
    driveTxWith(tx);

    const changes = Array.from({ length: 501 }, (_, i) => ({
      productId: i + 1,
      locationId: 2,
      newQuantity: 5,
      delta: 5,
    }));
    const res = await MASS_UPDATE(post("http://x/api/admin/inventory/mass-update", { changes }));
    expect(res.status).toBe(200);

    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect((data.details as any).rows).toBeUndefined();
    expect((data.details as any).rowsOmitted).toBe(true);
    expect((data.details as any).rowCount).toBe(501);
    expect(data.affectedCount).toBe(501);
  });
});

describe("transfers (GET) — read-switch to lib/change-tracking getAuditLogs", () => {
  it("reads INVENTORY_TRANSFER logs via getAuditLogs and never writes an event", async () => {
    db.auditLog.findMany.mockResolvedValue([
      {
        id: 1,
        createdAt: new Date(),
        action: "Transferred",
        batchId: "b1",
        details: {
          productName: "Widget",
          quantity: 4,
          fromLocationName: "A",
          toLocationName: "B",
        },
        user: { username: "u", email: "u@x.com" },
      },
    ] as any);
    db.auditLog.count.mockResolvedValue(1 as any);

    const req = new NextRequest("http://x/api/inventory/transfers?page=1&pageSize=20");
    const res = await TRANSFERS(req);
    expect(res.status).toBe(200);

    // Read path used the migrated getAuditLogs (findMany + count), no create.
    expect(db.auditLog.findMany).toHaveBeenCalledTimes(1);
    const where = db.auditLog.findMany.mock.calls[0][0]!.where as any;
    expect(where.actionType).toBe("INVENTORY_TRANSFER");
    expect(where.entityType).toBe("INVENTORY");
    expect(db.auditLog.create).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.transfers).toHaveLength(1);
    expect(body.transfers[0].productName).toBe("Widget");
  });
});
