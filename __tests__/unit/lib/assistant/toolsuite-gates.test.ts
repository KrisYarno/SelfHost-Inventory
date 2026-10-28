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
            // A seeded value may be a FUNCTION of the query, as on the `$root.` channel below
            // (A2 C15: the run-history reads are answered query-faithfully — a fixed value
            // would answer a read that asks the wrong question with the right rows).
            if (key in overrides) {
              const seeded = overrides[key];
              return Promise.resolve(
                typeof seeded === "function" ? (seeded as (...a: unknown[]) => unknown)(...args) : seeded,
              );
            }
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
            // Root client functions honour `__overrides` under a `$root.` key, exactly as
            // delegates do (pack C5.2): a read whose whole result set arrives through a
            // TAGGED `$queryRaw` — the reconciliation batch-summary statement — cannot be
            // seeded any other way, and an un-seedable branch is a branch whose PII
            // projection the gate would assert vacuously.
            const key = `$root.${p}`;
            if (key in overrides) {
              // A seeded value may be a FUNCTION of the statement (Part 2 A2): TWO
              // producers now share the raw channel — the reconciliation batch
              // summary and the match's deducted-side aggregate — and handing
              // either one's rows to the other is a fixture bug, never a reason
              // for a producer to tolerate rows it was not sent.
              const seeded = overrides[key];
              return Promise.resolve(
                typeof seeded === "function"
                  ? (seeded as (...a: unknown[]) => unknown)(...args)
                  : seeded,
              );
            }
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

import { ZodError } from "zod";
import {
  assistantTools,
  TOOL_SCOPES,
  CoverageSchema,
  notFound,
  testCtx,
  type ToolResult,
} from "@/lib/assistant/tools";
import { TOOL_PRESENTATION } from "@/lib/assistant/tool-presentation";
import { MATCH_DEFINITIONS } from "@/lib/reconciliation/match-keys";
import { resolveAssistantProduct } from "@/lib/assistant/resolve-product";
import { STATIC_WRITE_ALLOWLIST } from "./static-write-allowlist";
import { ORDER_PIPELINE_SELECT, ORDER_ITEM_UNITS_SELECT } from "@/lib/reports/order-pipeline";
// Reconciliation lane (pack C5.2): the lane's own frozen order projection + its
// forbidden-name set. The gate keeps its OWN literals below and pins the relationship
// between the two sets, so neither can be narrowed without failing here.
import {
  RECONCILIATION_ORDER_SELECT,
  RECONCILIATION_PII_FIELD_NAMES,
} from "@/lib/reconciliation/pii";
// Task 1.4: the C2 envelope pins read the SHARED schema (contract pack T0) — never a
// local re-declaration, which would pin a copy instead of the contract.
import { requestSchema } from "@/lib/assistant/thread-contracts";

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
  // Task 3.2 (C13): the archived listing is a distinct read path (relaxed deletedAt
  // predicate + nulled current-state fields), so it gets its own gate fixture.
  find_product: [{ query: "abc" }, { query: "abc", includeArchived: true }],
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
    // C6 (Task 2.2): the zero-row synthesis branch — a NEW read path that must stay
    // write-free and complete over the fail-closed proxy like every other mode.
    { groupBy: "product", includeZeroRows: true },
  ],
  // fixture[0] is the HAPPY path used by the coverage/definition gates — keep it argless
  // (or product-resolving) so it reaches an OK result; the pending-review productId case
  // is a LATER fixture (read-only gate only) that must return the notFound shape.
  get_operations: [{}, { windowDays: 30 }, { productId: PENDING_REVIEW_FIXTURE_ID }],
  get_shrinkage: [{ days: 30 }, { days: 365 }],
  get_valuation: [
    {},
    { groupBy: "product" },
    { groupBy: "location" },
    { productId: PENDING_REVIEW_FIXTURE_ID },
  ],
  get_movement_series: [
    {},
    { groupBy: "week" },
    { groupBy: "month" },
    { relativeDays: 7 },
    // W2-RCPT: the receipts-detail branch (getReceipts DB-side paging).
    { receipts: true },
    { productId: PENDING_REVIEW_FIXTURE_ID },
    // C10 (Task 2.4): the per-product breakdown — catalog-wide and bounded-batch.
    { breakdownBy: "product" },
    { breakdownBy: "product", productIds: [1, 2] },
    // A2 C8: the location-scoped variants read the location's name for the filters echo.
    { locationId: 2 },
    { receipts: true, locationId: 2 },
    { breakdownBy: "product", locationId: 2 },
  ],
  get_inventory_summary: [
    {},
    { rankBy: "onHand" },
    { rankBy: "value" },
    { rankBy: "outbound30" },
    { rankBy: "daysOfSupply" },
  ],
  get_inventory_policy: [{}, { productId: PENDING_REVIEW_FIXTURE_ID }],
  get_data_freshness: [{}],
  low_stock_report: [{}],
  // C11 (Task 2.5): the healthy-row and named-set branches (the latter runs the batch
  // resolver + the requested-id accounting) must complete write-free like the rest.
  reorder_report: [
    {},
    { includeOkay: false },
    { includeHealthy: true },
    { productIds: [1, 2] },
  ],
  // Wave-2 breadth. fixture[0] is the HAPPY path (coverage/definition gates) — a
  // COMPLETED past dayKey / argless case that reaches an OK result; the pending-review
  // productId case is a LATER fixture (read-only gate only), returning the notFound shape.
  get_stock_asof: [
    { dayKey: "2026-01-01" },
    { dayKey: "2026-01-01", productId: PENDING_REVIEW_FIXTURE_ID },
    // A2 C9: the location resolve (benign null -> notFound("location")) is a read path too;
    // the seeded C10 scan below drives its resolved branch.
    { dayKey: "2026-01-01", locationId: 2 },
  ],
  compare_periods: [
    { metric: "outbound_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 } },
    { metric: "sales_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 14 } },
    { metric: "sales_revenue", periodA: { relativeDays: 30 }, periodB: { relativeDays: 30 } },
    { metric: "inbound_units", periodA: { relativeDays: 30 }, periodB: { relativeDays: 30 } },
    {
      metric: "sales_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      productId: PENDING_REVIEW_FIXTURE_ID,
    },
    // C9 (Task 2.3): the by_product branch — a NEW read path (per-product groupBys +
    // identities + evidence lookups) that must stay write-free like every other mode.
    { metric: "sales_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 }, groupBy: "product" },
    {
      metric: "outbound_units",
      periodA: { relativeDays: 7 },
      periodB: { relativeDays: 7 },
      groupBy: "product",
      direction: "increase",
    },
  ],
  get_order_pipeline: [
    {},
    { groupBy: "status" },
    { groupBy: "integration" },
    { groupBy: "day" },
    { relativeDays: 7 },
  ],
  // Reconciliation lane (pack C5.2): ONE fixture per read branch of
  // get_order_reconciliation — the default window, a relative window, the class chip,
  // the member-scoped orderNumber filter, and the keyset page. The last one carries a
  // FROZEN cursor literal (base64url of {"t":1787184000000,"b":"gate-recon-a","c":0},
  // CX-13) rather than a placeholder: the producer REJECTS an undecodable cursor with a
  // 400, so a hand-waved string would exercise the error path and call the branch covered.
  get_order_reconciliation: [
    {},
    { relativeDays: 7 },
    { class: "attributed·fulfillment" },
    { orderNumber: "12345" },
    { limit: 5, cursor: "eyJ0IjoxNzg3MTg0MDAwMDAwLCJiIjoiZ2F0ZS1yZWNvbi1hIiwiYyI6MH0" },
  ],
  // Wave-3 composites. fixture[0] is the HAPPY path (coverage/definition gates): a valid
  // productId that resolves via the coverage-gate's product.findFirst override to an OK
  // overview; the pending-review productId case is a LATER fixture (read-only gate only),
  // returning the notFound shape. get_business_snapshot is argless.
  get_product_overview: [{ productId: 1 }, { productId: PENDING_REVIEW_FIXTURE_ID }],
  get_business_snapshot: [{}],
};

/**
 * MISUSE fixtures (review OC-1) — argument combinations that must be REJECTED. They live
 * beside TOOL_GATE_FIXTURES rather than inside it because the two matrices assert
 * OPPOSITE outcomes: a gate fixture must COMPLETE (status ok/truncated/error), a misuse
 * fixture must THROW a ZodError before any read happens. Folding the second kind into the
 * first would have meant teaching the no-throw gate to tolerate throws — weakening the
 * gate for all 17 tools to pin one rule.
 *
 * Each entry: the illegal args + a fragment of the self-correcting hint the caller gets.
 */
const TOOL_MISUSE_FIXTURES: Array<[string, Record<string, unknown>, RegExp]> = [
  // C10 / OC-1: breakdownBy partitions a POPULATION; productId narrows to one member.
  // The combination silently dropped the id and returned a CATALOG-wide breakdown.
  ["get_movement_series", { breakdownBy: "product", productId: 1 }, /mutually exclusive/],
  ["get_movement_series", { breakdownBy: "product", groupBy: "week" }, /mutually exclusive/],
  ["get_movement_series", { breakdownBy: "product", receipts: true }, /mutually exclusive/],
  ["get_movement_series", { productId: 1, productIds: [2] }, /mutually exclusive/],
  ["get_movement_series", { productIds: [1, 2] }, /requires breakdownBy/],
  ["get_sales", { groupBy: "day", includeZeroRows: true }, /includeZeroRows requires/],
  // (get_sales' includeZeroRows×productId rule is pinned in the C6 suite instead: here
  // the fail-closed proxy resolves every productId to null, so the tool short-circuits to
  // notFound before the assert — an ordering property, not a missing rule.)
  [
    "compare_periods",
    { metric: "sales_units", periodA: {}, periodB: {}, groupBy: "product", productId: 1 },
    /mutually exclusive/,
  ],
  [
    "compare_periods",
    { metric: "sales_units", periodA: {}, periodB: {}, direction: "increase" },
    /requires groupBy/,
  ],
  ["reorder_report", { productIds: [] }, /must not be empty/],
];

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

  // G1 PROOF (spec §7 / Task 2.6). The MCP adapter registers a tool by reading its
  // schema's raw `.shape` (tool-adapters.ts:112). A `.refine`/`.superRefine` anywhere in
  // an input schema produces a ZodEffects, which has NO `.shape` — so the tool would
  // register with an EMPTY input schema (or throw) on the sidecar while every web-side
  // test stayed green. This is why cross-field rules are post-parse assert* helpers.
  it("every registered tool's inputSchema exposes a raw `.shape` (MCP registerTool contract)", () => {
    for (const name of TOOL_NAMES) {
      const schema = assistantTools[name].inputSchema as unknown as { shape?: Record<string, unknown> };
      expect(typeof schema.shape).toBe("object");
      expect(schema.shape).not.toBeNull();
      // A ZodEffects wrapper is the exact failure mode; it exposes `_def.schema` instead.
      expect((schema as unknown as { _def: { typeName?: string } })._def.typeName).toBe("ZodObject");
    }
  });

  it("every registered tool has a TOOL_PRESENTATION entry", () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_PRESENTATION[name]).toBeDefined();
      expect(typeof TOOL_PRESENTATION[name].successLabel).toBe("string");
    }
  });

  // QA-3 / OC-5 as a GATE: an argument that changes WHICH POPULATION an answer covers must
  // never render the same disclosure row as the call without it — otherwise the user's only
  // record of the call describes a narrower (or wider) question than the tool answered.
  // find_product's `includeArchived` was the one member of the set that still did.
  it("OC-5: every population-changing argument changes its tool's disclosure row", () => {
    const PERIODS = { periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 } };
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["find_product", { query: "tirz" }, { query: "tirz", includeArchived: true }],
      ["get_sales", { groupBy: "product" }, { groupBy: "product", includeZeroRows: true }],
      ["get_movement_series", {}, { breakdownBy: "product" }],
      ["get_movement_series", { breakdownBy: "product" }, { breakdownBy: "product", productIds: [7] }],
      ["compare_periods", { metric: "sales_units", ...PERIODS }, { metric: "sales_units", ...PERIODS, groupBy: "product" }],
      ["reorder_report", {}, { includeOkay: false }],
      ["reorder_report", {}, { includeHealthy: true }],
      ["reorder_report", {}, { productIds: [7] }],
      // Reconciliation lane: the chip narrows to ONE evidence class and the order number
      // to the batches of ONE order — both change which batches the answer covers.
      [
        "get_order_reconciliation",
        { relativeDays: 7 },
        { relativeDays: 7, class: "attributed·manual" },
      ],
      ["get_order_reconciliation", { relativeDays: 7 }, { relativeDays: 7, orderNumber: "1301" }],
    ];
    for (const [name, plain, widened] of cases) {
      const p = TOOL_PRESENTATION[name];
      expect(p.summarizeArgs(widened)).not.toBe(p.summarizeArgs(plain));
    }
    // The QA-3 member, by its rendered words (a row that differs is not enough — it has to
    // say WHAT it now covers).
    expect(
      TOOL_PRESENTATION.find_product.summarizeArgs({ query: "tirz", includeArchived: true }),
    ).toContain("incl. deleted");
  });
});

// ---------------------------------------------------------------------------
// Disambiguation + truthfulness cues in the tool descriptions (spec §5 W0-DESC /
// §7 — the model routes on these; a missing cue is how it picks the wrong tool).
// ---------------------------------------------------------------------------

describe("tool descriptions carry their disambiguation + truthfulness cues", () => {
  const desc = (name: string) => assistantTools[name].description;

  it("get_valuation names cost, retail, margin and 'which units lack costs'", () => {
    const d = desc("get_valuation");
    expect(d).toMatch(/cost/i);
    expect(d).toMatch(/retail/i);
    expect(d).toMatch(/margin/i);
    expect(d).toMatch(/which units lack costs/i);
  });

  it("get_movement_series names transfers-are-internal, the legacy note, and absent=zero", () => {
    const d = desc("get_movement_series");
    expect(d).toMatch(/internal/i); // transfers are internal relocations
    expect(d).toMatch(/not sales/i); // legacy negative-ADJUSTMENT note
    expect(d).toMatch(/zero movement/i); // absent in-window period = zero movement
  });

  it("get_inventory_policy disambiguates against low_stock_report and reorder_report", () => {
    const d = desc("get_inventory_policy");
    expect(d).toContain("low_stock_report");
    expect(d).toContain("reorder_report");
  });

  it("get_inventory_summary points single-product questions at get_operations", () => {
    expect(desc("get_inventory_summary")).toContain("get_operations");
  });

  it("get_data_freshness names the not-tracked disclosure", () => {
    const d = desc("get_data_freshness");
    expect(d).toMatch(/notTracked|do you track|what do you track/i);
  });

  it("get_operations and get_movement_series each disclose the ops-vs-movement formula difference (item 3 — no false contradiction)", () => {
    const ops = desc("get_operations");
    const mv = desc("get_movement_series");
    // Each names the OTHER tool and frames a divergence as the two definitions, not a bug.
    expect(ops).toContain("get_movement_series");
    expect(ops).toMatch(/contradiction/i);
    expect(mv).toContain("get_operations");
    expect(mv).toMatch(/contradiction/i);
  });

  it("get_movement_series names the receipts:true detail affordance (W2-RCPT)", () => {
    const d = desc("get_movement_series");
    expect(d).toMatch(/receipts:true/i);
    expect(d).toMatch(/unitCostCents/); // frozen per-receipt cost surfaced
  });

  it("get_stock_asof labels possiblyStale a heuristic and rejects today/future (completed days only)", () => {
    const d = desc("get_stock_asof");
    expect(d).toMatch(/possiblyStale/);
    expect(d).toMatch(/heuristic/i); // labeled, never a certainty
    expect(d).toMatch(/completed days only/i);
    expect(d).toMatch(/never a fabricated 0/i); // null-with-reason, not a manufactured zero
  });

  it("compare_periods discloses mixed scope, zero-vs-unknown, and its reasons-key mapping", () => {
    const d = desc("compare_periods");
    expect(d).toMatch(/mixed/i); // mixed-scope tool
    expect(d).toMatch(/your companies/i); // sales metrics = caller companies
    expect(d).toMatch(/global/i); // ledger metrics = global
    expect(d).toMatch(/growth from zero/i); // the zero-vs-unknown honesty rule
    expect(d).toMatch(/a = periodA/); // reasons-key mapping
  });

  // Assistant A2 (pack C4, A2-G1R3-16): reorder_report's RESULT is mixed-scope now — its
  // rows are the global physical pool, the order signal on its unsized rows is the caller's
  // companies' — so its description says so, like the other mixed-scope tools above.
  it("reorder_report discloses mixed scope: rows global, orderSignal your companies'", () => {
    const d = desc("reorder_report");
    expect(d).toMatch(/mixed/i); // mixed-scope result
    expect(d).toMatch(/your companies/i); // the order signal = caller companies
    expect(d).toMatch(/global/i); // the rows = global
    expect(d).toContain(
      "Results are mixed-scope: rows are global, orderSignal is your companies'.",
    );
    // ...and the signal is a separate fact family: never summed, never a quantity.
    expect(d).toContain(
      "Recorded orders are a separate fact family — never added to the stock-outflow " +
        "figures and never a quantity.",
    );
    // The STATIC entry stays the outer physical-pool label ("mixed" is never a TOOL_SCOPES value).
    expect(TOOL_SCOPES.reorder_report).toBe("global");
  });

  it("compare_periods cross-references the two documented ledger divergences (W2 seam-fix item 3)", () => {
    const d = desc("compare_periods");
    // NEW-1: get_operations sums outbound over a ROLLING-INSTANT window ending now;
    // compare_periods uses CALENDAR-DAY windows — a small gap is the window definition.
    expect(d).toContain("get_operations");
    expect(d).toMatch(/rolling/i);
    expect(d).toMatch(/calendar-day/i);
    // M4: the outbound wrong-signed FOLD — get_movement_series folds a wrong-signed
    // SALE/STOCK_IN into its natural logType bucket, so its outbound family diverges.
    expect(d).toContain("get_movement_series");
    expect(d).toMatch(/wrong-signed/i);
    // Both framed as the DEFINITIONS, never a contradiction (same posture as ops↔movement).
    expect(d).toMatch(/contradiction/i);
  });

  it("get_order_pipeline discloses company scope, gross/refunds, and the no-PII posture", () => {
    const d = desc("get_order_pipeline");
    expect(d).toMatch(/company-scoped/i);
    expect(d).toMatch(/refunds are not netted/i);
    expect(d).toMatch(/PII/); // customer PII never returned
    expect(d).toMatch(/aging/i); // open-order aging buckets
  });

  it("get_product_overview frames itself as one-call, names the section tools, and discloses mixed scope + independent degradation", () => {
    const d = desc("get_product_overview");
    expect(d).toMatch(/one-call/i); // the choreography-killer framing
    // Names the per-topic tools a deep dive routes to.
    for (const t of ["get_stock", "get_valuation", "get_inventory_policy", "get_movement_series", "get_sales"]) {
      expect(d).toContain(t);
    }
    expect(d).toMatch(/mixed/i); // mixed-scope tool
    expect(d).toMatch(/your companies/i); // sales section = caller companies
    expect(d).toMatch(/independently/i); // sections degrade independently
  });

  // Quality+reach lane C2 (W0 slice): the guardrails that stop the review-#3 failure
  // classes — per-product looping for catalog questions, unresolved productIds, and
  // physical depletion presented as verified sales. Later tasks APPEND to this case as
  // they add the fields their sentences describe (2.2/2.3/2.4/2.5/3.2).
  it("descriptions carry the review-#3 guardrails", () => {
    const d = (n: string) => assistantTools[n].description;
    expect(d("get_sales")).toMatch(/ONE ROW PER PRODUCT/i);
    expect(d("get_sales")).toMatch(/never pass a productId you did not resolve/i);
    expect(d("compare_periods")).toMatch(/productId is OPTIONAL/);
    expect(d("get_operations")).toMatch(/PHYSICAL DEPLETION, not\s+verified sales/i);
    expect(d("get_operations")).toMatch(/never present these as 'sold'/i);
    expect(d("reorder_report")).toMatch(/demand may be entirely unclassified/i);
    // Task 2.2 (C6): the zero-row + dataStart affordances, described where the model
    // reads them — an affordance nobody is told about is an affordance nobody uses.
    expect(d("get_sales")).toMatch(/includeZeroRows/);
    expect(d("get_sales")).toMatch(/salesDataStart/);
    expect(d("get_sales")).toMatch(/windowCoverage/);
    expect(d("get_sales")).toMatch(/never a creation date/i);
    // Task 2.3 (C9): the per-product mode + the erratum's unranked semantics. Without
    // the "coverage artifact" sentence a model reads unranked rows as growth.
    expect(d("compare_periods")).toMatch(/groupBy:'product'/);
    expect(d("compare_periods")).toMatch(/ranked server-side/i);
    expect(d("compare_periods")).toMatch(/unranked/);
    expect(d("compare_periods")).toMatch(/COVERAGE artifact/i);
    expect(d("compare_periods")).toMatch(/never as growth/i);
    expect(d("compare_periods")).toMatch(/never 'new product'/i);
    // Task 2.4 (C10): the breakdown + bounded-batch affordances and the sign-first rank.
    expect(d("get_movement_series")).toMatch(/breakdownBy:'product'/);
    expect(d("get_movement_series")).toMatch(/productIds/);
    expect(d("get_movement_series")).toMatch(/ALL-ZERO row/i);
    expect(d("get_movement_series")).toMatch(/SIGN-FIRST/i);
    expect(d("get_movement_series")).toMatch(/coverage\.requested/);
    // Task 2.5 (C11): named-product sizing, the OK urgency, and the accounting rule
    // that keeps the C5 invariant true when requested ids are in play.
    expect(d("reorder_report")).toMatch(/includeHealthy/);
    expect(d("reorder_report")).toMatch(/productIds/);
    expect(d("reorder_report")).toMatch(/urgency 'OK'/);
    expect(d("reorder_report")).toMatch(/not_active/);
    expect(d("reorder_report")).toMatch(/unknown_id/);
    expect(d("reorder_report")).toMatch(/never in\s+coverage\.unavailable/i);
    expect(d("reorder_report")).toMatch(/CONFIGURED assumptions only/i);
    // Task 3.2 (C13): the archived affordance + the coherence rule for a deleted row.
    // Without the "history stays queryable" sentence a model reads the NULLED
    // current-state fields as "we have nothing on this product".
    expect(d("find_product")).toMatch(/includeArchived:true/);
    expect(d("find_product")).toMatch(/lifecycle/);
    expect(d("find_product")).toMatch(/DELETED products are ABSENT\s+by default/i);
    expect(d("find_product")).toMatch(/HISTORY stays queryable/i);
    // OC-1: the breakdown/productId exclusion is a REJECTION, so the description has to
    // name the legal repair — a model that learns the rule only from an error message
    // pays a round-trip for something the tool could have said up front.
    expect(d("get_movement_series")).toMatch(/productId is the SERIES\s+scope/i);
    expect(d("get_movement_series")).toMatch(/productIds:\[id\]/);
    // OC-2: the two archived counts mean DIFFERENT things; a description that named only
    // one of them would leave the second reading as more contributing history.
    expect(d("get_sales")).toMatch(/archivedProductsIncluded/);
    expect(d("get_sales")).toMatch(/archivedZeroRows/);
    expect(d("get_sales")).toMatch(/contributed nothing/i);
    // QA-1: the same two counts, the same distinction, on the movement breakdown — whose
    // force-emitted all-zero rows are the mechanism that made the fold-in wrong there too.
    expect(d("get_movement_series")).toMatch(/archivedProductsIncluded/);
    expect(d("get_movement_series")).toMatch(/archivedZeroRows/);
    expect(d("get_movement_series")).toMatch(/moved\s+nothing/i);
    // QA-8: includeZeroRows changes the ROW ORDER (one productId-asc order across real and
    // synthesized rows). A model that read page 1 as "the best sellers" — which is what the
    // default order gives it — would report the lowest product ids as the top of the list.
    expect(d("get_sales")).toMatch(/RE-ORDERS the\s+rows by productId ascending/);
    expect(d("get_sales")).toMatch(/measured rows no longer lead/i);
    // FD3-2: a page that silently dropped matched products is a page the model will walk
    // straight past — the repair has to be described where it routes, not only emitted.
    expect(d("find_product")).toMatch(/coverage\.byteSkipped/);
    expect(d("find_product")).toMatch(/coverage\.byteNote/);
    expect(d("find_product")).toMatch(/same offset, smaller limit/i);
    // FD3-3: a delta across periods with different company coverage reads as growth
    // unless the qualification travels WITH it.
    expect(d("compare_periods")).toMatch(/coverage\.periodCoverage/);
    expect(d("compare_periods")).toMatch(/coverage\.coverageShift/);
    expect(d("compare_periods")).toMatch(/not\s+like-for-like/i);
    // FD4-4: the `delta` reason key is emitted by BOTH modes (the FD3-3 mirror put it on
    // the by_product envelope too), so the legend that said "(totals mode)" told a model
    // to expect it in one mode and ignore it in the other. The corrected sentence names
    // the real condition — the presence of coverageShift — instead of a mode.
    expect(d("compare_periods")).toMatch(
      /delta = the coverageShift qualification \(BOTH modes, present only with\s+coverageShift\)/,
    );
    expect(d("compare_periods")).not.toMatch(/qualification \(totals mode\)/);
  });

  // Quality+reach C12 (Task 2.1): the mix fields are the composition a bare depletion
  // figure cannot carry, so both mix-bearing tools must NAME them — and both must carry
  // the G3 rolling-vs-calendar divergence sentence so the mix is never read as a
  // contradiction of get_movement_series' signed calendar buckets.
  it("the mix-bearing descriptions name their buckets + the G3 rolling-vs-calendar divergence", () => {
    const ops = desc("get_operations");
    const reorder = desc("reorder_report");
    expect(ops).toMatch(/outboundMix30/);
    expect(reorder).toMatch(/demandMix/);
    expect(reorder).toMatch(/demandUnits/);
    for (const d of [ops, reorder]) {
      // Every bucket named, so a reader knows what the six numbers are.
      for (const bucket of [
        "sale",
        "classifiedLoss",
        "adjustmentUnclassified",
        "correctionUnclassified",
        "countOut",
        "stockInReversal",
      ]) {
        expect(d).toContain(bucket);
      }
      // G3: absolute-units + rolling window vs movement's signed calendar buckets.
      expect(d).toMatch(/ABSOLUTE units/i);
      expect(d).toMatch(/ROLLING/i);
      expect(d).toMatch(/CALENDAR-DAY/i);
      expect(d).toMatch(/SIGNED/i);
      expect(d).toContain("get_movement_series");
      expect(d).toMatch(/contradiction/i);
    }
    // The two mixes partition DIFFERENT populations by design (spec C12) — said out loud
    // where the narrower one lives, so the divergence never reads as a bug.
    expect(reorder).toMatch(/CORRECTION-reasoned rows/i);
    expect(reorder).toContain("outboundMix30");
  });

  // Reconciliation lane D9: this tool's scope claim is a SPLIT one, and a model that
  // reads only half of it will either under-report the batches or over-report the orders.
  // Both halves, the derived-class caveat, and the filter's scope are pinned where the
  // model actually reads them.
  it("get_order_reconciliation discloses the GLOBAL/member split, the derived caveat, and the filter's scope", () => {
    const d = desc("get_order_reconciliation");
    expect(d).toMatch(/mixed/i);
    expect(d).toMatch(/BATCH population is GLOBAL/);
    expect(d).toMatch(/only for YOUR companies/);
    expect(d).toContain("orderRedacted");
    expect(d).toContain("orderMissing");
    // The truth source, and the one thing a derived class must never be relayed as.
    expect(d).toMatch(/LEDGER STAMP/);
    expect(d).toMatch(/never present a derived class as a recorded one/);
    // The filter is member-scoped, and its empty answer is a coverage sentence — NOT a
    // page of redacted rows.
    expect(d).toMatch(/filter searches your companies only/);
    expect(d).toContain("no order matching that number in your companies");
    expect(d).toMatch(/never returns redacted rows/);
    // No actor identity, ever.
    expect(d).toMatch(/no actor identity/);
    // OC-5: the keyset cursor is the ONLY way past page one, and a coverage block
    // that reported `moreCount` without it told a model rows remained and gave it
    // no way to read them.
    expect(d).toContain("coverage.nextCursor");
  });

  // OC-5: the paging affordance rides in the coverage block beside the bound it
  // qualifies — `null` included, so "no more pages" is stated rather than absent.
  it("get_order_reconciliation's coverage carries the keyset cursor beside moreCount", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.get_order_reconciliation.run({}, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const coverage = (result.data as { coverage: Record<string, unknown> }).coverage;
    expect(Object.keys(coverage)).toContain("nextCursor");
    expect(coverage.nextCursor).toBeNull();
  });

  // G2-2: the tool's rows carry the ATTRIBUTION class vocabulary and `toolRow`
  // strips `match` entirely, so relaying the 18 MATCH_DEFINITIONS sentences
  // defined a vocabulary nothing in the payload speaks — an invitation to invent
  // a `class: 'short'` that no row could ever carry. They come back when C4 puts
  // the match ON the rows, and not before.
  it("get_order_reconciliation's definitions carry NO match key until C4 wires the match", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.get_order_reconciliation.run({}, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const definitions = (result.data as { definitions: Record<string, string> }).definitions;

    expect(Object.keys(definitions).filter((k) => k in MATCH_DEFINITIONS)).toEqual([]);
    // QA-4: the two match TOTALS leave with their vocabulary — neither the figures
    // nor their sentences reach the tool until C4 puts the match on the rows.
    expect(definitions.matchedOrders).toBeUndefined();
    expect(definitions.matchUnavailableRows).toBeUndefined();
    const coverage = (result.data as { coverage: Record<string, unknown> }).coverage;
    expect(coverage.matchedOrders).toBeUndefined();
    expect(coverage.matchUnavailableRows).toBeUndefined();
    // FD-2's original two are still stripped: `toolRow` carries neither field.
    expect(definitions.canAttribute).toBeUndefined();
    expect(definitions.fulfillmentTargetMissing).toBeUndefined();
  });

  it("get_business_snapshot frames itself as one-call, names the section tools, and discloses mixed scope + independent degradation", () => {
    const d = desc("get_business_snapshot");
    expect(d).toMatch(/one call/i);
    for (const t of ["get_inventory_summary", "reorder_report", "get_sales", "get_order_pipeline", "get_data_freshness"]) {
      expect(d).toContain(t);
    }
    expect(d).toMatch(/mixed/i);
    expect(d).toMatch(/your companies/i);
    expect(d).toMatch(/independently/i);
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
// (1a-ii) MISUSE gate (OC-1) — an illegal argument combination is REJECTED with a
// self-correcting hint, BEFORE any read. A rule that only rejects after reading has
// already paid for (and could still return) the answer to a question nobody asked.
// ---------------------------------------------------------------------------

describe("MISUSE gate — illegal argument combinations reject before any read", () => {
  it.each(TOOL_MISUSE_FIXTURES)(
    "%s rejects %j with a self-correcting hint and reads nothing",
    async (name, fixture, hint) => {
      prismaCtl.__reset();
      await expect(assistantTools[name].run(fixture, CTX)).rejects.toBeInstanceOf(ZodError);
      // The hint is what the adapter surfaces as `hint`, so it must name the repair.
      await assistantTools[name].run(fixture, CTX).catch((err: unknown) => {
        expect((err as ZodError).errors[0]?.message).toMatch(hint);
      });
      // Nothing was read: no partial answer was computed and then thrown away.
      expect(prismaCtl.__calls).toEqual([]);
    },
  );
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

  // Assistant A2 (pack C4): the benign proxy's empty population never reaches the order
  // signal, so the fixture above cannot see that read. Seeded: approved products with no
  // outbound (unsized rows) and a recorded fact start — the signal's reads really run,
  // and they still write nothing.
  // A2 FR1 (pack C14): and the LINK check runs too, over a REAL mix — product 1 is linked on
  // the caller's one store (a measured 0), product 2 is not (null + not_linked) — plus the
  // window's unlinked-order count; none of it writes, and none of it reads `integration`.
  it("reorder_report's ORDER-SIGNAL read path runs and issues zero write calls (A2 C4 + C14)", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findMany"] = [
      { id: 1, name: "Gate Unsized", costPrice: null, product_locations: [{ quantity: 0 }], reorderConfig: null },
      { id: 2, name: "Gate Unlinked", costPrice: null, product_locations: [{ quantity: 0 }], reorderConfig: null },
    ];
    prismaCtl.__overrides["productSalesFact.aggregate"] = { _min: { dayKey: "2020-01-01" } };
    prismaCtl.__overrides["externalOrder.groupBy"] = [{ integrationId: "gate-store" }];
    prismaCtl.__overrides["productLink.findMany"] = [{ internalProductId: 1 }];
    prismaCtl.__overrides["externalOrder.count"] = 2;
    const result = await assistantTools.reorder_report.run({}, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // Non-vacuity: the signal's grouped fact read happened, over the caller's companies.
    const signalRead = prismaCtl.__calls.find(
      (c) =>
        c.model === "productSalesFact" &&
        c.method === "groupBy" &&
        (c.args as { by: string[] }).by[0] === "productId",
    );
    expect(signalRead).toBeDefined();
    expect((signalRead!.args as { where: { companyId: unknown } }).where.companyId).toEqual({ in: CTX.companyIds });
    const rows = (result.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.find((row) => row.productId === 1)).toMatchObject({
      orderSignal: { orderedUnits: 0, orders: 0 },
      outOfStockWithOrders: false,
    });
    // Non-vacuity: the same real run sees an unlinked product — never a measured 0.
    expect(rows.find((row) => row.productId === 2)).toMatchObject({
      orderSignal: null,
      orderSignalReason: "not_linked",
      outOfStockWithOrders: null,
    });
    const coverage = (result.data as { coverage: Record<string, unknown> }).coverage;
    expect(coverage.orderSignalUnlinkedOrders).toBe(2);
    // The link reads ran (stores from the caller's ORDERS, the listing reads ids only)...
    const linkReads = prismaCtl.__calls.filter(
      (c) =>
        (c.model === "externalOrder" && (c.method === "groupBy" || c.method === "count")) ||
        c.model === "productLink" ||
        c.model === "bundleComponent",
    );
    expect(linkReads.map((c) => `${c.model}.${c.method}`).sort()).toEqual([
      "bundleComponent.findMany",
      "externalOrder.count",
      "externalOrder.groupBy",
      "productLink.findMany",
    ]);
    for (const c of linkReads.filter((call) => call.method === "findMany")) {
      expect((c.args as { select: unknown }).select).toEqual({ internalProductId: true });
    }
    // ...and NO read touched the Integration table (the encrypted store keys live there).
    expect(prismaCtl.__calls.some((c) => c.model === "integration")).toBe(false);
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
// (1c) VALID-product post-resolution branch (W3 seam-fix item 6). The pending-review
// productId fixtures above short-circuit at resolution (notFound), so they never
// exercise a tool's POST-resolution read path under the zero-writes assertion. Here
// product.findFirst AND product.findUnique resolve to a VALID product (id 1), so every
// productId-taking tool runs its full post-resolution branch — which must ALSO be
// write-free.
// ---------------------------------------------------------------------------

describe("READ-ONLY gate — the VALID-product post-resolution branch is write-free (item 6)", () => {
  const VALID_PRODUCT = { id: 1, name: "Valid Gate Product" };

  // Every productId-taking tool (each resolves through resolveAssistantProduct), with a
  // VALID id and its other required args so it reaches the post-resolution path.
  const PRODUCT_ID_TOOL_FIXTURES: Array<[string, Record<string, unknown>]> = [
    ["get_stock", { productId: 1 }],
    ["get_sales", { productId: 1, groupBy: "product" }],
    ["get_operations", { productId: 1 }],
    ["get_valuation", { productId: 1, groupBy: "product" }],
    ["get_movement_series", { productId: 1 }],
    ["get_movement_series", { productId: 1, receipts: true }],
    ["get_inventory_policy", { productId: 1 }],
    ["get_stock_asof", { dayKey: "2026-01-01", productId: 1 }],
    [
      "compare_periods",
      { metric: "sales_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 }, productId: 1 },
    ],
    ["get_product_overview", { productId: 1 }],
  ];

  it.each(PRODUCT_ID_TOOL_FIXTURES)(
    "%s resolves a VALID product (post-resolution branch) and still issues zero write calls",
    async (name, fixture) => {
      prismaCtl.__reset();
      prismaCtl.__overrides["product.findFirst"] = VALID_PRODUCT; // resolveAssistantProduct
      prismaCtl.__overrides["product.findUnique"] = VALID_PRODUCT; // identity/policy detail reads
      const result = await assistantTools[name].run(fixture, CTX);
      // The tool actually reached its post-resolution branch — NOT the notFound shape.
      const isNotFound =
        (result as { status?: string }).status === "error" &&
        (result as { error?: { code?: string } }).error?.code === "NOT_FOUND";
      expect(isNotFound).toBe(false);
      // ...and that branch still wrote nothing.
      expect(writeCalls()).toEqual([]);
    },
  );
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
    // Found by the import-completeness meta-test below (Task 3.3): tools.ts imports the
    // Prisma client module itself, and it was never scanned. A write helper added to the
    // client factory would have been invisible to every layer of this gate.
    "lib/prisma.ts",
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
    // quality+reach Task 2.1: the mix classifier + the shared identities lookup.
    "lib/reports/outbound-mix.ts",
    // Wave-1 breadth modules wired into the read path by W1-INT (all read-only).
    "lib/analytics/valuation.ts",
    "lib/reports/movement.ts",
    "lib/reports/inventory-summary.ts",
    "lib/reports/policy.ts",
    "lib/assistant/freshness.ts",
    // Wave-2 breadth modules wired into the read path by W2-INT (all read-only).
    "lib/analytics/stock-asof.ts",
    "lib/reports/compare-periods.ts",
    "lib/reports/order-pipeline.ts",
    // Wave-3 composite + the PRE-W3 shared date-grain helper, both wired into the read
    // path by W3-A (composites compose the W1/W2 modules; date-grain has no data access).
    "lib/assistant/composites.ts",
    "lib/analytics/date-grain.ts",
    // reorder-config.ts is the read-path config dependency (reorder.ts imports it) and
    // is where the R2-B1 write lives — scanned so the allowlist can name it.
    "lib/reorder-config.ts",
    // Reconciliation lane (pack C5.2 + R-4): get_order_reconciliation pulls the report
    // producer into the read path, and the producer pulls three more modules plus the
    // attempt-contract types with it. The meta-test below only enforces tools.ts's DIRECT
    // imports (attribution + class-keys), so the transitive four are registered BY HAND
    // here — which is the only reason R-4's "no write token, comments included" rule is
    // enforced on them at all.
    "lib/reconciliation/attribution.ts",
    "lib/reconciliation/population.ts",
    "lib/reconciliation/derive.ts",
    "lib/reconciliation/pii.ts",
    // The class-key vocabulary is its OWN prisma-free module (pack amendment 3h): the
    // tool's z.enum value-imports THIS, never the producer.
    "lib/reconciliation/class-keys.ts",
    // CX-3: the types the producer needs from the attempts writer live here instead, so
    // the read path never imports `lib/attribution/attempts.ts`.
    "lib/attribution/contracts.ts",
    // Reconciliation Part 2 (pack CA1.6): the order-grain matcher. get_order_reconciliation
    // reaches it through the report producer from P2-C, and `items.ts` drags the bundle
    // resolver plus its Zod schema along — registered BY HAND for the same reason the four
    // above are, so the "no write token, comments included" rule covers them too.
    "lib/reconciliation/match-keys.ts",
    "lib/reconciliation/match.ts",
    "lib/reconciliation/items.ts",
    "lib/external-orders/bundle-snapshot.ts",
    "lib/validation/bundle-links.ts",
    // A2 (pack CA2.3): the producer the report calls, registered BY HAND for the
    // same reason — the meta-test below reads only `tools.ts`'s direct imports.
    "lib/reconciliation/match-producer.ts",
    // Assistant A2 (pack C4): the reorder order signal — a NEW company-scoped read in a
    // global tool, so it is scanned from birth (the meta-test below also demands it).
    "lib/reports/order-signal.ts",
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

  // -------------------------------------------------------------------------
  // (2a) META-TEST (Task 3.3 / OC-10): READ_PATH_FILES is HAND-MAINTAINED, so the
  // static scan above silently shrinks the moment tools.ts imports a new module and
  // nobody remembers this list. Derive the truth from the source instead: EVERY
  // `@/lib` module tools.ts imports must be scanned.
  // -------------------------------------------------------------------------
  it("every @/lib module imported by tools.ts is registered in READ_PATH_FILES", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const src = fs.readFileSync(path.join(repoRoot, "lib/assistant/tools.ts"), "utf8");
    const imported = new Set(
      Array.from(src.matchAll(/from\s+"@\/(lib\/[^"]+)"/g)).map((m) => `${m[1]}.ts`),
    );
    const registered = new Set(READ_PATH_FILES);
    const unregistered = Array.from(imported).filter((f) => !registered.has(f)).sort();
    expect(unregistered).toEqual([]);
  });

  it("every registered read-path file EXISTS (a stale entry scans nothing)", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const missing = READ_PATH_FILES.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (2b) META-TEST (Task 3.3 / OC-19, seam S10): the runner's `gate` suite is the
// named CONTRACT-GATE subset, and its `patterns` list is hand-maintained too. W0
// verified the failure mode: a pattern that matches nothing is SILENTLY IGNORED as
// long as the other patterns match, so a typo'd or deleted path costs a whole gate
// file with a GREEN run. Two assertions close that:
//   - bidirectional set equality against the canonical contract-gate file list, so a
//     new gate file that is never registered fails HERE rather than going unrun;
//   - fs.existsSync per registered path, so a typo cannot hide behind its neighbours.
//
// SCOPE OF THE CANONICAL LIST (adjudicated at Task 3.3): the `gate` suite is the
// CONTRACT gates — the files that pin cross-task contracts, definitions, prompt rules,
// presentation, and the approval/lifecycle trust boundary. Per-module behavioral suites
// (movement, demand, reorder, sales-coverage, compare-periods, movement-breakdown, ...)
// are NOT gate files: they belong to `all`, which runs them on every wave close. Adding
// them here would turn the "fast named subset" into a second full run and blur what the
// gate is FOR. Anything the plan later designates a contract gate is added to BOTH the
// runner and this list, together.
// ---------------------------------------------------------------------------

describe("GATE REGISTRATION meta-test (seam S10 — the runner's gate.patterns)", () => {
  const CONTRACT_GATE_FILES = [
    "__tests__/unit/lib/assistant/toolsuite-gates.test.ts",
    "__tests__/unit/lib/reports/metrics-contract.test.ts",
    "__tests__/unit/lib/assistant/prompt-rules.test.ts",
    "__tests__/unit/lib/assistant/tool-presentation.test.ts",
    "__tests__/unit/lib/reports/reorder-coverage-invariant.test.ts",
    "__tests__/unit/lib/reports/outbound-mix.test.ts",
    "__tests__/unit/lib/assistant/lifecycle-visibility.test.ts",
  ];

  /** Read the runner as TEXT — `require`ing it would SPAWN jest (it runs on import). */
  function registeredPatterns(): string[] {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const src = fs.readFileSync(path.join(repoRoot, "scripts/test-runner.js"), "utf8");
    const block = src.match(/gate:\s*\{[\s\S]*?patterns:\s*\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    return Array.from(block![1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
  }

  it("gate.patterns is EXACTLY the contract-gate file list (both directions)", () => {
    const registered = registeredPatterns();
    expect([...registered].sort()).toEqual([...CONTRACT_GATE_FILES].sort());
  });

  it("every registered gate pattern points at a file that EXISTS (S10: a miss is silent)", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const missing = registeredPatterns().filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
    expect(missing).toEqual([]);
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

// A2 C3: compare_periods' per-day figures (aPerDay, bPerDay, perDayDelta, perDayPctChange,
// perDayDirection) are rates too, so `perDay` / `PerDay` joins the pattern.
const RATE_FIELD = /avgDaily|velocity|Usage|Demand|[pP]erDay/;

/**
 * Per-tool prisma seeds for the DEFINITION gate's happy-path run (A2 C3). The benign proxy
 * returns an EMPTY aggregate, so compare_periods' fixture[0] (outbound_units totals, two
 * 7-day periods) resolves both periods to null and every per-day field to null — a gate run
 * over keys whose values are all null checks nothing a reader would see. Seeded: the ledger
 * source starts in 2020 and each period sums 7 units, so the per-day fields carry numbers.
 */
const DEFINITION_GATE_SEEDS: Record<string, Record<string, unknown>> = {
  compare_periods: {
    "inventory_logs.aggregate": {
      _min: { changeTime: new Date("2020-01-01T00:00:00.000Z") },
      _sum: { delta: -7 },
    },
  },
};

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
    Object.assign(prismaCtl.__overrides, DEFINITION_GATE_SEEDS[name] ?? {});
    const result = await assistantTools[name].run(TOOL_GATE_FIXTURES[name][0], CTX);
    if (result.status !== "ok") return;
    const rateKeys = collectKeys(result.data, (k) => RATE_FIELD.test(k) && !/Definition$/i.test(k));
    if (rateKeys.length === 0) return; // proxy yields empty data — no rate emitted, nothing to define
    const defKeys = collectKeys(result.data, (k) => /Definition$/i.test(k));
    expect(defKeys.length).toBeGreaterThan(0);
  });

  /** Every value under `key` anywhere in the payload (rows, envelope, nested blocks). */
  function valuesOf(data: unknown, key: string): unknown[] {
    const out: unknown[] = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          if (k === key) out.push(val);
          visit(val);
        }
      }
    };
    visit(data);
    return out;
  }

  // A2 C3 non-vacuity + teeth: the seeded compare payloads (totals, and by_product over
  // periods of different lengths) really carry POPULATED per-day fields, so the gate above
  // is checking numbers rather than absent keys; and the same payload with rateDefinition
  // stripped leaves no definition string at all — the exact condition the gate fails on.
  it.each([
    ["totals (fixture[0])", TOOL_GATE_FIXTURES.compare_periods[0]],
    [
      "by_product, 30 vs 7 days",
      { metric: "outbound_units", periodA: { relativeDays: 30 }, periodB: { relativeDays: 7 }, groupBy: "product" },
    ],
  ])("compare_periods %s: populated per-day fields ride with rateDefinition", async (_mode, args) => {
    prismaCtl.__reset();
    Object.assign(prismaCtl.__overrides, DEFINITION_GATE_SEEDS.compare_periods, {
      // by_product only: one product with 3 units in each period.
      "inventory_logs.groupBy": [{ productId: 1, _sum: { delta: -3 } }],
      "product.findMany": [{ id: 1, name: "Gate Fixture Product", deletedAt: null }],
    });
    const result = await assistantTools.compare_periods.run(args, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const rateKeys = collectKeys(result.data, (k) => RATE_FIELD.test(k) && !/Definition$/i.test(k));
    expect(rateKeys).toEqual(
      expect.arrayContaining(["aPerDay", "bPerDay", "perDayDelta", "perDayPctChange", "perDayDirection"]),
    );
    for (const key of ["aPerDay", "bPerDay", "perDayDelta"]) {
      const values = valuesOf(result.data, key);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(typeof v).toBe("number");
    }
    for (const v of valuesOf(result.data, "perDayDirection")) {
      expect(["increase", "decrease", "unchanged"]).toContain(v);
    }
    expect(collectKeys(result.data, (k) => /Definition$/i.test(k))).toEqual(["rateDefinition"]);
    const stripped = JSON.parse(JSON.stringify(result.data)) as { coverage: Record<string, unknown> };
    delete stripped.coverage.rateDefinition;
    expect(collectKeys(stripped, (k) => /Definition$/i.test(k))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PII PROJECTION GATE (spec §7 — allowlist, fail-closed). get_order_pipeline (and
// any tool touching ExternalOrder) must read through the exported allowlisted
// `select`s: the gate REJECTS an absent select or any `include`, and asserts the
// serialized result's key set carries NONE of the named non-selectable PII columns.
// ---------------------------------------------------------------------------

const PII_FIELD_NAMES = new Set([
  "customerEmail",
  "customerName",
  "rawPayload",
  "platformStatusRaw",
  "externalOrderUrl",
]);

describe("PII PROJECTION gate (spec §7 — get_order_pipeline)", () => {
  // Seed the proxy so BOTH the order read AND the item read fire (an empty order set
  // would skip the item query and leave the item allowlist un-exercised).
  const ORDER = {
    id: "o1",
    companyId: "c1",
    integrationId: "i1",
    internalStatus: "pending",
    nativeStatus: "processing",
    total: "10.00",
    currency: "USD",
    externalCreatedAt: new Date("2026-07-01T00:00:00.000Z"),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const ITEM = { id: "it1", orderId: "o1", quantity: 3, isMapped: true };

  // W2 seam-fix item 5: INDEPENDENT literal snapshots of the two allowlists. The gate
  // no longer trusts the exported const as its own oracle — a silent widening of the
  // export (e.g. adding customerEmail) is caught because the RECORDED select would no
  // longer deep-equal these frozen literals.
  const EXPECTED_ORDER_SELECT = {
    id: true,
    companyId: true,
    integrationId: true,
    internalStatus: true,
    nativeStatus: true,
    total: true,
    currency: true,
    externalCreatedAt: true,
    createdAt: true,
  };
  const EXPECTED_ITEM_SELECT = { id: true, orderId: true, quantity: true, isMapped: true };

  // Every get_order_pipeline fixture (incl. groupBy:"day") — the PII assertions run
  // across ALL of them, not just the argless case.
  const PIPELINE_FIXTURES = TOOL_GATE_FIXTURES.get_order_pipeline;

  async function runSeeded(args: Record<string, unknown>): Promise<ToolResult> {
    prismaCtl.__reset();
    prismaCtl.__overrides["externalOrder.findMany"] = [ORDER];
    prismaCtl.__overrides["externalOrderItem.findMany"] = [ITEM];
    return assistantTools.get_order_pipeline.run(args, CTX);
  }

  const externalCalls = () =>
    prismaCtl.__calls.filter((c) => c.model === "externalOrder" || c.model === "externalOrderItem");

  it("the exported allowlist selects are deep-frozen and match the independent snapshot", () => {
    expect(Object.isFrozen(ORDER_PIPELINE_SELECT)).toBe(true);
    expect(Object.isFrozen(ORDER_ITEM_UNITS_SELECT)).toBe(true);
    expect(ORDER_PIPELINE_SELECT).toEqual(EXPECTED_ORDER_SELECT);
    expect(ORDER_ITEM_UNITS_SELECT).toEqual(EXPECTED_ITEM_SELECT);
  });

  it.each(PIPELINE_FIXTURES.map((f, i) => [i, f as Record<string, unknown>]))(
    "fixture[%#] every ExternalOrder/ExternalOrderItem read uses the allowlist select (vs an INDEPENDENT literal) and NO include",
    async (_i, fixture) => {
      await runSeeded(fixture);
      const calls = externalCalls();
      // Both reads happened (order read + the dependent item read).
      expect(calls.some((c) => c.model === "externalOrder")).toBe(true);
      expect(calls.some((c) => c.model === "externalOrderItem")).toBe(true);
      for (const c of calls) {
        const a = c.args as { select?: unknown; include?: unknown };
        expect(a.include).toBeUndefined(); // fail-closed: an include is REJECTED
        expect(a.select).toBeDefined(); // fail-closed: an absent select is REJECTED
        // Compare against the INDEPENDENT literal, never the imported object.
        const expected = c.model === "externalOrder" ? EXPECTED_ORDER_SELECT : EXPECTED_ITEM_SELECT;
        expect(a.select).toEqual(expected);
      }
    },
  );

  it.each(PIPELINE_FIXTURES.map((f, i) => [i, f as Record<string, unknown>]))(
    "fixture[%#] touches EXACTLY the {externalOrder, externalOrderItem} model set (any new delegate FAILS)",
    async (_i, fixture) => {
      await runSeeded(fixture);
      const models = new Set(prismaCtl.__calls.map((c) => c.model));
      expect(models).toEqual(new Set(["externalOrder", "externalOrderItem"]));
    },
  );

  it.each(PIPELINE_FIXTURES.map((f, i) => [i, f as Record<string, unknown>]))(
    "fixture[%#] serialized result key set carries NONE of the non-selectable PII columns (catches spread-leaks)",
    async (_i, fixture) => {
      const result = await runSeeded(fixture);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const piiKeys = collectKeys(result.data, (k) => PII_FIELD_NAMES.has(k));
      expect(piiKeys).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// PII PROJECTION GATE — get_order_reconciliation (reconciliation lane spec D6/D9;
// pack C5.2). The tool reads ORDERS on behalf of a member, so it gets its own gate
// with its OWN frozen literal: the lane's select is a DIFFERENT projection from the
// pipeline's (it carries companyId for the membership math and reaches `platform`
// through a nested relation select), and asserting it against the exported const
// would only prove the const equals itself.
// ---------------------------------------------------------------------------

describe("PII PROJECTION gate (reconciliation lane D6 — get_order_reconciliation)", () => {
  // INDEPENDENT literal, never the imported object. A nested `select` is legal — it is
  // still an allowlist; an `include` is not, because it hands back the whole relation.
  const EXPECTED_RECONCILIATION_ORDER_SELECT = {
    id: true,
    orderNumber: true,
    internalStatus: true,
    externalCreatedAt: true,
    companyId: true,
    integration: { select: { platform: true } },
  };

  /**
   * ONE batch-summary row, in the shape the tagged `$queryRaw` returns (C2a.4). Without
   * it the window is empty, the producer never projects an order, and every assertion
   * below would pass over a payload that touched no PII at all.
   *
   * It carries a FULFILLMENT audit event on purpose, so the batch derives
   * `attributed·fulfillment` — the class the chip fixture asks for. A batch that
   * classified as anything else would make that one fixture select zero rows and assert
   * the projection over an empty page.
   */
  const SUMMARY_ROW = {
    nonAttributableBatches: 0,
    noBatchRows: 0,
    orderNumberMatches: 1,
    batchId: "gate-recon-a",
    minChangeTime: new Date("2026-08-01T00:00:00.000Z"),
    rowCount: 2,
    units: 3,
    productCount: 2,
    logTypes: "SALE",
    distinctStamps: 1,
    firstStamp: "gateorder-companya",
    lastStamp: "gateorder-companya",
    unstampedRows: 0,
    auditId: 4242,
    auditActionType: "EXTERNAL_ORDER_FULFILLMENT",
    auditEntityId: "gateorder-companya",
    auditOrderAttributionSource: null,
    auditIntent: null,
    auditSelectedExternalOrderId: null,
    auditOrderId: null,
    auditHasOrderReference: 0,
    auditHasRows: 0,
    auditHasRowsOmitted: 0,
    attemptId: null,
    attemptOutcome: null,
    attemptEvidence: null,
    attemptReason: null,
    attemptSource: null,
    attemptActorUserId: null,
    attemptOrderRecordId: null,
  };

  /** The order the stamp points at, as the frozen select would return it. */
  const ORDER_ROW = {
    id: "gateorder-companya",
    orderNumber: "1301",
    internalStatus: "pending",
    externalCreatedAt: new Date("2026-07-30T00:00:00.000Z"),
    companyId: "c1",
    integration: { platform: "WOOCOMMERCE" },
  };

  const RECONCILIATION_FIXTURES = TOOL_GATE_FIXTURES.get_order_reconciliation;

  async function runSeeded(args: Record<string, unknown>): Promise<ToolResult> {
    prismaCtl.__reset();
    // The batch summary, and NOT the match's deducted-side aggregate — which
    // this window's order has no rows for (pack CA2.1's alias, `AS outUnits`).
    prismaCtl.__overrides["$root.$queryRaw"] = (query: { sql: string }) =>
      query.sql.includes("AS outUnits") ? [] : [SUMMARY_ROW];
    prismaCtl.__overrides["externalOrder.findMany"] = [ORDER_ROW];
    return assistantTools.get_order_reconciliation.run(args, CTX);
  }

  it("the exported allowlist select is deep-frozen and matches the independent snapshot", () => {
    expect(Object.isFrozen(RECONCILIATION_ORDER_SELECT)).toBe(true);
    expect(Object.isFrozen(RECONCILIATION_ORDER_SELECT.integration)).toBe(true);
    expect(RECONCILIATION_ORDER_SELECT).toEqual(EXPECTED_RECONCILIATION_ORDER_SELECT);
  });

  // CX-6: the lane's set had to drop `note`/`customerName`-adjacent fields the Exceptions
  // finder legitimately returns, and a narrowing there must never quietly weaken THIS
  // gate. The direction is pinned: the lane's set is a SUPERSET of the gate's literal.
  it("RECONCILIATION_PII_FIELD_NAMES is a SUPERSET of this gate's own PII literal", () => {
    // `Array.from`, not a spread: the ROOT tsconfig (which is what `npx tsc --noEmit`
    // checks this file with) targets below ES2015, where spreading a Set needs
    // --downlevelIteration. Same set, same predicate.
    expect(Array.from(PII_FIELD_NAMES).every((k) => RECONCILIATION_PII_FIELD_NAMES.has(k))).toBe(
      true,
    );
  });

  it.each(RECONCILIATION_FIXTURES.map((f, i) => [i, f as Record<string, unknown>]))(
    "fixture[%#] every ExternalOrder read uses the allowlist select (vs an INDEPENDENT literal) and NO include",
    async (_i, fixture) => {
      await runSeeded(fixture);
      const calls = prismaCtl.__calls.filter((c) => c.model === "externalOrder");
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        const a = c.args as { select?: unknown; include?: unknown };
        expect(a.include).toBeUndefined(); // fail-closed: an include is REJECTED
        expect(a.select).toBeDefined(); // fail-closed: an absent select is REJECTED
        expect(a.select).toEqual(EXPECTED_RECONCILIATION_ORDER_SELECT);
      }
    },
  );

  it.each(RECONCILIATION_FIXTURES.map((f, i) => [i, f as Record<string, unknown>]))(
    "fixture[%#] serialized result key set carries NONE of the non-selectable PII columns",
    async (_i, fixture) => {
      const result = await runSeeded(fixture);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      const piiKeys = collectKeys(result.data, (k) => RECONCILIATION_PII_FIELD_NAMES.has(k));
      expect(piiKeys).toEqual([]);
    },
  );

  // D9: a member viewer never learns WHO — the batch pool is global, the operator is not.
  it("no row carries an actor, and the seeded order's fields reach a member of its company", async () => {
    const result = await runSeeded({});
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const data = result.data as { rows: Array<Record<string, unknown>> };
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).not.toHaveProperty("actor");
    expect(data.rows[0].order).toEqual({
      id: "gateorder-companya",
      orderNumber: "1301",
      internalStatus: "pending",
      platform: "WOOCOMMERCE",
      externalCreatedAt: "2026-07-30T00:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// SCOPE ECHO gate (spec C4, payload half — Task 1.1). Every scope-bearing tool
// echoes the scope it ACTUALLY queried, so a per-product answer can never be read
// as a catalog-wide one (and vice versa). Runs over the fail-closed proxy: the data
// is empty, but the echo is structural and must be present regardless.
// ---------------------------------------------------------------------------

describe("SCOPE ECHO gate (spec C4 — effective-scope echoes)", () => {
  const okData = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await assistantTools[name].run(args, CTX);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("not ok");
    return result.data as Record<string, unknown>;
  };

  it("get_sales echoes productScope: null for a catalog-wide call", async () => {
    prismaCtl.__reset();
    const data = await okData("get_sales", { groupBy: "product" });
    expect(data).toHaveProperty("productScope");
    expect(data.productScope).toBeNull();
  });

  it("get_sales echoes { productId, name, note } for a resolved single-product call", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 7, name: "TIRZ 10mg" };
    const data = await okData("get_sales", { productId: 7, groupBy: "product" });
    expect(data.productScope).toEqual({
      productId: 7,
      name: "TIRZ 10mg",
      note: "covers ONLY this product — not evidence about any other product",
    });
  });

  it("get_sales echoes productScope even on the EMPTY-companyIds short circuit", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 7, name: "TIRZ 10mg" };
    const result = await assistantTools.get_sales.run({ productId: 7 }, testCtx({ companyIds: [] }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect((result.data as { productScope: unknown }).productScope).toMatchObject({ productId: 7 });
  });

  // T4 (contract pack): the movement envelope is a DISCRIMINATED union keyed by the
  // literal `mode`, and `filters.mode === mode` on EVERY variant. One test per variant.
  it("get_movement_series (series) carries mode 'series' + filters, and filters.mode === mode", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 3, name: "P" };
    prismaCtl.__overrides["location.findUnique"] = { name: "Gate Annex" };
    const data = await okData("get_movement_series", { productId: 3, locationId: 2 });
    expect(data.mode).toBe("series");
    // A2 C8: a location-scoped echo names the location.
    expect(data.filters).toEqual({
      productId: 3,
      productIds: null,
      locationId: 2,
      locationName: "Gate Annex",
      mode: "series",
    });
    expect((data.filters as { mode: string }).mode).toBe(data.mode);
  });

  it("get_movement_series (receipts) carries mode 'receipts' + the SAME filters shape", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 3, name: "P" };
    prismaCtl.__overrides["location.findUnique"] = { name: "Gate Annex" };
    const data = await okData("get_movement_series", { productId: 3, locationId: 2, receipts: true });
    expect(data.mode).toBe("receipts");
    expect(data.filters).toEqual({
      productId: 3,
      productIds: null,
      locationId: 2,
      locationName: "Gate Annex",
      mode: "receipts",
    });
    expect((data.filters as { mode: string }).mode).toBe(data.mode);
  });

  it("get_movement_series echoes nulls for an unscoped call (both modes)", async () => {
    prismaCtl.__reset();
    const series = await okData("get_movement_series", {});
    expect(series.filters).toEqual({ productId: null, productIds: null, locationId: null, mode: "series" });
    prismaCtl.__reset();
    const receipts = await okData("get_movement_series", { receipts: true });
    expect(receipts.filters).toEqual({ productId: null, productIds: null, locationId: null, mode: "receipts" });
  });

  it("get_operations echoes scope { productId, windowDays } with the real default (90)", async () => {
    prismaCtl.__reset();
    const dflt = await okData("get_operations", {});
    expect(dflt.scope).toEqual({ productId: null, windowDays: 90 });
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 4, name: "P" };
    const scoped = await okData("get_operations", { productId: 4, windowDays: 30 });
    expect(scoped.scope).toEqual({ productId: 4, windowDays: 30 });
  });

  it("get_shrinkage echoes scope { days }", async () => {
    prismaCtl.__reset();
    expect((await okData("get_shrinkage", { days: 30 })).scope).toEqual({ days: 30 });
    prismaCtl.__reset();
    expect((await okData("get_shrinkage", { days: 365 })).scope).toEqual({ days: 365 });
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

describe("resolveAssistantProduct (spec §4 W0-PROD; opts + lifecycle by C13/T3)", () => {
  it("returns { id, name, lifecycle } for an approved, non-deleted product and filters on that scope", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 5, name: "TIRZ 10mg" };
    await expect(resolveAssistantProduct(5)).resolves.toEqual({
      id: 5,
      name: "TIRZ 10mg",
      lifecycle: "active",
    });
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

  // Task 3.2 sibling case: allowArchived relaxes ONLY deletedAt, and the resolved row is
  // TAGGED — a historical tool must be able to answer for a deleted product without ever
  // presenting it as a live one.
  it("allowArchived resolves a soft-deleted approved product, tagged, and drops ONLY the deletedAt predicate", async () => {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = {
      id: 6,
      name: "Retired 5mg",
      deletedAt: new Date("2026-02-01T00:00:00.000Z"),
    };
    await expect(resolveAssistantProduct(6, { allowArchived: true })).resolves.toEqual({
      id: 6,
      name: "Retired 5mg",
      lifecycle: "deleted",
    });
    const call = prismaCtl.__calls.find((c) => c.model === "product" && c.method === "findFirst");
    const where = (call!.args as { where: Record<string, unknown> }).where;
    // approvalStatus stays UNCONDITIONAL — allowArchived is not an approval bypass.
    expect(where).toMatchObject({ id: 6, approvalStatus: "APPROVED" });
    expect(where).not.toHaveProperty("deletedAt");
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

  // Wave-1 productId tools + the Wave-3 product composite (spec §4 W0-PROD): each resolves
  // through the shared resolver, so a guessed pending-review id returns the SAME notFound
  // shape — never provisional data. get_product_overview resolves BEFORE any section work.
  it.each(["get_operations", "get_valuation", "get_movement_series", "get_inventory_policy", "get_product_overview"])(
    "%s returns notFound for a pending-review productId",
    async (name) => {
      prismaCtl.__reset();
      const result = await assistantTools[name].run({ productId: PENDING_REVIEW_FIXTURE_ID }, CTX);
      expect(result).toEqual(NOT_FOUND);
    },
  );

  // Wave-2 productId tools need their required args alongside productId (dayKey /
  // metric+periods), so they can't share the argless it.each above.
  it("get_stock_asof returns notFound for a pending-review productId (resolved BEFORE the module call)", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.get_stock_asof.run(
      { dayKey: "2026-01-01", productId: PENDING_REVIEW_FIXTURE_ID },
      CTX,
    );
    expect(result).toEqual(NOT_FOUND);
  });

  it("compare_periods returns notFound for a pending-review productId", async () => {
    prismaCtl.__reset();
    const result = await assistantTools.compare_periods.run(
      {
        metric: "sales_units",
        periodA: { relativeDays: 7 },
        periodB: { relativeDays: 7 },
        productId: PENDING_REVIEW_FIXTURE_ID,
      },
      CTX,
    );
    expect(result).toEqual(NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// (4) G4 gate — TRANSITIVE-IMPORT WRITE-FREEDOM (spec REV-9 G4; plan D1; Task 1.4).
//
// The READ_PATH_FILES completeness meta-test above only sees tools.ts's DIRECT
// imports — it is not a closure, so a persistence module pulled in two hops down
// still escapes it. This gate closes that hole: a static BFS over the `@/lib` import
// graph rooted at BOTH read-path entry points (tools.ts = the tool bodies,
// tool-adapters.ts = the ai/MCP wrappers — design D1 names both) asserting the
// thread-persistence modules stay UNREACHABLE. Nothing is executed: every visited
// file is read from disk and its import statements are parsed.
//
// TYPE-ONLY IMPORTS ARE NOT EDGES. `import type ...` / `export type ... from ...` is
// erased at compile time and can issue no write, so following one would fail this
// gate on a compile-time-only reference (threads.ts's own
// `import type { UIMessage } from "ai"` is the shape that made the rule explicit —
// contract pack REV-5). An inline `{ type Foo }` specifier inside a VALUE import is
// still a real edge and is followed.
// ---------------------------------------------------------------------------

const G4_REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Design D1: the tool read path has two entry points, and the denial holds for both. */
const G4_ROOTS = ["lib/assistant/tools.ts", "lib/assistant/tool-adapters.ts"];

/** The persistence boundary the read path may never reach (spec G4 / plan D1). */
const PERSISTENCE_MODULES = [
  "lib/assistant/threads.ts",
  "lib/assistant/requests.ts",
  "lib/assistant/titles.ts",
];

/** Spec G4 states the denial as a glob (`lib/assistant/threads*`), so a future
 *  sibling (threads-foo.ts) is denied too — not only the three files above. */
const PERSISTENCE_PATTERN = /^lib\/assistant\/(threads|requests|titles)[^/]*\.tsx?$/;

type ImportEdge = { spec: string; typeOnly: boolean };

/**
 * Every module specifier in a source file, with its type-only flag. Handles the
 * statement forms that can create a RUNTIME edge — `import ... from "x"`,
 * `export ... from "x"`, side-effect `import "x"`, dynamic `import("x")` and
 * `require("x")` — and marks `import type` / `export type` statements type-only.
 * The clause between the keyword and `from` may contain neither `;` nor another
 * `import`/`export`, so one match can never straddle two statements and mis-read
 * the following statement's `type` modifier.
 */
function extractImportEdges(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const fromRe =
    /(?:^|[\n;])[ \t]*(?:import|export)\s+((?:type\s+)?)(?:(?!\bimport\b|\bexport\b|;)[\s\S])*?\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) {
    edges.push({ spec: m[2], typeOnly: m[1].trim() === "type" });
  }
  const callRe = /(?:^|[^\w$.])(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = callRe.exec(source)) !== null) edges.push({ spec: m[1], typeOnly: false });
  const sideEffectRe = /(?:^|[\n;])[ \t]*import\s*["']([^"']+)["']/g;
  while ((m = sideEffectRe.exec(source)) !== null) edges.push({ spec: m[1], typeOnly: false });
  return edges;
}

/** Resolve a LOCAL specifier (`@/…` alias or relative) to a repo-relative .ts(x)
 *  path INSIDE `lib/`. null = bare module, unresolvable, or outside lib/ — the G4
 *  graph is the `@/lib` graph, and a relative edge that lands in lib/ is one of its
 *  edges just as much as an aliased one. */
function resolveLibModule(spec: string, fromRel: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = path.join(G4_REPO_ROOT, spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.resolve(path.dirname(path.join(G4_REPO_ROOT, fromRel)), spec);
  } else {
    return null; // bare module (node_modules / builtin)
  }
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  for (const cand of candidates) {
    if (!fs.existsSync(cand)) continue;
    const rel = path.relative(G4_REPO_ROOT, cand).split(path.sep).join("/");
    return rel.startsWith("lib/") ? rel : null;
  }
  return null;
}

type LibWalk = { visited: Set<string>; parents: Map<string, string> };

/** Breadth-first walk of the runtime `@/lib` import graph from the given roots. */
function walkLibGraph(roots: string[]): LibWalk {
  const visited = new Set<string>();
  const parents = new Map<string, string>();
  const queue = [...roots];

  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (visited.has(rel)) continue;
    visited.add(rel);

    const abs = path.join(G4_REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const edge of extractImportEdges(fs.readFileSync(abs, "utf8"))) {
      if (edge.typeOnly) continue; // erased at compile time — never a runtime edge
      const target = resolveLibModule(edge.spec, rel);
      if (target === null || visited.has(target)) continue;
      if (!parents.has(target)) parents.set(target, rel);
      queue.push(target);
    }
  }

  return { visited, parents };
}

/** root -> … -> target, so a failure names the offending import chain. */
function importChain(walk: LibWalk, target: string): string {
  const chain = [target];
  let cur = target;
  while (walk.parents.has(cur) && chain.length < 40) {
    cur = walk.parents.get(cur) as string;
    chain.unshift(cur);
  }
  return chain.join(" -> ");
}

describe("G4 gate — the read path never transitively reaches thread persistence", () => {
  const walk = walkLibGraph(G4_ROOTS);

  it("walks a connected, plausible @/lib graph from BOTH roots (self-check — no vacuous pass)", () => {
    for (const root of G4_ROOTS) expect(walk.visited.has(root)).toBe(true);
    // Real transitive reach, several hops deep past the roots.
    expect(walk.visited.has("lib/reports/low-stock.ts")).toBe(true);
    expect(walk.visited.has("lib/products.ts")).toBe(true);
    expect(walk.visited.has("lib/analytics/queries.ts")).toBe(true);
    expect(walk.visited.has("lib/prisma.ts")).toBe(true);
    expect(walk.visited.size).toBeGreaterThan(20);
  });

  it("the extractor follows value imports and IGNORES type-only ones (walker contract)", () => {
    const source = [
      'import type { UIMessage } from "ai";',
      "import type {",
      "  AssistantMessageMetadata,",
      '} from "@/lib/assistant/thread-contracts";',
      'export type { TitleJob } from "@/lib/assistant/titles";',
      'import { claimTurn } from "@/lib/assistant/threads";',
      'import { tool, type ToolSet } from "ai";',
      'export { utcDayKey } from "@/lib/assistant/requests";',
      'import "@/lib/side-effect";',
      'const m = require("@/lib/required");',
      'const d = await import("@/lib/dynamic");',
    ].join("\n");
    const edges = extractImportEdges(source);
    const specs = (typeOnly: boolean) =>
      edges
        .filter((e) => e.typeOnly === typeOnly)
        .map((e) => e.spec)
        .sort();
    // `import type` / `export type` statements only — the erased ones.
    expect(specs(true)).toEqual([
      "@/lib/assistant/thread-contracts",
      "@/lib/assistant/titles",
      "ai",
    ]);
    // Everything that survives to runtime, incl. the inline-`type`-specifier import
    // and the VALUE re-export (`export { x } from` is an edge; `export type` is not).
    expect(specs(false)).toEqual([
      "@/lib/assistant/requests",
      "@/lib/assistant/threads",
      "@/lib/dynamic",
      "@/lib/required",
      "@/lib/side-effect",
      "ai",
    ]);
  });

  it("the walker DOES report threads.ts from app/api/assistant/route.ts (negative control)", () => {
    // The route GENUINELY imports the persistence modules (design D1: orchestration
    // calls persistence), so walking from it proves the machinery detects an edge and
    // the empty assertion below cannot pass vacuously — without touching product code.
    const control = walkLibGraph(["app/api/assistant/route.ts"]);
    expect(control.visited.has("lib/assistant/threads.ts")).toBe(true);
    expect(control.visited.has("lib/assistant/titles.ts")).toBe(true);
    // ...and requests.ts is reached TRANSITIVELY (route -> threads -> requests): the
    // multi-hop closure a direct-import check like READ_PATH_FILES cannot see.
    expect(control.visited.has("lib/assistant/requests.ts")).toBe(true);
    expect(control.parents.get("lib/assistant/requests.ts")).toBe("lib/assistant/threads.ts");
  });

  it("neither tools.ts nor tool-adapters.ts reaches threads/requests/titles (spec G4)", () => {
    const reached = Array.from(walk.visited)
      .filter((rel) => PERSISTENCE_MODULES.includes(rel) || PERSISTENCE_PATTERN.test(rel))
      .sort()
      .map((rel) => importChain(walk, rel));
    expect(reached).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (5) C2 ENVELOPE fast pins (spec C2; contract pack T0 — Task 1.4). The route's own
// cutover pins live in the integration suite; these are the FAST ones the gate suite
// carries, straight against the shared schema: the pre-lane envelope is dead, the C2
// envelope parses, and the 4-part / 24_576-character bounds are enforced at the zod
// layer (the serialized BYTE cap stays a post-parse assert at the route — C2).
// ---------------------------------------------------------------------------

describe("C2 envelope pins (contract pack T0 — requestSchema)", () => {
  const textPart = (text: string) => ({ type: "text", text });
  const validMessage = { id: "am-fixture-1", role: "user", parts: [textPart("hi")] };

  it("REJECTS the pre-lane envelope { conversationId, messages }", () => {
    const parsed = requestSchema.safeParse({
      conversationId: "abc",
      messages: [{ id: "m1", role: "user", parts: [textPart("hi")] }],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const paths = parsed.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("threadId");
    expect(paths).toContain("message");
  });

  it("ACCEPTS { threadId: null, message, trigger: 'submit-message' }", () => {
    const parsed = requestSchema.safeParse({
      threadId: null,
      message: validMessage,
      trigger: "submit-message",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.threadId).toBeNull();
    expect(parsed.data.trigger).toBe("submit-message");
    expect(parsed.data.message.parts).toEqual([textPart("hi")]);
  });

  it("caps the message at FOUR parts", () => {
    const parts = (n: number) => Array.from({ length: n }, (_, i) => textPart(`p${i}`));
    expect(
      requestSchema.safeParse({ threadId: null, message: { ...validMessage, parts: parts(4) } })
        .success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ threadId: null, message: { ...validMessage, parts: parts(5) } })
        .success,
    ).toBe(false);
  });

  it("caps each text part at 24_576 characters", () => {
    const atCap = { ...validMessage, parts: [textPart("x".repeat(24_576))] };
    const overCap = { ...validMessage, parts: [textPart("x".repeat(24_577))] };
    expect(requestSchema.safeParse({ threadId: null, message: atCap }).success).toBe(true);
    expect(requestSchema.safeParse({ threadId: null, message: overCap }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2 pack C10 — model-facing text carries no internal lane or design-reference names.
//
// Review #4 found "pre-Lane-4" (an internal lane name AND a false time claim: reason-less
// deductions are written today) in a coverage note and two descriptions, "(D12)" in a
// definition and "pre-lane" in a disclosure. The scan covers every tool DESCRIPTION and
// every serialized GATE-FIXTURE payload: a benign pass over the whole matrix, plus a
// seeded pass that makes the data-dependent notes (the unclassified-outbound note rides
// only when a reason-less outbound row exists) and the location-resolved branches appear.
// The only exemptions are the two reconciliation sentences B3 owns (shared with the
// reconciliation pages), by exact string.
// ---------------------------------------------------------------------------

describe("A2 C10 — no internal lane or design-reference names in model-facing text", () => {
  const LANE = /\b(pre-|post-)?lane\b/i;
  const DESIGN_REF = /\(D\d+\)/;
  /** B3-registered (lib/reconciliation/derive.ts:85 and attribution.ts:396-398). */
  const B3_EXEMPT = [
    "unknown — before the lane",
    "computed at read time because no attempt row exists — before the lane, or a path that did not record",
  ];
  const violationsIn = (label: string, text: string): string[] => {
    let scanned = text;
    for (const exempt of B3_EXEMPT) scanned = scanned.split(exempt).join("");
    const found: string[] = [];
    for (const re of [LANE, DESIGN_REF]) {
      const hit = scanned.match(re);
      if (hit) {
        const at = hit.index ?? 0;
        found.push(`${label}: ${JSON.stringify(scanned.slice(Math.max(0, at - 60), at + 40))}`);
      }
    }
    return found;
  };

  it("the patterns have teeth (the strings review #4 found) and the exemptions are live B3 strings", () => {
    expect(LANE.test("how this shop ships pre-Lane-4")).toBe(true);
    expect(LANE.test("pre-lane mass-update batches")).toBe(true);
    expect(LANE.test("the post-lane rows")).toBe(true);
    expect(DESIGN_REF.test("five events (D12)")).toBe(true);
    expect(LANE.test("unclassified outbound, landing page")).toBe(false);
    const recon = ["lib/reconciliation/derive.ts", "lib/reconciliation/attribution.ts"]
      .map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8"))
      .join("\n");
    for (const exempt of B3_EXEMPT) expect(recon).toContain(exempt);
  });

  it("every tool description is clean", () => {
    const violations = TOOL_NAMES.flatMap((name) =>
      violationsIn(`${name} description`, assistantTools[name].description),
    );
    expect(violations).toEqual([]);
  });

  it("every serialized gate-fixture payload is clean (benign pass over the whole matrix)", async () => {
    const violations: string[] = [];
    for (const name of TOOL_NAMES) {
      for (const fixture of TOOL_GATE_FIXTURES[name]) {
        prismaCtl.__reset();
        const result = await assistantTools[name].run(fixture, CTX);
        violations.push(...violationsIn(`${name} ${JSON.stringify(fixture)}`, JSON.stringify(result)));
      }
    }
    expect(violations).toEqual([]);
  });

  it("the seeded pass: the unclassified-outbound note and the location branches appear, and are clean", async () => {
    const seed = () => {
      prismaCtl.__reset();
      prismaCtl.__overrides["product.findFirst"] = { id: 1, name: "Gate Fixture Product" };
      prismaCtl.__overrides["location.findUnique"] = { id: 2, name: "Gate Annex" };
      // One reason-less outbound adjustment: the row the note describes.
      prismaCtl.__overrides["inventory_logs.findMany"] = [
        {
          id: 1,
          productId: 1,
          locationId: 2,
          locations: { name: "Gate Annex" },
          delta: -2,
          logType: "ADJUSTMENT",
          reasonCode: null,
          unitCostCents: null,
          batchId: null,
          changeTime: new Date("2026-01-01T12:00:00.000Z"),
        },
      ];
      prismaCtl.__overrides["inventory_logs.groupBy"] = [
        { productId: 1, logType: "ADJUSTMENT", reasonCode: null, _sum: { delta: -2 }, _count: 1 },
      ];
    };
    const seeded: Array<[string, Record<string, unknown>]> = [
      ["get_movement_series", {}],
      ["get_movement_series", { breakdownBy: "product" }],
      ["get_movement_series", { breakdownBy: "product", locationId: 2 }],
      ["get_movement_series", { receipts: true, locationId: 2 }],
      ["get_product_overview", { productId: 1 }],
      ["get_stock_asof", { dayKey: "2026-01-01", locationId: 2 }],
      ["get_shrinkage", { days: 30 }],
    ];
    const violations: string[] = [];
    const payloads: string[] = [];
    for (const [name, fixture] of seeded) {
      seed();
      const result = await assistantTools[name].run(fixture, CTX);
      expect({ name, fixture, status: result.status }).toEqual({ name, fixture, status: "ok" });
      const text = JSON.stringify(result);
      payloads.push(text);
      violations.push(...violationsIn(`${name} ${JSON.stringify(fixture)} (seeded)`, text));
    }
    expect(violations).toEqual([]);
    // Non-vacuity: the note really rode (series, breakdown and the overview's movement30).
    const withNote = payloads.filter((p) => p.includes('"unclassifiedLegacyNote"'));
    expect(withNote.length).toBeGreaterThanOrEqual(3);
    expect(payloads.some((p) => p.includes('"locationName":"Gate Annex"'))).toBe(true);
    expect(payloads.some((p) => p.includes('"watermarkScope":"all locations"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A2 pack C1 (A2-G1R3-1) — the remainingRows VALUE gate. Every PAGED tool is re-run with a
// seeded per-tool override (its count / findMany / groupBy returns more rows than a small
// `limit`, so the cursor is NON-null), and EVERY object in the payload that carries a
// `nextOffset` key must carry `remainingRows === (nextOffset === null ? 0 : totalRows -
// nextOffset)` immediately after it — computed from THAT object's own fields, which is
// what catches an envelope that copied its count from an inner page object (find_product's
// envelope totals and cursor are not its page's). The benign matrix alone would check only
// 0s (every cursor null there), so a non-vacuity check requires a non-null cursor per tool.
// ---------------------------------------------------------------------------

describe("A2 C1 — remainingRows VALUE gate (seeded, non-null cursors)", () => {
  /** Every object (envelope or nested page) in the payload that owns a `nextOffset` key. */
  function pagedObjects(data: unknown): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const visit = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") {
        if (Object.prototype.hasOwnProperty.call(v, "nextOffset")) out.push(v as Record<string, unknown>);
        Object.values(v).forEach(visit);
      }
    };
    visit(data);
    return out;
  }

  /** The gate's check for one payload: one line per object that breaks the C1 rule. */
  function remainingRowsViolations(label: string, data: unknown): string[] {
    return pagedObjects(data).flatMap((o) => {
      const { totalRows, nextOffset, remainingRows } = o as {
        totalRows: number;
        nextOffset: number | null;
        remainingRows: unknown;
      };
      const expected = nextOffset === null ? 0 : totalRows - nextOffset;
      const keys = Object.keys(o);
      const problems: string[] = [];
      if (remainingRows !== expected) {
        problems.push(`${label}: remainingRows ${String(remainingRows)} != ${expected} (totalRows ${totalRows}, nextOffset ${nextOffset})`);
      }
      if (keys.indexOf("remainingRows") !== keys.indexOf("nextOffset") + 1) {
        problems.push(`${label}: remainingRows is not immediately after nextOffset`);
      }
      return problems;
    });
  }

  /** Three approved products, wide enough for every product select the paged reads make. */
  const GATE_PRODUCTS = [1, 2, 3].map((id) => ({
    id,
    name: `Gate Product ${id}`,
    baseName: `Gate Product ${id}`,
    variant: null,
    deletedAt: null,
    approvalStatus: "APPROVED",
    lowStockThreshold: 5,
    costPrice: null,
    retailPrice: null,
    product_locations: [{ locationId: 1, quantity: 1 }],
  }));
  const LEDGER_ROWS = [1, 2, 3].map((id) => ({
    id,
    productId: id,
    locationId: 1,
    locations: { name: "Gate Main" },
    delta: 4,
    logType: "STOCK_IN",
    reasonCode: null,
    unitCostCents: null,
    batchId: null,
    changeTime: new Date("2026-01-01T12:00:00.000Z"),
  }));

  /** [tool, args, the per-tool prisma seed] — limit 1 against a 3-row source everywhere. */
  const PAGED: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    // ONE DB page, as the database returns it (at most `limit` rows), of 3 matches: the
    // envelope's total and cursor are the DB's, the byte-fit page's own are 1 and null.
    ["find_product", { query: "gate", limit: 1 }, { "product.count": 3, "product.findMany": GATE_PRODUCTS.slice(0, 1) }],
    ["get_sales", { groupBy: "product", includeZeroRows: true, limit: 1 }, { "product.findMany": GATE_PRODUCTS }],
    ["get_operations", { limit: 1 }, { "product.findMany": GATE_PRODUCTS }],
    ["get_valuation", { groupBy: "product", limit: 1 }, { "product.findMany": GATE_PRODUCTS }],
    [
      "get_movement_series",
      { receipts: true, limit: 1 },
      { "product.findMany": GATE_PRODUCTS, "inventory_logs.count": 3, "inventory_logs.findMany": LEDGER_ROWS.slice(0, 1) },
    ],
    [
      "get_movement_series",
      { breakdownBy: "product", productIds: [1, 2, 3], limit: 1 },
      { "product.findMany": GATE_PRODUCTS },
    ],
    ["get_inventory_summary", { rankBy: "onHand", limit: 1 }, { "product.findMany": GATE_PRODUCTS }],
    ["low_stock_report", { limit: 1 }, { "product.findMany": GATE_PRODUCTS }],
    ["reorder_report", { productIds: [1, 2, 3], limit: 1 }, {}],
    // DB-paged: the count says 3 in scope, the fetch hands back the one-row page asked for.
    [
      "get_stock_asof",
      { dayKey: "2026-01-01", limit: 1 },
      { "product.count": 3, "product.findMany": GATE_PRODUCTS.slice(0, 1) },
    ],
    [
      "compare_periods",
      { metric: "outbound_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 }, groupBy: "product", limit: 1 },
      {
        "inventory_logs.aggregate": { _min: { changeTime: new Date("2020-01-01T00:00:00.000Z") }, _sum: { delta: -7 } },
        "inventory_logs.groupBy": [1, 2, 3].map((id) => ({ productId: id, _sum: { delta: -id } })),
        "product.findMany": GATE_PRODUCTS,
      },
    ],
  ];

  async function runSeeded(name: string, args: Record<string, unknown>, seed: Record<string, unknown>) {
    prismaCtl.__reset();
    prismaCtl.__overrides["product.findFirst"] = { id: 1, name: "Gate Product 1" };
    Object.assign(prismaCtl.__overrides, seed);
    const result = await assistantTools[name].run(args, CTX);
    expect({ name, args, status: result.status }).toEqual({ name, args, status: "ok" });
    if (result.status !== "ok") throw new Error(`${name} not ok`);
    return result.data;
  }

  it.each(PAGED)("%s %j: every nextOffset-bearing object carries the right remainingRows, and a cursor is live", async (name, args, seed) => {
    const data = await runSeeded(name, args, seed);
    const paged = pagedObjects(data);
    expect(paged.length).toBeGreaterThan(0);
    // Non-vacuity (A2-G1R3-1): this run really has rows after the page.
    expect({ name, liveCursor: paged.some((o) => o.nextOffset !== null) }).toEqual({ name, liveCursor: true });
    expect(remainingRowsViolations(`${name} ${JSON.stringify(args)}`, data)).toEqual([]);
  });

  it("registration: every tool whose payload carries a nextOffset is in the seeded matrix", async () => {
    const seeded = new Set(PAGED.map(([name]) => name));
    const carriers = new Set<string>();
    const violations: string[] = [];
    for (const name of TOOL_NAMES) {
      for (const fixture of TOOL_GATE_FIXTURES[name]) {
        prismaCtl.__reset();
        prismaCtl.__overrides["product.findFirst"] = { id: 1, name: "Gate Product 1" };
        const result = await assistantTools[name].run(fixture, CTX);
        if (result.status !== "ok") continue;
        if (pagedObjects(result.data).length > 0) carriers.add(name);
        // The benign pass is checked too (every cursor null there, so every count 0).
        violations.push(...remainingRowsViolations(`${name} ${JSON.stringify(fixture)} (benign)`, result.data));
      }
    }
    expect(violations).toEqual([]);
    expect(Array.from(carriers).filter((name) => !seeded.has(name))).toEqual([]);
    // get_stock pages whole days with no nextOffset in its payload — C1 leaves it alone.
    expect(carriers.has("get_stock")).toBe(false);
  });

  it("teeth: an envelope that copies its count from its byte-fit page object fails the gate", async () => {
    const [name, args, seed] = PAGED[0]; // find_product: envelope total 3, page total 1
    const data = (await runSeeded(name, args, seed)) as Record<string, unknown>;
    expect(remainingRowsViolations("as shipped", data)).toEqual([]);
    // What copying from the page would ship: the page is ONE fetched DB page, all of it fit,
    // so its own cursor is null and its count 0 — while 2 matched products remain.
    const pageCopy = { ...data, remainingRows: 0 };
    expect(data.nextOffset).toBe(1);
    expect(data.remainingRows).toBe(2);
    expect(remainingRowsViolations("copied from the page", pageCopy)).toEqual([
      "copied from the page: remainingRows 0 != 2 (totalRows 3, nextOffset 1)",
    ]);
    // ...and an envelope with no count at all fails it too.
    const { remainingRows: _dropped, ...missing } = data;
    void _dropped;
    expect(remainingRowsViolations("missing", missing).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A2 pack C7 — compare_periods' sales metrics carry the sales-freshness note (both modes),
// the ledger metrics never do, and get_data_freshness / get_business_snapshot carry
// lastSucceededAt with both instants defined in their descriptions.
// ---------------------------------------------------------------------------

describe("A2 C7 — compare_periods' freshness note and the freshness tool's lastSucceededAt", () => {
  const HOUR_MS = 3_600_000;
  const finishedHoursAgo = (h: number) => new Date(Date.now() - h * HOUR_MS);
  const successRun = (h: number) => ({
    status: "SUCCEEDED",
    startedAt: finishedHoursAgo(h + 0.1),
    finishedAt: finishedHoursAgo(h),
    skippedReason: null,
  });
  const runReads = () => prismaCtl.__calls.filter((c) => c.model === "analyticsRebuildRun");
  type RunRow = { status: string; startedAt: Date; finishedAt: Date | null; skippedReason: string | null };
  type RunQuery = {
    where?: Record<string, unknown>;
    orderBy?: Record<string, string>;
    take?: number;
    select?: Record<string, boolean>;
  };
  /**
   * A2 C15: seed the sales run table, answered QUERY-FAITHFULLY through the proxy's function
   * overrides — `where` (equality, `in`, `gt`, and `not` with SQL's NULL rule: a NULL column
   * never matches `<>`), `orderBy` startedAt, `take` and `select`. An operator it does not
   * model throws rather than matching silently.
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
        .map((run) => ({ job: "sales", ...run }))
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
    prismaCtl.__overrides["analyticsRebuildRun.findFirst"] = (args?: RunQuery) => query({ ...args, take: 1 })[0] ?? null;
    prismaCtl.__overrides["analyticsRebuildRun.findMany"] = (args?: RunQuery) => query(args);
  }

  const SALES_TOTALS = { metric: "sales_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 14 } };
  const SALES_BY_PRODUCT = { ...SALES_TOTALS, groupBy: "product" };
  const LEDGER_TOTALS = { metric: "outbound_units", periodA: { relativeDays: 7 }, periodB: { relativeDays: 7 } };
  const LEDGER_BY_PRODUCT = { ...LEDGER_TOTALS, groupBy: "product" };

  async function compareCoverage(args: Record<string, unknown>, runs: RunRow[], ctx = CTX) {
    prismaCtl.__reset();
    seedRuns(runs);
    const result = await assistantTools.compare_periods.run(args, ctx);
    if (result.status !== "ok") throw new Error("not ok");
    return (result.data as { coverage: Record<string, unknown> }).coverage;
  }

  it.each([
    ["totals", SALES_TOTALS],
    ["by_product", SALES_BY_PRODUCT],
  ])("sales metric (%s): a 30-hour-old success -> the note; 20 hours -> none", async (_mode, args) => {
    const stale = successRun(30);
    expect((await compareCoverage(args, [stale])).salesFreshnessNote).toBe(
      `The last successful sales rebuild finished at ${stale.finishedAt.toISOString()}, more than a ` +
        `day ago; orders recorded after that are not counted yet.`,
    );
    expect(await compareCoverage(args, [successRun(20)])).not.toHaveProperty("salesFreshnessNote");
  });

  it.each([
    ["totals", LEDGER_TOTALS],
    ["by_product", LEDGER_BY_PRODUCT],
  ])("ledger metric (%s): never a note, and no run-history read", async (_mode, args) => {
    expect(await compareCoverage(args, [successRun(30)])).not.toHaveProperty("salesFreshnessNote");
    expect(runReads()).toEqual([]);
  });

  it("a caller with no companies: no note and no run-history read (sales metric, both modes)", async () => {
    for (const args of [SALES_TOTALS, SALES_BY_PRODUCT]) {
      expect(await compareCoverage(args, [successRun(30)], testCtx({ companyIds: [] }))).not.toHaveProperty(
        "salesFreshnessNote",
      );
      expect(runReads()).toEqual([]);
    }
  });

  it("get_data_freshness: rebuild.lastSucceededAt is the success's finishedAt, beside lastRunAt", async () => {
    prismaCtl.__reset();
    const run = successRun(30);
    seedRuns([
      { status: "FAILED", startedAt: finishedHoursAgo(2), finishedAt: finishedHoursAgo(2), skippedReason: null },
      run,
    ]);
    // The state row's lastRunAt is the FAILED attempt's finish (finalizeRebuildRun stamps
    // every finished attempt), so the two instants differ exactly as they do in production.
    const lastAttemptFinish = new Date("2026-10-27T02:00:09.000Z");
    prismaCtl.__overrides["analyticsRebuildState.findUnique"] = {
      lastRunAt: lastAttemptFinish,
      sourceWatermark: null,
      flaggedPairs: 0,
    };
    const result = await assistantTools.get_data_freshness.run({}, CTX);
    if (result.status !== "ok") throw new Error("not ok");
    const rebuild = (result.data as { rebuild: Record<string, unknown> }).rebuild;
    expect(rebuild).toEqual({
      lastRunAt: lastAttemptFinish.toISOString(),
      lastSucceededAt: run.finishedAt.toISOString(),
      sourceWatermark: null,
    });
    expect(Object.keys(rebuild)).toEqual(["lastRunAt", "lastSucceededAt", "sourceWatermark"]);
  });

  it("the freshness tool and the snapshot define lastRunAt and lastSucceededAt; get_sales defines lastRebuildAt", () => {
    const flat = (name: string) => assistantTools[name].description.replace(/\s+/g, " ");
    expect(flat("get_data_freshness")).toContain(
      "rebuild.lastRunAt is when the last rebuild attempt finished, whatever its outcome; " +
        "rebuild.lastSucceededAt is when the last successful rebuild finished.",
    );
    expect(flat("get_business_snapshot")).toContain(
      "freshness.lastRunAt is when the last rebuild attempt finished, whatever its outcome; " +
        "freshness.lastSucceededAt is when the last successful rebuild finished.",
    );
    expect(flat("get_sales")).toContain(
      "coverage.lastRebuildAt is when the last rebuild attempt finished, whatever its outcome.",
    );
  });
});
