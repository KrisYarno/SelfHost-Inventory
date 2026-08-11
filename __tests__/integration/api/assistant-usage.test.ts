// @jest-environment node
//
// Task 3.1 — the admin assistant-usage rollup API (spec C8; contract pack T11,
// seams S13/S19; D9 = read-only GET, NO coverage-registry entry).
//
// What is under test is the ROUTE's contract:
//   - the admin gate (401 unauthenticated / 403 non-admin, surfaced by apiHandler);
//   - ONE groupBy carrying `status` as an internal FIFTH dimension, folded in JS to
//     the four C8 dimensions (userId, dayKey, model, kind);
//   - `nullUsageRequests = _count._all - _count.inputTokens`, summed across the
//     status sub-groups (the truthful-data north star: a request whose usage never
//     arrived is a spend attempt with NO token truth, never a 0);
//   - null-preserving token sums (all-null contributors stay NULL, never 0);
//   - the inclusive UTC dayKey window + the 14-day default;
//   - tool mix over assistant_runs with the retention horizon note;
//   - TOKENS ONLY (no dollar fields anywhere) and NO thread content (ids, counts,
//     and token totals only).
//
// Prisma is the GLOBAL jest.setup mock (design D2). The delegates are armed with
// literal groupBy result rows because the folding arithmetic — not Prisma — is what
// this route owns; the DB-level proof is the launch gate.

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(),
}));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdmin } from "@/lib/api-utils";
import { AppError } from "@/lib/error-handling";
import { GET as usageGET } from "@/app/api/admin/assistant-usage/route";

/* eslint-disable @typescript-eslint/no-explicit-any */

const db = prisma as unknown as Record<string, any>;
const adminMock = requireAdmin as jest.Mock;

const ADMIN = {
  id: 1,
  email: "admin@example.com",
  name: null,
  isAdmin: true,
  isApproved: true,
  defaultLocationId: 1,
};

/** 2026-08-11T09:30:00Z — a fixed "now" so the default window is arithmetic, not luck. */
const NOW = new Date("2026-08-11T09:30:00.000Z");

const HORIZON_NOTE = "newest 10,000 runs retained — window may be clipped";

type GroupRow = {
  userId: number;
  dayKey: string;
  model: string;
  kind: string;
  status: string;
  _count: { _all: number; inputTokens: number };
  _sum: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
};

function group(
  userId: number,
  dayKey: string,
  model: string,
  kind: string,
  status: string,
  counts: { all: number; withInput: number },
  sums: { input: number | null; output: number | null; total: number | null },
): GroupRow {
  return {
    userId,
    dayKey,
    model,
    kind,
    status,
    _count: { _all: counts.all, inputTokens: counts.withInput },
    _sum: { inputTokens: sums.input, outputTokens: sums.output, totalTokens: sums.total },
  };
}

function req(query = ""): NextRequest {
  return new NextRequest(`http://localhost:3000/api/admin/assistant-usage${query}`);
}

async function callUsage(query = ""): Promise<{ status: number; body: any }> {
  const res = await (usageGET as any)(req(query));
  return { status: res.status, body: await res.json() };
}

function armRequests(rows: GroupRow[]): void {
  db.assistantRequest.groupBy.mockResolvedValue(rows);
}

function armRuns(rows: Array<{ toolName: string; _count: { _all: number } }>): void {
  db.assistantRun.groupBy.mockResolvedValue(rows);
}

function armUsers(rows: Array<{ id: number; username: string; email: string }>): void {
  db.user.findMany.mockResolvedValue(rows);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(NOW);
  adminMock.mockResolvedValue({ user: ADMIN });
  armRequests([]);
  armRuns([]);
  armUsers([]);
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-usage — admin gate", () => {
  it("401s an unauthenticated caller and reads NOTHING", async () => {
    adminMock.mockRejectedValue(new AppError("Authentication required", "UNAUTHORIZED", 401));

    const { status, body } = await callUsage();

    expect(status).toBe(401);
    expect(body).toEqual({ error: "Authentication required", code: "UNAUTHORIZED" });
    expect(db.assistantRequest.groupBy).not.toHaveBeenCalled();
    expect(db.assistantRun.groupBy).not.toHaveBeenCalled();
  });

  it("403s a non-admin caller and reads NOTHING", async () => {
    adminMock.mockRejectedValue(new AppError("Admin access required", "FORBIDDEN", 403));

    const { status, body } = await callUsage();

    expect(status).toBe(403);
    expect(body).toEqual({ error: "Admin access required", code: "FORBIDDEN" });
    expect(db.assistantRequest.groupBy).not.toHaveBeenCalled();
  });

  it("admits an admin (the gate is requireAdmin, and it runs before any read)", async () => {
    const { status } = await callUsage();

    expect(status).toBe(200);
    expect(adminMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-usage — range", () => {
  it("defaults to the last 14 INCLUSIVE UTC dayKeys ending today", async () => {
    const { body } = await callUsage();

    // 2026-07-29 .. 2026-08-11 inclusive = 14 days.
    expect(body.range).toEqual({ from: "2026-07-29", to: "2026-08-11" });
    expect(db.assistantRequest.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dayKey: { gte: "2026-07-29", lte: "2026-08-11" } },
      }),
    );
  });

  it("honors explicit from/to", async () => {
    const { body } = await callUsage("?from=2026-08-01&to=2026-08-03");

    expect(body.range).toEqual({ from: "2026-08-01", to: "2026-08-03" });
    expect(db.assistantRequest.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dayKey: { gte: "2026-08-01", lte: "2026-08-03" } },
      }),
    );
  });

  it("scopes tool mix by createdAt: from 00:00:00Z inclusive to the day AFTER `to` exclusive", async () => {
    await callUsage("?from=2026-08-01&to=2026-08-03");

    expect(db.assistantRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["toolName"],
        where: {
          createdAt: {
            gte: new Date("2026-08-01T00:00:00.000Z"),
            lt: new Date("2026-08-04T00:00:00.000Z"),
          },
        },
      }),
    );
  });

  it.each([
    ["?from=yesterday", "malformed from"],
    ["?to=2026-8-3", "unpadded to"],
    ["?from=2026-02-30&to=2026-03-01", "a date that does not exist"],
    ["?from=2026-08-05&to=2026-08-01", "from after to"],
  ])("400s %s (%s)", async (query) => {
    const { status, body } = await callUsage(query);

    expect(status).toBe(400);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(db.assistantRequest.groupBy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-usage — token rollups", () => {
  it("groups by the four C8 dimensions PLUS status, in ONE query, counting _all and inputTokens", async () => {
    await callUsage();

    expect(db.assistantRequest.groupBy).toHaveBeenCalledTimes(1);
    const args = db.assistantRequest.groupBy.mock.calls[0][0];
    expect(args.by).toEqual(["userId", "dayKey", "model", "kind", "status"]);
    expect(args._count).toEqual({ _all: true, inputTokens: true });
    expect(args._sum).toEqual({ inputTokens: true, outputTokens: true, totalTokens: true });
  });

  it("folds the status dimension away and emits EXACTLY the T11 row shape", async () => {
    armRequests([
      group(7, "2026-08-10", "claude-x", "chat", "ok", { all: 3, withInput: 3 }, { input: 300, output: 90, total: 390 }),
    ]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups).toHaveLength(1);
    expect(Object.keys(body.tokenRollups[0]).sort()).toEqual(
      [
        "aborted",
        "dayKey",
        "displayName",
        "errored",
        "inputTokens",
        "kind",
        "model",
        "nullUsageRequests",
        "outputTokens",
        "requests",
        "running",
        "totalTokens",
        "userId",
      ].sort(),
    );
    expect(body.tokenRollups[0]).toEqual({
      userId: 7,
      displayName: "kris",
      dayKey: "2026-08-10",
      model: "claude-x",
      kind: "chat",
      requests: 3,
      inputTokens: 300,
      outputTokens: 90,
      totalTokens: 390,
      aborted: 0,
      errored: 0,
      running: 0,
      nullUsageRequests: 0,
    });
  });

  it("sums the status sub-groups into one row: requests, aborted, errored, running", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "chat", "ok", { all: 4, withInput: 4 }, { input: 40, output: 20, total: 60 }),
      group(7, "2026-08-10", "m", "chat", "aborted", { all: 2, withInput: 1 }, { input: 5, output: 1, total: 6 }),
      group(7, "2026-08-10", "m", "chat", "error", { all: 3, withInput: 0 }, { input: null, output: null, total: null }),
      group(7, "2026-08-10", "m", "chat", "running", { all: 1, withInput: 0 }, { input: null, output: null, total: null }),
    ]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups).toHaveLength(1);
    expect(body.tokenRollups[0]).toMatchObject({
      requests: 10,
      aborted: 2,
      errored: 3,
      running: 1,
      inputTokens: 45,
      outputTokens: 21,
      totalTokens: 66,
    });
  });

  it("derives nullUsageRequests as _count._all - _count.inputTokens across every status sub-group", async () => {
    armRequests([
      // 4 ok rows, only 3 of which reported usage.
      group(7, "2026-08-10", "m", "chat", "ok", { all: 4, withInput: 3 }, { input: 30, output: 9, total: 39 }),
      // 2 aborted rows, neither reported usage.
      group(7, "2026-08-10", "m", "chat", "aborted", { all: 2, withInput: 0 }, { input: null, output: null, total: null }),
    ]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups[0].nullUsageRequests).toBe(3);
    expect(body.tokenRollups[0].requests).toBe(6);
  });

  it("keeps token sums NULL when EVERY contributing value is null (never 0)", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "title", "error", { all: 2, withInput: 0 }, { input: null, output: null, total: null }),
      group(7, "2026-08-10", "m", "title", "running", { all: 1, withInput: 0 }, { input: null, output: null, total: null }),
    ]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups[0].inputTokens).toBeNull();
    expect(body.tokenRollups[0].outputTokens).toBeNull();
    expect(body.tokenRollups[0].totalTokens).toBeNull();
    expect(body.tokenRollups[0].nullUsageRequests).toBe(3);
    expect(body.tokenRollups[0].requests).toBe(3);
  });

  it("a partially-null column sums the reported values only (null contributors are skipped, not zeroed)", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "chat", "ok", { all: 1, withInput: 1 }, { input: 100, output: 10, total: 110 }),
      group(7, "2026-08-10", "m", "chat", "error", { all: 1, withInput: 0 }, { input: null, output: null, total: null }),
    ]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      nullUsageRequests: 1,
    });
  });

  it("keeps chat and title separate rows (kind is a dimension, not a filter)", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "chat", "ok", { all: 1, withInput: 1 }, { input: 100, output: 10, total: 110 }),
      group(7, "2026-08-10", "m", "title", "ok", { all: 1, withInput: 1 }, { input: 8, output: 4, total: 12 }),
    ]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups.map((r: any) => r.kind).sort()).toEqual(["chat", "title"]);
  });

  it("orders rows newest-day first, then userId / model / kind (deterministic)", async () => {
    armRequests([
      group(9, "2026-08-09", "b", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
      group(7, "2026-08-10", "b", "title", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
      group(7, "2026-08-10", "a", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
      group(7, "2026-08-10", "b", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
    ]);
    armUsers([
      { id: 7, username: "kris", email: "kris@example.com" },
      { id: 9, username: "sam", email: "sam@example.com" },
    ]);

    const { body } = await callUsage("?from=2026-08-09&to=2026-08-10");

    expect(body.tokenRollups.map((r: any) => [r.dayKey, r.userId, r.model, r.kind])).toEqual([
      ["2026-08-10", 7, "a", "chat"],
      ["2026-08-10", 7, "b", "chat"],
      ["2026-08-10", 7, "b", "title"],
      ["2026-08-09", 9, "b", "chat"],
    ]);
  });

  it("returns an EMPTY rollup array when nothing ran (no zero-filled rows invented)", async () => {
    const { body } = await callUsage();

    expect(body.tokenRollups).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-usage — display names", () => {
  it("resolves names with ONE separate bare-userId query", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
      group(9, "2026-08-10", "m", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
      group(7, "2026-08-09", "m", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
    ]);
    armUsers([
      { id: 7, username: "kris", email: "kris@example.com" },
      { id: 9, username: "sam", email: "sam@example.com" },
    ]);

    const { body } = await callUsage("?from=2026-08-09&to=2026-08-10");

    expect(db.user.findMany).toHaveBeenCalledTimes(1);
    const args = db.user.findMany.mock.calls[0][0];
    expect(args.where.id.in.slice().sort()).toEqual([7, 9]);
    expect(body.tokenRollups.every((r: any) => typeof r.displayName === "string")).toBe(true);
  });

  it("names an unresolvable user by its id rather than inventing one", async () => {
    armRequests([
      group(404, "2026-08-10", "m", "chat", "ok", { all: 1, withInput: 1 }, { input: 1, output: 1, total: 2 }),
    ]);
    armUsers([]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.tokenRollups[0].displayName).toBe("User 404");
  });
});

// ---------------------------------------------------------------------------
// Tool mix
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-usage — tool mix", () => {
  it("rolls assistant_runs up by toolName, busiest first, with the retention horizon note", async () => {
    armRuns([
      { toolName: "get_stock", _count: { _all: 4 } },
      { toolName: "list_products", _count: { _all: 11 } },
      { toolName: "get_shrinkage", _count: { _all: 4 } },
    ]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");

    expect(body.toolMix).toEqual([
      { toolName: "list_products", calls: 11 },
      { toolName: "get_shrinkage", calls: 4 },
      { toolName: "get_stock", calls: 4 },
    ]);
    expect(body.horizonNote).toBe(HORIZON_NOTE);
  });

  it("returns an empty tool mix — and STILL the horizon note — when nothing ran", async () => {
    const { body } = await callUsage();

    expect(body.toolMix).toEqual([]);
    expect(body.horizonNote).toBe(HORIZON_NOTE);
  });
});

// ---------------------------------------------------------------------------
// The two standing prohibitions
// ---------------------------------------------------------------------------

describe("GET /api/admin/assistant-usage — tokens only, no thread content", () => {
  it("carries NO dollar/cost/price field anywhere in the response", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "chat", "ok", { all: 2, withInput: 2 }, { input: 100, output: 20, total: 120 }),
    ]);
    armRuns([{ toolName: "get_stock", _count: { _all: 3 } }]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");
    const serialized = JSON.stringify(body);

    expect(serialized).not.toMatch(/\$/);
    expect(serialized).not.toMatch(/cost|price|usd|dollar|cents|spendUsd/i);
  });

  it("carries NO thread content: no threadId, title, parts, message, or prompt fields", async () => {
    armRequests([
      group(7, "2026-08-10", "m", "chat", "ok", { all: 2, withInput: 2 }, { input: 100, output: 20, total: 120 }),
    ]);
    armRuns([{ toolName: "get_stock", _count: { _all: 3 } }]);
    armUsers([{ id: 7, username: "kris", email: "kris@example.com" }]);

    const { body } = await callUsage("?from=2026-08-10&to=2026-08-10");
    const serialized = JSON.stringify(body);

    expect(serialized).not.toMatch(/threadId|"title"|"parts"|"messages"|"prompt"|"content"/i);
    expect(Object.keys(body).sort()).toEqual(["horizonNote", "range", "toolMix", "tokenRollups"].sort());
  });

  it("never SELECTs thread or message rows at all", async () => {
    await callUsage();

    expect(db.assistantThread.findMany).not.toHaveBeenCalled();
    expect(db.assistantMessage.findMany).not.toHaveBeenCalled();
    expect(db.assistantMessage.groupBy).not.toHaveBeenCalled();
  });
});
