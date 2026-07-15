/**
 * @jest-environment node
 *
 * The assistant toolsuite ENFORCEMENT GATES (spec §7; plan-gate #4/#5). CI-failing,
 * Lane-6 style. Three layers of the READ-ONLY gate plus the coverage/definition
 * meta-rules and the shared product-resolver contract:
 *
 *  1. FAIL-CLOSED Prisma proxy — every registered tool is run through a per-tool fixture
 *     matrix against a proxy that returns shape-correct benign values (so every read
 *     path COMPLETES) and RECORDS every call. Each tool must (a) not throw and (b) issue
 *     zero business writes across EVERY tool (R2-B1 closed by W0-4; no expected-fails)
 *     (the known R2-B1 upsert; W0-4's acceptance flips it).
 *  2. STATIC source check — no un-allowlisted Prisma write tokens in the read-path source
 *     (allowlist in ./static-write-allowlist).
 *  3. COVERAGE + DEFINITION gates — every non-exempt tool carries a coverage/freshness
 *     block that validates CoverageSchema; a rate field carries a definition string.
 *     GATE_EXEMPTIONS is a temporary, shrink-only table.
 *
 * Plus the W0-PROD resolver contract + the universal productId not-found fixture.
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// (1) The fail-closed universal Prisma proxy. Defined inside the jest.mock factory
//     (hoisted); control handles are re-read via jest.requireMock below.
// ---------------------------------------------------------------------------

jest.mock("@/lib/prisma", () => {
  type Call = { model: string; method: string; args: unknown };
  const calls: Call[] = [];
  const overrides: Record<string, unknown> = {}; // `${model}.${method}` -> resolved value

  const benign = (method: string): unknown => {
    if (method === "findMany" || method === "groupBy") return []; // array-returning reads
    if (method.startsWith("find")) return null; // findUnique/findFirst(/OrThrow) -> null
    if (method === "count") return 0;
    if (method === "aggregate") return { _min: {}, _max: {}, _sum: {}, _count: {} };
    return {}; // create/update/upsert/delete/... -> benign object
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
            const key = `${model}.${method}`;
            if (key in overrides) return Promise.resolve(overrides[key]);
            return Promise.resolve(benign(method));
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
        if (p === "then") return undefined; // never a thenable
        if (p === "$transaction") {
          return (arg: unknown) =>
            typeof arg === "function"
              ? (arg as (c: unknown) => unknown)(root)
              : Promise.all(arg as unknown[]);
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
    __calls: calls,
    __overrides: overrides,
    __reset: () => {
      calls.length = 0;
      for (const k of Object.keys(overrides)) delete overrides[k];
    },
  };
});

import {
  assistantTools,
  TOOL_SCOPES,
  CoverageSchema,
  notFound,
  testCtx,
  type ToolResult,
} from "@/lib/assistant/tools";
import { resolveAssistantProduct } from "@/lib/assistant/resolve-product";
import { STATIC_WRITE_ALLOWLIST } from "./static-write-allowlist";

const prismaCtl = jest.requireMock("@/lib/prisma") as {
  __calls: Array<{ model: string; method: string; args: unknown }>;
  __overrides: Record<string, unknown>;
  __reset: () => void;
};

const CTX = testCtx({ companyIds: ["c1"] });

/** A large sentinel ID the proxy resolves to null (findFirst/findUnique -> null). */
const PENDING_REVIEW_FIXTURE_ID = 999999;

const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRawUnsafe",
]);

function writeCalls(): Array<{ model: string; method: string }> {
  return prismaCtl.__calls
    .filter((c) => WRITE_METHODS.has(c.method))
    .map((c) => ({ model: c.model, method: c.method }));
}

// ---------------------------------------------------------------------------
// Per-tool fixture matrix (spec §7: exercise each tool's branches).
// ---------------------------------------------------------------------------

const TOOL_GATE_FIXTURES: Record<string, unknown[]> = {
  find_product: [{ query: "abc" }],
  get_stock: [
    { productId: 1 },
    { productId: 1, from: "2026-01-01", to: "2026-06-01" },
    { productId: 1, locationId: 2 },
  ],
  get_sales: [
    {},
    { groupBy: "day" },
    { productId: 1, groupBy: "product" },
    { groupBy: "week" },
    { groupBy: "month" },
    { groupBy: "company" },
  ],
  get_operations: [{}, { windowDays: 30 }],
  get_shrinkage: [{ days: 30 }, { days: 365 }],
  get_valuation: [{}],
  low_stock_report: [{}],
  reorder_report: [{}, { includeOkay: false }],
};

/**
 * Temporary, SHRINKING coverage/definition exemptions (spec §7). Each W0 task removes
 * its entries; W0-2 empties the table — every one of the 8 tools now carries a
 * coverage/freshness block (and a definition string where it emits a rate), so nothing
 * is exempt. The baseline snapshot below pins that the table can only shrink.
 */
const GATE_EXEMPTIONS: Record<string, string[]> = {};
const GATE_EXEMPTIONS_BASELINE: Record<string, string[]> = {
  find_product: ["coverage"],
  get_sales: ["coverage"],
  get_operations: ["coverage", "definition"],
  low_stock_report: ["coverage", "definition"],
  get_stock: ["coverage"],
};

const isExempt = (tool: string, gate: string): boolean => (GATE_EXEMPTIONS[tool] ?? []).includes(gate);

const TOOL_NAMES = Object.keys(assistantTools);

beforeEach(() => prismaCtl.__reset());

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  it("every registered tool has gate fixtures", () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_GATE_FIXTURES[name]).toBeDefined();
      expect(TOOL_GATE_FIXTURES[name].length).toBeGreaterThan(0);
    }
  });

  it("every registered tool has a static TOOL_SCOPES entry (company|global — never mixed)", () => {
    for (const name of TOOL_NAMES) {
      expect(["company", "global"]).toContain(TOOL_SCOPES[name]);
    }
  });

  it("GATE_EXEMPTIONS only ever shrinks (baseline snapshot)", () => {
    for (const [tool, gates] of Object.entries(GATE_EXEMPTIONS)) {
      expect(GATE_EXEMPTIONS_BASELINE[tool]).toBeDefined(); // no NEWLY-exempted tool
      for (const g of gates) expect(GATE_EXEMPTIONS_BASELINE[tool]).toContain(g); // no NEW gate
    }
  });
});

// ---------------------------------------------------------------------------
// (1a) No throw — a crash must not false-pass the zero-writes assertion.
// ---------------------------------------------------------------------------

describe("READ-ONLY gate — every tool completes without throwing (fail-closed proxy)", () => {
  it.each(TOOL_NAMES)("%s completes for all fixtures", async (name) => {
    for (const fixture of TOOL_GATE_FIXTURES[name]) {
      prismaCtl.__reset();
      const result = await assistantTools[name].run(fixture, CTX);
      expect(result).toBeDefined();
      expect(["ok", "truncated", "error"]).toContain((result as ToolResult).status);
    }
  });
});

// ---------------------------------------------------------------------------
// (1b) Zero business writes — every tool, no exceptions (R2-B1 closed by W0-4).
// ---------------------------------------------------------------------------

describe("READ-ONLY gate — no business writes from def.run (fail-closed proxy)", () => {
  it.each(TOOL_NAMES.filter((n) => n !== "reorder_report"))(
    "%s issues zero write calls across all fixtures",
    async (name) => {
      for (const fixture of TOOL_GATE_FIXTURES[name]) {
        prismaCtl.__reset();
        await assistantTools[name].run(fixture, CTX);
        expect(writeCalls()).toEqual([]);
      }
    },
  );

  // R2-B1 CLOSED by W0-4: getGlobalReorderSettings() is findUnique + in-memory defaults.
  // This is the permanent zero-writes assertion for the reorder read path.
  it("reorder_report issues zero write calls (R2-B1 closed by W0-4)", async () => {
    prismaCtl.__reset();
    await assistantTools.reorder_report.run({}, CTX);
    expect(writeCalls()).toEqual([]);
  });

  // FIX 4d: the empty-companyIds context (a caller with no company access) must complete
  // and issue zero writes — get_sales takes the []-fast path (no query) rather than throwing.
  it("get_sales with EMPTY companyIds completes without throwing and issues zero writes", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.get_sales.run({}, testCtx({ companyIds: [] }));
    expect(["ok", "truncated", "error"]).toContain((result as ToolResult).status);
    expect(writeCalls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2) STATIC source check — no un-allowlisted write tokens in the read path.
// ---------------------------------------------------------------------------

describe("READ-ONLY gate — static source check (spec §7 layer 2)", () => {
  // FIX 4c: every module tools.ts pulls into the read path is scanned, so a write that
  // sneaks into ANY of them fails the gate. These mirror the actual @/lib imports of
  // lib/assistant/tools.ts (checked to exist; stock-threshold.ts is present in this repo).
  const READ_PATH_FILES = [
    "lib/assistant/tools.ts",
    "lib/assistant/window.ts",
    "lib/assistant/resolve-product.ts",
    "lib/assistant/sales-coverage.ts",
    "lib/products.ts",
    "lib/stock-threshold.ts",
    "lib/analytics/queries.ts",
    "lib/analytics/serialize.ts",
    "lib/analytics/dates.ts",
    "lib/reports/low-stock.ts",
    "lib/reports/reorder.ts",
    "lib/reports/demand.ts",
    "lib/reports/metrics-contract.ts",
    // reorder-config.ts is the read-path config dependency (reorder.ts imports it) and
    // is where the R2-B1 write lives — scanned so the allowlist can name it.
    "lib/reorder-config.ts",
  ];
  const WRITE_TOKEN_SRC =
    "\\.\\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\\s*\\(|" +
    "\\$(executeRaw|executeRawUnsafe|queryRawUnsafe)\\b";

  it("no Prisma write-method token appears un-allowlisted in the read-path source", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const unexpected: string[] = [];
    for (const rel of READ_PATH_FILES) {
      const src = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      const re = new RegExp(WRITE_TOKEN_SRC, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const method = m[1] ?? `$${m[2]}`;
        const allowed = STATIC_WRITE_ALLOWLIST.some((e) => e.file === rel && e.method === method);
        if (!allowed) unexpected.push(`${rel}: ${method}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it("the allowlist is EMPTY — the read path carries zero writes (W0-4 closed R2-B1)", () => {
    expect(STATIC_WRITE_ALLOWLIST).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (3) COVERAGE gate — shape, not just presence.
// ---------------------------------------------------------------------------

// FIX 4b: an EXACT key allowlist, not a substring match — so an unrelated key like
// `coverageNote` (or a future `pointsNote`) can never satisfy the coverage gate by merely
// containing "coverage". These are the only keys that carry a real coverage/freshness block.
const COVERAGE_BLOCK_KEYS = new Set([
  "coverage",
  "freshness",
  "seriesCoverage",
  "costCoverage",
  "receiptCoverage",
  "retailCoverage",
  "turnsCoverage",
]);

/** Recursively collect the values of any key in COVERAGE_BLOCK_KEYS (exact match). */
function collectCoverageBlocks(data: unknown): unknown[] {
  const found: unknown[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (COVERAGE_BLOCK_KEYS.has(k) && val && typeof val === "object" && !Array.isArray(val)) {
          found.push(val);
        }
        visit(val);
      }
    }
  };
  visit(data);
  return found;
}

describe("COVERAGE gate (spec §7 — validates CoverageSchema)", () => {
  it("CoverageSchema rejects an empty object but accepts a named-field block", () => {
    expect(() => CoverageSchema.parse({})).toThrow();
    expect(() => CoverageSchema.parse({ valued: 0, of: 80 })).not.toThrow();
  });

  // FIX 4a: a block whose only key holds `undefined` serializes to `{}` — it must FAIL,
  // so the gate can never be satisfied by an all-undefined block that ships empty JSON.
  it("CoverageSchema rejects a block whose keys are ALL undefined (serializes empty)", () => {
    expect(() => CoverageSchema.parse({ field: undefined })).toThrow();
    expect(() => CoverageSchema.parse({ a: undefined, b: undefined })).toThrow();
    // A single defined value (even 0 or null) is enough.
    expect(() => CoverageSchema.parse({ a: undefined, b: 0 })).not.toThrow();
    expect(() => CoverageSchema.parse({ a: null })).not.toThrow();
  });

  const coverageTools = TOOL_NAMES.filter((n) => !isExempt(n, "coverage"));
  it.each(coverageTools)("%s carries a coverage/freshness block validating CoverageSchema", async (name) => {
    prismaCtl.__reset();
    // Happy-path fixture: a productId-taking tool (get_stock) resolves through
    // resolveAssistantProduct — override findFirst so the fixture id resolves to an
    // approved product and the tool reaches its coverage-bearing OK result (rather than
    // notFound). Harmless for tools that don't resolve a product.
    prismaCtl.__overrides["product.findFirst"] = { id: 1, name: "Gate Fixture Product" };
    const result = await assistantTools[name].run(TOOL_GATE_FIXTURES[name][0], CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const blocks = collectCoverageBlocks(result.data);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(() => CoverageSchema.parse(b)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (3) DEFINITION gate — a rate field carries a definition string.
// ---------------------------------------------------------------------------

const RATE_FIELD = /avgDaily|velocity|Usage|Demand/;

function collectKeys(data: unknown, pred: (k: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (pred(k)) out.push(k);
        visit(val);
      }
    }
  };
  visit(data);
  return out;
}

describe("DEFINITION gate (spec §7 — rate field ⇒ definition string)", () => {
  const definitionTools = TOOL_NAMES.filter((n) => !isExempt(n, "definition"));
  it.each(definitionTools)("%s: any rate field is accompanied by a definition string", async (name) => {
    prismaCtl.__reset();
    // See the coverage gate: resolve the productId fixture to an approved product.
    prismaCtl.__overrides["product.findFirst"] = { id: 1, name: "Gate Fixture Product" };
    const result = await assistantTools[name].run(TOOL_GATE_FIXTURES[name][0], CTX);
    if (result.status !== "ok") return;
    const rateKeys = collectKeys(result.data, (k) => RATE_FIELD.test(k) && !/Definition$/i.test(k));
    if (rateKeys.length === 0) return; // proxy yields empty data — no rate emitted, nothing to define
    const defKeys = collectKeys(result.data, (k) => /Definition$/i.test(k));
    expect(defKeys.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// W0-PROD — the shared resolver + the ONE not-found shape.
// ---------------------------------------------------------------------------

describe("notFound — the ONE not-found shape (spec §4 W0-PROD)", () => {
  it("returns { status: error, error: { code: NOT_FOUND, message } } with no meta", () => {
    const r = notFound("product", PENDING_REVIEW_FIXTURE_ID);
    expect(r).toEqual({
      status: "error",
      error: { code: "NOT_FOUND", message: expect.stringContaining(String(PENDING_REVIEW_FIXTURE_ID)) },
    });
    expect((r as { meta?: unknown }).meta).toBeUndefined();
  });
});

describe("resolveAssistantProduct (spec §4 W0-PROD)", () => {
  it("returns { id, name } for an approved, non-deleted product and filters on that scope", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 5, name: "TIRZ 10mg" };
    await expect(resolveAssistantProduct(5)).resolves.toEqual({ id: 5, name: "TIRZ 10mg" });
    const call = prismaCtl.__calls.find((c) => c.model === "product" && c.method === "findFirst");
    expect(call).toBeDefined();
    expect((call!.args as { where: Record<string, unknown> }).where).toMatchObject({
      id: 5,
      deletedAt: null,
      approvalStatus: "APPROVED",
    });
  });

  it("returns null for a pending-review / soft-deleted / absent id (proxy findFirst -> null)", async () => {
    prismaCtl.__reset();
    await expect(resolveAssistantProduct(PENDING_REVIEW_FIXTURE_ID)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Universal productId fixture (spec §4 W0-PROD). A guessed pending-review ID must
// return the notFound shape from EVERY tool wired through resolveAssistantProduct.
// W0-2 wired get_stock + get_sales — the proxy resolves findFirst to null for the
// sentinel id, so each returns the shared notFound shape (never provisional data).
// ---------------------------------------------------------------------------

describe("universal productId not-found fixture (spec §4 W0-PROD)", () => {
  const NOT_FOUND = {
    status: "error",
    error: { code: "NOT_FOUND", message: expect.stringContaining(String(PENDING_REVIEW_FIXTURE_ID)) },
  };

  it("get_stock returns notFound for a pending-review productId (never currentStock:0)", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.get_stock.run({ productId: PENDING_REVIEW_FIXTURE_ID }, CTX);
    expect(result).toEqual(NOT_FOUND);
  });

  it("get_sales returns notFound for a pending-review productId", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.get_sales.run({ productId: PENDING_REVIEW_FIXTURE_ID }, CTX);
    expect(result).toEqual(NOT_FOUND);
  });
});
