// @jest-environment node
/**
 * Task 7 characterization tests — products-misc lane (D8 held-stock snapshots +
 * thresholds bulk PRODUCT_UPDATE + staging PATCH STAGING_UPDATE).
 *
 * Mirrors the Phase A change-tracking-users.test.ts pattern: a mocked Prisma whose
 * $transaction hands the handler a single shared `tx` object (exposed as db.__tx).
 * The REAL recordChange runs against that tx, so every assertion is on the ACTUAL
 * audit_logs create payload — proving:
 *   - the event row is written on the SAME tx as the mutation,
 *   - D8 heldStock captures nonzero product_locations rows on delete AND restore,
 *   - thresholds converts the array-form tx to callback form (record + writes
 *     share the tx client), fetches before-images, builds R-D14 rows, drops
 *     no-op rows (ER-B9), and degrades >500 rows to rowCount + rowsOmitted,
 *   - staging PATCH diffs over EXACTLY the provided fields (scalar after-values,
 *     not connect objects) and writes no event on an empty diff.
 */
import { NextRequest } from "next/server";

// Keep the REAL apiHandler (central ZodError/AppError -> status mapping) + the
// REAL requireCSRF (validateCSRFToken mocked to true); stub only the auth guards.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return {
    __esModule: true,
    ...actual,
    requireApproved: jest.fn(),
    requireAdmin: jest.fn(),
  };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock("@/lib/rateLimit", () => ({
  __esModule: true,
  RateLimitError: jest.requireActual("@/lib/rateLimit").RateLimitError,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: unknown) => r),
}));

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// REAL change-tracking (recordChange runs for real) with only newBatchId pinned
// so the thresholds bulk event's batchId is assertable by value.
jest.mock("@/lib/change-tracking", () => {
  const actual = jest.requireActual("@/lib/change-tracking");
  return { __esModule: true, ...actual, newBatchId: jest.fn(() => "test-batch-0001") };
});

// products/[id] route pulls these at module load (PUT/GET siblings); stub them so
// importing the route doesn't drag in the real product/inventory graphs.
jest.mock("@/lib/products", () => ({
  getProductsWithQuantities: jest.fn(),
  isProductUnique: jest.fn(async () => true),
  formatProductName: jest.fn(
    ({ baseName, variant }: any) => `${baseName ?? ""}${variant ? " " + variant : ""}`.trim()
  ),
}));
jest.mock("@/lib/inventory", () => ({
  __esModule: true,
  OptimisticLockError: jest.requireActual("@/lib/inventory").OptimisticLockError,
  getCurrentQuantity: jest.fn(async () => 0),
}));

// One tx object per run, shared by every mutation and the audit write so the
// "same transaction" claim is observable (all mocks live on db.__tx).
jest.mock("@/lib/prisma", () => {
  const tx = {
    product: {
      update: jest.fn(),
      findMany: jest.fn(async () => []),
    },
    product_locations: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
    },
    stagingItem: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn(async () => ({ id: 1 })) },
  };
  const db = {
    product: { findUnique: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { DELETE as productDELETE } from "@/app/api/products/[id]/route";
import { POST as restorePOST } from "@/app/api/admin/products/[id]/restore/route";
import { PATCH as thresholdsPATCH } from "@/app/api/admin/products/thresholds/route";
import { PATCH as stagingPATCH } from "@/app/api/staging-items/[id]/route";
import { requireApproved, requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const tx = db.__tx;
const ADMIN = { id: 7, isAdmin: true, isApproved: true };
const APPROVED = { id: 4, isAdmin: false, isApproved: true };

function mkReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

/** All create() payloads written to the shared tx this run. */
function auditRows(): any[] {
  return tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
  (requireApproved as jest.Mock).mockResolvedValue({ user: APPROVED });
});

// ---------------------------------------------------------------------------
// DELETE /api/products/[id] — PRODUCT_DELETE + D8 heldStock
// ---------------------------------------------------------------------------
describe("DELETE [id] — PRODUCT_DELETE captures D8 heldStock", () => {
  it("snapshots nonzero product_locations rows in the same tx and records deletedAt", async () => {
    db.product.findUnique.mockResolvedValue({ id: 5, name: "BPC 5mg", deletedAt: null });
    tx.product.update.mockResolvedValue({ id: 5, name: "BPC 5mg" });
    tx.product_locations.findMany.mockResolvedValue([
      { locationId: 1, quantity: 12 },
      { locationId: 2, quantity: 3 },
    ]);

    const resp = await productDELETE(mkReq("http://t/api/products/5", "DELETE"), {
      params: { id: "5" },
    } as any);

    expect(resp.status).toBe(200);
    // Same-tx proof: the flip and the audit write ran in ONE $transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    // heldStock is queried inside the tx, nonzero rows only.
    const findManyArg = tx.product_locations.findMany.mock.calls[0][0];
    expect(findManyArg.where).toEqual({ productId: 5, quantity: { not: 0 } });
    expect(findManyArg.select).toEqual({ locationId: true, quantity: true });

    const [row] = auditRows();
    expect(row.actionType).toBe("PRODUCT_DELETE");
    expect(row.entityType).toBe("PRODUCT");
    expect(row.entityId).toBe("5");
    expect(row.details.productName).toBe("BPC 5mg");
    expect(row.details.heldStock).toEqual([
      { locationId: 1, quantity: 12 },
      { locationId: 2, quantity: 3 },
    ]);

    // changes.deletedAt.to is the iso of the timestamp actually written.
    const writtenDeletedAt = tx.product.update.mock.calls[0][0].data.deletedAt;
    expect(writtenDeletedAt).toBeInstanceOf(Date);
    expect(row.details.changes.deletedAt.from).toBeNull();
    expect(row.details.changes.deletedAt.to).toBe(writtenDeletedAt.toISOString());
  });

  it("records an empty heldStock array when no nonzero rows are held", async () => {
    db.product.findUnique.mockResolvedValue({ id: 6, name: "Empty", deletedAt: null });
    tx.product.update.mockResolvedValue({ id: 6, name: "Empty" });
    tx.product_locations.findMany.mockResolvedValue([]);

    const resp = await productDELETE(mkReq("http://t/api/products/6", "DELETE"), {
      params: { id: "6" },
    } as any);

    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("PRODUCT_DELETE");
    expect(row.details.heldStock).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/products/[id]/restore — PRODUCT_RESTORE + D8 heldStock
// ---------------------------------------------------------------------------
describe("POST [id]/restore — PRODUCT_RESTORE captures D8 heldStock", () => {
  it("wraps the bare update in a tx, records deletedAt iso->null with heldStock", async () => {
    const priorDeletedAt = new Date("2026-01-01T00:00:00.000Z");
    db.product.findUnique.mockResolvedValue({ id: 5, name: "BPC 5mg", deletedAt: priorDeletedAt });
    tx.product.update.mockResolvedValue({ id: 5, name: "BPC 5mg" });
    tx.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 7 }]);

    const resp = await restorePOST(mkReq("http://t/api/admin/products/5/restore", "POST"), {
      params: { id: "5" },
    } as any);

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    // heldStock query mirrors delete: nonzero rows only, inside the tx.
    const findManyArg = tx.product_locations.findMany.mock.calls[0][0];
    expect(findManyArg.where).toEqual({ productId: 5, quantity: { not: 0 } });

    const [row] = auditRows();
    expect(row.actionType).toBe("PRODUCT_RESTORE");
    expect(row.entityType).toBe("PRODUCT");
    expect(row.entityId).toBe("5");
    expect(row.details.heldStock).toEqual([{ locationId: 1, quantity: 7 }]);
    expect(row.details.changes.deletedAt).toEqual({
      from: priorDeletedAt.toISOString(),
      to: null,
    });

    // The restore write clears deletedAt/deletedBy.
    const updateData = tx.product.update.mock.calls[0][0].data;
    expect(updateData.deletedAt).toBeNull();
    expect(updateData.deletedBy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/products/thresholds — bulk PRODUCT_UPDATE (R-D14 rows)
// ---------------------------------------------------------------------------
describe("PATCH thresholds — callback-tx conversion + R-D14 rows", () => {
  it("fetches before-images in the tx, records only changed rows on the SAME tx", async () => {
    tx.product.findMany.mockResolvedValue([
      { id: 10, lowStockThreshold: 5 },
      { id: 11, lowStockThreshold: 8 },
    ]);
    tx.product_locations.findMany.mockResolvedValue([
      { productId: 10, locationId: 1, minQuantity: 2 },
    ]);
    tx.product.update.mockResolvedValue({});
    tx.product_locations.upsert.mockResolvedValue({});

    const resp = await thresholdsPATCH(
      mkReq("http://t/api/admin/products/thresholds", "PATCH", {
        updates: [
          { productId: 10, combinedMinimum: 15, perLocation: [{ locationId: 1, minQuantity: 4 }] },
          { productId: 11, combinedMinimum: 8 }, // 8 -> 8: no change, dropped (ER-B9)
        ],
      })
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // record + writes share the tx client (callback-tx conversion).
    expect(tx.product.update).toHaveBeenCalled();
    expect(tx.product_locations.upsert).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    // before-images fetched inside the tx.
    expect(tx.product.findMany).toHaveBeenCalledTimes(1);
    expect(tx.product_locations.findMany).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("PRODUCT_UPDATE");
    expect(row.entityType).toBe("PRODUCT");
    expect(row.entityId).toBeNull(); // bulk op is unaddressed
    expect(row.batchId).toBe("test-batch-0001");
    // Only product 10 changed; product 11 (8->8) dropped by ER-B9.
    expect(row.affectedCount).toBe(1);
    expect(row.details.rows).toEqual([
      {
        entityId: "10",
        changes: {
          lowStockThreshold: { from: 5, to: 15 },
          "minQuantity[1]": { from: 2, to: 4 },
        },
      },
    ]);
    expect(row.details.rowsOmitted).toBeUndefined();
  });

  it("upsert create-path from-value is null when the product_locations row is new", async () => {
    tx.product.findMany.mockResolvedValue([{ id: 20, lowStockThreshold: 0 }]);
    tx.product_locations.findMany.mockResolvedValue([]); // no existing row for the pair
    tx.product.update.mockResolvedValue({});
    tx.product_locations.upsert.mockResolvedValue({});

    const resp = await thresholdsPATCH(
      mkReq("http://t/api/admin/products/thresholds", "PATCH", {
        updates: [{ productId: 20, perLocation: [{ locationId: 3, minQuantity: 9 }] }],
      })
    );

    expect(resp.status).toBe(200);
    // KEEP the create: { quantity: 0 } upsert semantics.
    const upsertArg = tx.product_locations.upsert.mock.calls[0][0];
    expect(upsertArg.create).toEqual({
      productId: 20,
      locationId: 3,
      quantity: 0,
      minQuantity: 9,
    });

    const [row] = auditRows();
    expect(row.details.rows).toEqual([
      { entityId: "20", changes: { "minQuantity[3]": { from: null, to: 9 } } },
    ]);
  });

  it("ER-B9: no real change across all rows => NO event (writes still applied)", async () => {
    tx.product.findMany.mockResolvedValue([{ id: 10, lowStockThreshold: 5 }]);
    tx.product_locations.findMany.mockResolvedValue([]);
    tx.product.update.mockResolvedValue({});

    const resp = await thresholdsPATCH(
      mkReq("http://t/api/admin/products/thresholds", "PATCH", {
        updates: [{ productId: 10, combinedMinimum: 5 }], // 5 -> 5
      })
    );

    expect(resp.status).toBe(200);
    expect(tx.product.update).toHaveBeenCalledTimes(1); // write still applied
    expect(tx.auditLog.create).not.toHaveBeenCalled(); // but no event
  });

  it("R-D14 cap: >500 changed rows degrade to 500 rows + rowCount + rowsOmitted", async () => {
    const before = Array.from({ length: 501 }, (_, i) => ({ id: i + 1, lowStockThreshold: 0 }));
    tx.product.findMany.mockResolvedValue(before);
    tx.product_locations.findMany.mockResolvedValue([]);
    tx.product.update.mockResolvedValue({});

    const updates = before.map((p) => ({ productId: p.id, combinedMinimum: 99 })); // each 0 -> 99

    const resp = await thresholdsPATCH(
      mkReq("http://t/api/admin/products/thresholds", "PATCH", { updates })
    );

    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.details.rows).toHaveLength(500);
    expect(row.details.rowCount).toBe(501);
    expect(row.details.rowsOmitted).toBe(true);
    expect(row.affectedCount).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/staging-items/[id] — STAGING_UPDATE (provided-fields-only diff)
// ---------------------------------------------------------------------------
describe("PATCH staging-items/[id] — STAGING_UPDATE", () => {
  it("diffs over EXACTLY the provided fields on the same tx as the update", async () => {
    tx.stagingItem.findUnique.mockResolvedValue({
      id: 5,
      description: "Old",
      vendor: null,
      countedQuantity: null,
      expectedQuantity: null,
      reference: null,
      notes: null,
      locationId: 1,
      resolvedProductId: null,
    });
    tx.stagingItem.update.mockResolvedValue({ id: 5, countedQuantity: 12 });

    const resp = await stagingPATCH(
      mkReq("http://t/api/staging-items/5", "PATCH", { countedQuantity: 12, vendor: "Acme" }),
      { params: { id: "5" } } as any
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.stagingItem.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("STAGING_UPDATE");
    expect(row.entityType).toBe("STAGING");
    expect(row.entityId).toBe("5");
    // ONLY the two provided fields appear — nothing else diffed.
    expect(row.details.changes).toEqual({
      countedQuantity: { from: null, to: 12 },
      vendor: { from: null, to: "Acme" },
    });
  });

  it("records SCALAR after-values for relation fields, but writes connect objects", async () => {
    tx.stagingItem.findUnique.mockResolvedValue({
      id: 5,
      locationId: 1,
      resolvedProductId: null,
    });
    tx.stagingItem.update.mockResolvedValue({ id: 5 });

    const resp = await stagingPATCH(
      mkReq("http://t/api/staging-items/5", "PATCH", { locationId: 2, resolvedProductId: 88 }),
      { params: { id: "5" } } as any
    );

    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.details.changes).toEqual({
      locationId: { from: 1, to: 2 },
      resolvedProductId: { from: null, to: 88 },
    });
    // The write still uses Prisma relation-connect objects.
    const data = tx.stagingItem.update.mock.calls[0][0].data;
    expect(data.location).toEqual({ connect: { id: 2 } });
    expect(data.resolvedProduct).toEqual({ connect: { id: 88 } });
  });

  it("ER-B9: providing the same value => NO event (update still applied)", async () => {
    tx.stagingItem.findUnique.mockResolvedValue({ id: 5, countedQuantity: 12 });
    tx.stagingItem.update.mockResolvedValue({ id: 5, countedQuantity: 12 });

    const resp = await stagingPATCH(
      mkReq("http://t/api/staging-items/5", "PATCH", { countedQuantity: 12 }),
      { params: { id: "5" } } as any
    );

    expect(resp.status).toBe(200);
    expect(tx.stagingItem.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("404 when the item is missing — no update, no event", async () => {
    tx.stagingItem.findUnique.mockResolvedValue(null);

    const resp = await stagingPATCH(
      mkReq("http://t/api/staging-items/999", "PATCH", { countedQuantity: 1 }),
      { params: { id: "999" } } as any
    );

    expect(resp.status).toBe(404);
    expect(tx.stagingItem.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
