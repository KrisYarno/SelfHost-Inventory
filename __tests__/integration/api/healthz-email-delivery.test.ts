/**
 * @jest-environment node
 *
 * N0 (C2f, FV-9) — healthz exposes the email delivery switch: the effective mode,
 * the allowlist COUNT (never an address), invalidEnv + its reasons, and whether a
 * provider key is configured (a boolean, never the key).
 */

jest.mock("@/lib/platforms/egress", () => ({
  __esModule: true,
  getPostureView: jest.fn(async () => ({
    effective: "off",
    capabilities: [],
    killSwitchEngaged: false,
    invalidEnv: false,
    invalidReasons: [],
    label: "Platform writes: OFF",
  })),
}));
jest.mock("@/lib/assistant/readiness", () => ({
  __esModule: true,
  encryptionKeyReadiness: jest.fn(() => ({ ready: true })),
}));

import { GET } from "@/app/api/healthz/route";

const OLD_ENV = process.env;
const KEY = "SG.healthz-never-prints-this-key";

function setEnv(vars: Record<string, string>) {
  process.env = { ...OLD_ENV };
  delete process.env.EMAIL_DELIVERY;
  delete process.env.EMAIL_ALLOWLIST;
  delete process.env.SENDGRID_API_KEY;
  Object.assign(process.env, vars);
}

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => {
  process.env = OLD_ENV;
});

async function emailDelivery() {
  const res = await GET();
  const raw = await res.text();
  return { block: JSON.parse(raw).emailDelivery, raw };
}

describe("healthz emailDelivery", () => {
  it("unset => off, not invalid; providerConfigured false without a key", async () => {
    setEnv({});
    const { block } = await emailDelivery();
    expect(block).toEqual({
      mode: "off",
      allowlistCount: 0,
      invalidEnv: false,
      invalidReasons: [],
      providerConfigured: false,
    });
  });

  it("on + a key => on, providerConfigured true, and the key itself never appears", async () => {
    setEnv({ EMAIL_DELIVERY: "on", SENDGRID_API_KEY: KEY });
    const { block, raw } = await emailDelivery();
    expect(block).toEqual({
      mode: "on",
      allowlistCount: 0,
      invalidEnv: false,
      invalidReasons: [],
      providerConfigured: true,
    });
    expect(raw).not.toContain(KEY);
  });

  it("allowlist => the COUNT only, never an address", async () => {
    setEnv({
      EMAIL_DELIVERY: "allowlist",
      EMAIL_ALLOWLIST: "kris.private@example.com, other.private@example.com",
    });
    const { block, raw } = await emailDelivery();
    expect(block.mode).toBe("allowlist");
    expect(block.allowlistCount).toBe(2);
    expect(raw).not.toMatch(/@example\.com|kris\.private|other\.private/);
  });

  it("a value not understood => off + invalidEnv (red), with the reason", async () => {
    setEnv({ EMAIL_DELIVERY: "On" });
    const { block, raw } = await emailDelivery();
    expect(block).toMatchObject({ mode: "off", invalidEnv: true, invalidReasons: ["EMAIL_DELIVERY"] });
    expect(raw).not.toContain('"On"');
  });

  it("allowlist with an empty list => off + invalidEnv [empty_allowlist]", async () => {
    setEnv({ EMAIL_DELIVERY: "allowlist", EMAIL_ALLOWLIST: " , " });
    const { block } = await emailDelivery();
    expect(block).toMatchObject({ mode: "off", invalidEnv: true, invalidReasons: ["empty_allowlist"] });
  });

  it("the existing blocks are untouched", async () => {
    setEnv({});
    const body = JSON.parse(await (await GET()).text());
    expect(body.status).toBe("ok");
    expect(body.platformWrites.effective).toBe("off");
    expect(body.readiness.encryptionKey).toEqual({ ready: true });
  });
});
