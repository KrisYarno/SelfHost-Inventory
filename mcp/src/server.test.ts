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
    // A2 M4 (pack C7): the sales rebuild run history (the freshness note + lastSucceededAt).
    analyticsRebuildRun: { findMany: jest.fn(async () => []) },
    fulfillmentSyncState: { findMany: jest.fn(async () => []) },
    productStockSnapshot: {
      // Wave-2: get_stock_asof reads _min AND _max for dataStart + watermark.
      aggregate: jest.fn(async () => ({ _min: {}, _max: {} })),
      groupBy: jest.fn(async () => []),
      findMany: jest.fn(async () => []),
    },
    // Wave-2: compare_periods sales metrics read ProductSalesFact aggregates.
    // quality+reach W1 (Task 1.1): get_sales groups facts BY product — the wire
    // assertion for productScope needs real rows beside the echo.
    productSalesFact: {
      aggregate: jest.fn(async () => ({ _min: {}, _max: {}, _sum: {}, _count: {} })),
      groupBy: jest.fn(async () => []),
    },
    externalOrder: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      // Wave-2: get_order_pipeline reads orders through the PII allowlist.
      findMany: jest.fn(async () => []),
      // A2 FR1 (pack C14): the reorder order signal's stores (integrationIds of the
      // caller's own orders — never the Integration table).
      groupBy: jest.fn(async () => []),
    },
    // Wave-2: get_order_pipeline reads order items through the PII allowlist.
    externalOrderItem: { findMany: jest.fn(async () => []) },
    globalReorderSettings: { findUnique: jest.fn(async () => null) },
    // A2 M3 (pack C8 / C9): get_stock_asof resolves a locationId and the movement filters
    // echo names its location (findUnique); the per-company sales coverage names each of
    // the caller's companies (company.findMany, { id, name } only).
    location: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
    company: { findMany: jest.fn(async () => []) },
    // A2 FR1 (pack C14): the listings that make a no-fact product LINKED.
    productLink: { findMany: jest.fn(async () => []) },
    bundleComponent: { findMany: jest.fn(async () => []) },
    // Reconciliation lane (pack C5.1): get_order_reconciliation reads the recording
    // boundary through orderAttributionAttempt and the drill-down reads audit_logs.
    // Mirrored EXACTLY in mcp/src/prisma-mock.ts — the parity test at the bottom of this
    // file compares the two method sets, which is the only thing that keeps the SHIPPED
    // bundle from 500ing on a tool every suite here says is green.
    orderAttributionAttempt: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    auditLog: { findMany: jest.fn(async () => []) },
    $queryRaw: jest.fn(async () => [{ ok: 1 }]),
  },
}));

import prisma from "@/lib/prisma";
import { createMcpHttpServer, start, mcpPort, isEnabled } from "./server";
import { RateLimiter } from "./rate-limit";
import { assistantTools } from "@/lib/assistant/tools";
import { registerMcpTools } from "@/lib/assistant/tool-adapters";
import { recordAssistantRun } from "@/lib/assistant/telemetry";
// The tsup MCP_BUILD_MOCK stand-in, imported ONLY to compare its surface (Task 2.6).
import prismaMock from "./prisma-mock";

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
        // A2 pack C1: the rows after this page (none on an empty last page).
        remainingRows: 0,
        // G2-6: identityMisses rides on every find_product coverage block (0 is the
        // normal reading; it is a defined field, never a conditional one).
        coverage: {
          matched: 0,
          scope: "approved products; name/baseName/variant match",
          identityMisses: 0,
        },
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

describe("POST /mcp — quality+reach W1 round-trips (scope echoes / coverage additions)", () => {
  // MCP parity is PER-TASK: every payload change lands its wire assertion here, over the
  // inline mock, with REAL values (never a status-only smoke). Task 1.1 owns the four
  // scope-echo payloads; 1.3/1.4/1.5 append their coverage/derivation assertions.
  beforeEach(() => {
    p.userCompany.findMany.mockReset();
    p.userCompany.findMany.mockResolvedValue([]);
    p.product.findMany.mockReset();
    p.product.findMany.mockResolvedValue([]);
    p.product.findFirst.mockReset();
    p.product.findFirst.mockResolvedValue(null);
    p.product.findUnique.mockReset();
    p.product.findUnique.mockResolvedValue(null);
    p.productSalesFact.groupBy.mockReset();
    p.productSalesFact.groupBy.mockResolvedValue([]);
    // Task 2.2 owns this one: get_sales' coverage now reads salesDataStart through
    // productSalesFact.aggregate, so it must be per-test isolated like the rest.
    p.productSalesFact.aggregate.mockReset();
    p.productSalesFact.aggregate.mockResolvedValue({ _min: {}, _max: {}, _sum: {}, _count: {} });
    p.externalOrder.count.mockReset();
    p.externalOrder.count.mockResolvedValue(0);
    p.inventory_logs.findMany.mockReset();
    p.inventory_logs.findMany.mockResolvedValue([]);
    p.inventory_logs.groupBy.mockReset();
    p.inventory_logs.groupBy.mockResolvedValue([]);
    p.inventory_logs.aggregate.mockReset();
    p.inventory_logs.aggregate.mockResolvedValue({ _min: {}, _max: {}, _sum: {}, _count: {} });
    p.inventory_logs.count.mockReset();
    p.inventory_logs.count.mockResolvedValue(0);
    p.analyticsRebuildState.findUnique.mockReset();
    p.analyticsRebuildState.findUnique.mockResolvedValue(null);
    p.systemSetting.findUnique.mockReset();
    p.systemSetting.findUnique.mockResolvedValue(null);
    p.globalReorderSettings.findUnique.mockReset();
    p.globalReorderSettings.findUnique.mockResolvedValue(null);
    // A2 M3: the location resolve / echo and the company names, isolated per test too.
    p.location.findUnique.mockReset();
    p.location.findUnique.mockResolvedValue(null);
    p.company.findMany.mockReset();
    p.company.findMany.mockResolvedValue([]);
    // A2 M4: the sales rebuild run history, isolated per test.
    p.analyticsRebuildRun.findMany.mockReset();
    p.analyticsRebuildRun.findMany.mockResolvedValue([]);
    p.product.count.mockReset();
    p.product.count.mockResolvedValue(0);
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

  it("get_sales: productScope echoes the RESOLVED product identity on the wire (C4)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]); // ctx.companyIds
    p.product.findFirst.mockResolvedValueOnce({ id: 7, name: "TIRZ 10mg" }); // resolver
    p.productSalesFact.groupBy.mockResolvedValueOnce([
      { productId: 7, _sum: { orderedQty: 12, revenue: "24.00", orderCount: 3 } },
    ]);
    p.product.findMany.mockResolvedValueOnce([{ id: 7, name: "TIRZ 10mg" }]); // row names

    const toolResult = await roundTrip("get_sales", { productId: 7, groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.productScope).toEqual({
      productId: 7,
      name: "TIRZ 10mg",
      note: "covers ONLY this product — not evidence about any other product",
    });
    // The scope echo sits beside REAL rows, not an empty payload.
    expect(toolResult.data.rows[0].productId).toBe(7);
  });

  it("get_sales: productScope is null for a catalog-wide call", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    const toolResult = await roundTrip("get_sales", { groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data).toHaveProperty("productScope");
    expect(toolResult.data.productScope).toBeNull();
  });

  it("get_sales: coverage carries the totalOrders DENOMINATOR + attributionNote (C7)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    // The two counts are siblings on ONE delegate: unattributed first, total second.
    p.externalOrder.count.mockResolvedValueOnce(319).mockResolvedValueOnce(2331);

    const toolResult = await roundTrip("get_sales", { groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.coverage.unattributedOrders).toBe(319);
    expect(toolResult.data.coverage.totalOrders).toBe(2331);
    expect(toolResult.data.coverage.attributionNote).toContain(
      "unattributedOrders of totalOrders company-scoped orders (all time)",
    );
    // The denominator is company-scoped and UNWINDOWED (no isMapped, no date range).
    expect(p.externalOrder.count.mock.calls[1][0]).toEqual({
      where: { companyId: { in: ["c1"] } },
    });
  });

  it("get_movement_series: mode 'series' + filters echo, filters.mode === mode (T4)", async () => {
    const when = new Date(Date.now() - 2 * 86_400_000);
    p.product.findFirst.mockResolvedValueOnce({ id: 3, name: "P" });
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { delta: -5, changeTime: when, logType: "SALE", reasonCode: null },
    ]);
    p.location.findUnique.mockResolvedValueOnce({ name: "Back room" });

    const toolResult = await roundTrip("get_movement_series", { productId: 3, locationId: 2 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.mode).toBe("series");
    // A2 C8: a location-scoped echo names its location.
    expect(toolResult.data.filters).toEqual({
      productId: 3,
      productIds: null,
      locationId: 2,
      locationName: "Back room",
      mode: "series",
    });
    // A2 C10: no reason-less outbound row in the window -> no unclassified-outbound note.
    expect(toolResult.data.coverage).not.toHaveProperty("unclassifiedLegacyNote");
    expect(toolResult.data.filters.mode).toBe(toolResult.data.mode);
    expect(toolResult.data.totals.sale).toBe(-5);
  });

  it("get_movement_series receipts:true: mode 'receipts' + the SAME filters echo (T4)", async () => {
    p.product.findFirst.mockResolvedValueOnce({ id: 3, name: "P" });
    p.inventory_logs.count.mockResolvedValueOnce(1);
    p.inventory_logs.findMany.mockResolvedValueOnce([
      {
        productId: 3,
        locationId: 2,
        locations: { name: "Back room" },
        delta: 20,
        unitCostCents: 500,
        batchId: "B1",
        changeTime: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    p.location.findUnique.mockResolvedValueOnce({ name: "Back room" });

    const toolResult = await roundTrip("get_movement_series", {
      productId: 3,
      locationId: 2,
      receipts: true,
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.mode).toBe("receipts");
    expect(toolResult.data.filters).toEqual({
      productId: 3,
      productIds: null,
      locationId: 2,
      locationName: "Back room",
      mode: "receipts",
    });
    expect(toolResult.data.filters.mode).toBe(toolResult.data.mode);
    expect(toolResult.data.rows[0].quantity).toBe(20);
    // A2 C8 / C10: the row names its location; the definition carries no design reference.
    expect(toolResult.data.rows[0].locationName).toBe("Back room");
    expect(toolResult.data.definitions.receiptEvent).toBe(
      "a receipt event = one stock-in batch; a five-batch delivery is five events",
    );
  });

  it("get_operations: scope echoes the REAL windowDays (default 90, explicit 30)", async () => {
    const dflt = await roundTrip("get_operations", {});
    expect(dflt.status).toBe("ok");
    expect(dflt.data.scope).toEqual({ productId: null, windowDays: 90 });

    p.product.findFirst.mockResolvedValueOnce({ id: 4, name: "P" });
    const scoped = await roundTrip("get_operations", { productId: 4, windowDays: 30 });
    expect(scoped.status).toBe("ok");
    expect(scoped.data.scope).toEqual({ productId: 4, windowDays: 30 });
  });

  it("get_shrinkage: scope echoes the REAL days window", async () => {
    const toolResult = await roundTrip("get_shrinkage", { days: 365 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.scope).toEqual({ days: 365 });
  });

  it("reorder_report: the six-bucket coverage + coverageNote reach the wire (C5)", async () => {
    // Two approved-active products; only one is emitted, so `healthy` is the field that
    // proves the accounting (the old block would have shown total 2 / suggested 0 /
    // unavailable 1 and silently lost the second product).
    p.product.findMany.mockResolvedValueOnce([
      { id: 1, name: "A NoDemand", costPrice: null, product_locations: [{ quantity: 3 }], reorderConfig: null },
      { id: 2, name: "B Healthy", costPrice: null, product_locations: [{ quantity: 1000 }], reorderConfig: null },
    ]);
    // Product 2 has a real demand signal (>= the default minEvidenceEvents of 3) but
    // stock far above 1.2x its reorder point => FINAL urgency null => healthy.
    const recent = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { productId: 2, delta: -1, changeTime: recent(3), logType: "SALE", reasonCode: null },
      { productId: 2, delta: -1, changeTime: recent(2), logType: "SALE", reasonCode: null },
      { productId: 2, delta: -1, changeTime: recent(1), logType: "SALE", reasonCode: null },
    ]);

    const toolResult = await roundTrip("reorder_report", {});
    expect(toolResult.status).toBe("ok");
    // A2 (pack C4/C5) adds labelled keys BESIDE the six buckets; the buckets are unchanged.
    const {
      costedNote,
      orderSignalWindow,
      orderSignalCoverage,
      orderSignalReasons,
      sectionScopes,
      orderSignalDefinition,
      ...buckets
    } = toolResult.data.coverage;
    expect(buckets).toEqual({
      total: 2,
      suggested: 0,
      unavailable: 1, // product 1: no_demand_signal
      healthy: 1, // product 2: final urgency null, not emitted
      approachingOmitted: 0,
      costed: 0,
    });
    expect(costedNote).toContain("costed counts the suggested rows that have a cost price");
    expect(orderSignalWindow.days).toBe(90);
    expect(orderSignalCoverage).toBe("none"); // this token's owner has no companies
    // A2 C14: the unsized row's short reason code, explained once.
    expect(orderSignalReasons).toEqual({ no_company_access: "no company access" });
    expect(sectionScopes).toEqual({ rows: "global", orderSignal: "company" });
    expect(orderSignalDefinition).toContain("never used to suggest a quantity");
    expect(toolResult.data.coverageNote).toContain("healthy = none of the urgency tiers applies");
    // The NORMATIVE invariant, asserted on the wire payload itself.
    const c = toolResult.data.coverage;
    expect(c.suggested + c.unavailable + c.healthy + c.approachingOmitted).toBe(c.total);
  });

  // Assistant A2 (pack C4, C2, C5): the order signal on the wire, for a caller WITH a
  // company — the out-of-stock product still being ordered is flagged with its recorded
  // figures, never a quantity, and listed in the envelope.
  it("reorder_report: the order signal, counts and definitions reach the wire (A2 C4/C2/C5)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    // One delegate, two reads: the reorder population (selects product_locations) and the
    // order signal's approved-active scope (selects id).
    p.product.findMany.mockImplementation(async (args: Record<string, unknown>) => {
      const select = (args.select ?? {}) as { product_locations?: unknown };
      return select.product_locations
        ? [
            { id: 5, name: "CJC/IPA 10mg", costPrice: null, product_locations: [{ quantity: 0 }], reorderConfig: null },
            { id: 6, name: "Shelf Sitter", costPrice: null, product_locations: [{ quantity: 4 }], reorderConfig: null },
            // A2 FR1: out of stock, no fact row, no listing on the caller's store.
            { id: 7, name: "Unlinked Lot", costPrice: null, product_locations: [{ quantity: 0 }], reorderConfig: null },
          ]
        : [{ id: 5 }, { id: 6 }, { id: 7 }];
    });
    // A2 FR1 (pack C14): c1's one store (from its orders) lists product 6, not product 7; 4
    // orders in the window carry a line on an unlinked listing.
    p.externalOrder.groupBy.mockResolvedValueOnce([{ integrationId: "store-c1" }]);
    p.productLink.findMany.mockResolvedValueOnce([{ internalProductId: 6 }]);
    p.externalOrder.count.mockResolvedValueOnce(4);
    // c1 has recorded since 2019 => full coverage: silence is a measured zero.
    p.productSalesFact.aggregate.mockResolvedValue({ _min: { dayKey: "2019-01-01" } });
    p.productSalesFact.groupBy.mockImplementation(async (args: Record<string, unknown>) =>
      (args.by as string[])[0] === "companyId"
        ? [{ companyId: "c1", _min: { dayKey: "2019-01-01" } }]
        : [{ productId: 5, _sum: { orderedQty: 14, orderCount: 7 } }],
    );

    const toolResult = await roundTrip("reorder_report", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.meta.scope).toBe("mixed");
    const data = toolResult.data;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = Object.fromEntries((data.rows as any[]).map((r) => [r.productId, r]));
    expect(byId[5]).toEqual({
      status: "unavailable",
      productId: 5,
      productName: "CJC/IPA 10mg",
      currentStock: 0,
      reason: "no_demand_signal",
      orderSignal: { orderedUnits: 14, orders: 7 },
      outOfStockWithOrders: true,
    });
    expect(byId[6]).toMatchObject({ orderSignal: { orderedUnits: 0, orders: 0 }, outOfStockWithOrders: false });
    // A2 C14: unlinked -> unknown, never a measured 0; the code is explained once.
    expect(byId[7]).toMatchObject({ orderSignal: null, orderSignalReason: "not_linked", outOfStockWithOrders: null });
    expect(data.coverage.orderSignalReasons).toEqual({
      not_linked: "not linked to a store listing in your companies, so its orders cannot be attributed",
    });
    expect(data.coverage.orderSignalUnlinkedOrders).toBe(4);
    expect(data.coverage.orderSignalUnlinkedNote).toContain("4 orders in this window");
    expect(data.outOfStockWithOrdersProducts).toEqual([
      { productId: 5, productName: "CJC/IPA 10mg", orderedUnits: 14, orders: 7 },
    ]);
    expect(data.outOfStockWithOrdersOmitted).toBe(0);
    expect(data.counts).toEqual({
      suggested: { OUT: 0, CRITICAL: 0, REORDER_NOW: 0, APPROACHING: 0 },
      unavailable: { no_demand_signal: 3, insufficient_history: 0 },
      unavailableAtZeroStock: 2,
      outOfStockWithOrders: 1,
      outOfStockWithOrdersUnknown: 1,
      orderSignalUnknown: 1,
    });
    expect(data.countsNote).toContain("never count rows yourself");
    expect(data.coverage.orderSignalCoverage).toBe("full");
    expect(data.definitions.urgency).toContain("Checked in that order");
    expect(data.definitions.reorderPoint).toContain("reorderPointSource 'computed'");
    // The signal read is the caller's companies' only.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signalRead = (p.productSalesFact.groupBy.mock.calls as any[]).map((c) => c[0]).find((a) => a.by[0] === "productId");
    expect(signalRead.where.companyId).toEqual({ in: ["c1"] });
    expect(signalRead.where.productId).toEqual({ in: [5, 6, 7] });
  });

  it("get_sales: coverage carries salesDataStart + windowCoverage + rowsNote (C6)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    p.product.findMany.mockResolvedValue([{ id: 1, name: "TIRZ 10mg" }]); // approved-id set + names
    p.productSalesFact.aggregate.mockResolvedValueOnce({ _min: { dayKey: "2019-01-01" } });

    const toolResult = await roundTrip("get_sales", { groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.coverage.salesDataStart).toBe("2019-01-01");
    // The window is the default last-30-days, well after 2019 => the source covers it.
    expect(toolResult.data.coverage.windowCoverage).toBe("full");
    expect(toolResult.data.coverage.rowsNote).toContain("includeZeroRows");
    // G5 FROM BIRTH: the dataStart aggregate is narrowed by the approved-id set.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aggArgs = p.productSalesFact.aggregate.mock.calls[0][0] as any;
    expect(aggArgs.where.productId).toEqual({ in: [1] });
  });

  it("get_sales includeZeroRows: a silent product is a MEASURED zero row on the wire (C6)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    p.productSalesFact.aggregate.mockResolvedValueOnce({ _min: { dayKey: "2019-01-01" } });
    // Product 7 sold; product 8 did not. Both are approved+active.
    p.productSalesFact.groupBy.mockImplementation(async (args: Record<string, unknown>) =>
      args._min
        ? [] // the post-pagination firstSaleDayKey lookup: no facts for the zero row
        : [{ productId: 7, _sum: { orderedQty: 12, revenue: "24.00", orderCount: 3 } }],
    );
    p.product.findMany.mockResolvedValue([
      { id: 7, name: "Sold", deletedAt: null },
      { id: 8, name: "Silent", deletedAt: null },
    ]);

    const toolResult = await roundTrip("get_sales", { groupBy: "product", includeZeroRows: true });
    expect(toolResult.status).toBe("ok");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = Object.fromEntries((toolResult.data.rows as any[]).map((r) => [r.productId, r]));
    expect(byId[7]._sum.orderedQty).toBe(12);
    // The C6 payoff: an ABSENT product becomes a MEASURED zero (full coverage), named,
    // tagged, with no fabricated reason — and firstSaleDayKey null as honest evidence.
    expect(byId[8]).toEqual({
      productId: 8,
      name: "Silent",
      lifecycle: "active",
      // OC-7: "0" — byte-identical to what a MEASURED Decimal(0) serializes to, so a
      // synthesized zero is not distinguishable from a real one by FORMAT.
      _sum: { orderedQty: 0, revenue: "0", orderCount: 0 },
      firstSaleDayKey: null,
    });
    expect(toolResult.data.totalRows).toBe(2);
  });

  it("get_sales includeZeroRows at the wrong grain is rejected with a self-correcting hint (G1)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    const toolResult = await roundTrip("get_sales", { groupBy: "day", includeZeroRows: true });
    expect(toolResult.status).toBe("error");
    expect(toolResult.code).toBe("TOOL_ERROR");
    expect(toolResult.hint).toContain("includeZeroRows requires groupBy:'product'");
  });

  it("compare_periods by_product: server-ranked per-product deltas on the wire (C9)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    // dataStart covers both windows => every row is RANKED (measured), unranked empty.
    p.productSalesFact.aggregate.mockResolvedValueOnce({ _min: { dayKey: "2019-01-01" } });
    p.productSalesFact.groupBy
      // FD-1: compare now classifies sales coverage with the SAME per-company rule
      // get_sales uses, so the FIRST groupBy is the per-company starts read (by
      // companyId). One company, sharing the caller-wide start => coverage is undegraded.
      .mockResolvedValueOnce([{ companyId: "c1", _min: { dayKey: "2019-01-01" } }])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 10 } },
        { productId: 2, _sum: { orderedQty: 10 } },
      ])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 40 } }, // +30
        { productId: 2, _sum: { orderedQty: 4 } }, // -6
      ])
      // A2 C14: both 30-day periods end TODAY, so each per-day numerator is a second read
      // over its rate window (through yesterday, 29 complete days) — today's units excluded.
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 9 } },
        { productId: 2, _sum: { orderedQty: 10 } },
      ])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 29 } },
        { productId: 2, _sum: { orderedQty: 4 } },
      ])
      .mockResolvedValueOnce([]); // post-pagination firstSaleDayKey lookup
    p.product.findMany.mockResolvedValue([
      { id: 1, name: "Grower", deletedAt: null },
      { id: 2, name: "Decliner", deletedAt: null },
    ]);

    const toolResult = await roundTrip("compare_periods", {
      metric: "sales_units",
      periodA: { relativeDays: 30 },
      periodB: { relativeDays: 30 },
      groupBy: "product",
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.mode).toBe("by_product");
    // Ranked SERVER-side by |delta| desc — the model never does this arithmetic.
    expect(toolResult.data.rows.map((r: { productId: number }) => r.productId)).toEqual([1, 2]);
    expect(toolResult.data.rows[0].delta).toBe(30);
    expect(toolResult.data.rows[0].name).toBe("Grower");
    expect(toolResult.data.rows[0].lifecycle).toBe("active");
    expect(toolResult.data.rows[1].delta).toBe(-6);
    expect(toolResult.data.totalRows).toBe(2);
    // Full coverage => nothing unknown-base, and the coverage says so machine-readably.
    expect(toolResult.data.unranked).toEqual([]);
    expect(toolResult.data.coverage.periodCoverage).toEqual({ a: "full", b: "full" });
    expect(toolResult.data.coverage.unrankedNote).toContain("COVERAGE artifact");
    // A2 C3/C2: equal lengths keep the |delta| ranking and say so; the counts cross too.
    expect(toolResult.data.rankedBy).toBe("total");
    expect(toolResult.data.counts).toEqual({ ranked: 2, increased: 1, decreased: 1, unchanged: 0, unranked: 0 });
    // A2 C14: over the complete days only (9 / 29 and 29 / 29), the windows echoed.
    expect(toolResult.data.rows[0]).toMatchObject({ aPerDay: 0.31, bPerDay: 1, perDayDelta: 0.69, perDayDirection: "increase" });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(toolResult.data.coverage.rateWindows.a).toMatchObject({ to: yesterday, days: 29 });
    expect(toolResult.data.coverage.rateWindows.b).toMatchObject({ to: yesterday, days: 29 });
  });

  // FD2-2 on the WIRE: degraded per-company coverage governs zero legality only, so the
  // measured rows still cross the boundary — together with the disclosure that explains
  // why one product is ranked and another is not.
  it("compare_periods by_product: degraded coverage ships MEASURED rows + companyCoverage", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }, { companyId: "c2" }]);
    // A2 C8: the companies' names (read once, over the caller's own companies).
    p.company.findMany.mockResolvedValueOnce([
      { id: "c1", name: "Acme Peptides" },
      { id: "c2", name: "Beta Labs" },
    ]);
    p.productSalesFact.aggregate.mockResolvedValueOnce({ _min: { dayKey: "2019-01-01" } });
    p.productSalesFact.groupBy
      // c2 returns NO group: it has never recorded a fact, so the window is degraded.
      .mockResolvedValueOnce([{ companyId: "c1", _min: { dayKey: "2019-01-01" } }])
      .mockResolvedValueOnce([{ productId: 1, _sum: { orderedQty: 10 } }])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 40 } }, // +30, measured on BOTH sides
        { productId: 2, _sum: { orderedQty: 4 } }, // no period-A row => unknown base
      ])
      .mockResolvedValueOnce([]); // post-pagination firstSaleDayKey lookup
    p.product.findMany.mockResolvedValue([
      { id: 1, name: "Grower", deletedAt: null },
      { id: 2, name: "Newcomer", deletedAt: null },
    ]);

    const toolResult = await roundTrip("compare_periods", {
      metric: "sales_units",
      periodA: { relativeDays: 30 },
      periodB: { relativeDays: 30 },
      groupBy: "product",
    });
    expect(toolResult.status).toBe("ok");
    // The recorded rows are REPORTED, not withheld.
    expect(toolResult.data.rows.map((r: { productId: number }) => r.productId)).toEqual([1]);
    expect(toolResult.data.rows[0].delta).toBe(30);
    // The absent-in-A product is unknown-base, never a manufactured zero.
    expect(toolResult.data.unranked.map((r: { productId: number }) => r.productId)).toEqual([2]);
    expect(toolResult.data.unranked[0].a).toBeNull();
    // ...and the disclosure names the company that degrades the window.
    expect(toolResult.data.coverage.periodCoverage).toEqual({ a: "partial", b: "partial" });
    expect(toolResult.data.coverage.companyCoverage).toEqual([
      { companyId: "c1", salesDataStart: "2019-01-01", name: "Acme Peptides" },
      { companyId: "c2", salesDataStart: null, name: "Beta Labs" },
    ]);
    // A2 C8: the company is NAMED in the prose, never shown by its id.
    expect(toolResult.data.coverage.companyCoverageNote).toContain("no sales data recorded for Beta Labs");
    expect(toolResult.data.coverage.companyCoverageNote).not.toContain("company c2");
  });

  // ---------------------------------------------------------------------------
  // A2 M4 on the WIRE (pack C1, C7): remainingRows from the envelope's own total and
  // cursor, the sales-freshness note on order figures, and get_data_freshness'
  // lastSucceededAt cross the MCP boundary with real values.
  // ---------------------------------------------------------------------------

  it("find_product: 50 matches at limit 20 -> nextOffset 20, remainingRows 30 on the wire (A2 C1)", async () => {
    const page = Array.from({ length: 20 }, (_v, i) => ({
      id: i + 1,
      name: `Match ${i + 1}`,
      baseName: "Match",
      variant: `${i + 1}`,
      lowStockThreshold: null,
      approvalStatus: "APPROVED",
      deletedAt: null,
    }));
    p.product.count.mockResolvedValueOnce(50);
    // One delegate, two reads: the DB page of 20 and the identity lookup over its ids.
    p.product.findMany.mockResolvedValue(page);

    const toolResult = await roundTrip("find_product", { query: "match", limit: 20 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.returned).toBe(20);
    expect(toolResult.data.totalRows).toBe(50);
    expect(toolResult.data.nextOffset).toBe(20);
    expect(toolResult.data.remainingRows).toBe(30);
  });

  it("get_sales: a 30-hour-old successful rebuild puts salesFreshnessNote on the wire (A2 C7)", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    const finishedAt = new Date(Date.now() - 30 * 3_600_000);
    p.analyticsRebuildRun.findMany.mockResolvedValue([
      { status: "SUCCEEDED", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt, skippedReason: null },
    ]);

    const toolResult = await roundTrip("get_sales", { groupBy: "day" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.coverage.salesFreshnessNote).toBe(
      `The last successful sales rebuild finished at ${finishedAt.toISOString()}, more than a day ` +
        `ago; orders recorded after that are not counted yet.`,
    );
    expect(toolResult.data.remainingRows).toBe(0);
    // The run history is read for the sales job only, newest first, filtered in JS.
    const read = p.analyticsRebuildRun.findMany.mock.calls[0][0];
    expect(read).toMatchObject({ where: { job: "sales" }, orderBy: { startedAt: "desc" }, take: 50 });
  });

  it("get_data_freshness: rebuild.lastSucceededAt beside lastRunAt on the wire (A2 C7)", async () => {
    const lastAttempt = new Date("2026-10-27T02:00:09.000Z");
    const lastSuccess = new Date("2026-10-26T02:07:31.000Z");
    p.analyticsRebuildState.findUnique.mockImplementation(async ({ where }: { where: { job: string } }) =>
      where.job === "sales" ? { lastRunAt: lastAttempt, sourceWatermark: null } : null,
    );
    p.analyticsRebuildRun.findMany.mockResolvedValue([
      { status: "FAILED", startedAt: new Date("2026-10-27T02:00:00.000Z"), finishedAt: lastAttempt, skippedReason: null },
      { status: "SUCCEEDED", startedAt: new Date("2026-10-26T02:00:00.000Z"), finishedAt: lastSuccess, skippedReason: null },
    ]);

    const toolResult = await roundTrip("get_data_freshness", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.rebuild).toEqual({
      lastRunAt: lastAttempt.toISOString(),
      lastSucceededAt: lastSuccess.toISOString(),
      sourceWatermark: null,
    });
  });

  // ---------------------------------------------------------------------------
  // A2 M3 on the WIRE (pack C6, C9, C2): unit prices, the as-of location read and the
  // by-product counts cross the MCP boundary with real values.
  // ---------------------------------------------------------------------------

  it("get_valuation groupBy product: currentUnitCostCents / unitRetailCents on the wire (A2 C6)", async () => {
    p.product.findMany.mockResolvedValueOnce([
      {
        id: 1,
        name: "Nothing on hand",
        costPrice: 0,
        retailPrice: 12.5,
        product_locations: [{ locationId: 1, quantity: 0, locations: { name: "Main" } }],
      },
    ]);
    const toolResult = await roundTrip("get_valuation", { groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.rows[0]).toMatchObject({
      productId: 1,
      units: 0,
      atRetailCents: 0, // a money total of 0: nothing on hand
      currentUnitCostCents: 0, // recorded as free
      unitRetailCents: 1250, // the price is not 0
    });
  });

  it("get_stock_asof locationId: the location echo + its coverage keys on the wire (A2 C9)", async () => {
    p.location.findUnique.mockResolvedValueOnce({ id: 2, name: "Annex" });
    // Two counts: the page's population ("recorded here on or before the day") and its
    // complement (notRecordedHere) — told apart by the where clause, not by call order.
    p.product.count.mockImplementation(async (args: { where?: { stockSnapshots?: { none?: unknown } } }) =>
      args?.where?.stockSnapshots?.none ? 3 : 1,
    );
    p.product.findMany.mockResolvedValueOnce([{ id: 1, name: "TIRZ" }]);
    p.productStockSnapshot.aggregate.mockResolvedValueOnce({
      _min: { dayKey: "2026-06-01" },
      _max: { dayKey: "2026-06-30" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.productStockSnapshot.groupBy.mockImplementation(async (args: any) =>
      args._sum
        ? [{ productId: 1, _sum: { quantity: 7 }, _count: 1 }]
        : [{ productId: 1, locationId: 2, _max: { dayKey: "2026-06-20" }, _min: { dayKey: "2026-06-01" } }],
    );
    const toolResult = await roundTrip("get_stock_asof", { dayKey: "2026-06-15", locationId: 2 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.location).toEqual({ id: 2, name: "Annex" });
    expect(toolResult.data.rows[0]).toMatchObject({ productId: 1, units: 7, possiblyStale: true });
    expect(toolResult.data.coverage).toMatchObject({
      snapshotWatermark: "2026-06-30",
      watermarkScope: "all locations",
      notRecordedHere: 3,
    });
    expect(typeof toolResult.data.coverage.notRecordedHereNote).toBe("string");
    expect(toolResult.data.totalRows).toBe(1);
    p.productStockSnapshot.groupBy.mockReset();
    p.productStockSnapshot.groupBy.mockResolvedValue([]);
    p.product.count.mockReset();
    p.product.count.mockResolvedValue(0);
  });

  it("get_stock_asof with an unknown locationId: NOT_FOUND with the location message (A2 C9)", async () => {
    const toolResult = await roundTrip("get_stock_asof", { dayKey: "2026-06-15", locationId: 99 });
    expect(toolResult).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: "No location with id 99." },
    });
  });

  it("get_movement_series breakdownBy:'product': whole-result counts + countsNote on the wire (A2 C2)", async () => {
    p.product.findMany.mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as { id?: { in: number[] } };
      const catalog = [
        { id: 1, name: "Shipper", deletedAt: null },
        { id: 2, name: "Receiver", deletedAt: null },
      ];
      return where.id?.in ? catalog.filter((c) => where.id!.in.includes(c.id)) : catalog;
    });
    p.inventory_logs.groupBy.mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as { delta?: { lt?: number; gt?: number } };
      if (where.delta?.lt != null) {
        return [{ productId: 1, logType: "ADJUSTMENT", reasonCode: null, _sum: { delta: -3 }, _count: 1 }];
      }
      return [{ productId: 2, logType: "STOCK_IN", reasonCode: null, _sum: { delta: 9 } }];
    });
    const toolResult = await roundTrip("get_movement_series", { breakdownBy: "product", limit: 1 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.returned).toBe(1);
    expect(toolResult.data.counts).toEqual({ products: 2, withOutbound: 1, withInbound: 1 });
    expect(toolResult.data.countsNote).toContain("never count rows yourself");
    // The reason-less outbound adjustment makes the note ride.
    expect(toolResult.data.coverage.reasonCodeNullRows).toBe(1);
    expect(toolResult.data.coverage.unclassifiedLegacyNote).toContain("without a reason code");
    p.product.findMany.mockReset();
    p.product.findMany.mockResolvedValue([]);
    p.inventory_logs.groupBy.mockReset();
    p.inventory_logs.groupBy.mockResolvedValue([]);
  });

  // FD4-7 on the WIRE: the FD3 round mirrored `coverageShift` onto the by_product envelope
  // (a joining company changes EVERY row's denominator) and the wire had no assertion for
  // it — only the totals mode did. A mirror nobody checks across the boundary is a mirror
  // that can be dropped by the next envelope edit without a test noticing.
  it("compare_periods by_product: a coverage shift rides on the ENVELOPE, with its legend", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }, { companyId: "c2" }]);
    p.productSalesFact.aggregate.mockResolvedValueOnce({ _min: { dayKey: "2020-01-01" } });
    p.productSalesFact.groupBy
      // c2's first fact is period B's FIRST DAY: it contributes to B and not to A.
      .mockResolvedValueOnce([
        { companyId: "c1", _min: { dayKey: "2020-01-01" } },
        { companyId: "c2", _min: { dayKey: "2026-06-08" } },
      ])
      .mockResolvedValueOnce([{ productId: 1, _sum: { orderedQty: 10 } }])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 25 } }, // +15, measured on both sides
        { productId: 2, _sum: { orderedQty: 12 } }, // no period-A row => unknown base
      ])
      .mockResolvedValueOnce([]); // post-pagination firstSaleDayKey lookup
    p.product.findMany.mockResolvedValue([
      { id: 1, name: "Grower", deletedAt: null },
      { id: 2, name: "Newcomer", deletedAt: null },
    ]);

    const toolResult = await roundTrip("compare_periods", {
      metric: "sales_units",
      periodA: { from: "2026-06-01", to: "2026-06-07" },
      periodB: { from: "2026-06-08", to: "2026-06-14" },
      groupBy: "product",
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.rows[0].delta).toBe(15);
    expect(toolResult.data.coverage.periodCoverage).toEqual({ a: "partial", b: "full" });
    // The qualification crosses the boundary ONCE, on the envelope...
    expect(toolResult.data.coverage.coverageShift).toContain("c2");
    expect(toolResult.data.coverage.coverageShift).toContain("not like-for-like");
    expect(toolResult.data.reasons.delta).toBe(toolResult.data.coverage.coverageShift);
    // ...with the legend that names the key, and never once per unranked row (FD4-3).
    expect(toolResult.data.coverage.reasonsKeys).toContain("delta = the coverageShift qualification");
    expect(toolResult.data.unranked[0].reasons.delta).toBeUndefined();
  });

  it("compare_periods totals mode gains its `mode` discriminant (ADDITIVE, C9)", async () => {
    p.inventory_logs.aggregate
      .mockResolvedValueOnce({ _min: { changeTime: new Date("2020-01-01T00:00:00.000Z") } })
      .mockResolvedValueOnce({ _sum: { delta: -10 } })
      .mockResolvedValueOnce({ _sum: { delta: -25 } })
      // A2 C14: the rate-window re-reads (through yesterday — today's ledger rows excluded).
      .mockResolvedValueOnce({ _sum: { delta: -9 } })
      .mockResolvedValueOnce({ _sum: { delta: -23 } });

    const toolResult = await roundTrip("compare_periods", {
      metric: "outbound_units",
      periodA: { relativeDays: 30 },
      periodB: { relativeDays: 30 },
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.mode).toBe("totals");
    expect(toolResult.data.a).toBe(10);
    expect(toolResult.data.b).toBe(25);
    // FD3-3 on the WIRE: totals mode carries the same per-period classification
    // by_product does, so a consumer branches on ONE key across both modes.
    expect(toolResult.data.coverage.periodCoverage).toEqual({ a: "full", b: "full" });
    // Equally-covered periods: the comparability qualification stays OFF.
    expect(toolResult.data.coverage.coverageShift).toBeUndefined();
    // A2 C3 on the WIRE: the totals payload carries the per-day figures and their definition
    // (no rankedBy, no counts — those are by_product's).
    // A2 C14: over the 29 complete days of each period (9 / 29 vs 23 / 29).
    expect(toolResult.data).toMatchObject({
      aPerDay: 0.31,
      bPerDay: 0.793,
      perDayDelta: 0.483,
      perDayDirection: "increase",
    });
    expect(toolResult.data.perDayPctChange).toBeCloseTo(14 / 9, 10);
    expect(toolResult.data.coverage.rateDefinition).toContain(
      "perDayDirection is the sign of the unrounded change.",
    );
    expect(toolResult.data.coverage.rateDefinition).toContain("over its COMPLETE days");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(toolResult.data.coverage.rateWindows).toEqual({
      a: { from: toolResult.data.periodA.from, to: yesterday, days: 29 },
      b: { from: toolResult.data.periodB.from, to: yesterday, days: 29 },
    });
    expect(toolResult.data.rankedBy).toBeUndefined();
    expect(toolResult.data.counts).toBeUndefined();
  });

  // A2 C3/C2 on the WIRE: the review-#4 question ("which products sold faster last month
  // than over the previous nine months?") — periods of different lengths rank and filter by
  // the per-day change, say so, and carry the counts over the whole result.
  it("compare_periods by_product over 274 vs 30 days: per-day ranking, rankedBy and counts cross the boundary", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    p.productSalesFact.aggregate.mockResolvedValueOnce({ _min: { dayKey: "2019-01-01" } });
    p.productSalesFact.groupBy
      .mockResolvedValueOnce([{ companyId: "c1", _min: { dayKey: "2019-01-01" } }])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 274 } }, // 1/day over the nine months
        { productId: 2, _sum: { orderedQty: 548 } }, // 2/day
      ])
      .mockResolvedValueOnce([
        { productId: 1, _sum: { orderedQty: 60 } }, // 2/day last month: FEWER units, faster
        { productId: 2, _sum: { orderedQty: 30 } }, // 1/day
      ])
      .mockResolvedValueOnce([]); // post-pagination firstSaleDayKey lookup
    p.product.findMany.mockResolvedValue([
      { id: 1, name: "Faster", deletedAt: null },
      { id: 2, name: "Slower", deletedAt: null },
    ]);

    const toolResult = await roundTrip("compare_periods", {
      metric: "sales_units",
      periodA: { from: "2025-09-01", to: "2026-06-01" },
      periodB: { from: "2026-06-02", to: "2026-07-01" },
      groupBy: "product",
      direction: "increase",
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.rankedBy).toBe("per_day");
    expect(toolResult.data.rows.map((r: { productId: number }) => r.productId)).toEqual([1]);
    expect(toolResult.data.rows[0]).toMatchObject({
      name: "Faster",
      delta: -214,
      aPerDay: 1,
      bPerDay: 2,
      perDayDelta: 1,
      perDayDirection: "increase",
    });
    expect(toolResult.data.counts).toEqual({ ranked: 1, increased: 1, decreased: 1, unchanged: 0, unranked: 0 });
    expect(toolResult.data.countsNote).toContain("never count rows yourself");
    expect(toolResult.data.coverage.rateDefinition).toContain(
      "rows are ranked and filtered by the per-day change",
    );
    expect(toolResult.data.coverage.reasonsKeys).toContain("perDayPctChange = per-day percent change");
  });

  it("get_movement_series breakdownBy:'product': per-product rows + a rejected-id echo (C10)", async () => {
    // Approved catalog = {1, 2}; id 4242 does not exist. The batch resolver and the
    // identity map both read product.findMany, so the mock honors the id filter.
    p.product.findMany.mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as { id?: { in: number[] } };
      const catalog = [
        { id: 1, name: "Shipper", deletedAt: null },
        { id: 2, name: "Silent", deletedAt: null },
      ];
      return where.id?.in ? catalog.filter((c) => where.id!.in.includes(c.id)) : catalog;
    });
    // OC-6: the breakdown AGGREGATES DB-side over two sign-partitioned groupBys, so the
    // wire fixture is expressed as GROUPS. The 12-out/4-back pair sits in the two
    // partitions on purpose: it is the case a single netted groupBy would get wrong.
    p.inventory_logs.groupBy.mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as { delta?: { lt?: number; gt?: number } };
      if (where.delta?.lt != null) {
        return [{ productId: 1, logType: "SALE", reasonCode: null, _sum: { delta: -12 }, _count: 1 }];
      }
      if (where.delta?.gt != null) {
        return [{ productId: 1, logType: "SALE", reasonCode: null, _sum: { delta: 4 }, _count: 1 }];
      }
      return [];
    });

    const toolResult = await roundTrip("get_movement_series", {
      breakdownBy: "product",
      productIds: [1, 2, 4242],
    });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.mode).toBe("by_product");
    // filters echoes the REAL scope of the rows — the RESOLVED ids. The unresolvable
    // one is accounted for in coverage.requested below, never smuggled into the scope
    // echo (which would claim the result covers a product it never read).
    expect(toolResult.data.filters).toEqual({
      productId: null,
      productIds: [1, 2],
      locationId: null,
      mode: "by_product",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = Object.fromEntries((toolResult.data.rows as any[]).map((r) => [r.productId, r]));
    // Sign-first: the 4-unit return does NOT cancel the 12 units that shipped.
    expect(byId[1].outboundUnits).toBe(12);
    expect(byId[1].sale).toBe(-8); // the SIGNED bucket still nets out honestly
    expect(byId[1].name).toBe("Shipper");
    expect(byId[1].lifecycle).toBe("active");
    // The requested-but-silent product is an ALL-ZERO row, not an absence.
    expect(byId[2].outboundUnits).toBe(0);
    expect(byId[2].net).toBe(0);
    // The unresolvable id is ECHOED, never silently dropped.
    expect(toolResult.data.coverage.requested).toEqual({
      requested: 3,
      resolved: 2,
      rejected: [{ productId: 4242, reason: "unknown_id" }],
    });
    // QA-1 on the WIRE: a bounded request carries BOTH archived counts. Product 2 is a
    // force-emitted all-zero row, so it belongs to the zero-row half — and neither product
    // is deleted here, which is what makes 0/0 the true pair rather than an absent key.
    expect(toolResult.data.coverage.archivedProductsIncluded).toBe(0);
    expect(toolResult.data.coverage.archivedZeroRows).toBe(0);
  });

  it("get_movement_series productIds WITHOUT breakdownBy is rejected with a hint (C10 narrowing)", async () => {
    const toolResult = await roundTrip("get_movement_series", { productIds: [1, 2] });
    expect(toolResult.status).toBe("error");
    expect(toolResult.code).toBe("TOOL_ERROR");
    expect(toolResult.hint).toContain("requires breakdownBy:'product'");
  });

  // OC-1: breakdownBy + productId used to be ACCEPTED on this wire — the singular id was
  // dropped and a CATALOG-wide breakdown came back looking like a single-product answer.
  // The round-trip proves the sidecar surfaces the rejection (and its repair) too.
  it("get_movement_series breakdownBy + productId is rejected with a self-correcting hint (OC-1)", async () => {
    const toolResult = await roundTrip("get_movement_series", {
      breakdownBy: "product",
      productId: 1,
    });
    expect(toolResult.status).toBe("error");
    expect(toolResult.code).toBe("TOOL_ERROR");
    expect(toolResult.hint).toContain("mutually exclusive");
    expect(toolResult.hint).toContain("productIds:[id]");
    // No rows: the rejection replaces the answer, it does not ride beside one.
    expect(toolResult.data).toBeUndefined();
  });

  it("get_operations: outboundMix30 decomposes unitsOut30 on the wire (C12)", async () => {
    // G2-1: the tool reads the approved-ACTIVE id set FIRST (it narrows the freshness
    // dataStarts), so the product read is dispatched on shape rather than call order —
    // a `mockResolvedValueOnce` would now be consumed by the id-set read.
    p.product.findMany.mockImplementation(async (args: Record<string, unknown>) => {
      const select = (args.select ?? {}) as Record<string, unknown>;
      const catalog = [
        {
          id: 1,
          name: "TIRZ",
          costPrice: null,
          lowStockThreshold: null,
          product_locations: [{ quantity: 40 }],
        },
      ];
      // The approved-id set selects `id` only; the operations row read selects the rest.
      return Object.keys(select).length === 1 ? catalog.map((p2) => ({ id: p2.id })) : catalog;
    });
    // The ONE regrouped 30-day read: (productId, logType, reasonCode) groups. Every other
    // groupBy on this delegate stays benign, so the mix here is the only seeded source.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.inventory_logs.groupBy.mockImplementation(async (args: any) => {
      if ((args?.by ?? []).length === 3) {
        return [
          { productId: 1, logType: "SALE", reasonCode: null, _sum: { delta: -4 }, _min: { changeTime: new Date(Date.now() - 10 * 86_400_000) } },
          { productId: 1, logType: "ADJUSTMENT", reasonCode: null, _sum: { delta: -16 }, _min: { changeTime: new Date(Date.now() - 5 * 86_400_000) } },
        ];
      }
      return [];
    });

    const toolResult = await roundTrip("get_operations", { windowDays: 30 });
    expect(toolResult.status).toBe("ok");
    const row = toolResult.data.rows[0];
    expect(row.unitsOut30).toBe(20);
    // The review-F2 shape, made visible: only 4 of 20 depleted units were a SALE row.
    expect(row.outboundMix30).toEqual({
      sale: 4,
      classifiedLoss: 0,
      adjustmentUnclassified: 16,
      correctionUnclassified: 0,
      countOut: 0,
      stockInReversal: 0,
    });
    // NORMATIVE (spec C12), asserted on the wire payload itself.
    const mix = row.outboundMix30 as Record<string, number>;
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBe(row.unitsOut30);
    // The definition string relayed beside it now points at the mix FIELDS.
    expect(toolResult.data.velocityDefinition).toContain("outboundMix30");
  });

  it("reorder_report: demandUnits + demandMix ride with the rate they explain (C12)", async () => {
    p.product.findMany.mockResolvedValueOnce([
      { id: 1, name: "A", costPrice: null, product_locations: [{ quantity: 0 }], reorderConfig: null },
    ]);
    const recent = (d: number) => new Date(Date.now() - d * 86_400_000);
    // reorderDemand's ONE findMany: the mix is composed from these very rows.
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { productId: 1, delta: -2, changeTime: recent(6), logType: "SALE", reasonCode: null },
      { productId: 1, delta: -5, changeTime: recent(4), logType: "ADJUSTMENT", reasonCode: null },
      { productId: 1, delta: -3, changeTime: recent(2), logType: "ADJUSTMENT", reasonCode: "DAMAGE" },
    ]);

    const toolResult = await roundTrip("reorder_report", {});
    expect(toolResult.status).toBe("ok");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (toolResult.data.rows as any[]).find((r) => r.status === "suggested");
    expect(row).toBeDefined();
    expect(row.demandUnits).toBe(10);
    expect(row.demandMix).toEqual({
      sale: 2,
      classifiedLoss: 3,
      adjustmentUnclassified: 5,
      correctionUnclassified: 0,
      countOut: 0,
      stockInReversal: 0,
    });
    expect(Object.values(row.demandMix as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(
      row.demandUnits,
    );
  });

  it("reorder_report productIds: OK row + not_active/unknown_id rows + requested accounting (C11)", async () => {
    // Approved catalog: 1 (active, healthy) and 9 (archived). 4242 does not exist.
    p.product.findMany.mockImplementation(async (args: Record<string, unknown>) => {
      const where = (args.where ?? {}) as { id?: { in: number[] }; deletedAt?: null };
      const select = (args.select ?? {}) as { product_locations?: boolean };
      const catalog = [
        { id: 1, name: "Healthy One", deletedAt: null },
        { id: 9, name: "Archived Product", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
      ];
      let rows = catalog;
      if (where.deletedAt === null) rows = rows.filter((c) => c.deletedAt == null);
      if (where.id?.in) rows = rows.filter((c) => where.id!.in.includes(c.id));
      if (select.product_locations) {
        // The population read: stock far above the reorder point => FINAL urgency null.
        return rows.map((c) => ({
          id: c.id,
          name: c.name,
          costPrice: null,
          product_locations: [{ quantity: 5000 }],
          reorderConfig: null,
        }));
      }
      return rows;
    });
    const recent = (d: number) => new Date(Date.now() - d * 86_400_000);
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { productId: 1, delta: -1, changeTime: recent(3), logType: "SALE", reasonCode: null },
      { productId: 1, delta: -1, changeTime: recent(2), logType: "SALE", reasonCode: null },
      { productId: 1, delta: -1, changeTime: recent(1), logType: "SALE", reasonCode: null },
    ]);

    const toolResult = await roundTrip("reorder_report", { productIds: [1, 9, 4242] });
    expect(toolResult.status).toBe("ok");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = Object.fromEntries((toolResult.data.rows as any[]).map((r) => [r.productId, r]));
    // A requested HEALTHY product answers with real numbers under urgency OK.
    expect(byId[1].status).toBe("suggested");
    expect(byId[1].urgency).toBe("OK");
    expect(typeof byId[1].grossReplenishmentNeed).toBe("number");
    // The archived id is NAMED but never sized.
    expect(byId[9]).toEqual({
      status: "unavailable",
      productId: 9,
      productName: "Archived Product",
      currentStock: null,
      reason: "not_active",
    });
    // The unknown id carries NO fabricated fields.
    expect(byId[4242]).toEqual({
      status: "unavailable",
      productId: 4242,
      productName: null,
      currentStock: null,
      reason: "unknown_id",
    });
    // Accounting: the two non-population rows live ONLY in `requested`...
    expect(toolResult.data.coverage.requested).toEqual({ requested: 3, notActive: 1, unknownIds: 1 });
    expect(toolResult.data.coverage.unavailable).toBe(0);
    // ...so the C5 invariant still holds on the wire.
    const c = toolResult.data.coverage;
    expect(c.suggested + c.unavailable + c.healthy + c.approachingOmitted).toBe(c.total);
    expect(c.total).toBe(1); // only the resolved-ACTIVE product
  });

  it("reorder_report with an EMPTY productIds array is rejected with a hint (G1)", async () => {
    const toolResult = await roundTrip("reorder_report", { productIds: [] });
    expect(toolResult.status).toBe("error");
    expect(toolResult.hint).toContain("productIds must not be empty");
  });

  it("low_stock_report: thresholdSource comes from the RAW override, not equality (C8)", async () => {
    // The fixture the OLD inference got wrong: an explicit override that EQUALS the
    // system default (10). Equality reported "system_default"; the raw column says
    // otherwise, and the raw value rides along as the evidence.
    p.product.findMany.mockResolvedValueOnce([
      { id: 1, name: "Equal Override", lowStockThreshold: 10, product_locations: [{ quantity: 2 }] },
      { id: 2, name: "Inherited", lowStockThreshold: null, product_locations: [{ quantity: 1 }] },
    ]);

    const toolResult = await roundTrip("low_stock_report", {});
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.systemDefaultThreshold).toBe(10);
    const byId = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (toolResult.data.alerts as any[]).map((a) => [a.productId, a]),
    );
    expect(byId[1].effectiveThreshold).toBe(10);
    expect(byId[1].rawThreshold).toBe(10);
    expect(byId[1].thresholdSource).toBe("product_override");
    expect(byId[2].effectiveThreshold).toBe(10);
    expect(byId[2].rawThreshold).toBeNull();
    expect(byId[2].thresholdSource).toBe("system_default");
  });

  // Assistant A2 (pack C2, C5): the counts block, the usage window and the alert rule on
  // the wire, over the real module (one alerts-off product at no stock, one slow mover).
  it("low_stock_report: counts, usageWindowDays and alertRule reach the wire (A2 C2/C5)", async () => {
    p.product.findMany.mockResolvedValueOnce([
      { id: 1, name: "Out", lowStockThreshold: 5, product_locations: [{ quantity: 0 }] },
      { id: 2, name: "Slow", lowStockThreshold: null, product_locations: [{ quantity: 5 }] },
      { id: 3, name: "Off", lowStockThreshold: 0, product_locations: [{ quantity: 0 }] },
    ]);
    // Slow: 1 unit, first outbound 30 days back => 1/30 => 0.0333/day (it read 0.0).
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { productId: 2, delta: -1, changeTime: new Date(Date.now() - 30 * 86_400_000), logType: "SALE", reasonCode: null },
    ]);

    const toolResult = await roundTrip("low_stock_report", {});
    expect(toolResult.status).toBe("ok");
    const data = toolResult.data;
    expect(data.counts).toEqual({
      alerts: 2,
      outOfStockAlerts: 1,
      lowAlerts: 1,
      productOverride: 1,
      systemDefault: 1,
      alertsOff: 1,
      alertsOffAtZeroStock: 1,
      outOfStockAllProducts: 2,
    });
    expect(data.countsNote).toContain("stockStateCounts.out");
    expect(data.usageWindowDays).toBe(30);
    expect(data.alertRule).toContain("a threshold of 0 turns alerts off");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const slow = (data.alerts as any[]).find((a) => a.productId === 2);
    expect(slow.averageDailyUsage).toBe(0.0333);
    expect(slow.daysUntilEmpty).toBe(150);
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
  it("get_stock_asof advertises the optional locationId input (A2 C9)", async () => {
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
      const tools = rpc.result.tools as Array<{ name: string; inputSchema: any; description: string }>;
      const asof = tools.find((t) => t.name === "get_stock_asof");
      expect(asof).toBeDefined();
      const root = asof!.inputSchema;
      // The converter dedups identical sub-schemas into a local `$ref` (locationId ->
      // productId, both positive ints), so resolve it against the root.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolve = (node: any): any => {
        if (node && node.$ref) {
          let cur = root;
          for (const seg of String(node.$ref).replace(/^#\//, "").split("/")) cur = cur[seg];
          return cur;
        }
        return node;
      };
      expect(root.properties.locationId).toBeDefined();
      expect(resolve(root.properties.locationId)).toEqual({ type: "integer", exclusiveMinimum: 0 });
      expect(asof!.inputSchema.required ?? []).not.toContain("locationId");
      expect(asof!.description).toContain("Pass locationId for one location's stock on that day");
    } finally {
      await close(server);
    }
  });

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

describe("POST /mcp — quality+reach W3 round-trips (approval + lifecycle over the wire)", () => {
  // Task 3.3 (spec C13/G5). The trust boundary is only real if it survives the OTHER
  // runtime: these drive the SIDECAR end-to-end and assert that (a) an unapproved
  // product never reaches the wire and IS disclosed, and (b) an archived product does,
  // tagged. `product.findMany` is dispatched BY WHERE-SHAPE rather than by call order,
  // because one get_sales call now makes three structurally different product reads
  // (the approved id set, the identity lookup, the contributor census) and a
  // mockResolvedValueOnce chain would pin the ORDER instead of the meaning.
  const APPROVED_ACTIVE = { id: 7, name: "TIRZ 10mg", deletedAt: null };
  const APPROVED_ARCHIVED = { id: 8, name: "Retired 5mg", deletedAt: new Date("2026-03-01T00:00:00.000Z") };

  function seedProductReads(rows: Array<Record<string, unknown>>, censusCount: number) {
    p.product.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      // The G5 CENSUS: starts from Product, reaches facts through a product-side relation.
      if (where.inventory_logs != null || where.salesFacts != null) {
        if (where.approvalStatus?.not === "APPROVED") {
          return Array.from({ length: censusCount }, (_v, i) => ({ id: 900 + i }));
        }
        // The archived-contributor census.
        return rows.filter((r) => r.deletedAt != null).map((r) => ({ id: r.id }));
      }
      // The approved id set / the identity lookup: both read the same population here.
      return rows;
    });
  }

  beforeEach(() => {
    p.userCompany.findMany.mockReset();
    p.userCompany.findMany.mockResolvedValue([]);
    p.product.findMany.mockReset();
    p.product.findMany.mockResolvedValue([]);
    p.product.findFirst.mockReset();
    p.product.findFirst.mockResolvedValue(null);
    p.product.count.mockReset();
    p.product.count.mockResolvedValue(0);
    p.productSalesFact.groupBy.mockReset();
    p.productSalesFact.groupBy.mockResolvedValue([]);
    p.productSalesFact.aggregate.mockReset();
    p.productSalesFact.aggregate.mockResolvedValue({ _min: {}, _max: {}, _sum: {}, _count: {} });
    p.inventory_logs.findMany.mockReset();
    p.inventory_logs.findMany.mockResolvedValue([]);
    p.inventory_logs.aggregate.mockReset();
    p.inventory_logs.aggregate.mockResolvedValue({ _min: {}, _max: {}, _sum: {}, _count: {} });
    p.inventory_logs.count.mockReset();
    p.inventory_logs.count.mockResolvedValue(0);
    p.externalOrder.count.mockReset();
    p.externalOrder.count.mockResolvedValue(0);
    p.analyticsRebuildState.findUnique.mockReset();
    p.analyticsRebuildState.findUnique.mockResolvedValue(null);
    p.product_locations.findMany.mockReset();
    p.product_locations.findMany.mockResolvedValue([]);
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

  it("get_sales: the fact read is narrowed to the APPROVED id set and the exclusion is disclosed", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    seedProductReads([APPROVED_ACTIVE, APPROVED_ARCHIVED], 2);
    p.productSalesFact.groupBy.mockResolvedValueOnce([
      { productId: 7, _sum: { orderedQty: 12, revenue: "24.00", orderCount: 3 } },
      { productId: 8, _sum: { orderedQty: 5, revenue: "9.00", orderCount: 1 } },
    ]);

    const toolResult = await roundTrip("get_sales", { groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    // The id-set filter reached the DB on the SIDECAR path, not just in-process.
    const factRead = p.productSalesFact.groupBy.mock.calls[0][0];
    expect(factRead.where.productId).toEqual({ in: [7, 8] });
    // ...and the exclusion is DISCLOSED with a real census count, never left implicit.
    expect(toolResult.data.coverage.excludedUnapprovedProducts).toBe(2);
    expect(toolResult.data.coverage.archivedProductsIncluded).toBe(1);
    expect(toolResult.data.coverage.approvalNote).toContain("APPROVED product universe only");
  });

  it("get_sales: an ARCHIVED product's row reaches the wire TAGGED lifecycle 'deleted'", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    seedProductReads([APPROVED_ACTIVE, APPROVED_ARCHIVED], 0);
    p.productSalesFact.groupBy.mockResolvedValueOnce([
      { productId: 8, _sum: { orderedQty: 5, revenue: "9.00", orderCount: 1 } },
    ]);

    const toolResult = await roundTrip("get_sales", { groupBy: "product" });
    const row = toolResult.data.rows.find((r: { productId: number }) => r.productId === 8);
    expect(row.name).toBe("Retired 5mg");
    expect(row.lifecycle).toBe("deleted");
    expect(row._sum.orderedQty).toBe(5);
  });

  it("get_sales(productId): an archived product resolves and the payload carries top-level lifecycle", async () => {
    p.userCompany.findMany.mockResolvedValueOnce([{ companyId: "c1" }]);
    p.product.findFirst.mockResolvedValueOnce(APPROVED_ARCHIVED); // the C13 resolver
    seedProductReads([APPROVED_ARCHIVED], 0);
    p.productSalesFact.groupBy.mockResolvedValueOnce([
      { productId: 8, _sum: { orderedQty: 5, revenue: "9.00", orderCount: 1 } },
    ]);

    const toolResult = await roundTrip("get_sales", { productId: 8, groupBy: "product" });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.lifecycle).toBe("deleted");
    expect(toolResult.data.productScope.name).toBe("Retired 5mg");
    // allowArchived relaxes ONLY deletedAt — approval stays unconditional on the wire path.
    const resolverCall = p.product.findFirst.mock.calls[0][0];
    expect(resolverCall.where.approvalStatus).toBe("APPROVED");
    expect(resolverCall.where).not.toHaveProperty("deletedAt");
  });

  it("get_movement_series: an archived product's history answers, tagged, over the wire", async () => {
    const when = new Date(Date.now() - 2 * 86_400_000);
    p.product.findFirst.mockResolvedValueOnce(APPROVED_ARCHIVED);
    seedProductReads([APPROVED_ARCHIVED], 1);
    p.inventory_logs.findMany.mockResolvedValueOnce([
      { delta: -5, changeTime: when, logType: "SALE", reasonCode: null },
    ]);

    const toolResult = await roundTrip("get_movement_series", { productId: 8 });
    expect(toolResult.status).toBe("ok");
    expect(toolResult.data.lifecycle).toBe("deleted");
    expect(toolResult.data.totals.sale).toBe(-5);
    expect(toolResult.data.coverage.excludedUnapprovedProducts).toBe(1);
  });

  it("find_product includeArchived:true: a deleted row is tagged, NULLED, and carries the stateNote", async () => {
    p.product.count.mockResolvedValue(1);
    // find_product reads the catalog page, then the shared identity lookup.
    p.product.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.id != null) return [APPROVED_ARCHIVED]; // productIdentities
      return [{ ...APPROVED_ARCHIVED, baseName: "Retired", variant: "5mg", approvalStatus: "APPROVED", lowStockThreshold: null }];
    });

    const toolResult = await roundTrip("find_product", { query: "Retired", includeArchived: true });
    expect(toolResult.status).toBe("ok");
    const row = toolResult.data.products[0];
    expect(row.lifecycle).toBe("deleted");
    expect(row.currentStock).toBeNull();
    expect(row.lowStock).toBeNull();
    expect(row.stockState).toBeNull();
    expect(row.stateNote).toBe("deleted product — current stock not reported; history remains queryable");
  });

  it("find_product WITHOUT the flag keeps the deletedAt predicate on the wire path", async () => {
    p.product.count.mockResolvedValue(0);
    await roundTrip("find_product", { query: "Retired" });
    const catalogRead = p.product.findMany.mock.calls.find(
      (c: any[]) => c[0]?.where?.approvalStatus === "APPROVED",
    );
    expect(catalogRead[0].where.deletedAt).toBeNull();
  });
});

describe("POST /mcp — reconciliation lane round-trip (pack C5.1 / seam S17)", () => {
  // The batch-summary read is a TAGGED `$queryRaw`, so the mock has to answer it with a
  // row SET rather than the /healthz probe's `[{ ok: 1 }]` — a single scalar row would
  // reach `summaryToFacts` as a batch with no id and no time. Both mock layers therefore
  // DISPATCH on the statement text; this describe binds the inline mock to the same rule
  // the built bundle's stand-in implements, and the parity describe below asserts that
  // stand-in's dispatch directly.
  beforeEach(() => {
    p.$queryRaw.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.$queryRaw.mockImplementation(async (first: any) => {
      const sql =
        typeof first === "object" && first !== null && "sql" in first ? first.sql : String(first);
      return /inventory_logs|external_order_items/.test(sql) && /GROUP BY/.test(sql)
        ? []
        : [{ ok: 1 }];
    });
    p.externalOrder.findMany.mockReset();
    p.externalOrder.findMany.mockResolvedValue([]);
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

  it("get_order_reconciliation: an empty window answers with BOTH scoping sentences and mixed scope", async () => {
    const toolResult = await roundTrip("get_order_reconciliation", { relativeDays: 7 });
    expect(toolResult.status).toBe("ok");
    // D9: the STATIC scope is global, the RESULT is mixed — batches global, orders member.
    expect(toolResult.meta.scope).toBe("mixed");
    const data = toolResult.data;
    expect(data.window).toMatchObject({ days: 7, source: "relative" });
    expect(data.rows).toEqual([]);
    expect(data.totals.attributable).toBe(0);
    expect(data.coverage.batchScope).toBe("global — the physical pool, no actor identity");
    expect(data.coverage.orderFieldScope).toBe("your companies only");
    expect(data.coverage.orderFilterScope).toBe("your companies only");
    expect(data.coverage.moreCount).toBe(0);
    // OC-5: the keyset cursor rides beside the bound it qualifies, null included —
    // "there is no next page" is a statement, not a missing key.
    expect(Object.keys(data.coverage)).toContain("nextCursor");
    expect(data.coverage.nextCursor).toBeNull();
    // R-2: an empty window still says what it excluded and why the share has no
    // denominator — never a bare 0 with no reason.
    expect(data.coverage.exclusionsNote).toContain("excluded from this window");
    expect(data.coverage.derivedShare).toBeNull();
    expect(data.coverage.notes).toContain(
      "no attributable batch in this window, so the derived share has no denominator",
    );
    expect(typeof data.definitions.population).toBe("string");
    // The recording boundary really was read through the delegate the mock provides.
    expect(p.orderAttributionAttempt.findFirst).toHaveBeenCalled();
  });

  it("the tool is registered with a member-scoped context and no `actor` KEY on the wire", async () => {
    const toolResult = await roundTrip("get_order_reconciliation", {});
    // A KEY scan, not a substring one: `coverage.batchScope` says the words "no actor
    // identity" out loud, which is the disclosure — the thing that must never appear is
    // an actor FIELD (D9: a member viewer never learns who moved the stock).
    const keys: string[] = [];
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v !== null && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          visit(child);
        }
      }
    };
    visit(toolResult);
    expect(keys).not.toContain("actor");
    expect(p.userCompany.findMany).toHaveBeenCalled();
  });
});

describe("MCP mock-layer parity (Task 2.6 consolidation — seam S12/CP-7)", () => {
  // WHY THIS IS STRUCTURAL, not another round-trip: the jest round-trips above run
  // against the INLINE mock, so they physically cannot detect a method missing from
  // mcp/src/prisma-mock.ts — the tsup MCP_BUILD_MOCK bundle's stand-in. The two layers
  // drift silently, and the first symptom is the SHIPPED artifact failing on a tool
  // every test suite says is green. So: compare the method SETS directly.
  const delegateShape = (client: Record<string, unknown>): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(client)
        .filter(([, value]) => value !== null && typeof value === "object")
        .map(([model, value]) => [model, Object.keys(value as object).sort()]),
    );

  const rootFunctions = (client: Record<string, unknown>): string[] =>
    Object.entries(client)
      .filter(([, value]) => typeof value === "function")
      .map(([key]) => key)
      .sort();

  it("the built-bundle mock exposes EXACTLY the inline mock's model+method surface", () => {
    expect(delegateShape(prismaMock as Record<string, unknown>)).toEqual(
      delegateShape(p as Record<string, unknown>),
    );
  });

  it("...and the same root-level client functions ($queryRaw et al)", () => {
    expect(rootFunctions(prismaMock as Record<string, unknown>)).toEqual(
      rootFunctions(p as Record<string, unknown>),
    );
  });

  // Pack C5.1 [OCk-14]: the built bundle's `$queryRaw` is now a DISPATCHER, and the
  // method-set comparison above cannot see behaviour. Both branches are asserted here,
  // through the OBJECT call form the reconciliation reads actually use
  // (`prisma.$queryRaw<T>(Prisma.sql\`…\`)`), because reading `.sql` off a template-tag
  // object is the part a string-only mock got wrong.
  it("the built-bundle mock DISPATCHES $queryRaw: a batch-summary statement answers with rows, the probe with [{ok:1}]", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mock = prismaMock as any;
    const summary = {
      sql: "WITH t AS (SELECT 1) SELECT l.batchId FROM inventory_logs l GROUP BY l.batchId",
      values: [],
    };
    await expect(mock.$queryRaw(summary)).resolves.toEqual([]);
    await expect(mock.$queryRaw({ sql: "SELECT i.id FROM external_order_items i GROUP BY i.orderId", values: [] })).resolves.toEqual([]);
    // The legacy /healthz probe is unchanged — it is neither of those statements.
    await expect(mock.$queryRaw`SELECT 1`).resolves.toEqual([{ ok: 1 }]);
  });
});
