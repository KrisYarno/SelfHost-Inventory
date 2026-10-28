/**
 * @jest-environment node
 *
 * Lane 4 trunk contract: the shared read-tool layer (lib/assistant/tools.ts).
 * Covers spec §5's tool-layer assertions: schema rejection (bad dates/ids/window),
 * caps + DB-level `take`, company isolation (empty -> empty + note), find_product
 * APPROVED-only, Decimal serialization, and the 32KB discriminated truncation result.
 *
 * The lib data layer is mocked so the tests pin the TOOL's contract (filters, bounds,
 * scope, serialization) rather than re-testing the underlying services. prisma is
 * deep-mocked for get_stock's direct product_locations read + getLowStockDefault.
 */

import { mockDeep, mockReset, type DeepMockProxy } from "jest-mock-extended";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

jest.mock("@/lib/prisma", () => {
  const { mockDeep: md } = require("jest-mock-extended");
  return { __esModule: true, default: md() };
});

jest.mock("@/lib/products", () => ({
  __esModule: true,
  getProductsWithQuantities: jest.fn(),
}));

jest.mock("@/lib/analytics/queries", () => ({
  __esModule: true,
  getSales: jest.fn(),
  getStockSeries: jest.fn(),
  getOperationsRows: jest.fn(),
  getShrinkageSummary: jest.fn(),
  getValuationSummary: jest.fn(),
}));

jest.mock("@/lib/reports/low-stock", () => ({
  __esModule: true,
  getLowStockReport: jest.fn(),
}));

// get_inventory_summary delegates valuation to getValuation (which itself reads prisma).
// Mock it so the summary byte-budget test drives the REAL inventory-summary module over
// deep-mocked prisma without recomputing valuation.
jest.mock("@/lib/analytics/valuation", () => ({
  __esModule: true,
  getValuation: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { assistantTools, remainingRowsOf, TURN_RESULT_BUDGET_BYTES, testCtx } from "@/lib/assistant/tools";
import { getProductsWithQuantities } from "@/lib/products";
import {
  getSales,
  getStockSeries,
  getOperationsRows,
} from "@/lib/analytics/queries";
import { getLowStockReport } from "@/lib/reports/low-stock";
import { getValuation } from "@/lib/analytics/valuation";

const db = prisma as unknown as DeepMockProxy<PrismaClient>;
const mockGetProducts = getProductsWithQuantities as jest.Mock;
const mockGetSales = getSales as jest.Mock;
const mockGetStockSeries = getStockSeries as jest.Mock;
const mockGetOperations = getOperationsRows as jest.Mock;
const mockGetLowStock = getLowStockReport as jest.Mock;
const mockGetValuation = getValuation as jest.Mock;

const CTX = testCtx({ companyIds: ["c1"] });
const CTX_NO_COMPANY = testCtx({ companyIds: [] });

/** A2 C16: `mode` is the run's own ('nightly' | 'full' | 'backfill'); unnamed = a nightly. */
type RunRow = { status: string; startedAt: Date; finishedAt: Date | null; skippedReason: string | null; mode?: string };
type RunQuery = {
  where?: Record<string, unknown>;
  orderBy?: Record<string, string>;
  take?: number;
  select?: Record<string, boolean>;
};
/**
 * A2 C15: the sales run table, answered QUERY-FAITHFULLY — `where` (equality, `in`, `gt`, and
 * `not` with SQL's NULL rule: a NULL column never matches `<>`), `orderBy` startedAt, `take`
 * and `select` — so a read that asks the wrong question gets the wrong answer here too. An
 * operator it does not model throws rather than matching silently.
 */
function seedRuns(runs: RunRow[]) {
  const scalar = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  const holds = (field: unknown, cond: unknown): boolean =>
    cond === null || typeof cond !== "object" || cond instanceof Date
      ? scalar(field) === scalar(cond)
      : Object.entries(cond).every(([op, arg]) => {
          if (op === "in") return (arg as unknown[]).some((v) => scalar(v) === scalar(field));
          if (op === "gt") return field != null && (scalar(field) as number) > (scalar(arg) as number);
          if (op === "not") return arg === null ? field != null : field != null && scalar(field) !== scalar(arg);
          throw new Error(`run fake: unmodelled operator ${op}`);
        });
  const query = ({ where = {}, orderBy, take, select }: RunQuery = {}) => {
    const rows: Array<Record<string, unknown>> = runs
      .map((run) => ({ job: "sales", mode: "nightly", ...run }))
      .filter((run: Record<string, unknown>) =>
        Object.entries(where).every(([key, cond]) => holds(run[key], cond)),
      );
    for (const [key, dir] of Object.entries(orderBy ?? {})) {
      if (key !== "startedAt") throw new Error(`run fake: unmodelled orderBy ${key}`);
      const sign = dir === "asc" ? 1 : -1;
      rows.sort((a, b) => sign * ((a.startedAt as Date).getTime() - (b.startedAt as Date).getTime()));
    }
    const page = take == null ? rows : rows.slice(0, take);
    if (!select) return page;
    const keys = Object.keys(select).filter((k) => select[k]);
    return page.map((row) => Object.fromEntries(keys.map((k) => [k, row[k]])));
  };
  db.analyticsRebuildRun.findFirst.mockImplementation(
    (async (args?: RunQuery) => query({ ...args, take: 1 })[0] ?? null) as never,
  );
  db.analyticsRebuildRun.findMany.mockImplementation((async (args?: RunQuery) => query(args)) as never);
}
/** A2 C15: neither run-history read was issued. */
function expectNoRunRead() {
  expect(db.analyticsRebuildRun.findFirst).not.toHaveBeenCalled();
  expect(db.analyticsRebuildRun.findMany).not.toHaveBeenCalled();
}

function product(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "TIRZ 10mg",
    baseName: "TIRZ",
    variant: "10mg",
    currentQuantity: 42,
    lowStockThreshold: 5,
    approvalStatus: "APPROVED",
    ...over,
  };
}

beforeEach(() => {
  mockReset(db);
  jest.clearAllMocks();
  // getLowStockDefault -> systemSetting.findUnique (real stock-threshold runs).
  db.systemSetting.findUnique.mockResolvedValue(null as never);
  db.product_locations.findMany.mockResolvedValue([] as never);
  mockGetStockSeries.mockResolvedValue([]);
  // W0-PROD: get_stock now resolves productId via resolveAssistantProduct
  // (prisma.product.findFirst). Default to an approved product so the happy paths
  // reach the series read; the schema-rejection tests throw before this is hit.
  db.product.findFirst.mockResolvedValue({ id: 1, name: "TIRZ 10mg" } as never);
  // W0-STOCK: the series is paged on DISTINCT DAYS (productStockSnapshot.groupBy) and
  // location names come from the locations table. Benign empties by default.
  db.productStockSnapshot.groupBy.mockResolvedValue([] as never);
  db.location.findMany.mockResolvedValue([] as never);
  // G2-6: find_product OMITS a matched product whose lifecycle it cannot read (it never
  // synthesizes "active"), so the shared identity lookup — prisma.product.findMany over
  // the ids just fetched — has to answer here. Id-less reads (the approved-id set) keep
  // returning [] exactly as before.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.product.findMany.mockImplementation((args: any) =>
    Promise.resolve(
      ((args?.where?.id?.in ?? []) as number[]).map((id) => ({
        id,
        name: `product ${id}`,
        deletedAt: null,
      })),
    ) as never,
  );
});

describe("find_product: APPROVED-only + caps", () => {
  it("passes approvalStatus:'APPROVED' and the ≤20 pageSize to the products service", async () => {
    mockGetProducts.mockResolvedValue({ products: [product()], total: 1 });

    const result = await assistantTools.find_product.run({ query: "TIRZ" }, CTX);

    expect(result.status).toBe("ok");
    const filters = mockGetProducts.mock.calls[0][0];
    expect(filters).toMatchObject({ search: "TIRZ", approvalStatus: "APPROVED", pageSize: 20, page: 1 });
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { products: unknown[] }).products).toHaveLength(1);
    }
  });

  it("honors an explicit limit within the ≤20 cap (paginated at the tool boundary)", async () => {
    const many = Array.from({ length: 12 }, (_, i) => product({ id: i }));
    mockGetProducts.mockResolvedValue({ products: many, total: 12 });
    const result = await assistantTools.find_product.run({ query: "abc", limit: 5 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as { products: unknown[]; returned: number; nextOffset: number | null };
      expect(data.products).toHaveLength(5);
      expect(data.returned).toBe(5);
      expect(data.nextOffset).toBe(5);
    }
  });

  it("rejects a limit above the cap (schema)", async () => {
    await expect(assistantTools.find_product.run({ query: "abc", limit: 999 }, CTX)).rejects.toThrow();
  });

  // G2-6: the old `?? "active"` default was a SYNTHESIZED lifecycle — sound only under an
  // assumption the code cannot check. A product whose identity did not come back is now
  // omitted and COUNTED, so a reader is told the list is short rather than handed a row
  // claiming a state nobody read.
  it("OMITS a matched product whose lifecycle could not be read, and counts it (never 'active')", async () => {
    mockGetProducts.mockResolvedValue({
      products: [product({ id: 1 }), product({ id: 2 })],
      total: 2,
    });
    // The identity read answers for #1 only — #2's lifecycle is unknown.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.product.findMany.mockImplementation((_args: any) =>
      Promise.resolve([{ id: 1, name: "Known", deletedAt: null }]) as never,
    );

    const result = await assistantTools.find_product.run({ query: "abc" }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as {
      products: Array<{ id: number; lifecycle: string }>;
      coverage: { matched: number; identityMisses: number; identityNote?: string };
    };
    expect(data.products.map((p) => p.id)).toEqual([1]);
    expect(data.products[0].lifecycle).toBe("active");
    // The gap is DISCLOSED: matched still says 2, and the miss is counted + explained.
    expect(data.coverage.matched).toBe(2);
    expect(data.coverage.identityMisses).toBe(1);
    expect(data.coverage.identityNote).toContain("never guesses");
  });

  // FD-3: the omission above and PAGING are the same mechanism seen twice. `nextOffset`
  // was counted in EMITTED rows, so one omitted identity made the cursor point back at a
  // source row this page already consumed AND stop being a multiple of `limit` — and
  // `assertPageAligned` REJECTS a non-aligned offset, so the tool handed back a cursor its
  // own schema refuses. The cursor counts SOURCE rows: the page it names is the next one.
  it("nextOffset stays a LEGAL, non-overlapping cursor when page 1 omits an identity", async () => {
    const CATALOG = [1, 2, 3, 4, 5, 6].map((id) => product({ id, name: `Product ${id}` }));
    // Page-aware source: exactly what getProductsWithQuantities does with page/pageSize.
    mockGetProducts.mockImplementation(
      (filters: { page: number; pageSize: number }) => ({
        products: CATALOG.slice(
          (filters.page - 1) * filters.pageSize,
          filters.page * filters.pageSize,
        ),
        total: CATALOG.length,
      }),
    );
    // Product #2's lifecycle cannot be read — the row is omitted, never synthesized.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.product.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        ((args?.where?.id?.in ?? []) as number[])
          .filter((id) => id !== 2)
          .map((id) => ({ id, name: `Product ${id}`, deletedAt: null })),
      ) as never,
    );

    const first = await assistantTools.find_product.run({ query: "product", limit: 3 }, CTX);
    if (first.status !== "ok") throw new Error("page 1 not ok");
    const page1 = first.data as {
      products: Array<{ id: number }>;
      returned: number;
      totalRows: number;
      nextOffset: number | null;
      coverage: { identityMisses: number };
    };

    // The omission itself is unchanged: two rows, the gap counted.
    expect(page1.products.map((p) => p.id)).toEqual([1, 3]);
    expect(page1.returned).toBe(2);
    expect(page1.coverage.identityMisses).toBe(1);
    // The cursor names SOURCE rows consumed (3), not emitted rows (2) — and 3 is a legal
    // page-aligned offset for limit 3, which 2 is not.
    expect(page1.nextOffset).toBe(3);

    // ...and CALLING it works: the schema's page-alignment assert accepts it, and the
    // page it returns is the NEXT one — no row repeated, none skipped.
    const second = await assistantTools.find_product.run(
      { query: "product", limit: 3, offset: page1.nextOffset! },
      CTX,
    );
    if (second.status !== "ok") throw new Error("page 2 not ok");
    const page2 = second.data as { products: Array<{ id: number }>; nextOffset: number | null };
    expect(page2.products.map((p) => p.id)).toEqual([4, 5, 6]);
    expect(page2.products.map((p) => p.id)).not.toContain(1);
    expect(page2.products.map((p) => p.id)).not.toContain(3);
    // Six source rows consumed of six matched: the walk terminates.
    expect(page2.nextOffset).toBeNull();
  });

  it("a page of NOTHING BUT omitted rows still advances the cursor (never a stuck walk)", async () => {
    const CATALOG = [1, 2, 3, 4].map((id) => product({ id, name: `Product ${id}` }));
    mockGetProducts.mockImplementation((filters: { page: number; pageSize: number }) => ({
      products: CATALOG.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize),
      total: CATALOG.length,
    }));
    // NOTHING on page 1 resolves; page 2 resolves normally.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.product.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        ((args?.where?.id?.in ?? []) as number[])
          .filter((id) => id > 2)
          .map((id) => ({ id, name: `Product ${id}`, deletedAt: null })),
      ) as never,
    );

    const first = await assistantTools.find_product.run({ query: "product", limit: 2 }, CTX);
    if (first.status !== "ok") throw new Error("page 1 not ok");
    const page1 = first.data as {
      products: unknown[];
      nextOffset: number | null;
      coverage: { identityMisses: number };
    };
    expect(page1.products).toEqual([]);
    expect(page1.coverage.identityMisses).toBe(2);
    // An empty page whose cursor did not move is an infinite walk; it moves past both.
    expect(page1.nextOffset).toBe(2);

    const second = await assistantTools.find_product.run(
      { query: "product", limit: 2, offset: page1.nextOffset! },
      CTX,
    );
    if (second.status !== "ok") throw new Error("page 2 not ok");
    expect((second.data as { products: Array<{ id: number }> }).products.map((p) => p.id)).toEqual([
      3, 4,
    ]);
  });

  // FD2-4: the OTHER way this page shortens. FD-3 fixed the cursor for OMITTED rows (it
  // counts source rows), but a BYTE-TRUNCATED page consumes a source index that is not a
  // whole page — and `assertPageAligned` rejects any offset that is not a multiple of
  // `limit`, so the tool handed back a cursor its own schema refuses. Exactly the FD-3
  // defect, reached through the byte fitter instead of the identity lookup.
  it("nextOffset stays page-ALIGNED when the byte fit truncates the page (and the walk continues)", async () => {
    // Rows fat enough that the 4 KiB floor cannot hold a whole page of them.
    const CATALOG = Array.from({ length: 12 }, (_, i) =>
      product({ id: i + 1, name: `Product ${i + 1} ` + "x".repeat(1200) }),
    );
    mockGetProducts.mockImplementation((filters: { page: number; pageSize: number }) => ({
      products: CATALOG.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize),
      total: CATALOG.length,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.product.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        ((args?.where?.id?.in ?? []) as number[]).map((id) => ({
          id,
          name: `Product ${id}`,
          deletedAt: null,
        })),
      ) as never,
    );

    // A tight late-turn budget, so the page shrinks instead of the result being discarded.
    const TIGHT = testCtx({ companyIds: ["c1"], remainingBytes: 5_000 });
    const first = await assistantTools.find_product.run({ query: "product", limit: 4 }, TIGHT);
    if (first.status !== "ok") throw new Error("page 1 not ok");
    const page1 = first.data as { products: unknown[]; returned: number; nextOffset: number | null };

    // The fitter really did shorten this page — otherwise the test proves nothing.
    expect(page1.returned).toBeLessThan(4);
    expect(page1.returned).toBeGreaterThan(0);
    // ...and the cursor it hands back is a LEGAL offset for this limit.
    expect(page1.nextOffset).not.toBeNull();
    expect(page1.nextOffset! % 4).toBe(0);

    // Calling it is accepted by the same schema assert, and the walk terminates.
    let offset = page1.nextOffset!;
    for (let hop = 0; hop < 5 && offset != null; hop += 1) {
      const next = await assistantTools.find_product.run({ query: "product", limit: 4, offset }, TIGHT);
      if (next.status !== "ok") throw new Error(`page at offset ${offset} not ok`);
      const page = next.data as { nextOffset: number | null };
      if (page.nextOffset == null) {
        offset = null as unknown as number;
        break;
      }
      expect(page.nextOffset % 4).toBe(0);
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(offset).toBeNull();
  });

  // FD3-2: FD2-4 made the truncated page's cursor LEGAL by skipping to the next whole
  // page — and left the skip SILENT. `returned < limit` was the only signal, which a
  // caller cannot distinguish from "the identity lookup dropped one" or "the source had
  // fewer rows", and following `nextOffset` then walks past matched products that were
  // never delivered. The loss is now counted and the repair is spelled out.
  describe("FD3-2 byte-truncated pages disclose the rows they dropped", () => {
    /** 12 fat products; a 5 KB late-turn budget holds only a couple of them per page. */
    function seedFatCatalog() {
      const CATALOG = Array.from({ length: 12 }, (_, i) =>
        product({ id: i + 1, name: `Product ${i + 1} ` + "x".repeat(1200) }),
      );
      mockGetProducts.mockImplementation((filters: { page: number; pageSize: number }) => ({
        products: CATALOG.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize),
        total: CATALOG.length,
      }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.product.findMany.mockImplementation((args: any) =>
        Promise.resolve(
          ((args?.where?.id?.in ?? []) as number[]).map((id) => ({
            id,
            name: `Product ${id}`,
            deletedAt: null,
          })),
        ) as never,
      );
      return CATALOG;
    }

    const TIGHT = () => testCtx({ companyIds: ["c1"], remainingBytes: 5_000 });

    type FindPage = {
      products: Array<{ id: number }>;
      returned: number;
      totalRows: number;
      nextOffset: number | null;
      coverage: { byteSkipped?: number; byteNote?: string; identityMisses: number };
    };

    it("counts the skipped SOURCE rows and names the retry that recovers them", async () => {
      seedFatCatalog();
      const result = await assistantTools.find_product.run({ query: "product", limit: 4 }, TIGHT());
      if (result.status !== "ok") throw new Error("not ok");
      const page = result.data as FindPage;

      // The fit really did shorten the page (otherwise the test proves nothing)...
      expect(page.returned).toBeLessThan(4);
      // ...and the rows the aligned cursor skips are COUNTED, not left to be inferred.
      expect(page.coverage.byteSkipped).toBe(4 - page.returned);
      expect(page.coverage.byteNote).toBeDefined();
      // The note is executable guidance: the same offset, a page small enough to fit.
      expect(page.coverage.byteNote).toMatch(/offset 0 and limit 2/);
      expect(page.coverage.byteNote).toMatch(/byte budget/i);
    });

    it("a walk that FOLLOWS the retry guidance reaches every matched source row", async () => {
      const CATALOG = seedFatCatalog();
      const seen = new Set<number>();
      let offset = 0;
      let limit = 4;
      // Bounded: 12 rows, so no legal walk needs more hops than that.
      for (let hop = 0; hop < 20; hop += 1) {
        const result = await assistantTools.find_product.run({ query: "product", limit, offset }, TIGHT());
        if (result.status !== "ok") throw new Error(`page at offset ${offset} not ok`);
        const page = result.data as FindPage;
        for (const row of page.products) seen.add(row.id);
        if (page.coverage.byteSkipped) {
          // Follow the note VERBATIM: same offset, the limit it names.
          const retry = /offset (\d+) and limit (\d+)/.exec(page.coverage.byteNote ?? "");
          if (!retry) throw new Error(`no retry guidance in: ${page.coverage.byteNote}`);
          expect(Number(retry[1])).toBe(offset);
          offset = Number(retry[1]);
          limit = Number(retry[2]);
          continue;
        }
        if (page.nextOffset == null) break;
        offset = page.nextOffset;
      }
      // Nothing was lost: every matched product was delivered somewhere in the walk.
      expect(Array.from(seen).sort((x, y) => x - y)).toEqual(CATALOG.map((p) => p.id));
    });

    it("byteSkipped and identityMisses never double-count the SAME dropped row", async () => {
      seedFatCatalog();
      // Product 4 (last of page 1) has no readable identity: it is OMITTED, and the byte
      // fit then drops one of the three rows that were ready. Two products are missing
      // from this page for two DIFFERENT reasons, and each counter owns one of them —
      // counting the omitted row as byte-skipped too would tell the reader three are gone.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db.product.findMany.mockImplementation((args: any) =>
        Promise.resolve(
          ((args?.where?.id?.in ?? []) as number[])
            .filter((id) => id !== 4)
            .map((id) => ({ id, name: `Product ${id}`, deletedAt: null })),
        ) as never,
      );

      const result = await assistantTools.find_product.run({ query: "product", limit: 4 }, TIGHT());
      if (result.status !== "ok") throw new Error("not ok");
      const page = result.data as FindPage;

      expect(page.coverage.identityMisses).toBe(1);
      expect(page.coverage.byteSkipped).toBe(3 - page.returned);
      expect(page.coverage.byteSkipped! + page.coverage.identityMisses).toBe(4 - page.returned);
    });

    it("a page that fits carries NO byteSkipped/byteNote keys at all", async () => {
      mockGetProducts.mockResolvedValue({ products: [product()], total: 1 });
      const result = await assistantTools.find_product.run({ query: "abc" }, CTX);
      if (result.status !== "ok") throw new Error("not ok");
      const coverage = (result.data as FindPage).coverage;
      expect(coverage.byteSkipped).toBeUndefined();
      expect(coverage.byteNote).toBeUndefined();
    });
  });

  it("reports identityMisses: 0 on the normal path (a defined field, not a conditional one)", async () => {
    mockGetProducts.mockResolvedValue({ products: [product()], total: 1 });
    const result = await assistantTools.find_product.run({ query: "abc" }, CTX);
    if (result.status !== "ok") throw new Error("not ok");
    const coverage = (result.data as { coverage: Record<string, unknown> }).coverage;
    expect(coverage.identityMisses).toBe(0);
    expect(coverage.identityNote).toBeUndefined();
  });

  it("rejects a too-short query (schema)", async () => {
    await expect(assistantTools.find_product.run({ query: "a" }, CTX)).rejects.toThrow();
  });

  it("paginates a large match set: a page of rows + nextOffset, never an empty truncation (D-T7)", async () => {
    const many = Array.from({ length: 4000 }, (_, i) =>
      product({ id: i, name: `Product-${i}-` + "x".repeat(40) }),
    );
    mockGetProducts.mockResolvedValue({ products: many, total: many.length });

    const result = await assistantTools.find_product.run({ query: "prod" }, CTX);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as {
        products: unknown[];
        returned: number;
        totalRows: number;
        nextOffset: number | null;
      };
      expect(data.products.length).toBeGreaterThan(0);
      expect(data.products.length).toBeLessThanOrEqual(20); // FIND_PRODUCT_MAX
      expect(data.returned).toBe(data.products.length);
      expect(data.nextOffset).not.toBeNull();
      expect(result.meta.bytes).toBeLessThanOrEqual(TURN_RESULT_BUDGET_BYTES);
      expect(result.meta.scope).toBe("global");
    }
  });
});

describe("get_stock: DB-level take + window validation", () => {
  it("passes a bounded `take` to getStockSeries and labels scope global", async () => {
    db.product_locations.findMany.mockResolvedValue([
      { locationId: 1, quantity: 30 },
      { locationId: 2, quantity: 12 },
    ] as never);
    // >= 1 distinct day so the day-grouped page actually fetches series rows.
    db.productStockSnapshot.groupBy.mockResolvedValue([{ dayKey: "2026-01-01" }] as never);
    db.location.findMany.mockResolvedValue([
      { id: 1, name: "Main" },
      { id: 2, name: "Back" },
    ] as never);

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);

    expect(result.status).toBe("ok");
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    // FIX 1(d): the points fetch probes ONE past the cap (STOCK_SERIES_MAX_ROWS + 1 =
    // 1001) so an overflow is detectable and trimmed on whole-day boundaries.
    expect(seriesArg.take).toBe(1001);
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { currentStock: number }).currentStock).toBe(42);
    }
  });

  it("returns notFound (never currentStock:0) for a non-approved / absent productId (W0-PROD)", async () => {
    db.product.findFirst.mockResolvedValue(null as never);
    const result = await assistantTools.get_stock.run({ productId: 424242 }, CTX);
    expect(result).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining("424242") },
    });
    // The series/stock reads never ran — the id was rejected up front.
    expect(mockGetStockSeries).not.toHaveBeenCalled();
  });

  it("names the scalar 'locationStock' (not currentStock) on a location-scoped read", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 2, quantity: 9 }] as never);
    const result = await assistantTools.get_stock.run({ productId: 1, locationId: 2 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as Record<string, unknown>;
      expect(data.locationStock).toBe(9);
      expect(data).not.toHaveProperty("currentStock");
      expect(data.locationId).toBe(2);
    }
  });

  it("seriesCoverage.complete is false + omitted>0 when older days overflow the day cap", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    // 400 distinct days: the DISTINCT-day count drives totalDays; the paged fetch honors
    // skip/take (max 366 days), so 34 older days are omitted with complete:false.
    const manyDays = Array.from({ length: 400 }, (_, i) => ({ dayKey: `2020-01-${i}` }));
    db.productStockSnapshot.groupBy.mockImplementation((arg: unknown) => {
      const a = arg as { skip?: number; take?: number };
      return Promise.resolve(
        a && a.take != null ? manyDays.slice(a.skip ?? 0, (a.skip ?? 0) + a.take) : manyDays,
      ) as never;
    });
    mockGetStockSeries.mockResolvedValue([]);

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
      expect(cov.totalDays).toBe(400);
      expect(cov.returnedDays).toBe(366);
      expect(cov.complete).toBe(false);
      expect(cov.omitted).toBe(34);
    }
  });

  // FIX 1 REV-2: a mock day-group source that honors orderBy desc + skip/take, so the
  // NEWEST-first paging (and offset into it) is actually exercised, not assumed.
  function mockDayGroups(allDaysAsc: string[]) {
    db.productStockSnapshot.groupBy.mockImplementation((arg: unknown) => {
      const a = arg as { orderBy?: { dayKey?: string }; skip?: number; take?: number };
      const all = allDaysAsc.map((dk) => ({ dayKey: dk }));
      if (a && a.orderBy && a.orderBy.dayKey === "desc") {
        const desc = [...all].reverse();
        const skip = a.skip ?? 0;
        return Promise.resolve(desc.slice(skip, skip + (a.take ?? desc.length))) as never;
      }
      return Promise.resolve(all) as never; // count() call: no orderBy/skip/take
    });
  }
  const isoSeq = (n: number, startUtc = Date.UTC(2024, 0, 1)) =>
    Array.from({ length: n }, (_, i) => new Date(startUtc + i * 86_400_000).toISOString().slice(0, 10));

  it("pages the NEWEST days first (re-sorted ASC) when history exceeds the day cap (FIX 1 REV-2)", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    const allDaysAsc = isoSeq(400);
    mockDayGroups(allDaysAsc);
    // Echo one point on the fetched range's from + to so the presented series shows dayKeys.
    mockGetStockSeries.mockImplementation((opts: { from: string; to: string }) =>
      Promise.resolve([
        { dayKey: opts.from, locationId: 1, quantity: 1 },
        { dayKey: opts.to, locationId: 1, quantity: 2 },
      ]),
    );

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const newest366 = allDaysAsc.slice(400 - 366); // the newest 366 days, ascending
    // The range fetch used min/max of the PAGE = the newest 366 days (never the oldest).
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    expect(seriesArg.from).toBe(newest366[0]); // oldest day OF the newest page
    expect(seriesArg.to).toBe(newest366[newest366.length - 1]); // the very newest day
    // The presented series is ASC.
    const series = (result.data as { series: Array<{ dayKey: string }> }).series;
    expect(series[0].dayKey).toBe(newest366[0]);
    expect(series[series.length - 1].dayKey).toBe(newest366[newest366.length - 1]);

    const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
    expect(cov.returnedDays).toBe(366);
    expect(cov.totalDays).toBe(400);
    expect(cov.complete).toBe(false);
    expect(cov.omitted).toBe(34);
    // FIX 1(c): the omission note is truthful about WHICH end + how to reach the rest.
    expect(String(cov.note)).toContain("most recent");
    expect(String(cov.note)).toContain("older days are available via offset");
  });

  it("offset reaches OLDER day pages (day-group offset into the newest-first order) (FIX 1b)", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    const allDaysAsc = isoSeq(400);
    mockDayGroups(allDaysAsc);
    mockGetStockSeries.mockResolvedValue([]);

    // offset 366 skips the newest 366 day-groups => the OLDEST 34 days remain.
    const result = await assistantTools.get_stock.run({ productId: 1, offset: 366 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const oldest34 = allDaysAsc.slice(0, 34);
    const seriesArg = mockGetStockSeries.mock.calls[0][0];
    expect(seriesArg.from).toBe(oldest34[0]); // 2024-01-01
    expect(seriesArg.to).toBe(oldest34[oldest34.length - 1]); // the oldest page's newest day
    const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
    expect(cov.returnedDays).toBe(34);
    expect(cov.totalDays).toBe(400);
    expect(cov.complete).toBe(true); // 366 + 34 = 400 => nothing beyond this page
  });

  it("trims WHOLE days off the OLDEST end + complete:false when points overflow the cap (FIX 1d)", async () => {
    db.product_locations.findMany.mockResolvedValue([{ locationId: 1, quantity: 5 }] as never);
    const [dayA, dayB, dayC] = ["2026-03-01", "2026-03-02", "2026-03-03"]; // ASC
    mockDayGroups([dayA, dayB, dayC]);
    // 1001 compact points (> the 1000 cap): 500 on the OLDEST day, then 300 + 201.
    // Dropping the oldest whole day (dayA, 500 pts) brings the page under the cap.
    const pts: Array<{ dayKey: string; locationId: number; quantity: number }> = [];
    for (let i = 0; i < 500; i++) pts.push({ dayKey: dayA, locationId: 1, quantity: 1 });
    for (let i = 0; i < 300; i++) pts.push({ dayKey: dayB, locationId: 1, quantity: 1 });
    for (let i = 0; i < 201; i++) pts.push({ dayKey: dayC, locationId: 1, quantity: 1 });
    mockGetStockSeries.mockResolvedValue(pts); // length 1001 = STOCK_SERIES_MAX_ROWS + 1

    const result = await assistantTools.get_stock.run({ productId: 1 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const cov = (result.data as { seriesCoverage: Record<string, unknown> }).seriesCoverage;
    expect(cov.complete).toBe(false);
    expect(String(cov.pointsNote)).toContain(dayA); // the dropped oldest day is named
    const series = (result.data as { series: Array<{ dayKey: string }> }).series;
    expect(series.some((p) => p.dayKey === dayA)).toBe(false); // fully trimmed
    expect(series.some((p) => p.dayKey === dayB)).toBe(true);
    expect(series.some((p) => p.dayKey === dayC)).toBe(true);
  });

  it("rejects a non-ISO date (schema)", async () => {
    await expect(assistantTools.get_stock.run({ productId: 1, from: "2026-13-40" }, CTX)).rejects.toThrow();
  });

  it("rejects an impossible calendar day 2026-02-30 (isoDay round-trip, W0-ISO)", async () => {
    await expect(assistantTools.get_stock.run({ productId: 1, from: "2026-02-30" }, CTX)).rejects.toThrow();
  });

  it("rejects a non-positive / non-integer id (schema)", async () => {
    await expect(assistantTools.get_stock.run({ productId: -5 }, CTX)).rejects.toThrow();
    await expect(assistantTools.get_stock.run({ productId: 1.5 }, CTX)).rejects.toThrow();
  });

  it("rejects a date window wider than 366 days", async () => {
    await expect(
      assistantTools.get_stock.run({ productId: 1, from: "2024-01-01", to: "2026-01-01" }, CTX),
    ).rejects.toThrow();
  });

  it("accepts a window within 366 days", async () => {
    const result = await assistantTools.get_stock.run(
      { productId: 1, from: "2026-01-01", to: "2026-06-01" },
      CTX,
    );
    expect(result.status).toBe("ok");
  });

  // FIX 5: the explicit-range cap is EXACTLY 366 inclusive day-keys (a 365-day span).
  it("accepts a window of exactly 366 inclusive day-keys (2026-01-01..2027-01-01, 365-day span)", async () => {
    const result = await assistantTools.get_stock.run(
      { productId: 1, from: "2026-01-01", to: "2027-01-01" },
      CTX,
    );
    expect(result.status).toBe("ok");
  });

  it("rejects a window of 367 inclusive day-keys (2026-01-01..2027-01-02, 366-day span)", async () => {
    await expect(
      assistantTools.get_stock.run({ productId: 1, from: "2026-01-01", to: "2027-01-02" }, CTX),
    ).rejects.toThrow();
  });
});

describe("get_sales: company isolation + Decimal serialization", () => {
  it("empty companyIds -> empty result + explanatory note, WITHOUT calling getSales", async () => {
    const result = await assistantTools.get_sales.run({}, CTX_NO_COMPANY);

    expect(mockGetSales).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const data = result.data as { rows: unknown[]; note: string };
      expect(data.rows).toEqual([]);
      expect(typeof data.note).toBe("string");
      expect(result.meta.scope).toBe("company");
    }
  });

  it("scopes to ctx.companyIds and serializes Decimal revenue to a string", async () => {
    mockGetSales.mockResolvedValue([
      {
        productId: 1,
        _sum: { revenue: new Prisma.Decimal("123.45"), orderedQty: 5, fulfilledQty: 5, orderCount: 2 },
      },
    ]);

    const result = await assistantTools.get_sales.run({ groupBy: "product" }, CTX);

    expect(mockGetSales).toHaveBeenCalledWith(expect.objectContaining({ companyIds: ["c1"], groupBy: "product" }));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const rows = (result.data as { rows: Array<{ _sum: { revenue: unknown } }> }).rows;
      expect(rows[0]._sum.revenue).toBe("123.45");
      expect(typeof rows[0]._sum.revenue).toBe("string");
      // No raw Decimal object crosses the tool boundary.
      expect(rows[0]._sum.revenue).not.toBeInstanceOf(Prisma.Decimal);
    }
  });
});

describe("get_operations: top-limit by attention", () => {
  it("returns at most `limit` rows, most-critical (attention) first", async () => {
    const rows = [
      { productId: 1, attention: "ok" },
      { productId: 2, attention: "out" },
      { productId: 3, attention: "low" },
      { productId: 4, attention: "stale" },
    ];
    mockGetOperations.mockResolvedValue({ rows, dataStarts: { sale: null, adjustment: null, receipt: null, snapshot: null } });

    const result = await assistantTools.get_operations.run({ limit: 2 }, CTX);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const out = (result.data as { rows: Array<{ productId: number; attention: string }> }).rows;
      expect(out).toHaveLength(2);
      expect(out[0].attention).toBe("out");
      expect(out[1].attention).toBe("low");
    }
  });

  it("rejects a limit above the ≤50 cap", async () => {
    await expect(assistantTools.get_operations.run({ limit: 51 }, CTX)).rejects.toThrow();
  });
});

describe("get_inventory_summary: reserves envelope bytes so a tight budget still returns a page (item 1)", () => {
  it("a tight remainingBytes returns a small OK page whose TOTAL bytes fit the budget — never discarded at the margin", async () => {
    // 50 products with long names: if the ranked page were given the FULL remaining
    // budget, it would fill it and the added valuation/totals/coverage envelope would push
    // the COMPLETED result OVER the budget the adapter threaded in — the residual-discard
    // bug. Reserving envelope bytes keeps the whole result under the budget.
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `Product-${i}-` + "x".repeat(300),
      lowStockThreshold: null,
      costPrice: null,
      retailPrice: null,
      product_locations: [{ locationId: 1, quantity: 100 - i, locations: { name: "Main" } }],
    }));
    db.product.findMany.mockResolvedValue(many as never);
    mockGetValuation.mockResolvedValue({
      groupBy: "total",
      rows: [
        { units: 999, atCurrentCostCents: null, atReceiptCostCents: null, atRetailCents: null, marginCents: null },
      ],
      coverage: {
        costedProducts: 0, ofProducts: 50, costedUnits: 0, ofUnits: 999,
        retailPricedProducts: 0, retailPricedUnits: 0,
        receiptCostedProducts: 0, receiptCostedUnits: 0, marginProducts: 0, marginUnits: 0,
      },
    });

    const TIGHT = 12_000;
    const result = await assistantTools.get_inventory_summary.run(
      { rankBy: "onHand", limit: 50 },
      testCtx({ companyIds: ["c1"], remainingBytes: TIGHT }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The COMPLETED result (ranked page + valuation + totals + coverage) fits under the
    // budget the adapter threaded in, so the adapter keeps it instead of discarding it.
    expect(result.meta.bytes).toBeLessThanOrEqual(TIGHT);
    // Still a real page (degrade to a SMALLER page, never nothing).
    const data = result.data as { ranked: { rows: unknown[]; returned: number } };
    expect(data.ranked.returned).toBeGreaterThan(0);
  });
});

describe("get_stock_asof: reserves envelope bytes so a tight budget still returns a page (item 6)", () => {
  it("a tight remainingBytes returns a small OK page whose TOTAL bytes fit the budget — never a truncation notice", async () => {
    // 100 compact rows so the byte-fit lands TIGHT against the budget (per-row slack is
    // small). If the page were given the FULL remaining budget it would fill it, and the
    // added dayKey + coverage envelope (larger than one row) would push the COMPLETED
    // result OVER the budget the adapter threaded in — the residual-discard bug. Reserving
    // envelope bytes keeps the whole result under the budget (a smaller page, never a notice).
    const many = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `P${i}` }));
    db.product.count.mockResolvedValue(many.length as never);
    db.product.findMany.mockImplementation((async (args: { skip?: number; take?: number }) => {
      const skip = args?.skip ?? 0;
      const take = args?.take ?? many.length;
      return many.slice(skip, skip + take);
    }) as never);
    db.productStockSnapshot.aggregate.mockResolvedValue({ _min: { dayKey: "2026-01-01" }, _max: { dayKey: "2026-06-30" } } as never);
    db.productStockSnapshot.groupBy.mockImplementation((async (args: { _sum?: unknown }) =>
      args._sum
        ? many.map((p) => ({ productId: p.id, _sum: { quantity: 5 }, _count: 1 }))
        : many.map((p) => ({ productId: p.id, locationId: 1, _max: { dayKey: "2026-06-30" }, _min: { dayKey: "2026-01-01" } }))) as never);
    db.analyticsRebuildState.findUnique.mockResolvedValue({ lastWindowTo: "2026-06-30", flaggedPairs: 0 } as never);

    // Small enough that the 100 rows overflow it (so the page is genuinely bounded by
    // bytes, not row count) — the residual-discard fires exactly at this margin.
    const TIGHT = 6_000;
    const result = await assistantTools.get_stock_asof.run(
      { dayKey: "2026-06-15", limit: 100 },
      testCtx({ companyIds: ["c1"], remainingBytes: TIGHT }),
    );

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The COMPLETED result (page + dayKey + coverage) fits under the threaded budget, so
    // the adapter keeps it instead of downgrading to a truncation notice.
    expect(result.meta.bytes).toBeLessThanOrEqual(TIGHT);
    // Still a real page (degrade to a SMALLER page, never nothing) and byte-bounded (the
    // full 100-row catalog did not fit, so nextOffset advances).
    const data = result.data as { returned: number; totalRows: number; nextOffset: number | null };
    expect(data.returned).toBeGreaterThan(0);
    expect(data.totalRows).toBe(100);
    expect(data.nextOffset).not.toBeNull();
  });
});

// A2 pack C9: get_stock_asof by location — the tool resolves the id (an unknown one is
// NOT_FOUND with its own message), threads it into the module, and echoes the location by
// name so the answer never shows a bare id.
describe("get_stock_asof: locationId (A2 C9)", () => {
  function seedAsof() {
    db.product.count.mockResolvedValue(1 as never);
    db.product.findMany.mockImplementation((async (args: { where?: { id?: { in?: number[] } } }) =>
      args?.where?.id?.in
        ? [{ id: 1, name: "TIRZ 10mg", deletedAt: null }]
        : [{ id: 1, name: "TIRZ 10mg" }]) as never);
    db.productStockSnapshot.aggregate.mockResolvedValue({ _min: { dayKey: "2026-01-01" }, _max: { dayKey: "2026-06-30" } } as never);
    db.productStockSnapshot.groupBy.mockImplementation((async (args: { _sum?: unknown }) =>
      args._sum
        ? [{ productId: 1, _sum: { quantity: 4 }, _count: 1 }]
        : [{ productId: 1, locationId: 2, _max: { dayKey: "2026-06-30" }, _min: { dayKey: "2026-01-01" } }]) as never);
    db.analyticsRebuildState.findUnique.mockResolvedValue({ lastWindowTo: "2026-06-30", flaggedPairs: 0 } as never);
  }

  it("an unknown locationId is NOT_FOUND with the location message, before any snapshot read", async () => {
    seedAsof();
    db.location.findUnique.mockResolvedValue(null as never);
    const result = await assistantTools.get_stock_asof.run({ dayKey: "2026-06-15", locationId: 99 }, CTX);
    expect(result).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: "No location with id 99." },
    });
    expect(db.productStockSnapshot.aggregate).not.toHaveBeenCalled();
    expect(db.product.count).not.toHaveBeenCalled();
  });

  it("a known locationId reaches the module and is echoed as { id, name }; the watermark is labelled global", async () => {
    seedAsof();
    db.location.findUnique.mockResolvedValue({ id: 2, name: "Annex" } as never);
    const result = await assistantTools.get_stock_asof.run({ dayKey: "2026-06-15", locationId: 2 }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as {
      dayKey: string;
      location: { id: number; name: string };
      coverage: Record<string, unknown>;
      rows: Array<{ units: number | null }>;
    };
    expect(Object.keys(data).slice(0, 2)).toEqual(["dayKey", "location"]);
    expect(data.location).toEqual({ id: 2, name: "Annex" });
    expect(data.coverage.watermarkScope).toBe("all locations");
    expect(data.coverage.notRecordedHere).toBe(1);
    expect(data.rows[0].units).toBe(4);
    for (const call of db.productStockSnapshot.groupBy.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({ locationId: 2 });
    }
    expect(db.location.findUnique).toHaveBeenCalledWith({ where: { id: 2 }, select: { id: true, name: true } });
  });

  it("without locationId: no location read, no echo, no location keys in coverage", async () => {
    seedAsof();
    const result = await assistantTools.get_stock_asof.run({ dayKey: "2026-06-15" }, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as Record<string, unknown> & { coverage: Record<string, unknown> };
    expect(data).not.toHaveProperty("location");
    expect(data.coverage).not.toHaveProperty("watermarkScope");
    expect(db.location.findUnique).not.toHaveBeenCalled();
  });

  it("an unknown productId keeps the product message", async () => {
    db.product.findFirst.mockResolvedValue(null as never);
    const result = await assistantTools.get_stock_asof.run({ dayKey: "2026-06-15", productId: 5, locationId: 2 }, CTX);
    expect(result).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: "No approved product with id 5." },
    });
  });

  it("the schema takes locationId as an optional positive int, and the description says how to use it", () => {
    const schema = assistantTools.get_stock_asof.inputSchema as unknown as {
      shape: Record<string, unknown>;
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(Object.keys(schema.shape)).toContain("locationId");
    expect(schema.safeParse({ dayKey: "2026-06-15", locationId: 0 }).success).toBe(false);
    expect(schema.safeParse({ dayKey: "2026-06-15" }).success).toBe(true);
    expect(assistantTools.get_stock_asof.description).toContain(
      "Pass locationId for one location's stock on that day (otherwise all locations are " +
        "summed); with locationId, only products recorded at that location on or before that " +
        "day are listed (coverage.notRecordedHere counts the rest — unknown, not zero). Location " +
        "ids and names: the valuation tool with groupBy 'location'.",
    );
  });
});

describe("low_stock_report: fetches the full report and paginates at the tool", () => {
  it("fetches all alerts (no limit passed down) and surfaces systemDefaultThreshold", async () => {
    mockGetLowStock.mockResolvedValue({ alerts: [], threshold: 10 });
    const result = await assistantTools.low_stock_report.run({ limit: 25 }, CTX);
    // Paging happens at the tool boundary now, so the full report is fetched.
    expect(mockGetLowStock).toHaveBeenCalledWith({});
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.meta.scope).toBe("global");
      expect((result.data as { systemDefaultThreshold: number }).systemDefaultThreshold).toBe(10);
    }
  });
});

// ===========================================================================
// A2 pack C1 — remainingRows, from each ENVELOPE's own totalRows and nextOffset
// ===========================================================================

describe("A2 C1 — remainingRows", () => {
  it("remainingRowsOf: null -> 0; 50 / 20 -> 30; at or past the end -> 0 (never negative)", () => {
    expect(remainingRowsOf(50, null)).toBe(0);
    expect(remainingRowsOf(0, null)).toBe(0);
    expect(remainingRowsOf(50, 20)).toBe(30);
    expect(remainingRowsOf(50, 49)).toBe(1);
    expect(remainingRowsOf(50, 50)).toBe(0);
    expect(remainingRowsOf(50, 70)).toBe(0);
  });

  it("find_product: 50 matches at limit 20 -> nextOffset 20, remainingRows 30, right after nextOffset", async () => {
    // One DB page of 20 (the tool reads exactly ONE page); the envelope's total is the DB
    // total, so the count comes from the ENVELOPE — the byte-fit page's own totalRows is 20.
    mockGetProducts.mockResolvedValue({
      products: Array.from({ length: 20 }, (_, i) => product({ id: i + 1 })),
      total: 50,
    });
    const result = await assistantTools.find_product.run({ query: "TIRZ", limit: 20 }, CTX);
    if (result.status !== "ok") throw new Error("not ok");
    const data = result.data as Record<string, unknown>;
    expect(data).toMatchObject({ returned: 20, totalRows: 50, nextOffset: 20, remainingRows: 30 });
    const keys = Object.keys(data);
    expect(keys.indexOf("remainingRows")).toBe(keys.indexOf("nextOffset") + 1);

    // The last page: offset 40 reads the final 10 -> no cursor, nothing remains.
    mockGetProducts.mockResolvedValue({
      products: Array.from({ length: 10 }, (_, i) => product({ id: 41 + i })),
      total: 50,
    });
    const last = await assistantTools.find_product.run({ query: "TIRZ", limit: 20, offset: 40 }, CTX);
    if (last.status !== "ok") throw new Error("not ok");
    expect(last.data).toMatchObject({ totalRows: 50, nextOffset: null, remainingRows: 0 });
  });

  it("find_product under a byte fit: remainingRows follows the page-aligned cursor; the dropped rows stay in byteSkipped", async () => {
    const CATALOG = Array.from({ length: 12 }, (_, i) =>
      product({ id: i + 1, name: `Product ${i + 1} ` + "x".repeat(1200) }),
    );
    mockGetProducts.mockImplementation((filters: { page: number; pageSize: number }) => ({
      products: CATALOG.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize),
      total: CATALOG.length,
    }));
    const tight = testCtx({ companyIds: ["c1"], remainingBytes: 5_000 });
    const result = await assistantTools.find_product.run({ query: "product", limit: 4 }, tight);
    if (result.status !== "ok") throw new Error("not ok");
    const data = result.data as {
      returned: number;
      totalRows: number;
      nextOffset: number | null;
      remainingRows: number;
      coverage: { byteSkipped?: number };
    };
    expect(data.returned).toBeLessThan(4); // the fit really dropped rows
    expect(data.nextOffset).toBe(4);
    expect(data.remainingRows).toBe(8); // 12 - 4: from the envelope, not the page
    expect(data.coverage.byteSkipped).toBe(4 - data.returned);
  });

  it("low_stock_report: remainingRows counts the alerts after this page", async () => {
    mockGetLowStock.mockResolvedValue({
      alerts: Array.from({ length: 7 }, (_, i) => ({
        productId: i + 1,
        name: `p${i + 1}`,
        currentStock: 1,
        threshold: 5,
        rawThreshold: null,
        averageDailyUsage: null,
        usageKnown: false,
        daysUntilEmpty: null,
      })),
      threshold: 5,
      alertsOff: 0,
      alertsOffAtZeroStock: 0,
      outOfStockAllProducts: 0,
    });
    const page1 = await assistantTools.low_stock_report.run({ limit: 3 }, CTX);
    if (page1.status !== "ok") throw new Error("not ok");
    expect(page1.data).toMatchObject({ returned: 3, totalRows: 7, nextOffset: 3, remainingRows: 4 });
    const page3 = await assistantTools.low_stock_report.run({ limit: 3, offset: 6 }, CTX);
    if (page3.status !== "ok") throw new Error("not ok");
    expect(page3.data).toMatchObject({ returned: 1, totalRows: 7, nextOffset: null, remainingRows: 0 });
  });

  it("get_sales with no company access: the empty envelope reads remainingRows 0", async () => {
    const result = await assistantTools.get_sales.run({}, CTX_NO_COMPANY);
    if (result.status !== "ok") throw new Error("not ok");
    expect(result.data).toMatchObject({ totalRows: 0, nextOffset: null, remainingRows: 0 });
  });
});

// ===========================================================================
// A2 pack C7 — get_sales' coverage.salesFreshnessNote (material staleness only; never for
// a caller with no companies; a failed run-history read is non-fatal)
// ===========================================================================

describe("A2 C7 — get_sales carries the sales-freshness note", () => {
  const HOUR_MS = 3_600_000;
  const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS);
  const success = (finishedHoursAgo: number) => ({
    status: "SUCCEEDED",
    startedAt: hoursAgo(finishedHoursAgo + 0.1),
    finishedAt: hoursAgo(finishedHoursAgo),
    skippedReason: null,
  });

  async function salesCoverage(ctx = CTX): Promise<Record<string, unknown>> {
    mockGetSales.mockResolvedValue([]);
    const result = await assistantTools.get_sales.run({ groupBy: "day" }, ctx);
    if (result.status !== "ok") throw new Error("not ok");
    return (result.data as { coverage: Record<string, unknown> }).coverage;
  }

  it("a 20-hour-old success: no note", async () => {
    seedRuns([success(20)]);
    expect(await salesCoverage()).not.toHaveProperty("salesFreshnessNote");
  });

  it("a 30-hour-old success: the stale note, naming the success's finishedAt", async () => {
    const run = success(30);
    seedRuns([run]);
    expect((await salesCoverage()).salesFreshnessNote).toBe(
      `The last successful sales rebuild finished at ${run.finishedAt.toISOString()}, more than a ` +
        `day ago; orders recorded after that are not counted yet.`,
    );
  });

  it("a FAILED run (NULL skippedReason) after a recent success: 'did not succeed'; a lock-held skip is ignored", async () => {
    const run = success(20);
    seedRuns([
      { status: "ABORTED", startedAt: hoursAgo(1), finishedAt: hoursAgo(1), skippedReason: "lock-held" },
      { status: "FAILED", startedAt: hoursAgo(2), finishedAt: hoursAgo(2), skippedReason: null },
      run,
    ]);
    // A2 C15 (A2-CR-4): no "as of" claim — a failed attempt can leave some days rebuilt.
    expect((await salesCoverage()).salesFreshnessNote).toBe(
      `The latest sales rebuild attempt did not succeed; the last successful rebuild finished at ` +
        `${run.finishedAt.toISOString()}, and orders recorded since then may be missing or only ` +
        `partly counted.`,
    );
    seedRuns([
      { status: "ABORTED", startedAt: hoursAgo(1), finishedAt: hoursAgo(1), skippedReason: "lock-held" },
      run,
    ]);
    expect(await salesCoverage()).not.toHaveProperty("salesFreshnessNote");
  });

  it("no successful rebuild on record: the missing-figures note", async () => {
    seedRuns([]);
    expect((await salesCoverage()).salesFreshnessNote).toBe(
      "No successful sales rebuild is on record — order figures may be missing.",
    );
  });

  it("no company access: no note and NO run-history read", async () => {
    seedRuns([success(30)]);
    const result = await assistantTools.get_sales.run({}, CTX_NO_COMPANY);
    if (result.status !== "ok") throw new Error("not ok");
    expect((result.data as { coverage: object }).coverage).not.toHaveProperty("salesFreshnessNote");
    expectNoRunRead();
  });

  it("a throwing run-history read: no note, and the result is still the full OK answer", async () => {
    db.analyticsRebuildRun.findFirst.mockRejectedValue(new Error("analytics_rebuild_runs unreachable") as never);
    const coverage = await salesCoverage();
    expect(coverage).not.toHaveProperty("salesFreshnessNote");
    expect(coverage).toHaveProperty("windowCoverage");
    expect(coverage).toHaveProperty("rowsNote");
  });

  it("the description carries the standing sentence and defines coverage.lastRebuildAt", () => {
    const d = assistantTools.get_sales.description.replace(/\s+/g, " ");
    expect(d).toContain(
      "Orders recorded since the last successful nightly rebuild are not counted yet, so the most " +
        "recent day or two may be partial.",
    );
    expect(d).toContain("coverage.lastRebuildAt is when the last rebuild attempt finished, whatever its outcome.");
  });
});

// ===========================================================================
// A2 pack C14 (A2-OCC-2) — compare_periods measures its per-day figures through the last
// COMPLETE day: yesterday for a ledger metric; for a sales metric, also never past the day
// before the newest successful sales rebuild STARTED (one run-history read serves both
// that and the freshness note). The module is REAL here, over deep-mocked prisma.
// ===========================================================================

describe("A2 C14 — compare_periods' rate windows (the tool's last complete day)", () => {
  const DAY = 86_400_000;
  const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
  /** Today at hh:00 UTC. */
  const todayAt = (hh: number) => new Date(`${day(0)}T${String(hh).padStart(2, "0")}:00:00.000Z`);
  const success = (startedAt: Date) => ({
    status: "SUCCEEDED",
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 5 * 60_000),
    skippedReason: null,
  });
  // A2 C16 (A2-FD1-4): "past the last complete day" — the sales frontier is a cut-off too.
  const RATE_DEFINITION =
    "per day = a period's total over its COMPLETE days divided by those days " +
    "(coverage.rateWindows): a period that reaches past the last complete day is measured for " +
    "its per-day figure only through it, because today's figures — and, until the nightly sales " +
    "rebuild succeeds, recent days' sales — are still arriving. Values of 1 or more are rounded " +
    "to 2 decimals, smaller values to 3 significant figures, so a small non-zero rate never " +
    "shows as 0; perDayDirection is the sign of the unrounded change. When the rate periods " +
    "differ in length, rows are ranked and filtered by the per-day change, because totals of " +
    "periods of different lengths are not comparable; delta and pctChange stay the change in " +
    "the full periods' totals. This is a calendar rate — the low-stock and reorder rates " +
    "divide by the days a product's outbound data covers, so they are not directly comparable " +
    "to it. Under partial company coverage these are rates of what was recorded.";

  /** c1 recording since 2020; 7 units on every day of the last fortnight, today included. */
  function seedDailySales() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.aggregate.mockImplementation((args: any) => {
      if (args._min) return Promise.resolve({ _min: { dayKey: "2020-01-01" } }) as never;
      const { gte, lte } = args.where.dayKey as { gte: string; lte: string };
      const days = Math.round((Date.parse(`${lte}T00:00:00Z`) - Date.parse(`${gte}T00:00:00Z`)) / DAY) + 1;
      return Promise.resolve({ _sum: { orderedQty: 7 * days } }) as never;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.productSalesFact.groupBy.mockImplementation((args: any) =>
      Promise.resolve(args.by[0] === "companyId" ? [{ companyId: "c1", _min: { dayKey: "2020-01-01" } }] : []) as never,
    );
    db.product.findMany.mockResolvedValue([{ id: 1 }] as never);
    db.company.findMany.mockResolvedValue([{ id: "c1", name: "Acme" }] as never);
  }
  const WEEK_TO_TODAY = { from: day(-6), to: day(0) };
  const LAST_WEEK = { from: day(-13), to: day(-7) };

  async function compare(args: Record<string, unknown>, ctx = CTX): Promise<Record<string, any>> {
    const result = await assistantTools.compare_periods.run(args, ctx);
    if (result.status !== "ok") throw new Error(`not ok: ${JSON.stringify(result)}`);
    return result.data as Record<string, any>;
  }

  it("a sales period after a rebuild that started at 03:00 today: rate window through yesterday", async () => {
    seedDailySales();
    seedRuns([success(todayAt(3))]);
    const data = await compare({ metric: "sales_units", periodA: LAST_WEEK, periodB: WEEK_TO_TODAY });
    expect(data.coverage.rateWindows).toEqual({
      a: { ...LAST_WEEK, days: 7 },
      b: { from: WEEK_TO_TODAY.from, to: day(-1), days: 6 },
    });
    expect(data.b).toBe(49); // the total keeps today
    expect(data.bPerDay).toBe(7); // 42 units over 6 complete days
    expect(data.coverage.rateDefinition).toBe(RATE_DEFINITION);
  });

  it("before the nightly run (the newest success started yesterday): sales rate windows end the day before yesterday", async () => {
    seedDailySales();
    seedRuns([success(new Date(todayAt(3).getTime() - DAY))]);
    const data = await compare({ metric: "sales_units", periodA: LAST_WEEK, periodB: WEEK_TO_TODAY });
    expect(data.coverage.rateWindows.b).toEqual({ from: WEEK_TO_TODAY.from, to: day(-2), days: 5 });
    expect(data.bPerDay).toBe(7);
    // ONE run-history read (A2 C15: the success, then the attempts after it; A2 C16: and the
    // newest full success, a second findFirst) serves both the rate day and the freshness note.
    expect(db.analyticsRebuildRun.findFirst).toHaveBeenCalledTimes(2);
    expect(db.analyticsRebuildRun.findMany).toHaveBeenCalledTimes(1);
  });

  it("no success on record, or a throwing read: yesterday (and the figures intact)", async () => {
    seedDailySales();
    seedRuns([]);
    const none = await compare({ metric: "sales_units", periodA: LAST_WEEK, periodB: WEEK_TO_TODAY });
    expect(none.coverage.rateWindows.b.to).toBe(day(-1));
    expect(none.coverage.salesFreshnessNote).toBe(
      "No successful sales rebuild is on record — order figures may be missing.",
    );
    db.analyticsRebuildRun.findFirst.mockRejectedValue(new Error("analytics_rebuild_runs unreachable") as never);
    const thrown = await compare({ metric: "sales_units", periodA: LAST_WEEK, periodB: WEEK_TO_TODAY });
    expect(thrown.coverage.rateWindows.b.to).toBe(day(-1));
    expect(thrown.coverage).not.toHaveProperty("salesFreshnessNote");
    expect(thrown.b).toBe(49);
  });

  it("a ledger metric: yesterday, whatever the sales rebuild did — and NO run-history read", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db.inventory_logs.aggregate.mockImplementation((args: any) =>
      Promise.resolve(
        args._min ? { _min: { changeTime: new Date("2020-01-01T00:00:00.000Z") } } : { _sum: { delta: -12 } },
      ) as never,
    );
    db.product.findMany.mockResolvedValue([] as never);
    seedRuns([success(new Date(todayAt(3).getTime() - 3 * DAY))]);
    const data = await compare({ metric: "outbound_units", periodA: LAST_WEEK, periodB: WEEK_TO_TODAY });
    expect(data.coverage.rateWindows.b).toEqual({ from: WEEK_TO_TODAY.from, to: day(-1), days: 6 });
    expect(data.bPerDay).toBe(2); // the second read's 12 units over 6 complete days
    expectNoRunRead();
  });

  it("by_product carries rateWindows + the rate definition, and the counts note names per-day ranking", async () => {
    seedDailySales();
    seedRuns([success(todayAt(3))]);
    const data = await compare({
      metric: "sales_units",
      periodA: LAST_WEEK,
      periodB: WEEK_TO_TODAY,
      groupBy: "product",
    });
    expect(data.mode).toBe("by_product");
    // Equal requested lengths, 7 vs 6 complete days: ranked by the per-day change.
    expect(data.rankedBy).toBe("per_day");
    expect(data.coverage.rateWindows).toEqual({
      a: { ...LAST_WEEK, days: 7 },
      b: { from: WEEK_TO_TODAY.from, to: day(-1), days: 6 },
    });
    expect(data.coverage.rateDefinition).toBe(RATE_DEFINITION);
    expect(data.countsNote).toBe(
      "ranked counts the rows this call ranks (after any direction filter); increased, " +
        "decreased and unchanged count every product with activity in either period that both " +
        "periods can measure, before that filter; unranked counts the products not comparable. " +
        "Under rankedBy 'per_day', increased and decreased follow the per-day change, not delta. " +
        "When the periods differ in length and one has no complete day yet (reasons.perDay), " +
        "rows rank by the change in totals, which is not like-for-like. " +
        "Use these for how many; never count rows yourself.",
    );
  });

  it("a caller with no companies: no run-history read; the rate windows still end yesterday", async () => {
    seedDailySales();
    const data = await compare({ metric: "sales_units", periodA: LAST_WEEK, periodB: WEEK_TO_TODAY }, CTX_NO_COMPANY);
    expect(data.coverage.rateWindows.b.to).toBe(day(-1));
    expectNoRunRead();
  });
});

describe("A2 C14 (A2-OCC-12) / C16 (A2-FD1-6) — get_valuation says whose retail price unitRetailCents is", () => {
  it("the description appends the stored-retail sentence after the money-totals rule", () => {
    const d = assistantTools.get_valuation.description.replace(/\s+/g, " ");
    expect(d).toContain(
      "nothing is on hand — never a free or unpriced product. unitRetailCents is the one stored " +
        "retail price (set by hand, or copied from one store listing when its price is synced), " +
        "not necessarily each store's live price.",
    );
    // A2 C16: pricing can be manual and the sync is manual — "synced from" over-claimed.
    expect(d).not.toContain("(synced from one store listing)");
  });

  it("get_product_overview's description says the same of its valuation row's retail", () => {
    const d = assistantTools.get_product_overview.description.replace(/\s+/g, " ");
    expect(d).toContain(
      "(currentUnitCostCents / unitRetailCents: 0 = recorded as free, null = not set; the retail " +
        "is the one stored price, set by hand or copied from one store listing, not necessarily " +
        "each store's live price)",
    );
    expect(d).not.toContain("synced from one store listing");
  });
});
