// @jest-environment node
/**
 * Task 4 characterization tests — companies + integrations CRUD migration to
 * @/lib/change-tracking (Phase B plan Task 4).
 *
 * Same mock-Prisma pattern as change-tracking-users.test.ts: a single `tx`
 * object is handed to every $transaction closure (exposed as db.__tx), the REAL
 * recordChange runs against it, so every assertion is on the ACTUAL audit_logs
 * create payload. Proves:
 *   - COMPANY_* / INTEGRATION_* events write on the SAME tx as the mutation,
 *   - company-scoped events carry companyId (the module throws in dev otherwise),
 *   - R-D11 snapshots (create + delete) + cascade id/identity arrays,
 *   - integration credential rotations record as post-redaction "[REDACTED]",
 *   - INTEGRATION_SYNC_CONFIG_CHANGE vs INTEGRATION_UPDATE branch rule,
 *   - companies DELETE 409 guard names each nonzero count,
 *   - salesFacts are NEVER deleteMany'd (they cascade via the DB — P-B5/P-B6).
 */
import { NextRequest } from "next/server";

// Keep the REAL apiHandler (ZodError/AppError mapping) + requireCSRF; stub only
// the admin guard.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn() };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

jest.mock("@/lib/rateLimit", () => {
  const actual = jest.requireActual("@/lib/rateLimit");
  return {
    __esModule: true,
    ...actual,
    enforceRateLimit: jest.fn(() => ({})),
    applyRateLimitHeaders: jest.fn((r: unknown) => r),
  };
});

// Deterministic, encryption-key-free credential handling.
jest.mock("@/lib/encryption", () => ({
  __esModule: true,
  encryptValue: jest.fn((v: string) => `enc(${v})`),
}));

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// REAL change-tracking (recordChange/diff run for real) with only newBatchId
// pinned for determinism (unused here, harmless).
jest.mock("@/lib/change-tracking", () => {
  const actual = jest.requireActual("@/lib/change-tracking");
  return { __esModule: true, ...actual, newBatchId: jest.fn(() => "test-batch-0001") };
});

// One tx object per run, shared by the mutations and the audit write.
jest.mock("@/lib/prisma", () => {
  const tx = {
    company: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    userCompany: { create: jest.fn() },
    integration: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    externalOrder: { findMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
    productLink: { findMany: jest.fn(), count: jest.fn(), deleteMany: jest.fn() },
    externalOrderItem: { count: jest.fn(), deleteMany: jest.fn() },
    productSalesFact: { count: jest.fn(), deleteMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    company: { findUnique: jest.fn() },
    integration: { findUnique: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { POST as companyPOST } from "@/app/api/admin/companies/route";
import { PUT as companyPUT, DELETE as companyDELETE } from "@/app/api/admin/companies/[id]/route";
import { POST as integrationPOST } from "@/app/api/admin/integrations/route";
import { PUT as integrationPUT, DELETE as integrationDELETE } from "@/app/api/admin/integrations/[id]/route";
import { requireAdmin } from "@/lib/api-utils";
import { recordChange } from "@/lib/change-tracking";
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
// POST /api/admin/companies — COMPANY_CREATE (atomic: company + membership + event)
// ---------------------------------------------------------------------------
describe("POST companies — COMPANY_CREATE (atomic, snapshot, autoMembership)", () => {
  it("creates company + membership + records COMPANY_CREATE in ONE tx", async () => {
    db.company.findUnique.mockResolvedValue(null); // slug free
    const created = { id: "co-new", name: "Acme", slug: "acme", createdAt: new Date(), updatedAt: new Date() };
    tx.company.create.mockResolvedValue(created);
    tx.userCompany.create.mockResolvedValue({});

    const resp = await companyPOST(
      mkReq("http://t/api/admin/companies", "POST", { name: "Acme", slug: "acme" })
    );

    expect(resp.status).toBe(201);
    // Same-tx proof: create + membership + audit all inside ONE $transaction.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.company.create).toHaveBeenCalledTimes(1);
    expect(tx.userCompany.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("COMPANY_CREATE");
    expect(row.entityType).toBe("COMPANY");
    expect(row.entityId).toBe("co-new");
    expect(row.companyId).toBe("co-new"); // company-scoped -> id
    expect(row.userId).toBe(7);
    expect(row.details.snapshot.name).toBe("Acme");
    expect(row.details.snapshot.slug).toBe("acme");
    expect(row.details.autoMembership).toBe(7);
  });

  it("slug collision -> 409, no tx, no event", async () => {
    db.company.findUnique.mockResolvedValue({ id: "existing", slug: "acme" });

    const resp = await companyPOST(
      mkReq("http://t/api/admin/companies", "POST", { name: "Acme", slug: "acme" })
    );

    expect(resp.status).toBe(409);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/companies/[id] — COMPANY_UPDATE (before-image by id + diff)
// ---------------------------------------------------------------------------
describe("PUT companies/[id] — COMPANY_UPDATE", () => {
  it("fetches before-image by id, diffs name/slug, records in the same tx", async () => {
    db.company.findUnique.mockResolvedValue(null); // slug not colliding
    tx.company.findUniqueOrThrow.mockResolvedValue({ name: "Old", slug: "old" });
    tx.company.update.mockResolvedValue({ id: "co-1", name: "New", slug: "new" });

    const resp = await companyPUT(
      mkReq("http://t/api/admin/companies/co-1", "PUT", { name: "New", slug: "new" }),
      { params: { id: "co-1" } } as any
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.company.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(tx.company.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("COMPANY_UPDATE");
    expect(row.entityType).toBe("COMPANY");
    expect(row.entityId).toBe("co-1");
    expect(row.companyId).toBe("co-1");
    expect(row.details.changes.name).toEqual({ from: "Old", to: "New" });
    expect(row.details.changes.slug).toEqual({ from: "old", to: "new" });
  });

  it("no-op (name/slug unchanged) -> update runs but NO event (ER-B9)", async () => {
    db.company.findUnique.mockResolvedValue(null);
    tx.company.findUniqueOrThrow.mockResolvedValue({ name: "Same", slug: "same" });
    tx.company.update.mockResolvedValue({ id: "co-1", name: "Same", slug: "same" });

    const resp = await companyPUT(
      mkReq("http://t/api/admin/companies/co-1", "PUT", { name: "Same", slug: "same" }),
      { params: { id: "co-1" } } as any
    );

    expect(resp.status).toBe(200);
    expect(tx.company.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("slug collision with a DIFFERENT company -> 409, no event", async () => {
    db.company.findUnique.mockResolvedValue({ id: "other", slug: "taken" });

    const resp = await companyPUT(
      mkReq("http://t/api/admin/companies/co-1", "PUT", { name: "X", slug: "taken" }),
      { params: { id: "co-1" } } as any
    );

    expect(resp.status).toBe(409);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/companies/[id] — COMPANY_DELETE (guard names each count)
// ---------------------------------------------------------------------------
describe("DELETE companies/[id] — 409 guard matrix + COMPANY_DELETE", () => {
  function companyWith(counts: { users: number; integrations: number; orders: number }) {
    return {
      id: "co-1",
      name: "Acme",
      slug: "acme",
      createdAt: new Date(),
      updatedAt: new Date(),
      _count: counts,
    };
  }

  it("404 on missing company", async () => {
    db.company.findUnique.mockResolvedValue(null);
    const resp = await companyDELETE(
      mkReq("http://t/api/admin/companies/co-1", "DELETE"),
      { params: { id: "co-1" } } as any
    );
    expect(resp.status).toBe(404);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("users alone blocks (409, message names users)", async () => {
    db.company.findUnique.mockResolvedValue(companyWith({ users: 3, integrations: 0, orders: 0 }));
    const resp = await companyDELETE(
      mkReq("http://t/api/admin/companies/co-1", "DELETE"),
      { params: { id: "co-1" } } as any
    );
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/user/i);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("integrations alone blocks (409, message names integrations)", async () => {
    db.company.findUnique.mockResolvedValue(companyWith({ users: 0, integrations: 2, orders: 0 }));
    const resp = await companyDELETE(
      mkReq("http://t/api/admin/companies/co-1", "DELETE"),
      { params: { id: "co-1" } } as any
    );
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/integration/i);
  });

  it("orders alone blocks (409, message names orders)", async () => {
    db.company.findUnique.mockResolvedValue(companyWith({ users: 0, integrations: 0, orders: 5 }));
    const resp = await companyDELETE(
      mkReq("http://t/api/admin/companies/co-1", "DELETE"),
      { params: { id: "co-1" } } as any
    );
    expect(resp.status).toBe(409);
    const body = await resp.json();
    expect(body.error).toMatch(/order/i);
  });

  it("all zero -> deletes + records COMPANY_DELETE (snapshot, same tx, NO salesFacts deleteMany)", async () => {
    db.company.findUnique.mockResolvedValue(companyWith({ users: 0, integrations: 0, orders: 0 }));
    tx.company.delete.mockResolvedValue({});

    const resp = await companyDELETE(
      mkReq("http://t/api/admin/companies/co-1", "DELETE"),
      { params: { id: "co-1" } } as any
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.company.delete).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    // salesFacts cascade via the DB — the guard requires zero integrations, so
    // there is nothing to deleteMany (P-B5/P-B6 rev.).
    expect(tx.productSalesFact.deleteMany).not.toHaveBeenCalled();

    const [row] = auditRows();
    expect(row.actionType).toBe("COMPANY_DELETE");
    expect(row.entityType).toBe("COMPANY");
    expect(row.entityId).toBe("co-1");
    expect(row.companyId).toBe("co-1");
    expect(row.details.snapshot.name).toBe("Acme");
    expect(row.details.snapshot.slug).toBe("acme");
    // _count must NOT leak into the snapshot (it is not a row field).
    expect(row.details.snapshot._count).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/integrations — INTEGRATION_CREATE (snapshot has NO credentials)
// ---------------------------------------------------------------------------
describe("POST integrations — INTEGRATION_CREATE", () => {
  it("records INTEGRATION_CREATE in the same tx; snapshot carries NO credential fields", async () => {
    db.company.findUnique.mockResolvedValue({ id: "co-1", name: "Acme" });
    const created = {
      id: "int-1",
      companyId: "co-1",
      name: "My Shop",
      platform: "SHOPIFY",
      storeUrl: "https://shop.example.com",
      company: { name: "Acme", slug: "acme" },
    };
    tx.integration.create.mockResolvedValue(created);

    const resp = await integrationPOST(
      mkReq("http://t/api/admin/integrations", "POST", {
        companyId: "co-1",
        platform: "SHOPIFY",
        name: "My Shop",
        storeUrl: "https://shop.example.com",
        apiKey: "key-123",
        apiSecret: "secret-456",
      })
    );

    expect(resp.status).toBe(201);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.integration.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_CREATE");
    expect(row.entityType).toBe("INTEGRATION");
    expect(row.entityId).toBe("int-1");
    expect(row.companyId).toBe("co-1");
    expect(row.details.snapshot).toEqual({
      name: "My Shop",
      platform: "SHOPIFY",
      storeUrl: "https://shop.example.com",
    });
    // Absolutely no credential material — even pre-redaction.
    expect(JSON.stringify(row.details.snapshot)).not.toMatch(/key-123|secret-456|apiKey|apiSecret/);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/integrations/[id] — UPDATE vs SYNC_CONFIG_CHANGE + credential redaction
// ---------------------------------------------------------------------------
describe("PUT integrations/[id] — branch rule + credential redaction", () => {
  const baseIntegration = {
    id: "int-1",
    companyId: "co-1",
    name: "Store",
    storeUrl: "https://s.example.com",
    isActive: true,
    stockSyncEnabled: false,
    fulfillmentPushEnabled: false,
    syncLocationId: null,
  };

  beforeEach(() => {
    tx.integration.findUniqueOrThrow.mockResolvedValue({ ...baseIntegration });
    tx.integration.update.mockResolvedValue({ ...baseIntegration, company: { name: "Acme", slug: "acme" } });
  });

  async function put(body: unknown) {
    return integrationPUT(
      mkReq("http://t/api/admin/integrations/int-1", "PUT", body),
      { params: { id: "int-1" } } as any
    );
  }

  it("ONLY stockSyncEnabled changed -> INTEGRATION_SYNC_CONFIG_CHANGE", async () => {
    const resp = await put({ stockSyncEnabled: true });
    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_SYNC_CONFIG_CHANGE");
    expect(row.companyId).toBe("co-1");
    expect(row.details.changes.stockSyncEnabled).toEqual({ from: false, to: true });
  });

  it("ONLY syncLocationId changed -> INTEGRATION_SYNC_CONFIG_CHANGE", async () => {
    const resp = await put({ syncLocationId: 5 });
    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_SYNC_CONFIG_CHANGE");
    expect(row.details.changes.syncLocationId).toEqual({ from: null, to: 5 });
  });

  it("isActive changed -> INTEGRATION_UPDATE (isActive is NOT sync-config)", async () => {
    const resp = await put({ isActive: false });
    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_UPDATE");
    expect(row.details.changes.isActive).toEqual({ from: true, to: false });
  });

  it("name changed -> INTEGRATION_UPDATE", async () => {
    const resp = await put({ name: "Renamed" });
    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_UPDATE");
    expect(row.details.changes.name).toEqual({ from: "Store", to: "Renamed" });
  });

  it("sync-config field + a non-sync field -> INTEGRATION_UPDATE (mixed)", async () => {
    const resp = await put({ stockSyncEnabled: true, name: "Renamed" });
    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_UPDATE");
  });

  it("credential rotation -> changes.apiKey is post-redaction '[REDACTED]', UPDATE", async () => {
    const resp = await put({ apiKey: "brand-new-key" });
    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_UPDATE");
    expect(row.details.changes.apiKey).toBe("[REDACTED]");
    // Plaintext must never appear anywhere in the recorded payload.
    expect(JSON.stringify(row)).not.toMatch(/brand-new-key/);
  });

  it("empty-string credential = leave unchanged -> no changes entry, no event", async () => {
    const resp = await put({ apiKey: "" });
    expect(resp.status).toBe(200);
    expect(tx.integration.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("no-op (name equals before-image) -> no event (ER-B9)", async () => {
    const resp = await put({ name: "Store" });
    expect(resp.status).toBe(200);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/integrations/[id] — INTEGRATION_DELETE (cascade capture)
// ---------------------------------------------------------------------------
describe("DELETE integrations/[id] — INTEGRATION_DELETE", () => {
  const fullIntegration = {
    id: "int-1",
    companyId: "co-1",
    platform: "SHOPIFY",
    name: "Store",
    storeUrl: "https://s.example.com",
    encryptedApiKey: "enc(key)",
    encryptedApiSecret: "enc(secret)",
    webhookSecret: "enc(hook)",
    isActive: true,
  };

  it("captures cascade arrays BEFORE deleteManys, counts salesFacts, records full redacted snapshot", async () => {
    db.integration.findUnique.mockResolvedValue({ ...fullIntegration });
    tx.externalOrder.findMany.mockResolvedValue([
      { id: "o1", orderNumber: "1001" },
      { id: "o2", orderNumber: "1002" },
    ]);
    tx.productLink.findMany.mockResolvedValue([
      { id: "pl1", externalProductId: "ext-1", isBundle: false },
    ]);
    tx.externalOrderItem.count.mockResolvedValue(4);
    tx.productSalesFact.count.mockResolvedValue(9);
    tx.externalOrderItem.deleteMany.mockResolvedValue({ count: 4 });
    tx.externalOrder.deleteMany.mockResolvedValue({ count: 2 });
    tx.productLink.deleteMany.mockResolvedValue({ count: 1 });
    tx.integration.delete.mockResolvedValue({});

    const resp = await integrationDELETE(
      mkReq("http://t/api/admin/integrations/int-1", "DELETE"),
      { params: { id: "int-1" } } as any
    );

    expect(resp.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.integration.delete).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    // salesFacts cascade via the DB (P-B5 rev.) — count only, NEVER deleteMany.
    expect(tx.productSalesFact.deleteMany).not.toHaveBeenCalled();

    // Ordering: cascade identity arrays + counts read BEFORE the destructive ops.
    const ordersRead = tx.externalOrder.findMany.mock.invocationCallOrder[0];
    const linksRead = tx.productLink.findMany.mock.invocationCallOrder[0];
    const factsCount = tx.productSalesFact.count.mock.invocationCallOrder[0];
    const orderItemsDelete = tx.externalOrderItem.deleteMany.mock.invocationCallOrder[0];
    const ordersDelete = tx.externalOrder.deleteMany.mock.invocationCallOrder[0];
    const linksDelete = tx.productLink.deleteMany.mock.invocationCallOrder[0];
    const integrationDelete = tx.integration.delete.mock.invocationCallOrder[0];
    expect(ordersRead).toBeLessThan(ordersDelete);
    expect(linksRead).toBeLessThan(linksDelete);
    expect(orderItemsDelete).toBeLessThan(ordersDelete);
    // salesFacts count must be taken before the integration.delete cascades them.
    expect(factsCount).toBeLessThan(integrationDelete);

    const [row] = auditRows();
    expect(row.actionType).toBe("INTEGRATION_DELETE");
    expect(row.entityType).toBe("INTEGRATION");
    expect(row.entityId).toBe("int-1");
    expect(row.companyId).toBe("co-1");
    // R-D11 full redacted snapshot.
    expect(row.details.snapshot.name).toBe("Store");
    expect(row.details.snapshot.platform).toBe("SHOPIFY");
    expect(row.details.snapshot.encryptedApiKey).toBe("[REDACTED]");
    expect(row.details.snapshot.encryptedApiSecret).toBe("[REDACTED]");
    expect(row.details.snapshot.webhookSecret).toBe("[REDACTED]");
    // Cascade id + identity arrays + counts.
    expect(row.details.cascade.orders).toEqual([
      { id: "o1", orderNumber: "1001" },
      { id: "o2", orderNumber: "1002" },
    ]);
    expect(row.details.cascade.productLinks).toEqual([
      { id: "pl1", externalProductId: "ext-1", isBundle: false },
    ]);
    expect(row.details.cascade.orderItems).toBe(4);
    expect(row.details.cascade.destroyedSalesFacts).toBe(9);
  });

  it("404 on missing integration, no tx, no event", async () => {
    db.integration.findUnique.mockResolvedValue(null);
    const resp = await integrationDELETE(
      mkReq("http://t/api/admin/integrations/int-1", "DELETE"),
      { params: { id: "int-1" } } as any
    );
    expect(resp.status).toBe(404);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Guardrail — company-scoped events without companyId throw in dev (the module
// protection every handler above relies on).
// ---------------------------------------------------------------------------
describe("recordChange companyId guardrail (dev-mode negative)", () => {
  it("throws when a company-scoped event omits companyId; no row written", async () => {
    await expect(
      recordChange(tx as any, {
        actor: { userId: 1 },
        actionType: "COMPANY_DELETE",
        entityType: "COMPANY",
        entityId: "co-1",
        action: "missing companyId",
        // companyId intentionally omitted
      })
    ).rejects.toThrow(/companyId is required/);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
