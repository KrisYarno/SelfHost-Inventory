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
      // Wave-2: getReceipts (get_movement_series receipts:true) counts before paging.
      count: jest.fn(async () => 0),
    },
    analyticsRebuildState: { findUnique: jest.fn(async () => null) },
    fulfillmentSyncState: { findMany: jest.fn(async () => []) },
    productStockSnapshot: {
      // Wave-2: get_stock_asof reads _min AND _max for dataStart + watermark.
      aggregate: jest.fn(async () => ({ _min: {}, _max: {} })),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    // Wave-2: compare_periods sales metrics read ProductSalesFact aggregates.
    productSalesFact: { aggregate: jest.fn(async () => ({ _min: {}, _max: {}, _sum: {}, _count: {} })) },
    externalOrder: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      // Wave-2: get_order_pipeline reads orders through the PII allowlist.
      findMany: jest.fn(async () => []),
    },
    // Wave-2: get_order_pipeline reads order items through the PII allowlist.
    externalOrderItem: { findMany: jest.fn(async () => []) },
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
    // W3 seam-fix item 4: freshness is a MIXED-scope read (global rebuild/ledger/snapshot
    // + company-scoped sales/order dates), so meta.scope is "mixed" and coverage carries a
    // machine-readable per-section scope map for the UI legend.
    expect(toolResult.meta.scope).toBe("mixed");
    expect(toolResult.data.coverage.sectionScopes).toEqual({
      rebuild: "global",
      sales: "company",
      fulfillmentSync: "global",
      dataStarts: "mixed",
      snapshots: "global",
    });
  });
});

describe("POST /mcp — Wave-2 tool round-trips assert REAL payload values (item 6)", () => {
  // Each Wave-2 tool executes end-to-end over MCP Streamable HTTP against a SEEDED mock
  // and asserts the real payload values on the wire (seed mock, assert real values — the
  // W1 seam-fix standard). Restore benign defaults so each seeded round-trip is
  // order-independent.
  beforeEach(() => {
    p.userCompany.findMany.mockReset();
    p.userCompany.findMany.mockResolvedValue([]);
    p.product.count.mockReset();
    p.product.count.mockResolvedValue(0);
    p.product.findMany.mockReset();
    p.product.findMany.mockResolvedValue([]);
    p.productStockSnapshot.aggregate.mockReset();
    p.productStockSnapshot.aggregate.mockResolvedValue({ _min: {}, _max: {} });
    p.productStockSnapshot.groupBy.mockReset();
    p.productStockSnapshot.groupBy.mockResolvedValue([]);
    p.analyticsRebuildState.findUnique.mockReset();
    p.analyticsRebuildState.findUnique.mockResolvedValue(null);
    p.inventory_logs.aggregate.mockReset();
    p.inventory_logs.aggregate.mockResolvedValue({ _min: {}, _max: {}, _sum: {}, _count: {} });
    p.inventory_logs.count.mockReset();
    p.inventory_logs.count.mockResolvedValue(0);
    p.inventory_logs.findMany.mockReset();
    p.inventory_logs.findMany.mockResolvedValue([]);
    p.externalOrder.findMany.mockReset();
    p.externalOrder.findMany.mockResolvedValue([]);
    p.externalOrderItem.findMany.mockReset();
    p.externalOrderItem.findMany.mockResolvedValue([]);
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

  it("get_stock_asof: exact-day units + real coverage watermark (global)", async () => {
    p.product.count.mockResolvedValueOnce(1);
    p.product.findMany.mockResolvedValueOnce([{ id: 1, name: "TIRZ" }]);
    p.productStockSnapshot.aggregate.mockResolvedValueOnce({
      _min: { dayKey: "2026-06-01" },
      _max: { dayKey: "2026-06-30" },
    });
    // groupBy is called twice inside the page fetch: day-sum (_sum + _count) then the
    // per-pair span (_max + _min). W2 seam-fix item 1: series-end is the MIN over pairs'
    // maxes, and _count = locations present on day D.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.productStockSnapshot.groupBy.mockImplementation(async (args: any) =>
      args._sum
        ? [{ productId: 1, _sum: { quantity: 42 }, _count: 1 }]
        : [{ productId: 1, locationId: 1, _max: { dayKey: "2026-06-30" }, _min: { dayKey: "2026-06-01" } }],
    );

    const toolResult = await roundTrip("get_stock_asof", { dayKey: "2026-06-15" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.dayKey).toBe("2026-06-15");
    expect(toolResult.data.totalRows).toBe(1);
    // Real exact-day on-hand + the pair's series end (single location present, no partial).
    expect(toolResult.data.rows[0].productId).toBe(1);
    expect(toolResult.data.rows[0].units).toBe(42);
    expect(toolResult.data.rows[0].seriesEndsAt).toBe("2026-06-30");
    expect(toolResult.data.rows[0].pairsPresentOnDay).toBe(1);
    expect(toolResult.data.rows[0].knownPairs).toBe(1);
    // Coverage watermark = later of MAX(dayKey) and lastWindowTo (null here) → 2026-06-30.
    expect(toolResult.data.coverage.snapshotWatermark).toBe("2026-06-30");
    expect(toolResult.data.coverage.snapshotDataStart).toBe("2026-06-01");
  });

  it("get_stock_asof (future dayKey): the module's AppError is masked to a generic TOOL_ERROR (item 7)", async () => {
    // getStockAsOf throws AppError(VALIDATION,400) on a future day. Since the live
    // drive (2026-07-15) our OWN AppError text rides as `hint` (self-correction
    // signal for models); the CODE and status stay masked/generic and no status
    // code or error-class name leaks.
    const toolResult = await roundTrip("get_stock_asof", { dayKey: "2099-01-01" });
    expect(toolResult.status).toBe("error");
    expect(toolResult.code).toBe("TOOL_ERROR");
    expect(toolResult.hint).toBe("snapshots cover completed days only");
    // No AppError internals (status code / class name) leak into the payload.
    expect(JSON.stringify(toolResult)).not.toMatch(/VALIDATION|"400"|AppError/);
  });

  it("compare_periods (outbound_units): server-computed a/b/delta/pctChange + mixed scope", async () => {
    // Call order inside comparePeriods: dataStart (_min), value(periodA) (_sum), value(periodB).
    p.inventory_logs.aggregate
      .mockResolvedValueOnce({ _min: { changeTime: new Date("2026-01-01T00:00:00.000Z") } })
      .mockResolvedValueOnce({ _sum: { delta: -100 } })
      .mockResolvedValueOnce({ _sum: { delta: -150 } });

    const toolResult = await roundTrip("compare_periods", {
      metric: "outbound_units",
      periodA: { relativeDays: 30 },
      periodB: { relativeDays: 30 },
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.meta.scope).toBe("mixed");
    expect(toolResult.data.metric).toBe("outbound_units");
    // |−100| and |−150|, delta and pctChange computed server-side (never by the model).
    expect(toolResult.data.a).toBe(100);
    expect(toolResult.data.b).toBe(150);
    expect(toolResult.data.delta).toBe(50);
    expect(toolResult.data.pctChange).toBe(0.5);
    // W2 seam-fix item 3: machine-readable scopes alongside the prose metricScope.
    expect(toolResult.data.coverage.metricScopes).toEqual({ sales: "company", ledger: "global" });
  });

  it("get_order_pipeline: SEPARATE order revenue vs item units, company-scoped", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]); // ctx.companyIds
    p.externalOrder.findMany.mockResolvedValueOnce([
      {
        id: "o1",
        companyId: "c1",
        integrationId: "i1",
        internalStatus: "pending",
        nativeStatus: "processing",
        total: "12.50",
        currency: "USD",
        externalCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    p.externalOrderItem.findMany.mockResolvedValueOnce([
      { id: "it1", orderId: "o1", quantity: 4, isMapped: true },
    ]);

    const toolResult = await roundTrip("get_order_pipeline", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.meta.scope).toBe("company");
    expect(toolResult.data.groupBy).toBe("status");
    // ORDER section: one pending order at 1250 cents (SUM(total) never joined to items).
    expect(toolResult.data.orders[0].key).toBe("pending");
    expect(toolResult.data.orders[0].orderCount).toBe(1);
    expect(toolResult.data.orders[0].totalCents).toBe(1250);
    // ITEM section: 4 units, a SEPARATE aggregate (a multi-item order never triples revenue).
    expect(toolResult.data.items[0].units).toBe(4);
    expect(toolResult.data.coverage.refundsNote).toBe("refunds are not netted");
  });

  it("get_movement_series receipts:true: STOCK_IN detail rows with frozen cost (global)", async () => {
    p.inventory_logs.count.mockResolvedValueOnce(1);
    p.inventory_logs.findMany.mockResolvedValueOnce([
      {
        productId: 1,
        locationId: 2,
        delta: 20,
        unitCostCents: 500,
        batchId: "B1",
        changeTime: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);

    const toolResult = await roundTrip("get_movement_series", { receipts: true });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.mode).toBe("receipts");
    expect(toolResult.data.totalRows).toBe(1);
    // Real receipt detail: positive delta as quantity, frozen unitCostCents/batchId relayed.
    expect(toolResult.data.rows[0].quantity).toBe(20);
    expect(toolResult.data.rows[0].unitCostCents).toBe(500);
    expect(toolResult.data.rows[0].batchId).toBe("B1");
    expect(toolResult.data.rows[0].locationId).toBe(2);
  });
});

describe("POST /mcp — Wave-3 composite round-trips assert REAL section values", () => {
  // The two composites fan out to many module reads in ONE call; each round-trip seeds
  // those reads and asserts the real composed SECTION values on the wire (seed mock,
  // assert real values — the W1/W2 seam-fix standard) plus meta.scope "mixed".
  beforeEach(() => {
    p.userCompany.findMany.mockReset();
    p.userCompany.findMany.mockResolvedValue([{ companyId: "c1" }]); // ctx.companyIds
    p.product.findFirst.mockReset();
    p.product.findFirst.mockResolvedValue(null);
    p.product.findUnique.mockReset();
    p.product.findUnique.mockResolvedValue(null);
    p.product.findMany.mockReset();
    p.product.findMany.mockResolvedValue([]);
    p.product.count.mockReset();
    p.product.count.mockResolvedValue(0);
    p.product_locations.findMany.mockReset();
    p.product_locations.findMany.mockResolvedValue([]);
    p.location.findMany.mockReset();
    p.location.findMany.mockResolvedValue([]);
    p.inventory_logs.aggregate.mockReset();
    p.inventory_logs.aggregate.mockResolvedValue({ _min: {}, _max: {}, _sum: {}, _count: {} });
    p.inventory_logs.groupBy.mockReset();
    p.inventory_logs.groupBy.mockResolvedValue([]);
    p.inventory_logs.findMany.mockReset();
    p.inventory_logs.findMany.mockResolvedValue([]);
    p.productSalesFact.aggregate.mockReset();
    p.productSalesFact.aggregate.mockResolvedValue({ _sum: {} });
    p.globalReorderSettings.findUnique.mockReset();
    p.globalReorderSettings.findUnique.mockResolvedValue(null);
    p.analyticsRebuildState.findUnique.mockReset();
    p.analyticsRebuildState.findUnique.mockResolvedValue(null);
    p.fulfillmentSyncState.findMany.mockReset();
    p.fulfillmentSyncState.findMany.mockResolvedValue([]);
    p.productStockSnapshot.aggregate.mockReset();
    p.productStockSnapshot.aggregate.mockResolvedValue({ _min: {}, _max: {} });
    p.externalOrder.findFirst.mockReset();
    p.externalOrder.findFirst.mockResolvedValue(null);
    p.externalOrder.count.mockReset();
    p.externalOrder.count.mockResolvedValue(0);
    p.externalOrder.findMany.mockReset();
    p.externalOrder.findMany.mockResolvedValue([]);
    p.externalOrderItem.findMany.mockReset();
    p.externalOrderItem.findMany.mockResolvedValue([]);
    p.systemSetting.findUnique.mockReset();
    p.systemSetting.findUnique.mockResolvedValue(null);
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

  it("get_product_overview: composed sections + mixed scope + company-scoped sales section", async () => {
    p.product.findFirst.mockResolvedValueOnce({ id: 1, name: "TIRZ 30" }); // resolveAssistantProduct
    // identity + getPolicy both read product.findUnique; one shape satisfies both selects.
    p.product.findUnique.mockResolvedValue({
      id: 1, name: "TIRZ 30", baseName: "TIRZ", variant: "30", lowStockThreshold: null,
      reorderConfig: null, product_locations: [{ quantity: 12 }],
    });
    p.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 12 }]);
    p.location.findMany.mockResolvedValue([{ id: 1, name: "Main" }]);
    // velocity: |−60| over ~20 covered days => a positive units/day rate.
    p.inventory_logs.aggregate.mockResolvedValueOnce({
      _sum: { delta: -60 },
      _min: { changeTime: new Date(Date.now() - 20 * 86_400_000) },
    });
    p.productSalesFact.aggregate.mockResolvedValue({ _sum: { orderedQty: 40, revenue: "1234.50" } });

    const toolResult = await roundTrip("get_product_overview", { productId: 1 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.meta.scope).toBe("mixed"); // spec §6 — sales section company-scoped
    expect(toolResult.data.productId).toBe(1);
    // identity: 12 on hand, in_stock (null threshold => system default).
    expect(toolResult.data.identity.currentStock).toBe(12);
    expect(toolResult.data.identity.stockState).toBe("in_stock");
    // velocity: real outbound units + a positive contract rate + the definition string.
    expect(toolResult.data.velocity.unitsOut30).toBe(60);
    expect(toolResult.data.velocity.usageKnown).toBe(true);
    expect(toolResult.data.velocity.avgDailyOutbound).toBeGreaterThan(0);
    expect(typeof toolResult.data.velocity.velocityDefinition).toBe("string");
    // sales30 is COMPANY-scoped and carries the seeded ordered units.
    expect(toolResult.data.sales30.scope).toBe("company");
    expect(toolResult.data.sales30.orderedUnits).toBe(40);
    // top-level coverage maps each section's scope; nothing degraded here.
    expect(toolResult.data.coverage.sectionScopes.sales30).toBe("company");
    expect(toolResult.data.coverage.sectionScopes.velocity).toBe("global");
    expect(toolResult.data.coverage.degradedSections).toEqual([]);
  });

  it("get_business_snapshot: KPIs + reorder-now + company-scoped sales/pipeline + mixed scope", async () => {
    // One catalog product read shared by inventory-summary + valuation + reorder.
    p.product.findMany.mockResolvedValue([
      {
        id: 1, name: "A", lowStockThreshold: null, costPrice: null, retailPrice: null,
        reorderConfig: null, product_locations: [{ locationId: 1, quantity: 30, locations: { name: "Main" } }],
      },
    ]);
    p.productSalesFact.aggregate.mockResolvedValue({ _sum: { orderedQty: 40, revenue: "500.00" } });
    p.externalOrder.findMany.mockResolvedValue([
      {
        id: "o1", companyId: "c1", integrationId: "i1", internalStatus: "pending",
        nativeStatus: "processing", total: "12.50", currency: "USD",
        externalCreatedAt: new Date("2026-07-01T00:00:00.000Z"), createdAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    p.externalOrderItem.findMany.mockResolvedValue([{ id: "it1", orderId: "o1", quantity: 9, isMapped: true }]);

    const toolResult = await roundTrip("get_business_snapshot", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.meta.scope).toBe("mixed");
    // inventory KPIs (global): 30 on hand, in_stock census.
    expect(toolResult.data.inventory.scope).toBe("global");
    expect(toolResult.data.inventory.unitsOnHand).toBe(30);
    expect(toolResult.data.inventory.stockStateCounts.in_stock).toBe(1);
    // reorder-now count comes from the worklist coverage (no demand => 0 suggested).
    expect(toolResult.data.reorderNow.reorderNowCount).toBe(0);
    // sales (company-scoped): the seeded 30d ordered units.
    expect(toolResult.data.sales.scope).toBe("company");
    expect(toolResult.data.sales.last30d.orderedUnits).toBe(40);
    // order pipeline (company-scoped): one pending order at 1250 cents, 9 item units separate.
    expect(toolResult.data.orderPipeline.scope).toBe("company");
    expect(toolResult.data.orderPipeline.byStatus[0].orderCount).toBe(1);
    expect(toolResult.data.orderPipeline.byStatus[0].totalCents).toBe(1250);
    expect(toolResult.data.coverage.sectionScopes.sales).toBe("company");
  });
});

describe("POST /mcp — tools/list advertised schema shape (item 8)", () => {
  it("compare_periods advertises nested periodA/periodB object schemas with from/to/relativeDays", async () => {
    const server = createMcpHttpServer();
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(200);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rpc = (await res.json()) as any;
      const tools = rpc.result.tools as Array<{ name: string; inputSchema: any }>;
      const cmp = tools.find((t) => t.name === "compare_periods");
      expect(cmp).toBeDefined();
      const root = cmp!.inputSchema;
      const props = root.properties;
      // The JSON-Schema converter dedups identical sub-schemas into a local `$ref`
      // (periodB → periodA), so resolve a `{ $ref: "#/a/b" }` node against the root.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolve = (node: any): any => {
        if (node && node.$ref) {
          const segs = String(node.$ref).replace(/^#\//, "").split("/");
          let cur = root;
          for (const s of segs) cur = cur[s];
          return cur;
        }
        return node;
      };
      // metric + the two nested period objects are advertised at the top level.
      expect(props.metric).toBeDefined();
      // periodA/periodB are NESTED object schemas, not scalars — the shape pin: a
      // consumer (or the model) sees the {from,to,relativeDays} structure it must fill.
      for (const key of ["periodA", "periodB"]) {
        expect(props[key]).toBeDefined();
        const period = resolve(props[key]);
        expect(period.type).toBe("object");
        expect(period.properties).toBeDefined();
        expect(period.properties.from).toBeDefined();
        expect(period.properties.to).toBeDefined();
        expect(period.properties.relativeDays).toBeDefined();
      }
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
