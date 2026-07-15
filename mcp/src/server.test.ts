/**
 * server.test.ts — in-process integration of the sidecar HTTP server (spec D8):
 * health states, generic-401 auth rejection, weighted 429 rate limiting, a real
 * MCP tool round-trip over HTTP, tool parity with the shared tool set, and the
 * disabled-mode start() contract. Prisma is jest-mocked; the MCP transport and the
 * trunk registerMcpTools adapter run for real (both are CJS-requireable).
 */
import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import http from "node:http";
import type { AddressInfo } from "node:net";

// `ai` (v7) is ESM-only with no CJS build, so jest-runtime cannot load it. The
// sidecar path never calls ai's tool() (only registerMcpTools + the shared def.run),
// so stub it. The built-artifact smoke test exercises the REAL `ai` under Node ESM.
jest.mock("ai", () => ({ __esModule: true, tool: (def: unknown) => def }));

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    apiToken: {
      findUnique: jest.fn(),
      update: jest.fn(async () => ({ id: "tok_mock" })),
    },
    userCompany: { findMany: jest.fn(async () => []) },
    assistantRun: { create: jest.fn(async () => ({ id: 1 })) },
    product: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
    product_locations: { findMany: jest.fn(async () => []) },
    systemSetting: { findUnique: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => [{ ok: 1 }]),
  },
}));

import prisma from "@/lib/prisma";
import { createMcpHttpServer, start, mcpPort, isEnabled } from "./server";
import { RateLimiter } from "./rate-limit";
import { assistantTools } from "@/lib/assistant/tools";
import { registerMcpTools } from "@/lib/assistant/tool-adapters";
import { recordAssistantRun } from "@/lib/assistant/telemetry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = prisma;

const VALID_TOKEN = "invmcp_" + "A".repeat(43); // well-shaped: prefix + 43 base64url chars

function echoTokenRecord() {
  // Echo the queried tokenHash back so the constant-time compare passes; live admin owner.
  return async ({ where }: { where: { tokenHash: string } }) => ({
    id: "tok_mock",
    tokenHash: where.tokenHash,
    revokedAt: null,
    ownerUserId: 1,
    owner: { isAdmin: true, isApproved: true, deletedAt: null },
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const MCP_HEADERS = {
  authorization: `Bearer ${VALID_TOKEN}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

function toolCall(id: number, name: string, args: Record<string, unknown>) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

beforeEach(() => {
  p.apiToken.findUnique.mockReset();
  p.apiToken.findUnique.mockImplementation(echoTokenRecord());
  p.apiToken.update.mockReset();
  p.apiToken.update.mockResolvedValue({ id: "tok_mock" });
  p.$queryRaw.mockReset();
  p.$queryRaw.mockResolvedValue([{ ok: 1 }]);
});

describe("GET /healthz", () => {
  it("returns 200 + a healthy report when the db probe succeeds", async () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, db: { ok: true }, encryptionKey: { ok: true } });
    } finally {
      await close(server);
    }
  });

  it("returns 503 when the db probe fails", async () => {
    p.$queryRaw.mockRejectedValue(new Error("db down"));
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(503);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(body.db.ok).toBe(false);
    } finally {
      await close(server);
    }
  });

  it("requires no auth for /healthz", async () => {
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await close(server);
    }
  });
});

describe("POST /mcp — auth", () => {
  it("rejects a missing/malformed Bearer with a generic 401", async () => {
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: toolCall(1, "find_product", { query: "abc" }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ error: "unauthorized" });
      // did NOT reach the tool graph
      expect(p.userCompany.findMany).not.toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("rejects an unknown token with 401", async () => {
    p.apiToken.findUnique.mockResolvedValue(null);
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: toolCall(1, "find_product", { query: "abc" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await close(server);
    }
  });
});

describe("POST /mcp — rate limiting", () => {
  it("returns 429 with a Retry-After once the per-token budget is exceeded", async () => {
    const server = createMcpHttpServer({ rateLimiter: new RateLimiter({ perTokenPerMin: 1, globalPerMin: 1000 }) });
    const port = await listen(server);
    try {
      const first = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: toolCall(1, "find_product", { query: "abc" }),
      });
      expect(first.status).toBe(200);
      const second = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: toolCall(2, "find_product", { query: "abc" }),
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBeTruthy();
      expect(await second.json()).toEqual({ error: "rate_limited" });
    } finally {
      await close(server);
    }
  });
});

describe("POST /mcp — tool round-trip", () => {
  it("executes find_product over MCP Streamable HTTP and returns an ok ToolResult", async () => {
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: toolCall(1, "find_product", { query: "abc" }),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpc = (await res.json()) as any;
      expect(rpc.result).toBeDefined();
      const text = rpc.result.content[0].text as string;
      const toolResult = JSON.parse(text);
      expect(toolResult.status).toBe("ok");
      expect(toolResult.data).toEqual({ products: [], returned: 0, totalRows: 0, nextOffset: null });
      // context was resolved from the token owner + telemetry recorded
      expect(p.userCompany.findMany).toHaveBeenCalled();
      expect(p.assistantRun.create).toHaveBeenCalled();
    } finally {
      await close(server);
    }
  });

  it("returns 405 for non-POST on /mcp and 404 for unknown paths", async () => {
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const get = await fetch(`http://127.0.0.1:${port}/mcp`);
      expect(get.status).toBe(405);
      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await close(server);
    }
  });
});

describe("tool parity", () => {
  it("registers exactly the shared assistantTools keys on the MCP server", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    };
    registerMcpTools(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeServer as any,
      async () => ({ userId: 1, isAdmin: false, companyIds: [], surface: "mcp" as const }),
      recordAssistantRun,
    );
    expect(registered.sort()).toEqual(Object.keys(assistantTools).sort());
  });
});

describe("start() disabled mode", () => {
  const original = process.env.ENABLE_MCP;
  afterEach(() => {
    if (original === undefined) delete process.env.ENABLE_MCP;
    else process.env.ENABLE_MCP = original;
  });

  it("returns null and logs one line when ENABLE_MCP !== '1'", async () => {
    delete process.env.ENABLE_MCP;
    expect(isEnabled()).toBe(false);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const result = await start();
    expect(result).toBeNull();
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("listens when ENABLE_MCP === '1' and honours MCP_PORT", async () => {
    process.env.ENABLE_MCP = "1";
    const originalPort = process.env.MCP_PORT;
    // pick a free ephemeral port
    const probe = http.createServer();
    const freePort = await listen(probe);
    await close(probe);
    process.env.MCP_PORT = String(freePort);
    expect(mcpPort()).toBe(freePort);
    const server = await start();
    expect(server).not.toBeNull();
    try {
      const res = await fetch(`http://127.0.0.1:${freePort}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      if (server) await close(server);
      if (originalPort === undefined) delete process.env.MCP_PORT;
      else process.env.MCP_PORT = originalPort;
    }
  });
});
