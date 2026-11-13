// @jest-environment node
/**
 * STOCK IN'S NOTE, route side (reconciliation Part 2, pack § P2-B3-1R, R-a.4).
 *
 * The Stock In dialog's one optional Note is sent as `notes`; the route parses
 * it through `StockInSchema` (`lib/validation/inventory.ts` — NOT the supply
 * orders' schema of the same name) and writes a non-empty one to the audit
 * event's `details.notes`, where the product History shows it to admins and
 * its author (R-a.2). The REAL route and the REAL change-tracking run against
 * a deep-mocked Prisma; the 400 is read through the REAL `apiHandler`, as an
 * API caller receives it.
 *
 * Until M-b.7 the dialog still sends `orderNumber`; the schema strips it, as
 * it always has, and nothing of it is written.
 */

import { mockDeep, type DeepMockProxy } from "jest-mock-extended";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(),
  requireCSRF: jest.fn(),
}));
jest.mock("@/lib/rateLimit", () => ({
  enforceRateLimit: jest.fn(() => ({})),
  applyRateLimitHeaders: jest.fn((r: unknown) => r),
}));
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: mockDeep() }));

import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireApproved, requireCSRF } from "@/lib/api-utils";
import { StockInSchema } from "@/lib/validation/inventory";
import { POST as STOCK_IN } from "@/app/api/inventory/stock-in/route";

const db = prisma as unknown as DeepMockProxy<typeof prisma>;

function post(body: unknown): NextRequest {
  return new NextRequest("http://x/api/inventory/stock-in", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-csrf-token": "x" },
  });
}

/** The prelock's returning SELECT (lib/inventory/prelock.ts), by its text. */
function isPrelockSelect(sql: string): boolean {
  return sql.includes("FROM product_locations") && sql.includes("(productId, locationId) IN");
}

function sqlTextOf(arg: unknown): string {
  return arg && typeof arg === "object" && typeof (arg as { sql?: unknown }).sql === "string"
    ? (arg as { sql: string }).sql
    : String(arg);
}

/** A fresh transaction client: the key prelocked at version 1, every write answered. */
function makeTx() {
  const tx = mockDeep<Prisma.TransactionClient>();
  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (arg: unknown) =>
    isPrelockSelect(sqlTextOf(arg)) ? [{ productId: 5, locationId: 2, quantity: 10, version: 1 }] : []
  );
  (tx.$executeRaw as unknown as jest.Mock).mockResolvedValue(0);
  tx.product_locations.upsert.mockResolvedValue({ version: 2 } as never);
  tx.inventory_logs.create.mockResolvedValue({
    id: 1,
    productId: 5,
    locationId: 2,
    delta: 4,
    products: { name: "Widget" },
  } as never);
  tx.product.update.mockResolvedValue({} as never);
  tx.auditLog.create.mockResolvedValue({ id: 1 } as never);
  (db.$transaction as unknown as jest.Mock).mockImplementation(async (cb: (t: unknown) => unknown) =>
    cb(tx)
  );
  return tx;
}

/** Stock in through the REAL route; hand back the response and the event's details. */
async function stockIn(extra: Record<string, unknown>) {
  const tx = makeTx();
  const res = await STOCK_IN(post({ productId: 5, locationId: 2, quantity: 4, ...extra }));
  const calls = tx.auditLog.create.mock.calls;
  return {
    res,
    tx,
    details: calls.length > 0 ? (calls[0][0].data.details as Record<string, unknown>) : null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (requireApproved as jest.Mock).mockResolvedValue({
    user: { id: 7, email: "u@x.com", isApproved: true, isAdmin: false },
  });
  (requireCSRF as jest.Mock).mockResolvedValue(undefined);
  db.product.findUnique.mockResolvedValue({
    costPrice: new Prisma.Decimal("2.50"),
    name: "Widget",
  } as never);
});

describe("Stock In's Note — persisted on the event as details.notes (R-a.4)", () => {
  it("a Note is persisted, trimmed, beside the stock-in marker", async () => {
    const { res, details } = await stockIn({ notes: "  pallet 3, two boxes crushed  " });

    expect(res.status).toBe(200);
    expect(details).toMatchObject({ source: "stock-in", notes: "pallet 3, two boxes crushed" });
  });

  it("an empty or whitespace-only Note is ABSENT — never an empty string", async () => {
    for (const notes of ["", "   ", "\n\t"]) {
      const { res, details } = await stockIn({ notes });
      expect(res.status).toBe(200);
      expect(details).not.toBeNull();
      expect("notes" in (details as Record<string, unknown>)).toBe(false);
    }
  });

  it("no Note at all keeps today's details exactly", async () => {
    const { res, details } = await stockIn({});

    expect(res.status).toBe(200);
    expect(details).toEqual({
      source: "stock-in",
      productId: 5,
      delta: 4,
      locationId: 2,
      unitCostCents: 250,
    });
  });

  it("2,000 characters are accepted", async () => {
    const { res, details } = await stockIn({ notes: "n".repeat(2000) });
    expect(res.status).toBe(200);
    expect((details as Record<string, unknown>).notes).toHaveLength(2000);
  });

  it("2,001 characters are a 400 VALIDATION_ERROR, and nothing is written", async () => {
    const { res, tx } = await stockIn({ notes: "n".repeat(2001) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("a non-string Note is a 400 too", async () => {
    const { res } = await stockIn({ notes: 42 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("the dialog's orderNumber (sent until M-b.7) is still ignored: stripped at the parse, never written", async () => {
    const { res, details } = await stockIn({ orderNumber: "12345", notes: "x" });

    expect(res.status).toBe(200);
    expect(details).toMatchObject({ notes: "x" });
    expect(JSON.stringify(details)).not.toContain("12345");
    expect(StockInSchema.parse({ productId: 5, locationId: 2, quantity: 4, orderNumber: "12345" })).toEqual({
      productId: 5,
      locationId: 2,
      quantity: 4,
    });
  });
});
