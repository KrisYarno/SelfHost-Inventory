// @jest-environment node
/**
 * admin/backup POST on a FAILED mysqldump: the `error` string the GUI alerts
 * carries the first meaningful stderr line (never just the exit code), the
 * MariaDB client's deprecation notice + TLS warning are skipped, and the full
 * stderr still rides `details`. Regression for the 2026-08-19 "mysqldump failed
 * (code 2)" report, whose cause (a missing caching_sha2_password client plugin)
 * was invisible from the browser.
 */
import { NextRequest } from "next/server";

process.env.DATABASE_URL = "mysql://user:pass@localhost:3306/testdb";

jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn(), requireApproved: jest.fn() };
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
jest.mock("next/headers", () => ({
  headers: jest.fn(async () => ({ get: () => null })),
}));

let stderrForRun = "";
const STDERR =
  "mysqldump: Deprecated program name. It will be removed in a future release, use '/usr/bin/mariadb-dump' instead\n" +
  "WARNING: option --ssl-verify-server-cert is disabled, because of an insecure passwordless login.\n" +
  'mysqldump: Got error: 1045: "Plugin caching_sha2_password could not be loaded: Error loading shared library /usr/lib/mariadb/plugin/caching_sha2_password.so: No such file or directory" when trying to connect\n';

jest.mock("node:child_process", () => {
  const actual = jest.requireActual("node:child_process");
  return {
    ...actual,
    spawn: jest.fn(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory scope (the admin-config suite's idiom)
      const { EventEmitter } = require("node:events");
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stderr.emit("data", Buffer.from(stderrForRun));
        proc.emit("close", 2);
      });
      return proc;
    }),
  };
});
jest.mock("node:fs", () => {
  const actual = jest.requireActual("node:fs");
  return {
    ...actual,
    promises: { ...actual.promises, mkdir: jest.fn(async () => undefined), writeFile: jest.fn(async () => undefined) },
  };
});
jest.mock("@/lib/prisma", () => {
  const tx = { auditLog: { create: jest.fn() } };
  const db = { __tx: tx, $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { __esModule: true, default: db };
});

import { POST as backupPOST } from "@/app/api/admin/backup/route";
import { requireAdmin } from "@/lib/api-utils";
import { spawn } from "node:child_process";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ADMIN = { id: 7, email: "a@e.com", isAdmin: true, isApproved: true };

describe("admin/backup POST — a failing mysqldump names its cause", () => {
  beforeEach(() => {
    (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
    (spawn as jest.Mock).mockClear();
    stderrForRun = STDERR;
  });

  it("all-noise stderr falls back to the bare code message (never an empty suffix)", async () => {
    stderrForRun = STDERR.split("\n").slice(0, 2).join("\n") + "\n";
    const req = new NextRequest("http://t/api/admin/backup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "x" },
    });
    const res = await backupPOST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("mysqldump failed (code 2)");
  });

  it("500 with error = code + the first meaningful stderr line; details = full stderr; no audit row", async () => {
    const req = new NextRequest("http://t/api/admin/backup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "x" },
    });
    const res = await backupPOST(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe(
      'mysqldump failed (code 2): Got error: 1045: "Plugin caching_sha2_password could not be loaded: Error loading shared library /usr/lib/mariadb/plugin/caching_sha2_password.so: No such file or directory" when trying to connect',
    );
    expect(body.details).toBe(STDERR);
    // The route retries once without --routines/--events before giving up.
    expect((spawn as jest.Mock).mock.calls).toHaveLength(2);
    expect((prisma as any).__tx.auditLog.create).not.toHaveBeenCalled();
  });
});
