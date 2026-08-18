// @jest-environment node
//
// Lane 3 (Task 6): GET /api/admin/ops-health (Sub<T>-enveloped triage aggregate)
// + POST /api/admin/analytics-rebuild (manual trigger) + lib/backup/list.
//
// House conventions: real apiHandler/requireCSRF/enforceRateLimit + real
// recordChange (so audit + CSRF + rate-limit behaviour is exercised); only the
// guards, prisma, and the heavy rebuild/backup collaborators are mocked.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1 } })),
}));
jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(() => Promise.resolve(true)) }));
jest.mock("next/headers", () => ({ headers: jest.fn(async () => ({ get: () => null })) }));
jest.mock("@/lib/analytics/rebuild-snapshots", () => ({ rebuildStockSnapshots: jest.fn() }));
jest.mock("@/lib/analytics/rebuild-sales", () => ({ rebuildSalesFacts: jest.fn() }));
jest.mock("@/lib/backup/list", () => ({ listBackups: jest.fn() }));
jest.mock("@/lib/prisma", () => {
  const db: any = {
    integration: { findMany: jest.fn() },
    user: { count: jest.fn() },
    product: { count: jest.fn() },
    stagingItem: { count: jest.fn() },
    analyticsRebuildState: { findMany: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    analyticsRebuildRun: { findFirst: jest.fn(), findMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  db.$transaction = jest.fn(async (cb: (t: typeof db) => unknown) => cb(db));
  return { __esModule: true, default: db };
});

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET as opsHealthGET } from "@/app/api/admin/ops-health/route";
import { POST as rebuildPOST } from "@/app/api/admin/analytics-rebuild/route";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/api-utils";
import { validateCSRFToken } from "@/lib/csrf";
import { listBackups } from "@/lib/backup/list";
import { rebuildSalesFacts } from "@/lib/analytics/rebuild-sales";
import { rebuildStockSnapshots } from "@/lib/analytics/rebuild-snapshots";

const m = prisma as unknown as {
  integration: { findMany: jest.Mock };
  user: { count: jest.Mock };
  product: { count: jest.Mock };
  stagingItem: { count: jest.Mock };
  analyticsRebuildState: { findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  analyticsRebuildRun: { findFirst: jest.Mock; findMany: jest.Mock };
  auditLog: { create: jest.Mock };
};
const listBackupsMock = listBackups as jest.Mock;
const salesMock = rebuildSalesFacts as jest.Mock;
const snapshotsMock = rebuildStockSnapshots as jest.Mock;

const HOUR = 60 * 60 * 1000;

function opsReq(): NextRequest {
  return new NextRequest("http://x/api/admin/ops-health");
}

/** All subsystems healthy; individual tests override one axis. */
function setHealthy() {
  m.integration.findMany.mockResolvedValue([]);
  m.user.count.mockResolvedValue(0);
  m.product.count.mockResolvedValue(0);
  m.stagingItem.count.mockResolvedValue(0);
  m.analyticsRebuildState.findMany.mockResolvedValue([
    { job: "sales", lockedAt: null, heartbeatAt: null, lastError: null },
    { job: "snapshots", lockedAt: null, heartbeatAt: null, lastError: null },
  ]);
  m.systemSetting.findUnique.mockImplementation(({ where }: any) =>
    where.key === "analyticsRebuildEnabled" ? Promise.resolve({ value: "false" }) : Promise.resolve(null),
  );
  m.analyticsRebuildRun.findFirst.mockResolvedValue(null);
  m.analyticsRebuildRun.findMany.mockResolvedValue([]);
  listBackupsMock.mockResolvedValue({ status: "ok", files: [{ name: "b.sql", mtimeMs: Date.now() }] });
}

/** Enable the rebuild + a fresh heartbeat + a recent successful run (the "all green rebuild" baseline). */
function enableRebuildHealthy(now: number) {
  m.systemSetting.findUnique.mockImplementation(({ where }: any) => {
    if (where.key === "analyticsRebuildEnabled") return Promise.resolve({ value: "true" });
    if (where.key === "analyticsSidecarHeartbeat")
      return Promise.resolve({ value: JSON.stringify({ at: new Date(now - 60_000).toISOString(), envEnabled: true }) });
    return Promise.resolve(null);
  });
  m.analyticsRebuildRun.findFirst.mockResolvedValue({ finishedAt: new Date(now - 60_000), startedAt: new Date(now - 120_000) });
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 1 } });
  (validateCSRFToken as jest.Mock).mockResolvedValue(true);
  setHealthy();
});

// ===========================================================================
// GET /api/admin/ops-health
// ===========================================================================

describe("GET /api/admin/ops-health", () => {
  test("all clear => verdict 'ok', empty attention, every subsystem enveloped ok", async () => {
    const res = await opsHealthGET(opsReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe("ok");
    expect(body.attention).toEqual([]);
    expect(body.integrations.status).toBe("ok");
    expect(body.backups.status).toBe("ok");
    expect(body.pendingReviews.status).toBe("ok");
    expect(body.rebuild.status).toBe("ok");
  });

  test("lock-stale derivation: a held lock with a stale heartbeat flags lockStale + a warning", async () => {
    const now = Date.now();
    enableRebuildHealthy(now);
    m.analyticsRebuildState.findMany.mockResolvedValue([
      { job: "sales", lockedAt: new Date(now - 20 * 60 * 1000), heartbeatAt: new Date(now - 20 * 60 * 1000), lastError: null },
    ]);

    const body = await (await opsHealthGET(opsReq())).json();
    const sales = body.rebuild.data.jobs.find((j: any) => j.job === "sales");
    expect(sales.lockStale).toBe(true);
    expect(body.attention.some((a: any) => /lock is stale/i.test(a.message))).toBe(true);
    expect(body.verdict).toBe("degraded");
  });

  test("no-recent-success warning: enabled job with no SUCCEEDED run warns", async () => {
    const now = Date.now();
    enableRebuildHealthy(now);
    m.analyticsRebuildRun.findFirst.mockResolvedValue(null); // never succeeded
    m.analyticsRebuildState.findMany.mockResolvedValue([
      { job: "sales", lockedAt: null, heartbeatAt: null, lastError: null },
    ]);

    const body = await (await opsHealthGET(opsReq())).json();
    const sales = body.rebuild.data.jobs.find((j: any) => j.job === "sales");
    expect(sales.lastSuccessAt).toBeNull();
    expect(body.attention.some((a: any) => /no successful rebuild/i.test(a.message))).toBe(true);
  });

  test("heartbeat-stale derivation: enabled + stale heartbeat => heartbeatStale + a negative 'sidecar not running'", async () => {
    const now = Date.now();
    enableRebuildHealthy(now);
    // Heartbeat 3h old (> 2x default 30m tick).
    m.systemSetting.findUnique.mockImplementation(({ where }: any) => {
      if (where.key === "analyticsRebuildEnabled") return Promise.resolve({ value: "true" });
      if (where.key === "analyticsSidecarHeartbeat")
        return Promise.resolve({ value: JSON.stringify({ at: new Date(now - 3 * HOUR).toISOString(), envEnabled: true }) });
      return Promise.resolve(null);
    });

    const body = await (await opsHealthGET(opsReq())).json();
    expect(body.rebuild.data.heartbeatStale).toBe(true);
    expect(body.attention.some((a: any) => a.severity === "negative" && /sidecar not running/i.test(a.message))).toBe(true);
    expect(body.verdict).toBe("failing");
  });

  test("malformed heartbeat JSON is tolerated (no 500): heartbeatStale true, route still 200", async () => {
    const now = Date.now();
    enableRebuildHealthy(now);
    m.systemSetting.findUnique.mockImplementation(({ where }: any) => {
      if (where.key === "analyticsRebuildEnabled") return Promise.resolve({ value: "true" });
      if (where.key === "analyticsSidecarHeartbeat") return Promise.resolve({ value: "{not valid json" });
      return Promise.resolve(null);
    });

    const res = await opsHealthGET(opsReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rebuild.status).toBe("ok");
    expect(body.rebuild.data.sidecarSeenAt).toBeNull();
    expect(body.rebuild.data.heartbeatStale).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Receiving/Labeling overhaul (PK2-12, spec §11): the staging counter SPLITS.
  // `stagingOpenNewFlow` is live work on the new flow; `stagingResidualReceived`
  // is the renamed legacy counter, and a straggler there is a cutover event, not
  // a queue. TWO numbers, TWO rows, NEVER a sum.
  // -------------------------------------------------------------------------

  test("loadPendingReviews counts FOUR things, and the two staging counters use their own predicates", async () => {
    m.stagingItem.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status?.in ? 3 : 1),
    );

    const body = await (await opsHealthGET(opsReq())).json();

    expect(m.stagingItem.count).toHaveBeenCalledTimes(2);
    const predicates = m.stagingItem.count.mock.calls.map((c: any[]) => c[0].where);
    expect(predicates).toContainEqual({ status: { in: ["ORDERED", "VERIFIED", "LABELING"] } });
    expect(predicates).toContainEqual({ status: "RECEIVED" });
    expect(body.pendingReviews.data).toEqual({
      pendingUsers: 0,
      pendingProducts: 0,
      stagingOpenNewFlow: 3,
      stagingResidualReceived: 1,
    });
  });

  test("open new-flow lines are REPORTED, never an attention item (REV-10 clause 7)", async () => {
    m.stagingItem.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status?.in ? 5 : 0),
    );

    const body = await (await opsHealthGET(opsReq())).json();

    // The number is still published — it is the workload figure.
    expect(body.pendingReviews.data.stagingOpenNewFlow).toBe(5);
    // But a busy dock is not a health problem: an ops-health that is amber
    // whenever anybody is receiving something teaches people to ignore amber.
    expect(body.attention.some((a: any) => /receiving lines/i.test(a.message))).toBe(false);
  });

  test("a RESIDUAL received row is a cutover straggler pointing at the runbook, never at /pre-staging", async () => {
    m.stagingItem.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status?.in ? 0 : 2),
    );

    const body = await (await opsHealthGET(opsReq())).json();

    const item = body.attention.find((a: any) => /straggler/i.test(a.message));
    expect(item).toBeDefined();
    expect(item.message).toMatch(/runbook/i);
    expect(item.href).not.toBe("/pre-staging");
    // The two counters are never added together into one message.
    expect(body.attention.some((a: any) => /2 receiving/i.test(a.message))).toBe(false);
  });

  test("both staging counters at zero raise no staging attention at all", async () => {
    m.stagingItem.count.mockResolvedValue(0);

    const body = await (await opsHealthGET(opsReq())).json();

    expect(body.attention).toEqual([]);
    expect(body.verdict).toBe("ok");
  });

  test("live receiving work alone leaves the verdict OK (REV-10 clause 7)", async () => {
    m.stagingItem.count.mockImplementation(({ where }: any) =>
      Promise.resolve(where.status?.in ? 12 : 0),
    );

    const body = await (await opsHealthGET(opsReq())).json();

    expect(body.attention).toEqual([]);
    expect(body.verdict).toBe("ok");
  });

  test("a failing subsystem degrades to unavailable and NEVER 500s the route", async () => {
    m.user.count.mockRejectedValue(new Error("db down")); // sinks loadPendingReviews only

    const res = await opsHealthGET(opsReq());
    expect(res.status).toBe(200); // Promise.allSettled: route never 500s
    const body = await res.json();
    expect(body.pendingReviews.status).toBe("unavailable");
    expect(body.pendingReviews.errorCode).toBe("PENDING_REVIEWS_UNAVAILABLE");
    // The other subsystems still resolved.
    expect(body.integrations.status).toBe("ok");
    expect(body.attention.some((a: any) => /unavailable/i.test(a.message))).toBe(true);
  });

  test("backup volume unreadable => data.volume 'unavailable' + a negative attention (distinct from empty)", async () => {
    listBackupsMock.mockResolvedValue({ status: "unavailable", errorCode: "ENOENT", files: [] });
    const body = await (await opsHealthGET(opsReq())).json();
    expect(body.backups.status).toBe("ok"); // the loader itself did not throw
    expect(body.backups.data.volume).toBe("unavailable");
    expect(body.attention.some((a: any) => a.severity === "negative" && /volume unreadable/i.test(a.message))).toBe(true);
    expect(body.verdict).toBe("failing");
  });

  test("no backups (ok, empty) => a 'none' warning, NOT a negative unreadable state", async () => {
    listBackupsMock.mockResolvedValue({ status: "ok", files: [] });
    const body = await (await opsHealthGET(opsReq())).json();
    expect(body.backups.data.volume).toBe("ok");
    expect(body.backups.data.count).toBe(0);
    expect(body.attention.some((a: any) => a.severity === "warning" && /No database backups/i.test(a.message))).toBe(true);
    expect(body.attention.some((a: any) => a.severity === "negative")).toBe(false);
    expect(body.verdict).toBe("degraded");
  });

  test("parses lastSyncError JSON + surfaces a durable order-sync failure as negative", async () => {
    m.integration.findMany.mockResolvedValue([
      {
        id: "i1",
        name: "Store",
        platform: "SHOPIFY",
        isActive: true,
        lastSyncAt: new Date(),
        lastSyncError: JSON.stringify({ at: "2026-07-10T00:00:00Z", errors: [{ message: "429 rate limited" }], errorCount: 1 }),
        lastStockSyncError: null,
        syncLockedAt: null,
        webhookFailureCount: 0,
        lastWebhookReceivedAt: null,
        company: { name: "Acme" },
      },
    ]);
    const body = await (await opsHealthGET(opsReq())).json();
    expect(body.integrations.data[0].lastSyncError.message).toBe("429 rate limited");
    expect(body.attention.some((a: any) => a.severity === "negative" && /order sync failing/i.test(a.message))).toBe(true);
  });
});

// ===========================================================================
// lib/backup/list — REAL implementation over a real temp dir (no fs mock)
// ===========================================================================

describe("listBackups (real fs)", () => {
  const realListBackups = (jest.requireActual("@/lib/backup/list") as typeof import("@/lib/backup/list")).listBackups;
  let dir: string;
  const prevDir = process.env.BACKUP_DIR;

  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (prevDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = prevDir;
  });

  test("ENOENT (missing volume) => status 'unavailable' with the errno, files [] (distinct from empty)", async () => {
    process.env.BACKUP_DIR = path.join(os.tmpdir(), `nope-${Date.now()}-${Math.random()}`);
    const listing = await realListBackups();
    expect(listing.status).toBe("unavailable");
    expect(listing.errorCode).toBe("ENOENT");
    expect(listing.files).toEqual([]);
  });

  test("empty dir => status 'ok', files [] (NOT unavailable)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "backups-"));
    process.env.BACKUP_DIR = dir;
    const listing = await realListBackups();
    expect(listing.status).toBe("ok");
    expect(listing.files).toEqual([]);
  });

  test("populated dir => .sql/.sql.gz only, newest first with mtimeMs", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "backups-"));
    process.env.BACKUP_DIR = dir;
    await fs.writeFile(path.join(dir, "notes.txt"), "ignore me");
    await fs.writeFile(path.join(dir, "old.sql"), "-- old");
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(path.join(dir, "new.sql.gz"), "gz");

    const listing = await realListBackups();
    expect(listing.status).toBe("ok");
    expect(listing.files.map((f) => f.name)).toEqual(["new.sql.gz", "old.sql"]); // .txt filtered, newest first
    expect(listing.files[0].mtimeMs).toBeGreaterThanOrEqual(listing.files[1].mtimeMs);
  });
});

// ===========================================================================
// POST /api/admin/analytics-rebuild
// ===========================================================================

describe("POST /api/admin/analytics-rebuild", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://x/api/admin/analytics-rebuild", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("records ANALYTICS_REBUILD_TRIGGER before dispatch, then runs sales nightly with source:'manual'", async () => {
    salesMock.mockResolvedValue({ rowsDeleted: 0, rowsInserted: 3, unattributed: 0, skipped: false });

    const res = await rebuildPOST(postReq({ job: "sales", mode: "nightly" }));
    expect(res.status).toBe(200);

    // Audit event recorded (the human TRIGGER; run telemetry stays out of the audit log).
    expect(m.auditLog.create).toHaveBeenCalledTimes(1);
    expect(m.auditLog.create.mock.calls[0][0].data.actionType).toBe("ANALYTICS_REBUILD_TRIGGER");
    expect(m.auditLog.create.mock.calls[0][0].data.entityType).toBe("SYSTEM");

    // Dispatched with manual meta carrying the requesting user.
    expect(salesMock).toHaveBeenCalledWith({ meta: { mode: "nightly", source: "manual", requestedByUserId: 1 } });
  });

  test("snapshots full dispatches with source:'manual' meta", async () => {
    snapshotsMock.mockResolvedValue({ rowsInserted: 1, flaggedPairs: 0, nullLocationCutoff: null, skipped: false });
    await rebuildPOST(postReq({ job: "snapshots", mode: "full" }));
    expect(snapshotsMock).toHaveBeenCalledWith({ meta: { mode: "full", source: "manual", requestedByUserId: 1 } });
  });

  test("invalid CSRF => 403, no dispatch, no audit", async () => {
    (validateCSRFToken as jest.Mock).mockResolvedValue(false);
    const res = await rebuildPOST(postReq({ job: "sales", mode: "nightly" }));
    expect(res.status).toBe(403);
    expect(salesMock).not.toHaveBeenCalled();
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  test("invalid body (bad job) => 400, no dispatch, no audit", async () => {
    const res = await rebuildPOST(postReq({ job: "bogus", mode: "nightly" }));
    expect(res.status).toBe(400);
    expect(salesMock).not.toHaveBeenCalled();
    expect(m.auditLog.create).not.toHaveBeenCalled();
  });

  test("rate-limited: the 6th trigger in the window => 429 (5/user/hr)", async () => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 5555 } }); // fresh rate-limit bucket
    salesMock.mockResolvedValue({ rowsDeleted: 0, rowsInserted: 0, unattributed: 0, skipped: false });

    for (let i = 0; i < 5; i++) {
      const ok = await rebuildPOST(postReq({ job: "sales", mode: "nightly" }));
      expect(ok.status).toBe(200);
    }
    const limited = await rebuildPOST(postReq({ job: "sales", mode: "nightly" }));
    expect(limited.status).toBe(429);
  });
});
