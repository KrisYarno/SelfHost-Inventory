// @jest-environment node
/**
 * Task 3 characterization tests — admin config + exports recording through
 * @/lib/change-tracking (Phase B plan, "Task 3 (Lane: admin config + exports)").
 *
 * The mock-Prisma pattern mirrors change-tracking-users.test.ts: `$transaction`
 * hands the handler a single `tx` object (exposed as `db.__tx`) and the REAL
 * recordChange runs against it, so every assertion is on the ACTUAL audit_logs
 * create payload. What this pins:
 *   - settings POST is ATOMIC (both upserts + the record on ONE tx client) with
 *     FETCHED from-values, and honors the ER-B9 no-op rules;
 *   - backup POST records BACKUP_CREATED (filename + sizeBytes) AFTER a
 *     successful dump and touches no prisma model except the audit row;
 *   - each of the 3 GET exports records a DATA_EXPORT with its exact
 *     details.export tag and still streams the CSV;
 *   - ER-B6: a rejecting recordChange on admin/logs/export => 500, NO CSV body
 *     (pins record-before-stream ordering; one route stands in for all three).
 */
import { NextRequest } from "next/server";

// Valid DB URL so admin/backup's parseDatabaseUrl succeeds and reaches the dump.
process.env.DATABASE_URL = "mysql://user:pass@localhost:3306/testdb";

// Keep the REAL apiHandler (ZodError -> 400, AppError -> mapped status) +
// requireCSRF; stub only the auth guards.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn(), requireApproved: jest.fn() };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

// Spread the actual module so the RateLimitError class stays intact (the REAL
// apiHandler does `error instanceof RateLimitError` on its error path); override
// only the two functions the routes call.
jest.mock("@/lib/rateLimit", () => {
  const actual = jest.requireActual("@/lib/rateLimit");
  return {
    __esModule: true,
    ...actual,
    enforceRateLimit: jest.fn(() => ({})),
    applyRateLimitHeaders: jest.fn((r: unknown) => r),
  };
});

// Real recordChange calls headers(); give it a deterministic, empty context.
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

// admin/backup shells out to mysqldump and writes to disk — override only the
// spawn / fs.write path (spread the rest so Prisma's client init, which uses
// child_process.exec + fs at require time, keeps working). The dump emits a
// fixed body so sizeBytes is deterministic.
jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    spawn: jest.fn(() => {
      const { EventEmitter } = require("node:events");
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit("data", Buffer.from("-- dump contents\n"));
        proc.emit("close", 0);
      });
      return proc;
    }),
  };
});

jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: jest.fn(async () => undefined),
      writeFile: jest.fn(async () => undefined),
    },
  };
});

// One tx object per run, shared by the settings upserts and the audit write so
// the "same transaction" claim is observable. Top-level `db` holds the read
// models the export routes query OUTSIDE the record tx.
jest.mock("@/lib/prisma", () => {
  const tx = {
    systemSetting: { findMany: jest.fn(), upsert: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    product: { findMany: jest.fn() },
    location: { findMany: jest.fn() },
    inventory_logs: { findMany: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { POST as settingsPOST } from "@/app/api/admin/settings/route";
import { POST as backupPOST } from "@/app/api/admin/backup/route";
import { GET as inventoryExportGET } from "@/app/api/inventory/export/route";
import { GET as logsExportGET } from "@/app/api/admin/logs/export/route";
import { GET as countSheetGET } from "@/app/api/admin/inventory/mass-update/export/route";
import { requireAdmin, requireApproved } from "@/lib/api-utils";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const tx = db.__tx;
const ADMIN = { id: 7, email: "a@e.com", isAdmin: true, isApproved: true };
const DUMP_BODY = "-- dump contents\n";

function postReq(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

function getReq(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

/** All create() payloads written to the shared tx this run. */
function auditRows(): any[] {
  return tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
  (requireApproved as jest.Mock).mockResolvedValue({ user: ADMIN });
  tx.systemSetting.findMany.mockResolvedValue([]);
  tx.systemSetting.upsert.mockResolvedValue({});
  db.product.findMany.mockResolvedValue([]);
  db.location.findMany.mockResolvedValue([]);
  db.inventory_logs.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// POST /api/admin/settings — SETTINGS_UPDATE, atomic, FETCHED from-values
// ---------------------------------------------------------------------------
describe("admin/settings POST — SETTINGS_UPDATE (atomic, ER-B9)", () => {
  it("records on the SAME tx as both upserts, with FETCHED from-values", async () => {
    tx.systemSetting.findMany.mockResolvedValue([
      { key: "weeklyReportsEnabled", value: "true" },
    ]);

    const res = await settingsPOST(
      postReq("http://t/api/admin/settings", {
        weeklyReportsEnabled: false,
        analyticsRebuildEnabled: true,
      })
    );

    expect(res.status).toBe(200);
    // Single-tx atomicity: findMany + both upserts + record all on the one tx.
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.systemSetting.findMany).toHaveBeenCalledWith({
      where: { key: { in: ["weeklyReportsEnabled", "analyticsRebuildEnabled"] } },
    });
    expect(tx.systemSetting.upsert).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("SETTINGS_UPDATE");
    expect(row.entityType).toBe("SETTINGS");
    expect(row.entityId).toBeNull();
    expect(row.userId).toBe(ADMIN.id);
    expect(row.actorKind).toBe("USER");
    expect(row.details.changes).toEqual({
      weeklyReportsEnabled: { from: "true", to: "false" },
      analyticsRebuildEnabled: { from: null, to: "true" },
    });
  });

  it("ER-B9: a provided flag whose value is unchanged (from === to) drops, no event", async () => {
    tx.systemSetting.findMany.mockResolvedValue([
      { key: "weeklyReportsEnabled", value: "true" },
    ]);

    const res = await settingsPOST(
      postReq("http://t/api/admin/settings", { weeklyReportsEnabled: true })
    );

    expect(res.status).toBe(200);
    // The upsert still runs (idempotent write), but the no-op change is dropped
    // and the changes map ends empty => NO event.
    expect(tx.systemSetting.upsert).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("ER-B9: only provided flags appear in changes", async () => {
    const res = await settingsPOST(
      postReq("http://t/api/admin/settings", { analyticsRebuildEnabled: false })
    );

    expect(res.status).toBe(200);
    const [row] = auditRows();
    expect(Object.keys(row.details.changes)).toEqual(["analyticsRebuildEnabled"]);
    expect(row.details.changes.analyticsRebuildEnabled).toEqual({ from: null, to: "false" });
  });

  it("ER-B9: empty body => no transaction, no upsert, no event (200)", async () => {
    const res = await settingsPOST(postReq("http://t/api/admin/settings", {}));

    expect(res.status).toBe(200);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.systemSetting.upsert).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/backup — BACKUP_CREATED after a successful dump
// ---------------------------------------------------------------------------
describe("admin/backup POST — BACKUP_CREATED", () => {
  it("records filename + sizeBytes after the dump and writes no other prisma model", async () => {
    const res = await backupPOST(postReq("http://t/api/admin/backup"));

    expect(res.status).toBe(200);
    // The download still streams (SQL body), and exactly one audit row is written.
    expect(res.headers.get("content-type")).toBe("application/sql");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    // No stock/settings/etc. writes — the only prisma write is the audit row.
    expect(tx.systemSetting.upsert).not.toHaveBeenCalled();

    const [row] = auditRows();
    expect(row.actionType).toBe("BACKUP_CREATED");
    expect(row.entityType).toBe("SYSTEM");
    expect(row.entityId).toBeNull();
    expect(row.userId).toBe(ADMIN.id);
    expect(row.details.filename).toMatch(/^manual-.*\.sql$/);
    expect(row.details.sizeBytes).toBe(Buffer.byteLength(DUMP_BODY));
  });
});

// ---------------------------------------------------------------------------
// GET exports — DATA_EXPORT before streaming
// ---------------------------------------------------------------------------
describe("inventory/export GET — DATA_EXPORT { export: 'inventory' }", () => {
  it("records the export and still streams the CSV", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "P1", baseName: "P1", variant: "", product_locations: [] },
      { id: 2, name: "P2", baseName: "P2", variant: "", product_locations: [] },
    ]);
    db.location.findMany.mockResolvedValue([]);

    const res = await inventoryExportGET(getReq("http://t/api/inventory/export"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    const [row] = auditRows();
    expect(row.actionType).toBe("DATA_EXPORT");
    expect(row.entityType).toBe("SYSTEM");
    expect(row.userId).toBe(ADMIN.id);
    expect(row.details.export).toBe("inventory");
    expect(row.details.rowCount).toBe(2);
  });
});

describe("admin/logs/export GET — DATA_EXPORT { export: 'inventory-logs', filters }", () => {
  it("records the export with parsed filters + rowCount and still streams the CSV", async () => {
    db.inventory_logs.findMany.mockResolvedValue([
      {
        changeTime: new Date("2026-07-01T00:00:00.000Z"),
        products: { name: "P1" },
        users: { username: "u" },
        locations: { name: "Main" },
        logType: "ADJUSTMENT",
        delta: 5,
      },
    ]);

    const res = await logsExportGET(
      getReq("http://t/api/admin/logs/export?type=ADJUSTMENT&user=7&search=widget")
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    const [row] = auditRows();
    expect(row.actionType).toBe("DATA_EXPORT");
    expect(row.details.export).toBe("inventory-logs");
    expect(row.details.rowCount).toBe(1);
    expect(row.details.filters).toMatchObject({
      type: "ADJUSTMENT",
      user: "7",
      search: "widget",
    });
  });

  it("ER-B6: a rejecting recordChange => 500 and NO CSV body (record-before-stream)", async () => {
    tx.auditLog.create.mockRejectedValueOnce(new Error("audit store down"));
    db.inventory_logs.findMany.mockResolvedValue([]);

    const res = await logsExportGET(getReq("http://t/api/admin/logs/export"));

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type") || "").not.toContain("text/csv");
    const body = await res.text();
    // The CSV header row is never emitted — the response is the JSON 500 body.
    expect(body).not.toContain("Timestamp");
  });
});

describe("mass-update/export GET — DATA_EXPORT { export: 'count-sheet' }", () => {
  it("records the export and still streams the CSV", async () => {
    db.product.findMany.mockResolvedValue([
      { id: 1, name: "P1", baseName: "", variant: "", product_locations: [] },
    ]);
    db.location.findMany.mockResolvedValue([]);

    const res = await countSheetGET(
      getReq("http://t/api/admin/inventory/mass-update/export")
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");

    const [row] = auditRows();
    expect(row.actionType).toBe("DATA_EXPORT");
    expect(row.entityType).toBe("SYSTEM");
    expect(row.userId).toBe(ADMIN.id);
    expect(row.details.export).toBe("count-sheet");
    expect(row.details.rowCount).toBe(1);
  });
});
