/**
 * @jest-environment node
 *
 * C10 — get_movement_series `breakdownBy:'product'` + the bounded batch (Task 2.4).
 *
 * The failure this closes (review #3 F7): "which products moved?" had no single-call
 * answer, so the model looped a per-product tool over the catalog — slow, expensive,
 * and wrong the moment it started ranking the results itself.
 *
 * Pins:
 *  - the FULL signed 12-bucket partition per product, with `net === SUM(delta)` holding
 *    PER ROW (the series invariant, per product);
 *  - a REQUESTED product with no movement is an ALL-ZERO row, never an absence;
 *  - ranking is SIGN-FIRST: a positive SALE row (a return) never cancels outbound;
 *  - the four G1 asserts, all rejected BEFORE the receipts branch;
 *  - unresolvable ids are NEVER queried and ARE echoed (privacy-preserving reasons);
 *  - the new list mode pages through the shared byte fitter (G2).
 */

import { mockReset, type DeepMockProxy } from "jest-mock-extended";
import { ZodError } from "zod";
import type { PrismaClient } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});
jest.mock("@/lib/products", () => ({ __esModule: true, getProductsWithQuantities: jest.fn() }));
jest.mock("@/lib/reports/low-stock", () => ({ __esModule: true, getLowStockReport: jest.fn() }));

import prisma from "@/lib/prisma";
import { assistantTools, testCtx } from "@/lib/assistant/tools";
import { resolveAssistantProducts } from "@/lib/assistant/resolve-product";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const CTX = testCtx({ companyIds: ["c1"] });

interface Catalog {
  id: number;
  name: string;
  deletedAt?: Date | null;
  approved?: boolean;
}

/**
 * ONE product.findMany delegate serves three DIFFERENT reads (the approved-id set, the
 * batch resolver, and the identity map), so the seed dispatches on the where/select
 * shape — and honors approvalStatus, which is what makes the unapproved-id fixtures
 * meaningful rather than decorative.
 */
function seedCatalog(catalog: Catalog[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.product.findMany.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    let rows = catalog.slice();
    if (where.approvalStatus === "APPROVED") rows = rows.filter((c) => c.approved !== false);
    if (where.deletedAt === null) rows = rows.filter((c) => c.deletedAt == null);
    const ids: number[] | undefined = where.id?.in;
    if (ids) rows = rows.filter((c) => ids.includes(c.id));
    return Promise.resolve(
      rows.map((c) => ({ id: c.id, name: c.name, deletedAt: c.deletedAt ?? null })),
    ) as never;
  });
}

interface LedgerRow {
  productId: number;
  delta: number;
  logType: string;
  reasonCode?: string | null;
}

function seedLedger(rows: LedgerRow[]) {
  db.inventory_logs.findMany.mockResolvedValue(
    rows.map((r) => ({ ...r, reasonCode: r.reasonCode ?? null })) as never,
  );
}

const okData = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await assistantTools.get_movement_series.run(args, CTX);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("not ok");
  return result.data as Record<string, unknown>;
};

const hintOf = async (args: Record<string, unknown>): Promise<string> => {
  try {
    await assistantTools.get_movement_series.run(args, CTX);
  } catch (err) {
    if (err instanceof ZodError) return err.errors[0]?.message ?? "";
    throw new Error(`expected a ZodError, got ${(err as Error).constructor.name}`);
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
});

describe("row integrity — the FULL partition, per product", () => {
  it("net === SUM(delta) on EVERY row, with all 11 buckets present", async () => {
    seedCatalog([
      { id: 1, name: "One" },
      { id: 2, name: "Two" },
    ]);
    seedLedger([
      { productId: 1, delta: -10, logType: "SALE" },
      { productId: 1, delta: -4, logType: "ADJUSTMENT", reasonCode: "DAMAGE" },
      { productId: 1, delta: 30, logType: "STOCK_IN" },
      { productId: 1, delta: -5, logType: "TRANSFER" },
      { productId: 2, delta: -3, logType: "COUNT" },
    ]);

    const data = await okData({ breakdownBy: "product" });
    expect(data.mode).toBe("by_product");
    const rows = data.rows as Array<Record<string, number>>;
    const byId = Object.fromEntries(rows.map((r) => [r.productId, r]));

    expect(byId[1].sale).toBe(-10);
    expect(byId[1].classifiedLoss).toBe(-4);
    expect(byId[1].stockIn).toBe(30);
    expect(byId[1].transferOut).toBe(-5);
    expect(byId[1].net).toBe(11); // -10 -4 +30 -5
    expect(byId[2].countOut).toBe(-3);
    expect(byId[2].net).toBe(-3);

    // The series invariant, held PER ROW: net is the sum of the 11 signed buckets.
    const BUCKETS = [
      "stockIn", "correctionIn", "adjustmentIn", "countIn",
      "sale", "classifiedLoss", "adjustmentUnclassified", "correctionUnclassified", "countOut",
      "transferIn", "transferOut",
    ];
    for (const row of rows) {
      expect(BUCKETS.reduce((s, k) => s + row[k], 0)).toBe(row.net);
    }
  });

  it("ranks SIGN-FIRST: a positive SALE return never cancels outbound", async () => {
    seedCatalog([
      { id: 1, name: "Churner" },
      { id: 2, name: "Steady" },
    ]);
    seedLedger([
      // Product 1 shipped 500 and took 500 back: NET zero, but it MOVED 500 out.
      { productId: 1, delta: -500, logType: "SALE" },
      { productId: 1, delta: 500, logType: "SALE" },
      { productId: 2, delta: -100, logType: "SALE" },
    ]);

    const data = await okData({ breakdownBy: "product" });
    const rows = data.rows as Array<Record<string, number>>;
    expect(rows[0].productId).toBe(1); // 500 outbound beats 100
    expect(rows[0].outboundUnits).toBe(500);
    expect(rows[0].net).toBe(0); // ...while the signed net is honestly zero
    expect(rows[1].outboundUnits).toBe(100);
  });

  it("a TRANSFER leg is NOT outbound for ranking (internal relocation, spec C10)", async () => {
    seedCatalog([
      { id: 1, name: "Mover" },
      { id: 2, name: "Shipper" },
    ]);
    seedLedger([
      { productId: 1, delta: -900, logType: "TRANSFER" },
      { productId: 2, delta: -10, logType: "SALE" },
    ]);
    const rows = (await okData({ breakdownBy: "product" })).rows as Array<Record<string, number>>;
    expect(rows[0].productId).toBe(2); // the 900-unit transfer is not depletion
    expect(rows.find((r) => r.productId === 1)!.outboundUnits).toBe(0);
    expect(rows.find((r) => r.productId === 1)!.transferOut).toBe(-900);
  });
});

describe("the bounded batch — resolution, zero rows, and the rejected echo", () => {
  it("emits an ALL-ZERO row for a REQUESTED product with no movement", async () => {
    seedCatalog([
      { id: 1, name: "Silent" },
      { id: 2, name: "Busy" },
    ]);
    seedLedger([{ productId: 2, delta: -7, logType: "SALE" }]);

    const data = await okData({ breakdownBy: "product", productIds: [1, 2] });
    const byId = Object.fromEntries(
      (data.rows as Array<Record<string, unknown>>).map((r) => [r.productId, r]),
    );
    // "TIRZ 60mg: 0 deductions recorded" — answerable in ONE call, as a real row.
    expect(byId[1]).toMatchObject({ productId: 1, name: "Silent", outboundUnits: 0, net: 0, sale: 0 });
    expect(byId[2].outboundUnits).toBe(7);
  });

  it("echoes rejected ids and NEVER queries them (unapproved and absent look identical)", async () => {
    seedCatalog([{ id: 1, name: "Real" }, { id: 2, name: "Pending", approved: false }]);
    seedLedger([{ productId: 1, delta: -2, logType: "SALE" }]);

    const data = await okData({ breakdownBy: "product", productIds: [1, 2, 4242] });
    const coverage = data.coverage as { requested: { requested: number; resolved: number; rejected: unknown[] } };
    expect(coverage.requested.requested).toBe(3);
    expect(coverage.requested.resolved).toBe(1);
    // PRIVACY: the unapproved id and the absent id give the SAME reason, so the surface
    // can never be used to probe which product ids exist but await approval.
    expect(coverage.requested.rejected).toEqual([
      { productId: 2, reason: "unknown_id" },
      { productId: 4242, reason: "unknown_id" },
    ]);
    // ...and the ledger read only ever saw the RESOLVED id.
    const ledgerArgs = db.inventory_logs.findMany.mock.calls[0][0] as {
      where: { productId: { in: number[] } };
    };
    expect(ledgerArgs.where.productId).toEqual({ in: [1] });
  });

  it("an ARCHIVED-approved id resolves for this HISTORICAL read and is tagged", async () => {
    seedCatalog([{ id: 9, name: "Archived", deletedAt: new Date("2026-01-01T00:00:00.000Z") }]);
    seedLedger([{ productId: 9, delta: -5, logType: "SALE" }]);

    const data = await okData({ breakdownBy: "product", productIds: [9] });
    const row = (data.rows as Array<Record<string, unknown>>)[0];
    expect(row.lifecycle).toBe("deleted");
    expect(row.name).toBe("Archived");
    expect(row.sale).toBe(-5);
  });

  it("the CATALOG-WIDE breakdown carries the G5 approved-id set from birth", async () => {
    seedCatalog([
      { id: 1, name: "Approved" },
      { id: 2, name: "Pending", approved: false },
    ]);
    seedLedger([{ productId: 1, delta: -2, logType: "SALE" }]);

    await okData({ breakdownBy: "product" });
    const ledgerArgs = db.inventory_logs.findMany.mock.calls[0][0] as {
      where: { productId: { in: number[] } };
    };
    // The unapproved product is filtered at the SQL boundary — never in a row, never
    // in a total, not even before Task 3.1 retrofits the reads beside this one.
    expect(ledgerArgs.where.productId).toEqual({ in: [1] });
  });

  it("filters echo the RESOLVED scope (not the request), and filters.mode === mode (T4)", async () => {
    seedCatalog([{ id: 1, name: "One" }]);
    seedLedger([]);
    // 4242 is unresolvable: it is accounted for in coverage.requested, but it must NOT
    // appear in the scope echo — that echo claims what the ROWS cover.
    const data = await okData({ breakdownBy: "product", productIds: [1, 4242], locationId: 3 });
    expect(data.filters).toEqual({
      productId: null,
      productIds: [1],
      locationId: 3,
      mode: "by_product",
    });
    expect((data.filters as { mode: string }).mode).toBe(data.mode);
    expect((data.coverage as { requested: { requested: number } }).requested.requested).toBe(2);
  });

  it("a catalog-wide breakdown echoes productIds: null (no false batch scope)", async () => {
    seedCatalog([{ id: 1, name: "One" }]);
    seedLedger([]);
    const data = await okData({ breakdownBy: "product" });
    expect(data.filters).toEqual({
      productId: null,
      productIds: null,
      locationId: null,
      mode: "by_product",
    });
  });
});

describe("G1 asserts — all four, and all BEFORE the receipts branch", () => {
  it("breakdownBy x groupBy is rejected with a hint", async () => {
    expect(await hintOf({ breakdownBy: "product", groupBy: "week" })).toMatch(/mutually exclusive/);
  });

  it("breakdownBy x receipts is rejected with a hint — the receipts branch never wins", async () => {
    // Positional proof: receipts:true is checked FIRST in the run body, so if the
    // assert ran later this call would quietly return a receipts listing instead.
    const message = await hintOf({ breakdownBy: "product", receipts: true });
    expect(message).toMatch(/receipts/);
    expect(db.inventory_logs.count).not.toHaveBeenCalled();
  });

  it("productId x productIds is rejected with a hint", async () => {
    expect(await hintOf({ breakdownBy: "product", productId: 1, productIds: [2] })).toMatch(
      /mutually exclusive/,
    );
  });

  it("productIds WITHOUT breakdownBy is rejected (REV-4 narrowing — never a silent catalog aggregate)", async () => {
    const message = await hintOf({ productIds: [1, 2] });
    expect(message).toMatch(/requires breakdownBy/);
    expect(message).toMatch(/whole-catalog aggregate/);
    // Nothing was read: the rejection happens before any branch.
    expect(db.inventory_logs.findMany).not.toHaveBeenCalled();
  });

  it("the batch is BOUNDED at 20 ids (schema-level)", async () => {
    await expect(
      assistantTools.get_movement_series.run(
        { breakdownBy: "product", productIds: Array.from({ length: 21 }, (_v, i) => i + 1) },
        CTX,
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("G2 — the new list mode pages through the shared byte fitter", () => {
  it("a tight late-turn budget shrinks the page instead of truncating", async () => {
    seedCatalog(Array.from({ length: 60 }, (_v, i) => ({ id: i + 1, name: `Product ${"x".repeat(50)} ${i + 1}` })));
    seedLedger(
      Array.from({ length: 60 }, (_v, i) => ({ productId: i + 1, delta: -(i + 1), logType: "SALE" })),
    );

    const tight = await assistantTools.get_movement_series.run(
      { breakdownBy: "product" },
      testCtx({ companyIds: ["c1"], remainingBytes: 5_000 }),
    );
    expect(tight.status).toBe("ok"); // never the last-resort truncation downgrade
    if (tight.status !== "ok") return;
    const data = tight.data as Record<string, unknown>;
    expect(data.totalRows).toBe(60);
    expect((data.rows as unknown[]).length).toBeLessThan(60);
    expect((data.rows as unknown[]).length).toBeGreaterThan(0);
    expect(data.nextOffset).not.toBeNull();
  });
});

describe("resolveAssistantProducts — the batch resolver contract (T3)", () => {
  it("dedupes, preserves input order of first occurrence, and tags lifecycle", async () => {
    seedCatalog([
      { id: 5, name: "Five" },
      { id: 3, name: "Three", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
    ]);
    const batch = await resolveAssistantProducts([5, 3, 5], { allowArchived: true });
    expect(batch.resolved).toEqual([
      { id: 5, name: "Five", lifecycle: "active" },
      { id: 3, name: "Three", lifecycle: "deleted" },
    ]);
    expect(batch.rejected).toEqual([]);
  });

  it("ALWAYS filters approvalStatus; allowArchived relaxes ONLY deletedAt", async () => {
    seedCatalog([{ id: 3, name: "Three", deletedAt: new Date("2026-01-01T00:00:00.000Z") }]);

    const strict = await resolveAssistantProducts([3]);
    expect(strict.resolved).toEqual([]);
    expect(strict.rejected).toEqual([{ productId: 3, reason: "not_visible" }]);

    const relaxed = await resolveAssistantProducts([3], { allowArchived: true });
    expect(relaxed.resolved).toHaveLength(1);

    for (const call of db.product.findMany.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({
        approvalStatus: "APPROVED",
      });
    }
  });

  it("absent and UNAPPROVED ids are indistinguishable — both unknown_id (privacy)", async () => {
    seedCatalog([{ id: 7, name: "Pending", approved: false }]);
    const batch = await resolveAssistantProducts([7, 8], { allowArchived: true });
    expect(batch.resolved).toEqual([]);
    expect(batch.rejected).toEqual([
      { productId: 7, reason: "unknown_id" },
      { productId: 8, reason: "unknown_id" },
    ]);
  });

  it("with allowArchived, not_visible is UNREACHABLE by construction", async () => {
    seedCatalog([
      { id: 1, name: "Active" },
      { id: 2, name: "Archived", deletedAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: 3, name: "Pending", approved: false },
    ]);
    const batch = await resolveAssistantProducts([1, 2, 3, 99], { allowArchived: true });
    expect(batch.rejected.every((r) => r.reason === "unknown_id")).toBe(true);
  });

  it("returns empty for an empty id list WITHOUT querying, and never throws", async () => {
    const batch = await resolveAssistantProducts([]);
    expect(batch).toEqual({ resolved: [], rejected: [] });
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});
