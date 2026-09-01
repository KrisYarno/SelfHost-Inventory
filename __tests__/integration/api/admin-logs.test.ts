// @jest-environment node
//
// Phase C (P-C9): admin logs list + CSV export.
//  - `type` param is validated via z.nativeEnum(inventory_logs_logType): a real member
//    filters cleanly; garbage is a clean 400 (apiHandler ZodError map), never a Prisma 500.
//  - list rows + CSV gain batchId / reasonCode / unitCostCents columns.
//  - export validates BEFORE writing its DATA_EXPORT record (garbage => no side effect).
// P2-B1.5b: list rows also carry `batchRowCount` — the WHOLE batch's row count from
// ONE groupBy over the page's distinct batchIds, never shrunk by the page's filters.
import { NextRequest } from "next/server";

// Keep the REAL apiHandler (ZodError -> 400) but stub the admin guard.
jest.mock("@/lib/api-utils", () => {
  const actual = jest.requireActual("@/lib/api-utils");
  return {
    __esModule: true,
    ...actual,
    requireAdmin: jest.fn(),
  };
});

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    // groupBy is the P2-B1.5b page-count statement. ledgerRow() carries a non-null
    // batchId, so it fires in EVERY test here that reaches prisma.
    inventory_logs: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    $transaction: jest.fn(),
  },
}));

// lib/change-tracking imports next/headers at module top; replace the whole module.
jest.mock("@/lib/change-tracking", () => ({
  __esModule: true,
  recordChange: jest.fn(),
}));

import { GET as logsGET } from "@/app/api/admin/logs/route";
import { GET as exportGET } from "@/app/api/admin/logs/export/route";
import { requireAdmin } from "@/lib/api-utils";
import { recordChange } from "@/lib/change-tracking";
import prisma from "@/lib/prisma";

const m = prisma as unknown as {
  inventory_logs: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
  $transaction: jest.Mock;
};

function ledgerRow(over: Partial<any> = {}) {
  return {
    id: 1,
    changeTime: new Date("2026-06-10T12:00:00.000Z"),
    delta: 5,
    logType: "STOCK_IN",
    batchId: "11111111-1111-4111-8111-111111111111",
    reasonCode: null,
    unitCostCents: 1234,
    products: { name: "Widget" },
    users: { username: "kris" },
    locations: { name: "Shelf A" },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireAdmin as jest.Mock).mockResolvedValue({ user: { id: 1, isAdmin: true } });
  m.inventory_logs.groupBy.mockResolvedValue([]);
  m.$transaction.mockImplementation(async (cb: any) => cb({}));
});

describe("GET /api/admin/logs type validation + column exposure", () => {
  test("?type=STOCK_IN filters cleanly (where.logType = STOCK_IN)", async () => {
    m.inventory_logs.count.mockResolvedValue(1);
    m.inventory_logs.findMany.mockResolvedValue([ledgerRow()]);

    const res = await logsGET(new NextRequest("http://x/api/admin/logs?type=STOCK_IN"));
    expect(res.status).toBe(200);
    const where = (m.inventory_logs.findMany.mock.calls[0][0] as any).where;
    expect(where.logType).toBe("STOCK_IN");
  });

  test("?type=garbage => 400, not a Prisma 500", async () => {
    m.inventory_logs.count.mockResolvedValue(0);
    m.inventory_logs.findMany.mockResolvedValue([]);

    const res = await logsGET(new NextRequest("http://x/api/admin/logs?type=garbage"));
    expect(res.status).toBe(400);
    // Never reached the DB.
    expect(m.inventory_logs.findMany).not.toHaveBeenCalled();
  });

  test("response rows expose batchId / reasonCode / unitCostCents", async () => {
    m.inventory_logs.count.mockResolvedValue(1);
    m.inventory_logs.findMany.mockResolvedValue([
      ledgerRow({ reasonCode: "CORRECTION", unitCostCents: null, batchId: "abc" }),
    ]);

    const res = await logsGET(new NextRequest("http://x/api/admin/logs"));
    const body = await res.json();
    expect(body.logs[0]).toMatchObject({
      batchId: "abc",
      reasonCode: "CORRECTION",
      unitCostCents: null,
    });
  });
});

// ---------------------------------------------------------------------------
// P2-B1.5b — batchRowCount (the chip's "one of N in its batch")
// ---------------------------------------------------------------------------

describe("GET /api/admin/logs batchRowCount (P2-B1.5b)", () => {
  const BATCH_A = "11111111-1111-4111-8111-111111111111";
  const BATCH_B = "22222222-2222-4222-8222-222222222222";

  test("two rows of one batch both read the WHOLE batch's count", async () => {
    // The page shows 2 of the batch's 4 rows (a filter, or a page boundary) — the
    // chip must still say 4.
    m.inventory_logs.count.mockResolvedValue(2);
    m.inventory_logs.findMany.mockResolvedValue([
      ledgerRow({ id: 1, batchId: BATCH_A }),
      ledgerRow({ id: 2, batchId: BATCH_A }),
    ]);
    m.inventory_logs.groupBy.mockResolvedValue([{ batchId: BATCH_A, _count: { _all: 4 } }]);

    const res = await logsGET(new NextRequest("http://x/api/admin/logs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs.map((l: any) => l.batchRowCount)).toEqual([4, 4]);
  });

  test("a null-batch row reads batchRowCount null", async () => {
    m.inventory_logs.count.mockResolvedValue(2);
    m.inventory_logs.findMany.mockResolvedValue([
      ledgerRow({ id: 1, batchId: BATCH_A }),
      ledgerRow({ id: 2, batchId: null }),
    ]);
    m.inventory_logs.groupBy.mockResolvedValue([{ batchId: BATCH_A, _count: { _all: 1 } }]);

    const res = await logsGET(new NextRequest("http://x/api/admin/logs"));
    const body = await res.json();
    expect(body.logs[0].batchRowCount).toBe(1);
    expect(body.logs[1].batchRowCount).toBeNull();
  });

  test("the groupBy's where.batchId.in is the page's DISTINCT batchIds, unfiltered by the page's own where", async () => {
    m.inventory_logs.count.mockResolvedValue(3);
    m.inventory_logs.findMany.mockResolvedValue([
      ledgerRow({ id: 1, batchId: BATCH_A }),
      ledgerRow({ id: 2, batchId: BATCH_B }),
      ledgerRow({ id: 3, batchId: BATCH_A }),
      ledgerRow({ id: 4, batchId: null }),
    ]);

    await logsGET(new NextRequest("http://x/api/admin/logs?type=STOCK_IN"));

    expect(m.inventory_logs.groupBy).toHaveBeenCalledTimes(1);
    const args = m.inventory_logs.groupBy.mock.calls[0][0] as any;
    expect(args.by).toEqual(["batchId"]);
    expect(args._count).toEqual({ _all: true });
    expect(args.where.batchId.in).toEqual([BATCH_A, BATCH_B]);
    // The page's filters must NOT ride along — the count is over the whole batch.
    expect(args.where.logType).toBeUndefined();
    expect(Object.keys(args.where)).toEqual(["batchId"]);
  });

  test("a page with no batches issues NO groupBy at all", async () => {
    m.inventory_logs.count.mockResolvedValue(1);
    m.inventory_logs.findMany.mockResolvedValue([ledgerRow({ batchId: null })]);

    const res = await logsGET(new NextRequest("http://x/api/admin/logs"));
    expect(res.status).toBe(200);
    expect(m.inventory_logs.groupBy).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.logs[0].batchRowCount).toBeNull();
  });
});

describe("GET /api/admin/logs/export type validation + CSV columns", () => {
  test("?type=garbage => 400 BEFORE the DATA_EXPORT record is written", async () => {
    m.inventory_logs.findMany.mockResolvedValue([]);
    const res = await exportGET(new NextRequest("http://x/api/admin/logs/export?type=garbage"));
    expect(res.status).toBe(400);
    expect(recordChange).not.toHaveBeenCalled();
    expect(m.inventory_logs.findMany).not.toHaveBeenCalled();
  });

  test("CSV gains Batch ID / Reason Code / Unit Cost (cents) header + values", async () => {
    m.inventory_logs.findMany.mockResolvedValue([
      ledgerRow({ reasonCode: "DAMAGE", unitCostCents: 1234, batchId: "batch-1" }),
    ]);
    const res = await exportGET(new NextRequest("http://x/api/admin/logs/export?type=STOCK_IN"));
    expect(res.status).toBe(200);
    const csv = await res.text();
    const [headerLine, firstRow] = csv.split("\n");
    expect(headerLine).toContain("Batch ID");
    expect(headerLine).toContain("Reason Code");
    expect(headerLine).toContain("Unit Cost (cents)");
    expect(firstRow).toContain("batch-1");
    expect(firstRow).toContain("DAMAGE");
    expect(firstRow).toContain("1234");
    // The record ran (record-before-stream).
    expect(recordChange).toHaveBeenCalledTimes(1);
  });
});
