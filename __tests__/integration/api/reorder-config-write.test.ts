/**
 * @jest-environment node
 *
 * Lane reorder-points — Task 4: the config write paths (codex #13 — every interface
 * or the field is silently stripped).
 *
 * Pins:
 *  - the product PUT persists a per-product reorder config via upsert AND records the
 *    change under reorderConfig.* diff keys;
 *  - the global reorder-settings admin PUT updates the singleton with an audit diff.
 */

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireApproved: jest.fn(() => Promise.resolve({ user: { id: 9, isAdmin: true, isApproved: true } })),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 9, isAdmin: true } })),
  requireCSRF: jest.fn(() => Promise.resolve()),
}));
jest.mock("@/lib/rateLimit", () => ({
  __esModule: true,
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: any) => r),
}));
jest.mock("@/lib/products", () => ({
  __esModule: true,
  isProductUnique: jest.fn(() => Promise.resolve(true)),
  formatProductName: jest.fn(({ baseName, variant }: any) => `${baseName} ${variant}`.trim()),
}));
jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordChange: jest.fn(() => Promise.resolve()),
}));

jest.mock("@/lib/prisma", () => {
  const db: any = {
    product: {
      findUnique: jest.fn(),
      update: jest.fn(() => Promise.resolve({ id: 1, name: "P" })),
    },
    productReorderConfig: { upsert: jest.fn(() => Promise.resolve({})) },
    globalReorderSettings: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  db.$transaction = jest.fn(async (fn: any) => fn(db));
  return { __esModule: true, default: db };
});

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { recordChange } from "@/lib/change-tracking";
import { PUT as productPut } from "@/app/api/products/[id]/route";
import { PUT as reorderSettingsPut } from "@/app/api/admin/reorder-settings/route";

const db = prisma as any;
const mockRecord = recordChange as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test("product PUT upserts the reorder config and audits the diff", async () => {
  db.product.findUnique.mockResolvedValue({
    id: 1,
    name: "P",
    baseName: "P",
    variant: "x",
    unit: null,
    numericValue: null,
    lowStockThreshold: null,
    costPrice: null,
    retailPrice: 0,
    reorderConfig: { leadTimeDays: null, customSafetyStockDays: null, minOrderQuantity: 1, reorderPointOverride: null },
  });

  const req = new NextRequest("http://x/api/products/1", {
    method: "PUT",
    body: JSON.stringify({ reorderConfig: { leadTimeDays: 21, minOrderQuantity: 12 } }),
  });
  const res = await productPut(req, { params: { id: "1" } });
  expect(res.status).toBe(200);

  // upsert called with the provided fields.
  expect(db.productReorderConfig.upsert).toHaveBeenCalledTimes(1);
  const upsertArg = db.productReorderConfig.upsert.mock.calls[0][0];
  expect(upsertArg.where).toEqual({ productId: 1 });
  expect(upsertArg.update).toEqual({ leadTimeDays: 21, minOrderQuantity: 12 });

  // audit diff carries reorderConfig.* keys.
  const changes = mockRecord.mock.calls[0][1].changes;
  expect(changes["reorderConfig.leadTimeDays"]).toEqual({ from: null, to: 21 });
  expect(changes["reorderConfig.minOrderQuantity"]).toEqual({ from: 1, to: 12 });
});

test("global reorder-settings PUT upserts the singleton with an audit diff (row present)", async () => {
  // Present row → findUnique returns it; upsert patches via its update branch.
  db.globalReorderSettings.findUnique.mockResolvedValue({
    id: 1,
    defaultLeadTimeDays: 14,
    defaultSafetyStockDays: 7,
    defaultTargetCoverageMultiple: 2,
    minEvidenceEvents: 3,
  });
  db.globalReorderSettings.upsert.mockResolvedValue({
    id: 1,
    defaultLeadTimeDays: 30,
    defaultSafetyStockDays: 7,
    defaultTargetCoverageMultiple: 2,
    minEvidenceEvents: 3,
  });

  const req = new NextRequest("http://x/api/admin/reorder-settings", {
    method: "PUT",
    body: JSON.stringify({ defaultLeadTimeDays: 30 }),
  });
  const res = await reorderSettingsPut(req);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.defaultLeadTimeDays).toBe(30);

  const upsertArg = db.globalReorderSettings.upsert.mock.calls[0][0];
  expect(upsertArg.where).toEqual({ id: 1 });
  expect(upsertArg.update).toMatchObject({ defaultLeadTimeDays: 30, updatedBy: 9 });

  const call = mockRecord.mock.calls[0][1];
  expect(call.actionType).toBe("SETTINGS_UPDATE");
  expect(call.changes.defaultLeadTimeDays).toEqual({ from: 14, to: 30 });
  // Baseline is the persisted row, not the schema defaults.
  expect(call.details.baselineSource).toBe("row");
});

test("global reorder-settings PUT seeds via upsert.create with a schema-defaults baseline when the row is absent", async () => {
  // Absent row → findUnique returns null; the audit "from" is the schema-defaults
  // constant (defaultLeadTimeDays = 14) and the diff labels the baseline as such.
  db.globalReorderSettings.findUnique.mockResolvedValue(null);
  db.globalReorderSettings.upsert.mockResolvedValue({
    id: 1,
    defaultLeadTimeDays: 30,
    defaultSafetyStockDays: 7,
    defaultTargetCoverageMultiple: 2,
    minEvidenceEvents: 3,
  });

  const req = new NextRequest("http://x/api/admin/reorder-settings", {
    method: "PUT",
    body: JSON.stringify({ defaultLeadTimeDays: 30 }),
  });
  const res = await reorderSettingsPut(req);
  expect(res.status).toBe(200);

  const upsertArg = db.globalReorderSettings.upsert.mock.calls[0][0];
  expect(upsertArg.where).toEqual({ id: 1 });
  // create carries the submitted value over the schema defaults + updatedBy.
  expect(upsertArg.create).toMatchObject({ id: 1, defaultLeadTimeDays: 30, updatedBy: 9 });

  const call = mockRecord.mock.calls[0][1];
  expect(call.changes.defaultLeadTimeDays).toEqual({ from: 14, to: 30 });
  expect(call.details.baselineSource).toBe("schema_defaults");
});
