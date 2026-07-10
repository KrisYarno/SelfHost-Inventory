// @jest-environment node
/**
 * Task 5 characterization tests (Phase B) — mapping + bundle-link mutations
 * record through @/lib/change-tracking. Mirrors the Phase A
 * change-tracking-users.test.ts mock-Prisma pattern: a mocked `$transaction`
 * hands the handler a single `tx` object (exposed as `db.__tx`), the REAL
 * recordChange runs against that tx, so every assertion is on the ACTUAL
 * audit_logs create payload — proving:
 *   - the event row is written on the SAME tx as the mutation,
 *   - MAPPING is company-scoped: companyId is present on EVERY event (recordChange
 *     throws in non-prod when a company-scoped entity is missing companyId),
 *   - MAPPING_DELETE captures a FULL redacted link-row snapshot + read-before-
 *     delete cascade arrays (bundleComponents) + unmappedOrderItems count,
 *   - BUNDLE_CHANGE reads OLD components BEFORE the deleteMany (their ids ARE the
 *     destroyed identities) and records exact from/to component arrays,
 *   - products/[id]/links DELETE (normalized) runs the isMapped cleanup in the
 *     SAME tx as the delete + record.
 */
import { NextRequest } from "next/server";

// Keep the REAL apiHandler + requireCSRF + requireCompanyMembership (admin
// bypasses membership without a DB call); stub only the admin guard.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn() };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock("@/lib/rateLimit", () => ({
  __esModule: true,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: unknown) => r),
}));

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// One tx object per test run, shared by the mutation and the audit write so the
// "same transaction" claim is observable (all mocks live on db.__tx).
jest.mock("@/lib/prisma", () => {
  const tx = {
    productLink: { create: jest.fn(), delete: jest.fn() },
    bundleComponent: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
    externalOrderItem: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    productLink: { findUnique: jest.fn(), findFirst: jest.fn() },
    product: { findFirst: jest.fn(), findMany: jest.fn() },
    integration: { findUnique: jest.fn() },
    userCompany: { findFirst: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { DELETE as mappingsDELETE } from "@/app/api/admin/product-mappings/route";
import { POST as linksPOST, DELETE as linksDELETE } from "@/app/api/products/[id]/links/route";
import { POST as bundlePOST } from "@/app/api/products/bundle-links/route";
import { PATCH as bundlePATCH } from "@/app/api/products/bundle-links/[linkId]/route";
import { requireAdmin } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const tx = db.__tx;
const ADMIN = { id: 7, isAdmin: true, isApproved: true };

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
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/product-mappings — MAPPING_DELETE
// ---------------------------------------------------------------------------
describe("product-mappings DELETE — MAPPING_DELETE (snapshot + cascade)", () => {
  const linkRow = {
    id: "L1",
    integrationId: "int1",
    internalProductId: 5,
    externalProductId: "EP1",
    externalVariantId: null,
    externalSku: "SKU1",
    externalTitle: "Title 1",
    isBundle: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  it("records MAPPING_DELETE in the delete's tx with full snapshot, cascade arrays, and companyId", async () => {
    db.productLink.findUnique.mockResolvedValue({
      ...linkRow,
      integration: { companyId: "C1" },
    });
    tx.bundleComponent.findMany.mockResolvedValue([
      { id: "BC1", internalProductId: 9, quantity: 2 },
      { id: "BC2", internalProductId: 10, quantity: 1 },
    ]);
    tx.externalOrderItem.updateMany.mockResolvedValue({ count: 3 });
    tx.productLink.delete.mockResolvedValue({});

    const resp = await mappingsDELETE(
      mkReq("http://t/api/admin/product-mappings?linkId=L1", "DELETE"),
    );

    expect(resp.status).toBe(200);
    // Same-tx proof.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.externalOrderItem.updateMany).toHaveBeenCalledWith({
      where: { productLinkId: "L1" },
      data: { isMapped: false },
    });
    expect(tx.productLink.delete).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    // Read-before-delete: components captured BEFORE the link (and its cascade) vanish.
    expect(tx.bundleComponent.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.productLink.delete.mock.invocationCallOrder[0],
    );

    const [row] = auditRows();
    expect(row.actionType).toBe("MAPPING_DELETE");
    expect(row.entityType).toBe("MAPPING");
    expect(row.entityId).toBe("L1");
    expect(row.companyId).toBe("C1");
    expect(row.userId).toBe(7);
    // FULL redacted link-row snapshot — the integration relation is NOT part of it.
    expect(row.details.snapshot.id).toBe("L1");
    expect(row.details.snapshot.externalProductId).toBe("EP1");
    expect(row.details.snapshot.isBundle).toBe(true);
    expect(row.details.snapshot.integration).toBeUndefined();
    // Cascade: read-before-delete identity array + unmapped count.
    expect(row.details.cascade.bundleComponents).toEqual([
      { id: "BC1", internalProductId: 9, quantity: 2 },
      { id: "BC2", internalProductId: 10, quantity: 1 },
    ]);
    expect(row.details.cascade.unmappedOrderItems).toBe(3);
  });

  it("404 on a missing link records nothing", async () => {
    db.productLink.findUnique.mockResolvedValue(null);

    const resp = await mappingsDELETE(
      mkReq("http://t/api/admin/product-mappings?linkId=nope", "DELETE"),
    );

    expect(resp.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/products/[id]/links — MAPPING_CREATE (single)
// ---------------------------------------------------------------------------
describe("products/[id]/links POST — MAPPING_CREATE (single mapping)", () => {
  it("records MAPPING_CREATE in the create's tx with backfill count and companyId", async () => {
    db.product.findFirst.mockResolvedValue({ id: 5, deletedAt: null });
    db.integration.findUnique.mockResolvedValue({ id: "int1", companyId: "C1", isActive: true });
    tx.productLink.create.mockResolvedValue({ id: "L2", integration: { id: "int1", name: "n", platform: "p" } });
    tx.externalOrderItem.updateMany.mockResolvedValue({ count: 4 });

    const resp = await linksPOST(
      mkReq("http://t/api/products/5/links", "POST", {
        integrationId: "int1",
        externalProductId: "EP1",
        externalVariantId: "V1",
        externalSku: "S1",
        externalTitle: "T1",
      }),
      { params: { id: "5" } } as any,
    );

    expect(resp.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.productLink.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("MAPPING_CREATE");
    expect(row.entityType).toBe("MAPPING");
    expect(row.entityId).toBe("L2"); // created link cuid
    expect(row.companyId).toBe("C1");
    expect(row.userId).toBe(7);
    expect(row.details).toMatchObject({
      integrationId: "int1",
      internalProductId: 5,
      externalProductId: "EP1",
      externalVariantId: "V1",
      backfilledOrderItems: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/products/[id]/links — MAPPING_DELETE (normalized)
// ---------------------------------------------------------------------------
describe("products/[id]/links DELETE — MAPPING_DELETE (normalized: isMapped cleanup added)", () => {
  const linkRow = {
    id: "L3",
    integrationId: "int1",
    internalProductId: 5,
    externalProductId: "EP3",
    externalVariantId: null,
    externalSku: null,
    externalTitle: null,
    isBundle: false,
    createdAt: new Date("2026-02-02T00:00:00Z"),
  };

  it("wraps delete in a tx, unmaps stranded items, and records MAPPING_DELETE all in ONE tx", async () => {
    db.productLink.findUnique.mockResolvedValue({
      ...linkRow,
      integration: { companyId: "C1" },
    });
    tx.bundleComponent.findMany.mockResolvedValue([]);
    tx.externalOrderItem.updateMany.mockResolvedValue({ count: 2 });
    tx.productLink.delete.mockResolvedValue({});

    const resp = await linksDELETE(
      mkReq("http://t/api/products/5/links?linkId=L3", "DELETE"),
      { params: { id: "5" } } as any,
    );

    expect(resp.status).toBe(200);
    // The NEW cleanup + delete + record all live inside a single $transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.externalOrderItem.updateMany).toHaveBeenCalledWith({
      where: { productLinkId: "L3" },
      data: { isMapped: false },
    });
    expect(tx.productLink.delete).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("MAPPING_DELETE");
    expect(row.entityType).toBe("MAPPING");
    expect(row.entityId).toBe("L3");
    expect(row.companyId).toBe("C1");
    expect(row.details.snapshot.id).toBe("L3");
    expect(row.details.snapshot.integration).toBeUndefined();
    expect(row.details.cascade.bundleComponents).toEqual([]);
    expect(row.details.cascade.unmappedOrderItems).toBe(2);
  });

  it("400 when the link belongs to a different product records nothing", async () => {
    db.productLink.findUnique.mockResolvedValue({
      ...linkRow,
      internalProductId: 999,
      integration: { companyId: "C1" },
    });

    const resp = await linksDELETE(
      mkReq("http://t/api/products/5/links?linkId=L3", "DELETE"),
      { params: { id: "5" } } as any,
    );

    expect(resp.status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/products/bundle-links — MAPPING_CREATE (bundle)
// ---------------------------------------------------------------------------
describe("bundle-links POST — MAPPING_CREATE (isBundle + components)", () => {
  it("records MAPPING_CREATE in the create's tx with isBundle, components, backfill, companyId", async () => {
    db.integration.findUnique.mockResolvedValue({ id: "int1", companyId: "C1", isActive: true });
    db.product.findMany.mockResolvedValue([
      { id: 9, name: "A", deletedAt: null },
      { id: 10, name: "B", deletedAt: null },
    ]);
    db.productLink.findFirst.mockResolvedValue(null);
    tx.productLink.create.mockResolvedValue({
      id: "L4",
      integrationId: "int1",
      externalProductId: "EP1",
      externalVariantId: null,
      externalSku: null,
      externalTitle: null,
      isBundle: true,
      internalProductId: null,
      createdAt: new Date("2026-03-03T00:00:00Z"),
    });
    tx.bundleComponent.createMany.mockResolvedValue({ count: 2 });
    tx.externalOrderItem.updateMany.mockResolvedValue({ count: 5 });

    const resp = await bundlePOST(
      mkReq("http://t/api/products/bundle-links", "POST", {
        integrationId: "int1",
        externalProductId: "EP1",
        components: [
          { internalProductId: 9, quantity: 2 },
          { internalProductId: 10, quantity: 1 },
        ],
      }),
    );

    expect(resp.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.productLink.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("MAPPING_CREATE");
    expect(row.entityType).toBe("MAPPING");
    expect(row.entityId).toBe("L4");
    expect(row.companyId).toBe("C1");
    expect(row.details).toMatchObject({
      integrationId: "int1",
      internalProductId: null,
      externalProductId: "EP1",
      externalVariantId: null,
      isBundle: true,
      backfilledOrderItems: 5,
    });
    expect(row.details.components).toEqual([
      { internalProductId: 9, quantity: 2 },
      { internalProductId: 10, quantity: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/products/bundle-links/[linkId] — BUNDLE_CHANGE
// ---------------------------------------------------------------------------
describe("bundle-links PATCH — BUNDLE_CHANGE (old-before-delete from/to)", () => {
  it("reads OLD components before deleteMany and records exact from/to arrays in the tx", async () => {
    db.productLink.findUnique
      .mockResolvedValueOnce({ id: "L5", isBundle: true, integration: { companyId: "C1" } })
      .mockResolvedValueOnce({
        id: "L5",
        integrationId: "int1",
        externalProductId: "EP5",
        externalVariantId: null,
        externalSku: null,
        externalTitle: null,
        isBundle: true,
        internalProductId: null,
        createdAt: new Date("2026-04-04T00:00:00Z"),
        bundleComponents: [
          { internalProductId: 9, quantity: 2, sortOrder: 0, internalProduct: { name: "A" } },
        ],
      });
    db.product.findMany.mockResolvedValue([{ id: 9, name: "A", deletedAt: null }]);
    tx.bundleComponent.findMany.mockResolvedValue([
      { id: "BC9", internalProductId: 7, quantity: 3 },
    ]);
    tx.bundleComponent.deleteMany.mockResolvedValue({ count: 1 });
    tx.bundleComponent.createMany.mockResolvedValue({ count: 1 });

    const resp = await bundlePATCH(
      mkReq("http://t/api/products/bundle-links/L5", "PATCH", {
        components: [{ internalProductId: 9, quantity: 2 }],
      }),
      { params: { linkId: "L5" } } as any,
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // OLD rows read BEFORE the deleteMany destroys them (their ids ARE the identities).
    expect(tx.bundleComponent.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.bundleComponent.deleteMany.mock.invocationCallOrder[0],
    );
    // Record shares the tx with the createMany.
    expect(tx.bundleComponent.createMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("BUNDLE_CHANGE");
    expect(row.entityType).toBe("MAPPING");
    expect(row.entityId).toBe("L5");
    expect(row.companyId).toBe("C1");
    expect(row.details.changes.components.from).toEqual([
      { id: "BC9", internalProductId: 7, quantity: 3 },
    ]);
    expect(row.details.changes.components.to).toEqual([
      { internalProductId: 9, quantity: 2 },
    ]);
  });
});
