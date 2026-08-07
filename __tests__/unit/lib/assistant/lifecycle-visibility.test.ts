/**
 * @jest-environment node
 *
 * LIFECYCLE + APPROVAL VISIBILITY — the spec C13 policy table, enforced (assistant
 * quality+reach lane, Tasks 3.1/3.2; plan G4/G5).
 *
 * WHY A FIXTURE-BACKED PRISMA, NOT A CALL-SHAPE MOCK: the claim this lane makes is
 * "an unapproved product moves NO total in ANY grain". A test that only asserts a
 * `where` clause proves the code SAID the right thing; it cannot prove the number
 * changed. So the mock below is a small query engine over three seeded tables — the
 * totals in these assertions are computed from real rows through the real modules,
 * and the sentinel products are visible in the seed. Where the CONTRACT is about
 * mechanics rather than values (G5's Product-side census relation, "never an extra
 * full-window ledger groupBy"), the recorded calls are asserted too — seam S13 asks
 * for BOTH.
 *
 * THE THREE SENTINELS (one product each):
 *   #1 approved + active   — the control: always visible.
 *   #2 approved + ARCHIVED — visible in HISTORY (tagged lifecycle:'deleted'), never
 *                            in the nine current-state tools.
 *   #3 PENDING_REVIEW      — visible NOWHERE: not a row, not a total, not a dataStart.
 */

import { toDayKey } from "@/lib/analytics/dates";

// ---------------------------------------------------------------------------
// The fixture-backed Prisma engine. Everything lives inside the jest.mock factory
// (hoisted); control handles come back through jest.requireMock, exactly like the
// fail-closed proxy in toolsuite-gates.test.ts.
// ---------------------------------------------------------------------------

jest.mock("@/lib/prisma", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  type Row = Record<string, any>;
  const db: Record<string, Row[]> = {
    product: [],
    inventory_logs: [],
    productSalesFact: [],
    product_locations: [],
  };
  const calls: Array<{ model: string; method: string; args: any }> = [];
  const overrides: Record<string, unknown> = {};

  const cmp = (a: any, b: any): number => {
    const av = a instanceof Date ? a.getTime() : a;
    const bv = b instanceof Date ? b.getTime() : b;
    if (av === bv) return 0;
    if (av == null) return -1;
    if (bv == null) return 1;
    return av < bv ? -1 : 1;
  };

  /** Prisma field filter: scalar equality, or an operator object. */
  const matchField = (value: any, cond: any): boolean => {
    if (cond === null) return value === null || value === undefined;
    if (cond === undefined) return true;
    if (cond instanceof Date) return cmp(value, cond) === 0;
    if (typeof cond === "object" && !Array.isArray(cond)) {
      for (const [op, operand] of Object.entries(cond as Row)) {
        switch (op) {
          case "equals":
            if (!matchField(value, operand)) return false;
            break;
          case "not":
            if (matchField(value, operand)) return false;
            break;
          case "in":
            if (!(operand as any[]).some((o) => cmp(value, o) === 0)) return false;
            break;
          case "notIn":
            if ((operand as any[]).some((o) => cmp(value, o) === 0)) return false;
            break;
          case "gte":
            if (value == null || cmp(value, operand) < 0) return false;
            break;
          case "gt":
            if (value == null || cmp(value, operand) <= 0) return false;
            break;
          case "lte":
            if (value == null || cmp(value, operand) > 0) return false;
            break;
          case "lt":
            if (value == null || cmp(value, operand) >= 0) return false;
            break;
          case "contains":
            if (String(value ?? "").toLowerCase().indexOf(String(operand).toLowerCase()) < 0) return false;
            break;
          default:
            return false; // an unmodeled operator must FAIL loudly, never silently pass
        }
      }
      return true;
    }
    return cmp(value, cond) === 0;
  };

  /** Product-side relation fields (schema.prisma:84,92) — the ONLY spellings G5 allows. */
  const RELATIONS: Record<string, Record<string, (row: Row) => Row[]>> = {
    product: {
      inventory_logs: (p) => db.inventory_logs.filter((l) => l.productId === p.id),
      salesFacts: (p) => db.productSalesFact.filter((f) => f.productId === p.id),
    },
  };

  const matchRow = (model: string, row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === "AND") {
        const list = Array.isArray(cond) ? cond : [cond];
        if (!list.every((c: Row) => matchRow(model, row, c))) return false;
        continue;
      }
      if (key === "OR") {
        if (!(cond as Row[]).some((c) => matchRow(model, row, c))) return false;
        continue;
      }
      if (key === "NOT") {
        if (matchRow(model, row, cond as Row)) return false;
        continue;
      }
      const relation = RELATIONS[model]?.[key];
      if (relation) {
        const children = relation(row);
        const c = cond as Row;
        if (c.some && !children.some((ch) => matchRow("", ch, c.some))) return false;
        if (c.none && children.some((ch) => matchRow("", ch, c.none))) return false;
        if (c.every && !children.every((ch) => matchRow("", ch, c.every))) return false;
        continue;
      }
      if (!matchField(row[key], cond)) return false;
    }
    return true;
  };

  const rowsOf = (model: string, where: Row | undefined): Row[] =>
    (db[model] ?? []).filter((r) => matchRow(model, r, where));

  const sumOver = (rows: Row[], spec: Row): Row => {
    const out: Row = {};
    for (const field of Object.keys(spec)) {
      let total = 0;
      let seen = false;
      for (const r of rows) {
        if (r[field] == null) continue;
        total += Number(r[field]);
        seen = true;
      }
      out[field] = seen ? total : null;
    }
    return out;
  };

  const extremeOver = (rows: Row[], spec: Row, dir: -1 | 1): Row => {
    const out: Row = {};
    for (const field of Object.keys(spec)) {
      let best: any = null;
      for (const r of rows) {
        if (r[field] == null) continue;
        if (best === null || cmp(r[field], best) === dir) best = r[field];
      }
      out[field] = best;
    }
    return out;
  };

  const aggregateOf = (rows: Row[], args: Row): Row => ({
    _sum: args?._sum ? sumOver(rows, args._sum) : {},
    _min: args?._min ? extremeOver(rows, args._min, -1) : {},
    _max: args?._max ? extremeOver(rows, args._max, 1) : {},
    _count: rows.length,
  });

  const groupOf = (model: string, args: Row): Row[] => {
    const rows = rowsOf(model, args?.where);
    const by: string[] = args?.by ?? [];
    const buckets = new Map<string, Row[]>();
    for (const r of rows) {
      const key = JSON.stringify(by.map((k) => r[k] ?? null));
      const arr = buckets.get(key);
      if (arr) arr.push(r);
      else buckets.set(key, [r]);
    }
    return Array.from(buckets.entries()).map(([key, rs]) => {
      const out: Row = {};
      (JSON.parse(key) as any[]).forEach((v, i) => (out[by[i]] = v));
      const agg = aggregateOf(rs, args);
      if (args?._sum) out._sum = agg._sum;
      if (args?._min) out._min = agg._min;
      if (args?._max) out._max = agg._max;
      if (args?._count) out._count = rs.length;
      return out;
    });
  };

  const benign = (method: string): unknown => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method.startsWith("find")) return null;
    if (method === "count") return 0;
    if (method === "aggregate") return { _min: {}, _max: {}, _sum: {}, _count: 0 };
    return {};
  };

  const run = (model: string, method: string, args: Row): unknown => {
    const key = `${model}.${method}`;
    if (key in overrides) return overrides[key];
    if (!(model in db)) return benign(method);
    switch (method) {
      case "findMany": {
        let rows = rowsOf(model, args?.where);
        const orderBy = args?.orderBy;
        const orders: Row[] = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
        if (orders.length > 0) {
          rows = [...rows].sort((a, b) => {
            for (const o of orders) {
              const [field, dir] = Object.entries(o)[0] as [string, string];
              const c = cmp(a[field], b[field]);
              if (c !== 0) return dir === "desc" ? -c : c;
            }
            return 0;
          });
        }
        if (args?.skip) rows = rows.slice(args.skip);
        if (args?.take != null) rows = rows.slice(0, args.take);
        return rows.map((r) => ({ ...r }));
      }
      case "findFirst":
      case "findFirstOrThrow":
      case "findUnique":
      case "findUniqueOrThrow": {
        // Served from the fixtures like every other read: a resolver that stops matching
        // must FAIL here, not quietly fall through to a benign null (which would turn a
        // visibility regression into a passing not-found assertion).
        const hit = rowsOf(model, args?.where)[0];
        return hit ? { ...hit } : null;
      }
      case "count":
        return rowsOf(model, args?.where).length;
      case "aggregate":
        return aggregateOf(rowsOf(model, args?.where), args ?? {});
      case "groupBy":
        return groupOf(model, args ?? {});
      default:
        return benign(method);
    }
  };

  const delegateCache: Record<string, unknown> = {};
  const makeDelegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop === "symbol") return undefined;
          const method = String(prop);
          return (...args: unknown[]) => {
            calls.push({ model, method, args: args[0] });
            return Promise.resolve(run(model, method, (args[0] ?? {}) as Row));
          };
        },
      },
    );

  const root: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop === "symbol") return undefined;
        const p = String(prop);
        if (p === "then") return undefined;
        if (p === "$transaction") {
          return (arg: unknown) =>
            typeof arg === "function" ? (arg as (c: unknown) => unknown)(root) : Promise.all(arg as unknown[]);
        }
        if (p.startsWith("$")) {
          return (...args: unknown[]) => {
            calls.push({ model: "$root", method: p, args: args[0] });
            return Promise.resolve(p.toLowerCase().includes("query") ? [] : 0);
          };
        }
        return (delegateCache[p] ??= makeDelegate(p));
      },
    },
  );

  return {
    __esModule: true,
    default: root,
    __db: db,
    __calls: calls,
    __overrides: overrides,
    __reset: () => {
      calls.length = 0;
    },
    __seed: (tables: Record<string, Row[]>) => {
      for (const k of Object.keys(db)) db[k] = [];
      for (const [k, rows] of Object.entries(tables)) db[k] = rows.map((r) => ({ ...r }));
      calls.length = 0;
      for (const k of Object.keys(overrides)) delete overrides[k];
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

import { assistantTools, testCtx, type ToolResult } from "@/lib/assistant/tools";

/* eslint-disable @typescript-eslint/no-explicit-any */
const prismaCtl = jest.requireMock("@/lib/prisma") as {
  __calls: Array<{ model: string; method: string; args: any }>;
  __overrides: Record<string, unknown>;
  __reset: () => void;
  __seed: (tables: Record<string, any[]>) => void;
};

const CTX = testCtx({ companyIds: ["c1"] });

// ---------------------------------------------------------------------------
// The seed. Dates are relative to the CLOCK the tools themselves read (resolveWindow
// calls `new Date()`), so every fixture row lands inside the default 30-day window.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS);
const dayKeyAgo = (n: number) => toDayKey(daysAgo(n));

const ACTIVE_ID = 1;
const ARCHIVED_ID = 2;
const UNAPPROVED_ID = 3;
const SILENT_ID = 4;
const SILENT_ARCHIVED_ID = 5;

/** `product_locations` is seeded BOTH as its own table (getBulkTotalQuantities reads the
 *  model directly) and as the relation array on each product row (inventory-summary
 *  selects it as a nested relation) — one source of truth for both spellings. */
const STOCK: Record<number, number> = {
  [ACTIVE_ID]: 12,
  [ARCHIVED_ID]: 0,
  [UNAPPROVED_ID]: 99,
  [SILENT_ID]: 7,
  [SILENT_ARCHIVED_ID]: 0,
};

const product = (id: number, name: string, baseName: string, approvalStatus: string, deletedAt: Date | null) => ({
  id,
  name,
  baseName,
  variant: "1",
  approvalStatus,
  deletedAt,
  lowStockThreshold: null,
  costPrice: null,
  retailPrice: null,
  product_locations: [{ locationId: 1, quantity: STOCK[id] }],
});

const PRODUCTS = [
  product(ACTIVE_ID, "Active Approved A", "A", "APPROVED", null),
  product(ARCHIVED_ID, "Archived Approved B", "B", "APPROVED", daysAgo(3)),
  product(UNAPPROVED_ID, "Pending Review C", "C", "PENDING_REVIEW", null),
  product(SILENT_ID, "Silent Active D", "D", "APPROVED", null),
  // No facts, no ledger rows, and ARCHIVED: the only way it can appear anywhere is as a
  // zero row from an active+archived population (seam S15).
  product(SILENT_ARCHIVED_ID, "Quiet Retired E", "E", "APPROVED", daysAgo(10)),
];

const PRODUCT_LOCATIONS = PRODUCTS.map((p) => ({
  productId: p.id,
  locationId: 1,
  quantity: STOCK[p.id],
}));

/** One ledger row per product per shape, so every total has a distinguishable magnitude:
 *  active 1x, archived 10x, unapproved 100x. A total that includes the unapproved product
 *  is off by an order of magnitude — impossible to read as a rounding difference. */
const LEDGER = [
  // outbound SALE rows
  { id: 11, productId: ACTIVE_ID, locationId: 1, delta: -10, logType: "SALE", reasonCode: null, changeTime: daysAgo(2), unitCostCents: null, batchId: null },
  { id: 12, productId: ARCHIVED_ID, locationId: 1, delta: -100, logType: "SALE", reasonCode: null, changeTime: daysAgo(2), unitCostCents: null, batchId: null },
  { id: 13, productId: UNAPPROVED_ID, locationId: 1, delta: -1000, logType: "SALE", reasonCode: null, changeTime: daysAgo(2), unitCostCents: null, batchId: null },
  // classified-loss rows (get_shrinkage)
  { id: 21, productId: ACTIVE_ID, locationId: 1, delta: -7, logType: "ADJUSTMENT", reasonCode: "DAMAGE", changeTime: daysAgo(4), unitCostCents: null, batchId: null },
  { id: 22, productId: ARCHIVED_ID, locationId: 1, delta: -70, logType: "ADJUSTMENT", reasonCode: "DAMAGE", changeTime: daysAgo(4), unitCostCents: null, batchId: null },
  { id: 23, productId: UNAPPROVED_ID, locationId: 1, delta: -700, logType: "ADJUSTMENT", reasonCode: "DAMAGE", changeTime: daysAgo(4), unitCostCents: null, batchId: null },
  // receipts (get_movement_series receipts:true)
  { id: 31, productId: ACTIVE_ID, locationId: 1, delta: 5, logType: "STOCK_IN", reasonCode: null, changeTime: daysAgo(5), unitCostCents: 100, batchId: "b1" },
  { id: 32, productId: ARCHIVED_ID, locationId: 1, delta: 50, logType: "STOCK_IN", reasonCode: null, changeTime: daysAgo(5), unitCostCents: 200, batchId: "b2" },
  { id: 33, productId: UNAPPROVED_ID, locationId: 1, delta: 500, logType: "STOCK_IN", reasonCode: null, changeTime: daysAgo(5), unitCostCents: 300, batchId: "b3" },
  // OUT-OF-WINDOW data floors. These sit far behind every query window, so they move no
  // total — they exist to give the ledger sources a dataStart, and to prove that an
  // UNAPPROVED product's even-older row never becomes one (a disclosed data-start is as
  // much a claim about the approved universe as a total is).
  { id: 41, productId: ACTIVE_ID, locationId: 1, delta: -1, logType: "SALE", reasonCode: null, changeTime: daysAgo(200), unitCostCents: null, batchId: null },
  { id: 42, productId: UNAPPROVED_ID, locationId: 1, delta: -1, logType: "SALE", reasonCode: null, changeTime: daysAgo(400), unitCostCents: null, batchId: null },
  { id: 51, productId: ACTIVE_ID, locationId: 1, delta: -2, logType: "ADJUSTMENT", reasonCode: "DAMAGE", changeTime: daysAgo(300), unitCostCents: null, batchId: null },
  { id: 52, productId: UNAPPROVED_ID, locationId: 1, delta: -2, logType: "ADJUSTMENT", reasonCode: "DAMAGE", changeTime: daysAgo(500), unitCostCents: null, batchId: null },
];

const FACTS = [
  { id: 101, productId: ACTIVE_ID, companyId: "c1", integrationId: "i1", dayKey: dayKeyAgo(2), orderedQty: 4, revenue: "8.00", orderCount: 2, fulfilledQty: 0 },
  { id: 102, productId: ARCHIVED_ID, companyId: "c1", integrationId: "i1", dayKey: dayKeyAgo(2), orderedQty: 40, revenue: "80.00", orderCount: 5, fulfilledQty: 0 },
  { id: 103, productId: UNAPPROVED_ID, companyId: "c1", integrationId: "i1", dayKey: dayKeyAgo(2), orderedQty: 400, revenue: "800.00", orderCount: 9, fulfilledQty: 0 },
  // The APPROVED source floor: makes the default window FULLY covered, so an absent
  // product is a MEASURED zero rather than an unknown.
  { id: 104, productId: ACTIVE_ID, companyId: "c1", integrationId: "i1", dayKey: dayKeyAgo(200), orderedQty: 1, revenue: "2.00", orderCount: 1, fulfilledQty: 0 },
  // The unapproved product's OLDEST fact — it must never become salesDataStart.
  { id: 105, productId: UNAPPROVED_ID, companyId: "c1", integrationId: "i1", dayKey: dayKeyAgo(400), orderedQty: 7, revenue: "9.00", orderCount: 1, fulfilledQty: 0 },
  // The ARCHIVED product's own out-of-window floor, so a PRODUCT-SCOPED compare of it has
  // a covered base period (source coverage is per-scope, and a deleted product's history
  // has to be comparable, not just present).
  { id: 106, productId: ARCHIVED_ID, companyId: "c1", integrationId: "i1", dayKey: dayKeyAgo(200), orderedQty: 3, revenue: "5.00", orderCount: 1, fulfilledQty: 0 },
];

function seed(): void {
  prismaCtl.__seed({
    product: PRODUCTS,
    inventory_logs: LEDGER,
    productSalesFact: FACTS,
    product_locations: PRODUCT_LOCATIONS,
  });
}

beforeEach(seed);

async function runTool(name: string, args: Record<string, unknown>, ctx = CTX): Promise<any> {
  const result = (await assistantTools[name].run(args, ctx)) as ToolResult;
  expect(result.status).toBe("ok");
  return (result as { status: "ok"; data: any }).data;
}

const callsTo = (model: string, method: string) =>
  prismaCtl.__calls.filter((c) => c.model === model && c.method === method);

/** Every product.findMany that carries a G5 census predicate (Product-side relation). */
const censusCalls = () =>
  callsTo("product", "findMany").filter(
    (c) => c.args?.where?.inventory_logs != null || c.args?.where?.salesFacts != null,
  );

// ===========================================================================
// TASK 3.1 — the approved universe on the PRE-EXISTING historical reads
// ===========================================================================

describe("3.1 get_sales — the approved universe in every grain", () => {
  it("product grain: unapproved contributes NO row and NO units; archived contributes BOTH, tagged", async () => {
    const data = await runTool("get_sales", { groupBy: "product" });
    const ids = data.rows.map((r: any) => r.productId).sort();
    expect(ids).toEqual([ACTIVE_ID, ARCHIVED_ID]);
    // 4 + 40 = 44. With the unapproved product it would be 444.
    expect(data.rows.reduce((s: number, r: any) => s + (r._sum.orderedQty ?? 0), 0)).toBe(44);
    const archivedRow = data.rows.find((r: any) => r.productId === ARCHIVED_ID);
    expect(archivedRow.lifecycle).toBe("deleted");
    const activeRow = data.rows.find((r: any) => r.productId === ACTIVE_ID);
    expect(activeRow.lifecycle).toBe("active");
    // OC-3: the rows are typed `unknown[]`, so tsc cannot catch an object leaking into
    // `name` — this is the value-bearing assertion that it is a real STRING.
    expect(typeof activeRow.name).toBe("string");
    expect(activeRow.name).toBe("Active Approved A");
  });

  it("product grain: discloses the excluded-unapproved census and the archived contributors", async () => {
    const data = await runTool("get_sales", { groupBy: "product" });
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });

  it("day grain (no product ids in rows): same totals, archived disclosed via the CENSUS", async () => {
    const data = await runTool("get_sales", { groupBy: "day" });
    expect(data.rows.reduce((s: number, r: any) => s + (r._sum.orderedQty ?? 0), 0)).toBe(44);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });

  it("company grain: the unapproved product moves no total there either", async () => {
    const data = await runTool("get_sales", { groupBy: "company" });
    expect(data.rows.reduce((s: number, r: any) => s + (r._sum.orderedQty ?? 0), 0)).toBe(44);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
  });

  it("salesDataStart ignores the unapproved product's OLDER facts (2.2 from-birth, verified here)", async () => {
    const data = await runTool("get_sales", { groupBy: "product" });
    // The unapproved product's oldest fact is 400 days back; the approved floor is 200.
    expect(data.coverage.salesDataStart).toBe(dayKeyAgo(200));
    expect(data.coverage.windowCoverage).toBe("full");
  });

  it("includeZeroRows: a silent APPROVED product gets a measured zero row; the unapproved one never appears", async () => {
    const data = await runTool("get_sales", { groupBy: "product", includeZeroRows: true });
    const ids = data.rows.map((r: any) => r.productId).sort();
    expect(ids).toContain(SILENT_ID);
    expect(ids).not.toContain(UNAPPROVED_ID);
    const silent = data.rows.find((r: any) => r.productId === SILENT_ID);
    // OC-7: "0" is what a MEASURED zero serializes to (Decimal(0).toString()).
    expect(silent._sum).toEqual({ orderedQty: 0, revenue: "0", orderCount: 0 });
  });

  // OC-2: `archivedProductsIncluded` counts CONTRIBUTORS. The zero-row synthesis was
  // folded into it, so a deleted product that contributed NOTHING inflated the count —
  // "1 archived product's history is in these numbers" when the honest answer was 0.
  it("archivedProductsIncluded counts MEASURED rows only; zero rows are counted separately", async () => {
    const measuredOnly = await runTool("get_sales", { groupBy: "product" });
    // ARCHIVED_ID really sold 40 units in the window; SILENT_ARCHIVED_ID has no facts.
    expect(measuredOnly.coverage.archivedProductsIncluded).toBe(1);
    expect(measuredOnly.coverage.archivedZeroRows).toBeUndefined(); // no zero rows here

    const withZeros = await runTool("get_sales", { groupBy: "product", includeZeroRows: true });
    // The count does NOT move when synthesized rows join the answer...
    expect(withZeros.coverage.archivedProductsIncluded).toBe(1);
    // ...and the archived zero-row population is disclosed on its own terms.
    expect(withZeros.coverage.archivedZeroRows).toBe(1);
    // The row is still THERE and still tagged — nothing was hidden by the correction.
    const quiet = withZeros.rows.find((r: any) => r.productId === SILENT_ARCHIVED_ID);
    expect(quiet.lifecycle).toBe("deleted");
  });

  it("G5 mechanics: an id-set filter on the fact read, a PRODUCT-SIDE census, and no ledger groupBy", async () => {
    await runTool("get_sales", { groupBy: "product" });
    const factRead = callsTo("productSalesFact", "groupBy")[0];
    expect(factRead.args.where.productId.in).toEqual(expect.arrayContaining([ACTIVE_ID, ARCHIVED_ID]));
    expect(factRead.args.where.productId.in).not.toContain(UNAPPROVED_ID);
    const census = censusCalls();
    expect(census.length).toBeGreaterThan(0);
    // PRODUCT-SIDE relation only (G5 bans the child-side `product` spelling here).
    for (const c of census) {
      expect(c.args.where.salesFacts?.some ?? c.args.where.inventory_logs?.some).toBeDefined();
      expect(c.args.where).not.toHaveProperty("product");
    }
    // NEVER an extra full-window ledger groupBy for a SALES question.
    expect(callsTo("inventory_logs", "groupBy")).toEqual([]);
  });
});

describe("3.1 get_shrinkage — approved universe + aggregate disclosure", () => {
  it("classified loss counts approved products only (archived included, unapproved excluded)", async () => {
    const data = await runTool("get_shrinkage", { days: 30 });
    // 7 + 70 = 77. With the unapproved product it would be 777.
    expect(data.byReason.DAMAGE.units).toBe(77);
    expect(data.totalUnits).toBe(77);
  });

  it("discloses the excluded-unapproved census and the archived contributors", async () => {
    const data = await runTool("get_shrinkage", { days: 30 });
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });

  it("dataStart comes from the approved universe — an unapproved product's older row never sets it", async () => {
    const data = await runTool("get_shrinkage", { days: 30 });
    // The approved floor is 300 days back; the unapproved one is 500. A disclosed
    // data-start is a claim about the universe being reported, so it obeys the filter too.
    expect(data.dataStart.slice(0, 10)).toBe(dayKeyAgo(300));
  });
});

describe("3.1 get_movement_series — approved universe in all three modes", () => {
  it("series totals exclude the unapproved product and include the archived one", async () => {
    const data = await runTool("get_movement_series", {});
    // SALE bucket is SIGNED: -(10 + 100). With the unapproved product it would be -1110.
    expect(data.totals.sale).toBe(-110);
    expect(data.totals.stockIn).toBe(55);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });

  it("receipts rows come only from approved products, and the disclosure rides along", async () => {
    const data = await runTool("get_movement_series", { receipts: true });
    const ids = data.rows.map((r: any) => r.productId).sort();
    expect(ids).toEqual([ACTIVE_ID, ARCHIVED_ID]);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
  });

  it("by_product (approved from birth) now carries the same disclosure", async () => {
    const data = await runTool("get_movement_series", { breakdownBy: "product" });
    const ids = data.rows.map((r: any) => r.productId).sort();
    expect(ids).toEqual([ACTIVE_ID, ARCHIVED_ID]);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });

  it("G5 mechanics: the ledger census uses the PRODUCT-SIDE inventory_logs relation", async () => {
    await runTool("get_movement_series", {});
    const census = censusCalls();
    expect(census.length).toBeGreaterThan(0);
    for (const c of census) {
      expect(c.args.where.inventory_logs.some).toBeDefined();
      expect(c.args.where).not.toHaveProperty("products");
    }
  });
});

describe("3.1 compare_periods — both metric families, both modes", () => {
  const PERIODS = { periodA: { relativeDays: 10 }, periodB: { relativeDays: 10 } };

  it("totals mode, sales metric: the unapproved product moves neither period", async () => {
    const data = await runTool("compare_periods", { metric: "sales_units", ...PERIODS });
    expect(data.b).toBe(44);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });

  it("totals mode, ledger metric: outbound_units counts approved rows only", async () => {
    const data = await runTool("compare_periods", { metric: "outbound_units", ...PERIODS });
    // |(-10) + (-100) + (-7) + (-70)| = 187. With the unapproved product: 1887.
    expect(data.b).toBe(187);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
  });

  it("by_product mode carries the disclosure beside its (already approved-scoped) rows", async () => {
    const data = await runTool("compare_periods", {
      metric: "sales_units",
      groupBy: "product",
      ...PERIODS,
    });
    const ids = [...data.rows, ...data.unranked].map((r: any) => r.productId).sort();
    expect(ids).not.toContain(UNAPPROVED_ID);
    expect(data.coverage.excludedUnapprovedProducts).toBe(1);
    expect(data.coverage.archivedProductsIncluded).toBe(1);
  });
});

describe("3.1 get_business_snapshot — a CURRENT-STATE tool stays active-only", () => {
  it("sales totals exclude the ARCHIVED product as well as the unapproved one", async () => {
    const data = await runTool("get_business_snapshot", {});
    expect(data.sales.status).toBe("ok");
    // Only the active approved product's 4 units — never 44 (archived) and never 444.
    expect(data.sales.last30d.orderedUnits).toBe(4);
  });

  it("its fact read is narrowed to the approved ACTIVE id set", async () => {
    await runTool("get_business_snapshot", {});
    const aggregates = callsTo("productSalesFact", "aggregate").filter(
      (c) => c.args?.where?.dayKey != null,
    );
    expect(aggregates.length).toBeGreaterThan(0);
    for (const c of aggregates) {
      expect(c.args.where.productId.in).toContain(ACTIVE_ID);
      expect(c.args.where.productId.in).not.toContain(ARCHIVED_ID);
      expect(c.args.where.productId.in).not.toContain(UNAPPROVED_ID);
    }
  });
});

// ===========================================================================
// G2-1 — the FRESHNESS aggregates. The rows of these tools were always approved-scoped;
// their per-source data-starts were not, so a PENDING-REVIEW product's oldest ledger row
// dated a report that excludes that product entirely. A disclosed data-start is a claim
// about the universe being reported.
// ===========================================================================

describe("G2-1 — a pending-review product's oldest row moves NO dataStart", () => {
  it("get_operations freshness is measured over the approved-ACTIVE universe", async () => {
    const data = await runTool("get_operations", {});
    // The unapproved product's oldest SALE is 400 days back; the approved floor is 200.
    expect(data.freshness.ledgerSaleStart.slice(0, 10)).toBe(dayKeyAgo(200));
    // Its oldest OUTBOUND row (a negative ADJUSTMENT) is 500 days back; approved: 300.
    expect(data.freshness.outbound.slice(0, 10)).toBe(dayKeyAgo(300));
    expect(data.freshness.adjustment.slice(0, 10)).toBe(dayKeyAgo(300));

    // MECHANICS (seam S13): every dataStart aggregate carries the id-set filter, and for
    // this CURRENT-STATE tool the universe is ACTIVE-only — the same population its rows
    // come from, so the freshness block and the rows can never describe different sets.
    const aggregates = callsTo("inventory_logs", "aggregate");
    expect(aggregates.length).toBeGreaterThan(0);
    for (const c of aggregates) {
      expect(c.args.where.productId.in).toContain(ACTIVE_ID);
      expect(c.args.where.productId.in).not.toContain(ARCHIVED_ID);
      expect(c.args.where.productId.in).not.toContain(UNAPPROVED_ID);
    }
  });

  it("get_data_freshness dataStarts are measured over the approved HISTORICAL universe", async () => {
    const data = await runTool("get_data_freshness", {});
    expect(data.dataStarts.ledgerSaleStart.slice(0, 10)).toBe(dayKeyAgo(200));
    expect(data.dataStarts.ledgerOutboundStart.slice(0, 10)).toBe(dayKeyAgo(300));
    expect(data.dataStarts.ledgerReceiptStart.slice(0, 10)).toBe(dayKeyAgo(5));

    // This surface REPORTS archived history (get_sales, get_movement_series...), so its
    // documented universe is active + archived — and never the unapproved product.
    const aggregates = callsTo("inventory_logs", "aggregate");
    expect(aggregates.length).toBeGreaterThan(0);
    for (const c of aggregates) {
      expect(c.args.where.productId.in).toEqual(
        expect.arrayContaining([ACTIVE_ID, ARCHIVED_ID]),
      );
      expect(c.args.where.productId.in).not.toContain(UNAPPROVED_ID);
    }
  });
});

// ===========================================================================
// OC-4 / G2-2 — the snapshot's sales section vs get_sales. The two tools answer the
// same question over DIFFERENT universes by design; the snapshot never said so, and its
// salesDataStart was measured over a population its totals do not sum.
// ===========================================================================

describe("OC-4 — the snapshot's ACTIVE-ONLY sales section discloses the gap", () => {
  it("snapshot total <= get_sales total, and the difference is the disclosed archived history", async () => {
    const snapshot = await runTool("get_business_snapshot", {});
    const sales = await runTool("get_sales", { groupBy: "product", relativeDays: 30 });

    const salesUnits = sales.rows.reduce((s: number, r: any) => s + (r._sum.orderedQty ?? 0), 0);
    const snapshotUnits = snapshot.sales.last30d.orderedUnits;
    expect(snapshotUnits).toBeLessThanOrEqual(salesUnits);
    // ...and the gap is EXACTLY the archived product's 40 units, nothing unexplained.
    expect(salesUnits - snapshotUnits).toBe(40);

    // Both sides now state which universe they measured.
    expect(sales.coverage.archivedProductsIncluded).toBe(1);
    expect(snapshot.sales.coverage.archivedProductsIncluded).toBe(0);
    expect(snapshot.sales.coverage.excludedUnapprovedProducts).toBe(1);
    expect(snapshot.sales.coverage.approvalNote).toContain("ACTIVE-ONLY");
    expect(snapshot.sales.coverage.approvalNote).toContain("get_sales");
  });

  it("G2-2: the snapshot's salesDataStart is measured over that SAME active-only universe", async () => {
    await runTool("get_business_snapshot", {});
    // The un-windowed fact aggregates are the salesDataStart reads (the windowed ones are
    // the section totals). The snapshot's own read excludes the archived product; the
    // freshness section keeps the historical universe, and neither ever sees an
    // unapproved product.
    const startReads = callsTo("productSalesFact", "aggregate").filter(
      (c) => c.args?.where?.dayKey == null,
    );
    expect(startReads.length).toBeGreaterThan(0);
    expect(
      startReads.filter((c) => !c.args.where.productId.in.includes(ARCHIVED_ID)).length,
    ).toBeGreaterThan(0);
    for (const c of startReads) {
      expect(c.args.where.productId.in).not.toContain(UNAPPROVED_ID);
    }
  });

  it("get_product_overview's sales30 start is active-only too (its product is active)", async () => {
    await runTool("get_product_overview", { productId: ACTIVE_ID });
    const startReads = callsTo("productSalesFact", "aggregate").filter(
      (c) => c.args?.where?.dayKey == null,
    );
    expect(startReads.length).toBeGreaterThan(0);
    for (const c of startReads) {
      expect(c.args.where.productId.in).toContain(ACTIVE_ID);
      expect(c.args.where.productId.in).not.toContain(ARCHIVED_ID);
    }
  });
});

describe("3.1 seam S11 — the deprecated taxonomy re-export is gone", () => {
  it("lib/analytics/queries.ts no longer re-exports SHRINKAGE_CLASS_REASONS", async () => {
    const queries = await import("@/lib/analytics/queries");
    expect(Object.keys(queries)).not.toContain("SHRINKAGE_CLASS_REASONS");
  });
});

// ===========================================================================
// TASK 3.2 — the FULL spec C13 policy table
// ===========================================================================

const NOT_FOUND_FOR_ARCHIVED = {
  status: "error",
  error: { code: "NOT_FOUND", message: expect.stringContaining(String(ARCHIVED_ID)) },
};

describe("3.2 policy table — the NINE current-state tools never see an archived product", () => {
  // Each of these resolves through the SINGULAR resolver with its default (active-only)
  // scope. A tool that quietly started passing allowArchived would answer here instead of
  // refusing, which is exactly the incoherence spec C13 forbids.
  it.each([
    ["get_stock", {}],
    ["get_operations", {}],
    ["get_valuation", {}],
    ["get_inventory_policy", {}],
    ["get_product_overview", {}],
  ])("%s returns notFound for the archived product", async (name, extra) => {
    const result = await assistantTools[name].run({ productId: ARCHIVED_ID, ...extra }, CTX);
    expect(result).toEqual(NOT_FOUND_FOR_ARCHIVED);
  });

  it("the unapproved product is equally invisible to them (unchanged, re-pinned here)", async () => {
    const result = await assistantTools.get_stock.run({ productId: UNAPPROVED_ID }, CTX);
    expect(result).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining(String(UNAPPROVED_ID)) },
    });
  });

  it("catalog-grain current-state tools carry neither product in their rows", async () => {
    const summary = await runTool("get_inventory_summary", {});
    expect(summary.productCount).toBe(2); // the two APPROVED + ACTIVE products only
    const catalogReads = callsTo("product", "findMany").filter(
      (c) => c.args?.where?.approvalStatus === "APPROVED" && c.args?.where?.deletedAt === null,
    );
    expect(catalogReads.length).toBeGreaterThan(0);
  });
});

describe("3.2 policy table — the FOUR historical tools DO see it, tagged", () => {
  // Seam S4/CP-8: the exact-shape resolver gate cannot prove each CALL SITE passes
  // allowArchived. Driving the archived id through all four tools can, and does.
  it("get_sales(productId) answers for an archived product and tags the lifecycle", async () => {
    const data = await runTool("get_sales", { productId: ARCHIVED_ID, groupBy: "product" });
    expect(data.lifecycle).toBe("deleted");
    expect(data.productScope.name).toBe("Archived Approved B");
    expect(data.rows[0]._sum.orderedQty).toBe(40);
  });

  it("get_movement_series(productId) returns its real movement, tagged", async () => {
    const data = await runTool("get_movement_series", { productId: ARCHIVED_ID });
    expect(data.lifecycle).toBe("deleted");
    expect(data.totals.sale).toBe(-100);
  });

  it("get_stock_asof(EXPLICIT productId) reaches it — and tags the row", async () => {
    const data = await runTool("get_stock_asof", { dayKey: dayKeyAgo(1), productId: ARCHIVED_ID });
    expect(data.lifecycle).toBe("deleted");
    expect(data.rows.map((r: any) => r.productId)).toEqual([ARCHIVED_ID]);
    expect(data.rows[0].lifecycle).toBe("deleted");
  });

  it("get_stock_asof CATALOG page stays active-only (the named C13 exception)", async () => {
    const data = await runTool("get_stock_asof", { dayKey: dayKeyAgo(1) });
    const ids = data.rows.map((r: any) => r.productId).sort();
    expect(ids).toEqual([ACTIVE_ID, SILENT_ID]);
    expect(data.rows.every((r: any) => r.lifecycle === "active")).toBe(true);
  });

  it("compare_periods(productId) answers for it, tagged", async () => {
    const data = await runTool("compare_periods", {
      metric: "sales_units",
      productId: ARCHIVED_ID,
      periodA: { relativeDays: 10 },
      periodB: { relativeDays: 10 },
    });
    expect(data.lifecycle).toBe("deleted");
    expect(data.b).toBe(40);
  });

  it("includeZeroRows now populates from active+archived (W2 seam S15 closed)", async () => {
    const data = await runTool("get_sales", { groupBy: "product", includeZeroRows: true });
    const ids = data.rows.map((r: any) => r.productId).sort((a: number, b: number) => a - b);
    // SILENT_ARCHIVED has NO facts at all: it can only be here if the zero-row population
    // is active+archived, which is exactly what W2 deferred to this task.
    expect(ids).toEqual([ACTIVE_ID, ARCHIVED_ID, SILENT_ID, SILENT_ARCHIVED_ID]);
    expect(ids).not.toContain(UNAPPROVED_ID);
    const quiet = data.rows.find((r: any) => r.productId === SILENT_ARCHIVED_ID);
    expect(quiet.lifecycle).toBe("deleted");
    expect(quiet._sum).toEqual({ orderedQty: 0, revenue: "0", orderCount: 0 });
  });

  it("receipts rows carry name + lifecycle (W2 seam S14 closed)", async () => {
    const data = await runTool("get_movement_series", { receipts: true });
    const archived = data.rows.find((r: any) => r.productId === ARCHIVED_ID);
    expect(archived.name).toBe("Archived Approved B");
    expect(archived.lifecycle).toBe("deleted");
    const active = data.rows.find((r: any) => r.productId === ACTIVE_ID);
    expect(active.lifecycle).toBe("active");
  });
});

describe("3.2 find_product — includeArchived, tagged rows, nulled current state", () => {
  it("archived products are ABSENT by default", async () => {
    const data = await runTool("find_product", { query: "Approved" });
    const ids = data.products.map((p: any) => p.id).sort();
    expect(ids).toEqual([ACTIVE_ID]);
  });

  it("includeArchived:true lists them, tagged, with current-state fields NULLED + a stateNote", async () => {
    const data = await runTool("find_product", { query: "Approved", includeArchived: true });
    const ids = data.products.map((p: any) => p.id).sort();
    expect(ids).toEqual([ACTIVE_ID, ARCHIVED_ID]);
    const archived = data.products.find((p: any) => p.id === ARCHIVED_ID);
    expect(archived.lifecycle).toBe("deleted");
    expect(archived.currentStock).toBeNull();
    expect(archived.lowStock).toBeNull();
    expect(archived.stockState).toBeNull();
    expect(archived.stateNote).toBe(
      "deleted product — current stock not reported; history remains queryable",
    );
    // The live row keeps every current-state field it always had.
    const active = data.products.find((p: any) => p.id === ACTIVE_ID);
    expect(active.lifecycle).toBe("active");
    expect(typeof active.currentStock).toBe("number");
    expect(active.stateNote).toBeUndefined();
  });

  it("the unapproved product never surfaces, with or without the flag", async () => {
    const data = await runTool("find_product", { query: "Pending", includeArchived: true });
    expect(data.products).toEqual([]);
  });
});

describe("3.2 getProductsWithQuantities — default behavior unchanged for every OTHER caller", () => {
  it("omitting includeDeleted keeps today's deletedAt: null predicate", async () => {
    const { getProductsWithQuantities } = await import("@/lib/products");
    prismaCtl.__reset();
    await getProductsWithQuantities({ search: "Approved" });
    for (const c of callsTo("product", "findMany")) {
      expect(c.args.where.deletedAt).toBeNull();
    }
    for (const c of callsTo("product", "count")) {
      expect(c.args.where.deletedAt).toBeNull();
    }
  });

  it("includeDeleted:true is the ONLY way the predicate is relaxed", async () => {
    const { getProductsWithQuantities } = await import("@/lib/products");
    prismaCtl.__reset();
    await getProductsWithQuantities({ search: "Approved", includeDeleted: true });
    for (const c of [...callsTo("product", "findMany"), ...callsTo("product", "count")]) {
      expect(c.args.where).not.toHaveProperty("deletedAt");
    }
  });
});

describe("3.2 conv-2 end-to-end — 'when did it stock out?' is movement-history reading", () => {
  it("find_product(includeArchived) -> movement series gives the DEPLETION DATES, labeled", async () => {
    // Step 1: the model finds the deleted product it could not see before.
    const found = await runTool("find_product", { query: "Archived", includeArchived: true });
    const target = found.products.find((p: any) => p.lifecycle === "deleted");
    expect(target.id).toBe(ARCHIVED_ID);
    expect(target.stateNote).toContain("history remains queryable");

    // Step 2: its movement series carries the dated depletion — the honest answer to
    // "when did it stock out", which is a series read, never a single-call scalar.
    const series = await runTool("get_movement_series", { productId: target.id });
    expect(series.lifecycle).toBe("deleted");
    const depletionDays = series.points.filter((p: any) => p.sale < 0);
    expect(depletionDays.length).toBeGreaterThan(0);
    expect(depletionDays[0].key).toBe(dayKeyAgo(2));

    // Step 3: as-of on the SPECIFIC id confirms balances on a day (catalog page would not).
    const asOf = await runTool("get_stock_asof", { dayKey: dayKeyAgo(1), productId: target.id });
    expect(asOf.rows[0].lifecycle).toBe("deleted");
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
