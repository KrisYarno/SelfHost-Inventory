/**
 * health.test.ts — /healthz report states (spec D8/D12). Top-level `ok` reflects DB
 * reachability only; the encryption key is reported but never gates ("report, don't
 * die"). Covers key ok/malformed/missing x db up/down.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { randomBytes } from "node:crypto";
import { healthReport, type DbProbe } from "./health";

const dbUp: DbProbe = { $queryRaw: async () => [{ ok: 1 }] };
const dbDown: DbProbe = {
  $queryRaw: async () => {
    throw new Error("connection refused");
  },
};

const originalKey = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64"); // valid 32-byte key
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describe("healthReport", () => {
  it("is ok with a valid key and a reachable db", async () => {
    const report = await healthReport(dbUp);
    expect(report).toEqual({ ok: true, encryptionKey: { ok: true }, db: { ok: true } });
  });

  it("stays ok when the key is malformed but the db is reachable (key never gates)", async () => {
    process.env.ENCRYPTION_KEY = "not-32-bytes";
    const report = await healthReport(dbUp);
    expect(report.ok).toBe(true);
    expect(report.db.ok).toBe(true);
    expect(report.encryptionKey.ok).toBe(false);
    expect(report.encryptionKey.reason).toBeDefined();
  });

  it("reports the key as not-ok when absent, without gating ok", async () => {
    delete process.env.ENCRYPTION_KEY;
    const report = await healthReport(dbUp);
    expect(report.ok).toBe(true);
    expect(report.encryptionKey.ok).toBe(false);
  });

  it("is not ok when the db is unreachable, even with a valid key", async () => {
    const report = await healthReport(dbDown);
    expect(report.ok).toBe(false);
    expect(report.db.ok).toBe(false);
    expect(report.db.reason).toBe("database unreachable");
    expect(report.encryptionKey.ok).toBe(true);
  });
});
