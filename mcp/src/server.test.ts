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
    product: {
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
    },
    product_locations: { findMany: jest.fn(async () => []) },
    systemSetting: { findUnique: jest.fn(async () => null) },
    // Wave-1 breadth tools' read graphs (benign shapes so each def.run completes over
    // the mock): get_valuation / get_movement_series / get_inventory_summary /
    // get_inventory_policy / get_data_freshness.
    inventory_logs: {
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async () => []),
      aggregate: jest.fn(async () => ({ _min: {}, _max: {}, _sum: {}, _count: {} })),
    },
    analyticsRebuildState: { findUnique: jest.fn(async () => null) },
    fulfillmentSyncState: { findMany: jest.fn(async () => []) },
    productStockSnapshot: {
      aggregate: jest.fn(async () => ({ _min: {} })),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    externalOrder: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
    globalReorderSettings: { findUnique: jest.fn(async () => null) },
    location: { findMany: jest.fn(async () => []) },
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
      // find_product now carries a caller-honest coverage block (W0-2 / spec §7).
      expect(toolResult.data).toEqual({
        products: [],
        returned: 0,
        totalRows: 0,
        nextOffset: null,
        coverage: { matched: 0, scope: "approved products; name/baseName/variant match" },
      });
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

describe("POST /mcp — Wave-1 tool round-trips assert REAL payload values (item 4)", () => {
  // Each new tool executes end-to-end over MCP Streamable HTTP against a SEEDED mock and
  // the REAL payload values are asserted on the wire — not just status + a coverage regex.
  // These Wave-1 read delegates carry no per-test reset above, so restore benign defaults
  // here so each seeded round-trip is order-independent.
  beforeEach(() => {
    p.product.findMany.mockReset();
    p.product.findMany.mockResolvedValue([]);
    p.product.findFirst.mockReset();
    p.product.findFirst.mockResolvedValue(null);
    p.product.findUnique.mockReset();
    p.product.findUnique.mockResolvedValue(null);
    p.inventory_logs.findMany.mockReset();
    p.inventory_logs.findMany.mockResolvedValue([]);
    p.inventory_logs.groupBy.mockReset();
    p.inventory_logs.groupBy.mockResolvedValue([]);
    p.fulfillmentSyncState.findMany.mockReset();
    p.fulfillmentSyncState.findMany.mockResolvedValue([]);
    p.product_locations.findMany.mockReset();
    p.product_locations.findMany.mockResolvedValue([]);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function roundTrip(name: string, args: Record<string, unknown>): Promise<any> {
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: toolCall(1, name, args),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpc = (await res.json()) as any;
      expect(rpc.result).toBeDefined();
      return JSON.parse(rpc.result.content[0].text as string);
    } finally {
      await close(server);
    }
  }

  it("get_valuation (total): returned/totalRows/nextOffset envelope (item 6) + a real coverage count", async () => {
    p.product.findMany.mockResolvedValueOnce([
      { id: 1, name: "A", costPrice: null, retailPrice: null, product_locations: [{ locationId: 1, quantity: 10, locations: { name: "Main" } }] },
      { id: 2, name: "B", costPrice: null, retailPrice: null, product_locations: [{ locationId: 1, quantity: 5, locations: { name: "Main" } }] },
    ]);

    const toolResult = await roundTrip("get_valuation", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.groupBy).toBe("total");
    // Envelope consistency (item 6): total carries the same paging shape as other grains.
    expect(toolResult.data.returned).toBe(1);
    expect(toolResult.data.totalRows).toBe(1);
    expect(toolResult.data.nextOffset).toBeNull();
    // Real payload values.
    expect(toolResult.data.rows[0].units).toBe(15);
    expect(toolResult.data.coverage.ofProducts).toBe(2);
    expect(toolResult.data.coverage.ofUnits).toBe(15);
  });

  it("get_movement_series: grain + window.days + one bucket value + net", async () => {
    const when = new Date(Date.now() - 2 * 86_400_000); // inside the default 30-day window
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { delta: -5, changeTime: when, logType: "SALE", reasonCode: null },
    ]);

    const toolResult = await roundTrip("get_movement_series", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.grain).toBe("day");
    expect(toolResult.data.window.days).toBe(30);
    // One bucket value + the derived net (net === SUM of every bucket).
    expect(toolResult.data.totals.sale).toBe(-5);
    expect(toolResult.data.totals.net).toBe(-5);
  });

  it("get_inventory_summary: stockStateCounts census + a ranked metric", async () => {
    // qty 30 => in_stock for any sane default; qty 0 => always out (threshold-independent).
    p.product.findMany.mockResolvedValue([
      { id: 1, name: "A", lowStockThreshold: null, costPrice: null, retailPrice: null, product_locations: [{ locationId: 1, quantity: 30, locations: { name: "Main" } }] },
      { id: 2, name: "B", lowStockThreshold: null, costPrice: null, retailPrice: null, product_locations: [{ locationId: 1, quantity: 0, locations: { name: "Main" } }] },
    ]);

    const toolResult = await roundTrip("get_inventory_summary", { rankBy: "onHand" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.stockStateCounts).toEqual({ in_stock: 1, low: 0, out: 1 });
    // onHand ranked leaderboard: product 1 (30) leads product 2 (0).
    expect(toolResult.data.ranked.rows[0].metric).toBe(30);
  });

  it("get_inventory_policy: a per-field source value (raw override => product_override)", async () => {
    p.product.findFirst.mockResolvedValueOnce({ id: 1, name: "TIRZ" }); // resolveAssistantProduct
    p.product.findUnique.mockResolvedValueOnce({ id: 1, name: "TIRZ", lowStockThreshold: 7, reorderConfig: null });

    const toolResult = await roundTrip("get_inventory_policy", { productId: 1 });
    expect(toolResult.status).toBe("ok");
    // Source is decided from raw-column presence, never equality with the default.
    expect(toolResult.data.product.lowStockThreshold.source).toBe("product_override");
    expect(toolResult.data.product.lowStockThreshold.raw).toBe(7);
    expect(toolResult.data.product.lowStockThreshold.effective).toBe(7);
  });

  it("get_data_freshness: enabled null + the aggregated-integration suffix", async () => {
    const c1 = new Date("2026-07-01T00:00:00.000Z");
    const c2 = new Date("2026-07-10T00:00:00.000Z");
    p.fulfillmentSyncState.findMany.mockResolvedValueOnce([
      { cursorModifiedAt: c2, backfillComplete: true, backfillPage: null, backfillBefore: null },
      { cursorModifiedAt: c1, backfillComplete: false, backfillPage: 3, backfillBefore: c1 },
    ]);

    const toolResult = await roundTrip("get_data_freshness", {});
    expect(toolResult.status).toBe("ok");
    // Enablement is never observable from this process; the suffix discloses the store count.
    expect(toolResult.data.fulfillmentSync.enabled).toBeNull();
    expect(toolResult.data.fulfillmentSync.cursor).toContain("(oldest of 2 integrations)");
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
