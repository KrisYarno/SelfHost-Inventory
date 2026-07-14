/**
 * @jest-environment node
 */

/**
 * Lane 6 T6 — posture visibility + the emergency stop, end to end.
 *
 * Three things this proves:
 *   1. healthz reports the PARSED effective posture, and a malformed env is RED.
 *   2. the admin settings route actually WRITES the kill switch (it would be
 *      silently stripped without the validation allowlist entry — codex #24).
 *   3. engaging the kill switch blocks a would-be-allowed write end to end.
 */

import prisma from "@/lib/prisma";

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    integration: { findUnique: jest.fn() },
    systemSetting: { findUnique: jest.fn(), findMany: jest.fn(), upsert: jest.fn() },
    platformWriteAttempt: { create: jest.fn(), update: jest.fn() },
    location: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordIngestion: jest.fn().mockResolvedValue(true),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/encryption", () => ({
  __esModule: true,
  isEncrypted: jest.fn(() => false),
  decryptValue: jest.fn((v: string) => v),
}));

jest.mock("@/lib/assistant/readiness", () => ({
  __esModule: true,
  encryptionKeyReadiness: jest.fn(() => ({ ready: true })),
}));

jest.mock("@/lib/api-utils", () => ({
  __esModule: true,
  apiHandler: (fn: any) => fn,
  requireAdmin: jest.fn().mockResolvedValue({ user: { id: 1, isAdmin: true } }),
  requireCSRF: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/stock-threshold", () => ({
  __esModule: true,
  getLowStockDefault: jest.fn().mockResolvedValue(10),
}));

const db = prisma as unknown as {
  integration: { findUnique: jest.Mock };
  systemSetting: { findUnique: jest.Mock; findMany: jest.Mock; upsert: jest.Mock };
  platformWriteAttempt: { create: jest.Mock; update: jest.Mock };
  location: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.PLATFORM_WRITES;
  delete process.env.PLATFORM_WRITE_CAPABILITIES;
  db.systemSetting.findUnique.mockResolvedValue(null);
  global.fetch = jest.fn().mockResolvedValue({
    status: 200,
    headers: new Headers(),
    text: async () => "{}",
  } as unknown as Response);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("healthz posture block (codex #16)", () => {
  it("reports OFF when nothing is configured (production default), NOT red", async () => {
    const { GET } = await import("@/app/api/healthz/route");
    const resp = await GET();
    const body = await resp.json();

    expect(body.status).toBe("ok");
    expect(body.platformWrites.effective).toBe("off");
    expect(body.platformWrites.invalidEnv).toBe(false);
    expect(body.platformWrites.label).toBe("Platform writes: OFF");
  });

  it("reports the parsed posture when writes are on", async () => {
    process.env.PLATFORM_WRITES = "on";
    process.env.PLATFORM_WRITE_CAPABILITIES = "stock_status";

    const { GET } = await import("@/app/api/healthz/route");
    const body = await (await GET()).json();

    expect(body.platformWrites.effective).toBe("on");
    expect(body.platformWrites.capabilities).toEqual(["stock_status"]);
    expect(body.platformWrites.label).toBe("Platform writes: ON — stock status only");
  });

  it("goes RED (invalidEnv) on a malformed PLATFORM_WRITES, and falls closed to off", async () => {
    process.env.PLATFORM_WRITES = "onn";

    const { GET } = await import("@/app/api/healthz/route");
    const body = await (await GET()).json();

    expect(body.platformWrites.effective).toBe("off");
    expect(body.platformWrites.invalidEnv).toBe(true);
    expect(body.platformWrites.invalidReasons).toContain("PLATFORM_WRITES");
    expect(body.platformWrites.label).toBe(
      "Platform writes: OFF (configuration not understood)"
    );
  });

  it("reflects the kill switch when it is engaged in the DB", async () => {
    process.env.PLATFORM_WRITES = "on";
    process.env.PLATFORM_WRITE_CAPABILITIES = "stock_status";
    db.systemSetting.findUnique.mockResolvedValue({ value: "true" });

    const { GET } = await import("@/app/api/healthz/route");
    const body = await (await GET()).json();

    expect(body.platformWrites.killSwitchEngaged).toBe(true);
    expect(body.platformWrites.effective).toBe("off");
  });
});

describe("admin settings — the kill switch is not stripped (codex #24)", () => {
  it("WRITES platformWritesKillSwitch (validated + persisted)", async () => {
    const tx = {
      systemSetting: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    db.$transaction.mockImplementation(async (cb: any) => cb(tx));

    const { POST } = await import("@/app/api/admin/settings/route");
    const req = {
      json: async () => ({ platformWritesKillSwitch: true }),
    } as unknown as Request;

    const resp = await POST(req as never);
    expect(resp.status).toBe(200);

    // It reached the DB — i.e. zod did NOT strip it.
    expect(tx.systemSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: "platformWritesKillSwitch" },
        create: { key: "platformWritesKillSwitch", value: "true" },
      })
    );
  });

  it("GET returns the current kill-switch state", async () => {
    db.location.findMany.mockResolvedValue([]);
    db.systemSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where.key === "platformWritesKillSwitch" ? { value: "true" } : null
    );

    const { GET } = await import("@/app/api/admin/settings/route");
    const body = await (await (GET as unknown as () => Promise<Response>)()).json();

    expect(body.platformWritesKillSwitch).toBe(true);
  });
});

describe("kill switch blocks a would-be-allowed write end to end (R-E9)", () => {
  it("engaging the switch turns a fully-allowed stock push into a blocked one", async () => {
    process.env.PLATFORM_WRITES = "on";
    process.env.PLATFORM_WRITE_CAPABILITIES = "stock_status";
    db.integration.findUnique.mockResolvedValue({
      id: "int-1",
      companyId: "co-1",
      name: "Awake",
      platform: "WOOCOMMERCE",
      storeUrl: "https://store.example.com",
      isActive: true,
      stockSyncEnabled: true,
      fulfillmentPushEnabled: true,
      updatedAt: new Date("2026-07-14T00:00:00Z"),
      encryptedWriteKey: "ck",
      encryptedWriteSecret: "cs",
      encryptedReadKey: "rk",
      encryptedReadSecret: "rs",
    });
    db.platformWriteAttempt.create.mockResolvedValue({ id: 1 });
    db.platformWriteAttempt.update.mockResolvedValue({});

    const { pushStockStatus } = await import("@/lib/platforms/egress");

    // 1. Switch OFF -> the push sends.
    db.systemSetting.findUnique.mockResolvedValue(null);
    const allowed = (await pushStockStatus("int-1", [
      { externalProductId: "10", inStock: true },
    ])) as { results: Array<{ status: string }> };
    expect(allowed.results[0].status).toBe("sent");

    // 2. Switch ON -> the very next push blocks, no redeploy, no env change.
    (global.fetch as jest.Mock).mockClear();
    db.systemSetting.findUnique.mockResolvedValue({ value: "true" });
    const blocked = (await pushStockStatus("int-1", [
      { externalProductId: "10", inStock: true },
    ])) as { results: Array<{ status: string; reason?: string }> };

    expect(blocked.results[0].status).toBe("blocked");
    expect(blocked.results[0].reason).toBe("kill_switch");
    expect(global.fetch).toHaveBeenCalledTimes(0);
  });
});
