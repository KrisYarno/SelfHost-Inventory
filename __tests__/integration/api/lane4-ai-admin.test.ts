// @jest-environment node
/**
 * Lane 4 (Task 4 / W2-B) — admin AI panel API contracts (spec D2/D3/D7/D12,
 * §12 D-B7/8/9). Same shared-tx harness as change-tracking-accounts: the mocked
 * `$transaction` hands each handler one `tx` (exposed as `db.__tx`), and the REAL
 * `recordChange` runs against it, so audit assertions are on the ACTUAL payload.
 * Proves: key no-op/replace/remove + routing-dependency guards; once-only token
 * + no-store; token entropy/hash shape; owner validation; revoke + audit; the
 * verify-test hardening matrix (bad scheme/userinfo/redirect/timeout/oversize ->
 * generic failure, key never leaked); routing invariant 400s; diff [REDACTED].
 */
import { NextRequest } from "next/server";
import http from "node:http";
import { createHash } from "node:crypto";

jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return { __esModule: true, ...actual, requireAdmin: jest.fn() };
});

jest.mock("@/lib/csrf", () => ({ validateCSRFToken: jest.fn(async () => true) }));

// Deterministic crypto boundary so no-op/replace/remove are observable and the
// verify test has a known plaintext to assert is never echoed.
jest.mock("@/lib/encryption", () => ({
  __esModule: true,
  encryptValue: jest.fn((v: string) => `ENC(${v})`),
  decryptValue: jest.fn(() => "SAVED-KEY"),
}));

jest.mock("next/headers", () => ({ headers: jest.fn(async () => ({ get: () => null })) }));

jest.mock("@/lib/prisma", () => {
  const tx = {
    aiProvider: { findUnique: jest.fn(), upsert: jest.fn() },
    systemSetting: { findUnique: jest.fn(), upsert: jest.fn() },
    apiToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    aiProvider: { findMany: jest.fn(), findUnique: jest.fn() },
    systemSetting: { findUnique: jest.fn() },
    apiToken: { findMany: jest.fn() },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    __tx: tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { __esModule: true, default: db };
});

import { GET as providersGET } from "@/app/api/admin/ai-providers/route";
import { PUT as providerPUT } from "@/app/api/admin/ai-providers/[kind]/route";
import { POST as providerTEST } from "@/app/api/admin/ai-providers/[kind]/test/route";
import { PUT as routingPUT } from "@/app/api/admin/ai-providers/routing/route";
import { GET as tokensGET, POST as tokensPOST } from "@/app/api/admin/api-tokens/route";
import { POST as revokePOST } from "@/app/api/admin/api-tokens/[id]/revoke/route";
import { requireAdmin } from "@/lib/api-utils";
import { encryptValue } from "@/lib/encryption";
import prisma from "@/lib/prisma";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = prisma as any;
const tx = db.__tx;
const ADMIN = { id: 7, email: "admin@e.com", name: null, isAdmin: true, isApproved: true, defaultLocationId: 1 };

function mkReq(url: string, method: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

function auditRows(): any[] {
  return tx.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
}

function routingValue(kind: string, model: string): string {
  return JSON.stringify({ default: { providerKind: kind, model } });
}

async function withServer(
  handler: http.RequestListener,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  try {
    await fn(port);
  } finally {
    (server as any).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: ADMIN });
  (encryptValue as jest.Mock).mockImplementation((v: string) => `ENC(${v})`);
  // Default: no routing configured.
  tx.systemSetting.findUnique.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// GET providers — hasKey only, never key material
// ---------------------------------------------------------------------------
describe("GET /api/admin/ai-providers", () => {
  it("returns all four kinds with hasKey and NO key material", async () => {
    db.aiProvider.findMany.mockResolvedValue([
      {
        kind: "ANTHROPIC",
        encryptedApiKey: "ENC(secret)",
        baseUrl: null,
        enabledModels: ["m1"],
        isEnabled: true,
        updatedAt: new Date("2026-07-13T00:00:00Z"),
      },
    ]);

    const resp = await providersGET(mkReq("http://t/api/admin/ai-providers", "GET"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.providers).toHaveLength(4);

    const anthropic = body.providers.find((p: any) => p.kind === "ANTHROPIC");
    expect(anthropic.hasKey).toBe(true);
    expect(anthropic.exists).toBe(true);
    expect(anthropic.encryptedApiKey).toBeUndefined();
    const google = body.providers.find((p: any) => p.kind === "GOOGLE");
    expect(google).toMatchObject({ hasKey: false, exists: false, isEnabled: false });

    // No key material anywhere in the serialized response.
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("ENC(");
  });
});

// ---------------------------------------------------------------------------
// PUT provider — key no-op / replace / remove + routing guards
// ---------------------------------------------------------------------------
describe("PUT /api/admin/ai-providers/[kind] — key semantics", () => {
  function existing(overrides: Record<string, unknown> = {}) {
    return {
      kind: "ANTHROPIC",
      encryptedApiKey: "ENC(old)",
      baseUrl: null,
      enabledModels: ["m1"],
      isEnabled: true,
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("absent apiKey is a NO-OP (never touches encryptedApiKey)", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(existing());
    tx.aiProvider.upsert.mockResolvedValue(existing({ enabledModels: ["m1", "m2"] }));

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", { enabledModels: ["m1", "m2"] }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(200);
    expect(encryptValue).not.toHaveBeenCalled();
    const upsertArg = tx.aiProvider.upsert.mock.calls[0][0];
    expect("encryptedApiKey" in upsertArg.update).toBe(false);
    const [row] = auditRows();
    expect(row.actionType).toBe("AI_PROVIDER_UPDATE");
    expect(row.details.changes.enabledModels).toEqual({ from: ["m1"], to: ["m1", "m2"] });
  });

  it("non-empty apiKey REPLACES and diffs the key as [REDACTED]", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(existing());
    tx.aiProvider.upsert.mockResolvedValue(existing({ encryptedApiKey: "ENC(sk-new)" }));

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", { apiKey: "sk-new" }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(200);
    expect(encryptValue).toHaveBeenCalledWith("sk-new");
    const upsertArg = tx.aiProvider.upsert.mock.calls[0][0];
    expect(upsertArg.update.encryptedApiKey).toBe("ENC(sk-new)");
    const [row] = auditRows();
    // The deep-scan collapses the whole denylisted change value to [REDACTED].
    expect(row.details.changes.encryptedApiKey).toBe("[REDACTED]");
    expect(JSON.stringify(row)).not.toContain("sk-new");
    expect(JSON.stringify(row)).not.toContain("ENC(sk-new)");
  });

  it("removeKey while routing depends on the kind is REJECTED (D-B8 message)", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(existing());
    tx.systemSetting.findUnique.mockResolvedValue({ value: routingValue("ANTHROPIC", "m1") });

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", { removeKey: true }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe(
      "Assistant uses this provider. Choose another model in Routing defaults before disabling it.",
    );
    expect(tx.aiProvider.upsert).not.toHaveBeenCalled();
  });

  it("removeKey when NOT routed clears the saved key", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(existing());
    tx.aiProvider.upsert.mockResolvedValue(existing({ encryptedApiKey: null }));

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", { removeKey: true }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(200);
    const upsertArg = tx.aiProvider.upsert.mock.calls[0][0];
    expect(upsertArg.update.encryptedApiKey).toBeNull();
  });

  it("disabling the last-routed provider is blocked inline", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(existing());
    tx.systemSetting.findUnique.mockResolvedValue({ value: routingValue("ANTHROPIC", "m1") });

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", { isEnabled: false }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("Choose another model in Routing defaults");
    expect(tx.aiProvider.upsert).not.toHaveBeenCalled();
  });

  it("enabling with zero models is rejected", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(existing({ enabledModels: [], isEnabled: false }));

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", { isEnabled: true }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain("at least one model");
  });

  it("first save of a kind emits AI_PROVIDER_CREATE", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(null);
    tx.aiProvider.upsert.mockResolvedValue(existing({ encryptedApiKey: "ENC(sk-x)" }));

    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC", "PUT", {
        apiKey: "sk-x",
        enabledModels: ["m1"],
        isEnabled: true,
      }),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    expect(resp.status).toBe(200);
    const [row] = auditRows();
    expect(row.actionType).toBe("AI_PROVIDER_CREATE");
    expect(row.entityId).toBe("ANTHROPIC");
  });

  it("rejects an unknown provider kind", async () => {
    const resp = await providerPUT(
      mkReq("http://t/api/admin/ai-providers/FOO", "PUT", { isEnabled: true }),
      { params: { kind: "FOO" } } as any,
    );
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PUT routing — validateSurfaceConfig invariant 400s + SETTINGS_UPDATE
// ---------------------------------------------------------------------------
describe("PUT /api/admin/ai-providers/routing", () => {
  it("rejects a config referencing a missing/disabled provider (400)", async () => {
    tx.aiProvider.findUnique.mockResolvedValue(null); // provider not configured

    const resp = await routingPUT(
      mkReq("http://t/api/admin/ai-providers/routing", "PUT", {
        default: { providerKind: "ANTHROPIC", model: "m1" },
      }),
    );

    expect(resp.status).toBe(400);
    expect(tx.systemSetting.upsert).not.toHaveBeenCalled();
  });

  it("writes a valid config and records SETTINGS_UPDATE", async () => {
    tx.aiProvider.findUnique.mockResolvedValue({
      kind: "ANTHROPIC",
      isEnabled: true,
      encryptedApiKey: "ENC(x)",
      baseUrl: null,
      enabledModels: ["m1"],
    });
    tx.systemSetting.findUnique.mockResolvedValue(null);
    tx.systemSetting.upsert.mockResolvedValue({});

    const resp = await routingPUT(
      mkReq("http://t/api/admin/ai-providers/routing", "PUT", {
        default: { providerKind: "ANTHROPIC", model: "m1" },
      }),
    );

    expect(resp.status).toBe(200);
    const upsertArg = tx.systemSetting.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ key: "aiSurfaceConfig" });
    const [row] = auditRows();
    expect(row.actionType).toBe("SETTINGS_UPDATE");
    expect(row.details.changes.default.to).toEqual({ providerKind: "ANTHROPIC", model: "m1" });
  });
});

// ---------------------------------------------------------------------------
// Tokens — create (once-only/no-store/entropy/hash) + owner validation + revoke
// ---------------------------------------------------------------------------
describe("POST /api/admin/api-tokens", () => {
  it("mints an invmcp_ token, stores only its sha256, returns it once with no-store", async () => {
    db.user.findUnique.mockResolvedValue({
      id: 5,
      username: "u",
      email: "u@e.com",
      isApproved: true,
      deletedAt: null,
    });
    tx.apiToken.create.mockResolvedValue({
      id: "tok_1",
      name: "Claude Desktop",
      tier: "read",
      createdAt: new Date("2026-07-13T00:00:00Z"),
    });

    const resp = await tokensPOST(
      mkReq("http://t/api/admin/api-tokens", "POST", { name: "Claude Desktop", ownerUserId: 5 }),
    );

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    const body = await resp.json();
    expect(body.token).toMatch(/^invmcp_[A-Za-z0-9_-]+$/);

    // Stored hash is the sha256 hex of the returned plaintext — the plaintext
    // itself is never stored.
    const createArg = tx.apiToken.create.mock.calls[0][0];
    expect(createArg.data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createArg.data.tokenHash).toBe(
      createHash("sha256").update(body.token).digest("hex"),
    );
    expect(createArg.data.tier).toBe("read");

    // Event carries name/tier only — never the token or its hash.
    const [row] = auditRows();
    expect(row.actionType).toBe("API_TOKEN_CREATE");
    expect(row.details).toMatchObject({ name: "Claude Desktop", tier: "read", ownerUserId: 5 });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(body.token);
    expect(serialized).not.toContain(createArg.data.tokenHash);
  });

  it("rejects an unapproved owner (400)", async () => {
    db.user.findUnique.mockResolvedValue({ id: 5, isApproved: false, deletedAt: null });
    const resp = await tokensPOST(
      mkReq("http://t/api/admin/api-tokens", "POST", { name: "x", ownerUserId: 5 }),
    );
    expect(resp.status).toBe(400);
    expect(tx.apiToken.create).not.toHaveBeenCalled();
  });

  it("rejects a soft-deleted owner (400)", async () => {
    db.user.findUnique.mockResolvedValue({ id: 5, isApproved: true, deletedAt: new Date() });
    const resp = await tokensPOST(
      mkReq("http://t/api/admin/api-tokens", "POST", { name: "x", ownerUserId: 5 }),
    );
    expect(resp.status).toBe(400);
  });
});

describe("GET /api/admin/api-tokens", () => {
  it("lists tokens + eligible owners without key material", async () => {
    db.apiToken.findMany.mockResolvedValue([
      {
        id: "tok_1",
        name: "t",
        tier: "read",
        createdAt: new Date(),
        lastUsedAt: null,
        revokedAt: null,
        tokenHash: "deadbeef".repeat(8),
        owner: { id: 5, username: "u", email: "u@e.com", isAdmin: false, _count: { companies: 2 } },
      },
    ]);
    db.user.findMany.mockResolvedValue([{ id: 5, username: "u", email: "u@e.com" }]);

    const resp = await tokensGET(mkReq("http://t/api/admin/api-tokens", "GET"));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.tokens[0]).toMatchObject({ status: "active", access: "2 companies" });
    expect(JSON.stringify(body)).not.toContain("deadbeef");
    expect(body.owners).toHaveLength(1);
  });
});

describe("POST /api/admin/api-tokens/[id]/revoke", () => {
  it("sets revokedAt and records API_TOKEN_REVOKE (name/tier only)", async () => {
    tx.apiToken.findUnique.mockResolvedValue({
      id: "tok_1",
      name: "t",
      tier: "read",
      tokenHash: "abc",
      revokedAt: null,
    });
    tx.apiToken.update.mockResolvedValue({});

    const resp = await revokePOST(
      mkReq("http://t/api/admin/api-tokens/tok_1/revoke", "POST"),
      { params: { id: "tok_1" } } as any,
    );

    expect(resp.status).toBe(200);
    const updateArg = tx.apiToken.update.mock.calls[0][0];
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date);
    const [row] = auditRows();
    expect(row.actionType).toBe("API_TOKEN_REVOKE");
    expect(row.details).toEqual({ name: "t", tier: "read" });
    expect(JSON.stringify(row)).not.toContain("abc");
  });

  it("404s an unknown token id, no event", async () => {
    tx.apiToken.findUnique.mockResolvedValue(null);
    const resp = await revokePOST(mkReq("http://t/api/admin/api-tokens/nope/revoke", "POST"), {
      params: { id: "nope" },
    } as any);
    expect(resp.status).toBe(404);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Verify test — hardening matrix (Ollama) + cloud key never leaks
// ---------------------------------------------------------------------------
describe("POST /api/admin/ai-providers/[kind]/test — Ollama hardening", () => {
  async function runOllama(baseUrl: string | null) {
    db.aiProvider.findUnique.mockResolvedValue({ kind: "OLLAMA", baseUrl, encryptedApiKey: null });
    const resp = await providerTEST(
      mkReq("http://t/api/admin/ai-providers/OLLAMA/test", "POST"),
      { params: { kind: "OLLAMA" } } as any,
    );
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    return resp.json();
  }

  it("rejects a non-http(s) scheme without any network", async () => {
    expect(await runOllama("ftp://example.com/")).toEqual({ ok: false, status: "failed" });
  });

  it("rejects a URL carrying userinfo", async () => {
    expect(await runOllama("http://user:pass@127.0.0.1:1/")).toEqual({
      ok: false,
      status: "failed",
    });
  });

  it("a 200 from /api/tags verifies", async () => {
    await withServer(
      (req, res) => {
        expect(req.url).toBe("/api/tags");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [] }));
      },
      async (port) => {
        expect(await runOllama(`http://127.0.0.1:${port}`)).toEqual({
          ok: true,
          status: "verified",
        });
      },
    );
  });

  it("a redirect (302) fails (redirects disabled)", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(302, { location: "http://127.0.0.1:1/" });
        res.end();
      },
      async (port) => {
        expect(await runOllama(`http://127.0.0.1:${port}`)).toEqual({ ok: false, status: "failed" });
      },
    );
  });

  it("an oversized body (>64KB) fails", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("x".repeat(70 * 1024));
      },
      async (port) => {
        expect(await runOllama(`http://127.0.0.1:${port}`)).toEqual({ ok: false, status: "failed" });
      },
    );
  });

  it("a hung connection times out and fails", async () => {
    await withServer(
      () => {
        /* never respond */
      },
      async (port) => {
        expect(await runOllama(`http://127.0.0.1:${port}`)).toEqual({ ok: false, status: "failed" });
      },
    );
  }, 10000);
});

describe("POST /api/admin/ai-providers/[kind]/test — cloud key never leaves", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("pings with the saved key in the header and never echoes it", async () => {
    db.aiProvider.findUnique.mockResolvedValue({ kind: "ANTHROPIC", encryptedApiKey: "ENC(x)" });
    const fetchMock = jest.fn(async () => ({ ok: true }) as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const resp = await providerTEST(
      mkReq("http://t/api/admin/ai-providers/ANTHROPIC/test", "POST"),
      { params: { kind: "ANTHROPIC" } } as any,
    );

    const body = await resp.json();
    expect(body).toEqual({ ok: true, status: "verified" });
    const headers = (fetchMock.mock.calls[0] as any[])[1].headers;
    expect(headers["x-api-key"]).toBe("SAVED-KEY");
    // The decrypted key never appears in the response.
    expect(JSON.stringify(body)).not.toContain("SAVED-KEY");
  });

  it("a non-200 cloud response fails", async () => {
    db.aiProvider.findUnique.mockResolvedValue({ kind: "OPENAI", encryptedApiKey: "ENC(x)" });
    global.fetch = jest.fn(async () => ({ ok: false }) as Response) as unknown as typeof fetch;

    const resp = await providerTEST(
      mkReq("http://t/api/admin/ai-providers/OPENAI/test", "POST"),
      { params: { kind: "OPENAI" } } as any,
    );
    expect(await resp.json()).toEqual({ ok: false, status: "failed" });
  });

  it("a cloud kind with no saved key fails without a network call", async () => {
    db.aiProvider.findUnique.mockResolvedValue({ kind: "GOOGLE", encryptedApiKey: null });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const resp = await providerTEST(
      mkReq("http://t/api/admin/ai-providers/GOOGLE/test", "POST"),
      { params: { kind: "GOOGLE" } } as any,
    );
    expect(await resp.json()).toEqual({ ok: false, status: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
