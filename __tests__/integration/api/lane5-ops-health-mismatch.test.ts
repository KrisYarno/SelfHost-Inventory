// @jest-environment node
//
// Lane 5 (P5, codex #12): GET /api/admin/ops-health two-flag misconfig surfacing.
// The sidecar heartbeat carries { at, envEnabled }; the route compares envEnabled
// (environment flag) against the admin/DB toggle and emits a dedicated attention
// item on mismatch in BOTH directions — but ONLY from a FRESH heartbeat with a
// parsed boolean envEnabled (a stale/absent/pre-P5 heartbeat keeps today's
// not-running behavior and fires no mismatch item).
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(() => Promise.resolve({ user: { id: 1 } })),
}));
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
  };
  return { __esModule: true, default: db };
});

import { NextRequest } from "next/server";
import { GET as opsHealthGET } from "@/app/api/admin/ops-health/route";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/api-utils";
import { listBackups } from "@/lib/backup/list";

const m = prisma as unknown as {
  integration: { findMany: jest.Mock };
  user: { count: jest.Mock };
  product: { count: jest.Mock };
  stagingItem: { count: jest.Mock };
  analyticsRebuildState: { findMany: jest.Mock };
  systemSetting: { findUnique: jest.Mock };
  analyticsRebuildRun: { findFirst: jest.Mock; findMany: jest.Mock };
};
const listBackupsMock = listBackups as jest.Mock;

const HOUR = 60 * 60 * 1000;
const ENV_ON_DB_OFF = "Analytics rebuild is enabled in the environment but the admin toggle is off.";
const DB_ON_ENV_OFF = "Analytics rebuild admin toggle is on but the environment flag is off.";

function opsReq(): NextRequest {
  return new NextRequest("http://x/api/admin/ops-health");
}

/** Everything but the rebuild axis healthy + quiet. */
function setBaseHealthy() {
  m.integration.findMany.mockResolvedValue([]);
  m.user.count.mockResolvedValue(0);
  m.product.count.mockResolvedValue(0);
  m.stagingItem.count.mockResolvedValue(0);
  m.analyticsRebuildRun.findMany.mockResolvedValue([]);
  listBackupsMock.mockResolvedValue({ status: "ok", files: [{ name: "b.sql", mtimeMs: Date.now() }] });
  // Two jobs; every job shares the DB toggle. A recent success keeps the
  // no-recent-success warning out of the way of the mismatch assertions.
  m.analyticsRebuildState.findMany.mockResolvedValue([
    { job: "sales", lockedAt: null, heartbeatAt: null, lastError: null },
    { job: "snapshots", lockedAt: null, heartbeatAt: null, lastError: null },
  ]);
  m.analyticsRebuildRun.findFirst.mockResolvedValue({
    finishedAt: new Date(Date.now() - 60_000),
    startedAt: new Date(Date.now() - 120_000),
  });
}

/**
 * Configure the DB toggle + heartbeat payload.
 * @param dbEnabled admin/DB analyticsRebuildEnabled
 * @param env "on" | "off" | "absent" — heartbeat envEnabled boolean, or a pre-P5 payload with no envEnabled
 * @param fresh whether the heartbeat is recent (within 2x tick) or stale
 */
function configure(dbEnabled: boolean, env: "on" | "off" | "absent", fresh: boolean) {
  const now = Date.now();
  const at = new Date(now - (fresh ? 60_000 : 3 * HOUR)).toISOString();
  m.systemSetting.findUnique.mockImplementation(({ where }: any) => {
    if (where.key === "analyticsRebuildEnabled") {
      return Promise.resolve({ value: dbEnabled ? "true" : "false" });
    }
    if (where.key === "analyticsSidecarHeartbeat") {
      const payload = env === "absent" ? { at } : { at, envEnabled: env === "on" };
      return Promise.resolve({ value: JSON.stringify(payload) });
    }
    return Promise.resolve(null);
  });
}

async function attentionMessages(): Promise<string[]> {
  const body = await (await opsHealthGET(opsReq())).json();
  return (body.attention as { message: string }[]).map((a) => a.message);
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 1 } });
  setBaseHealthy();
});

describe("GET /api/admin/ops-health — two-flag misconfig (P5)", () => {
  test("env ON + admin toggle OFF (fresh heartbeat) => the env-on/db-off item", async () => {
    configure(false, "on", true);
    const msgs = await attentionMessages();
    expect(msgs).toContain(ENV_ON_DB_OFF);
    expect(msgs).not.toContain(DB_ON_ENV_OFF);
  });

  test("admin toggle ON + env OFF (fresh heartbeat) => the db-on/env-off item", async () => {
    configure(true, "off", true);
    const msgs = await attentionMessages();
    expect(msgs).toContain(DB_ON_ENV_OFF);
    expect(msgs).not.toContain(ENV_ON_DB_OFF);
  });

  test("both ON (fresh heartbeat) => NO mismatch item", async () => {
    configure(true, "on", true);
    const msgs = await attentionMessages();
    expect(msgs).not.toContain(ENV_ON_DB_OFF);
    expect(msgs).not.toContain(DB_ON_ENV_OFF);
  });

  test("both OFF (fresh heartbeat) => NO mismatch item", async () => {
    configure(false, "off", true);
    const msgs = await attentionMessages();
    expect(msgs).not.toContain(ENV_ON_DB_OFF);
    expect(msgs).not.toContain(DB_ON_ENV_OFF);
  });

  test("stale heartbeat with disagreeing flags => NO mismatch item (falls back to not-running)", async () => {
    configure(false, "on", false); // env on, db off, but heartbeat is 3h old
    const msgs = await attentionMessages();
    expect(msgs).not.toContain(ENV_ON_DB_OFF);
    expect(msgs).not.toContain(DB_ON_ENV_OFF);
  });

  test("pre-P5 heartbeat (no envEnabled field) => NO mismatch item even when fresh", async () => {
    configure(true, "absent", true); // db on, fresh heartbeat, but envEnabled absent => null
    const body = await (await opsHealthGET(opsReq())).json();
    expect(body.rebuild.data.envEnabled).toBeNull();
    const msgs = (body.attention as { message: string }[]).map((a) => a.message);
    expect(msgs).not.toContain(ENV_ON_DB_OFF);
    expect(msgs).not.toContain(DB_ON_ENV_OFF);
  });

  test("mismatch item is surfaced with the Analytics rebuild system + settings href", async () => {
    configure(true, "off", true);
    const body = await (await opsHealthGET(opsReq())).json();
    const item = (body.attention as { message: string; system: string; href: string }[]).find(
      (a) => a.message === DB_ON_ENV_OFF,
    );
    expect(item).toBeDefined();
    expect(item!.system).toBe("Analytics rebuild");
    expect(item!.href).toBe("/admin/settings");
  });
});
