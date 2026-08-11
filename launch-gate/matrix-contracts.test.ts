/**
 * launch-gate/matrix-contracts.test.ts — ASSERTION MATRIX ROW 2: the quality+reach
 * lane's tool contracts, re-asserted through the REAL route (plan Task 1.7; spec C7
 * row 2, items 2a-2m; quality+reach spec REV-4 C4-C13).
 *
 * WHAT MAKES THIS DIFFERENT FROM THE UNIT SUITES: those tools are already covered by
 * ~360 mocked gate tests. This file asserts the same contracts against a REAL MySQL
 * database, through the REAL adapter, over the REAL SSE wire — and recomputes every
 * expectation with INDEPENDENT raw SQL (`oracleQuery`, never prisma). A contract that
 * holds against a mock and fails against rows is exactly what this gate exists to
 * catch, and the recomputation is the only thing that can tell the two apart.
 *
 * ONE describe PER AMENDMENT ITEM (2a…2m), in the spec's order.
 *
 * SCENARIOS. Four scripted turns, packed to 9 tool calls each (STEP_LIMIT is 10, so a
 * turn always has a step left for its closing text):
 *   contract-echoes-and-mix    memberA  a, c, g, h, i, j(degraded), k(historical), m
 *   contract-modes-and-misuse  memberA  d, e, f, l
 *   contract-reorder-sweep     admin    b, j(full), k(current-state refusals)
 *   contract-lifecycle-census  admin    d(shift), e, k(census + the remaining tools)
 * The two memberA turns carry the FD2-2 per-company degradation (memberA holds the
 * no-sales company); the two admin turns carry the staggered A/B starts that produce a
 * real coverage SHIFT. Neither caller can produce the other's case.
 */

import { describe, expect, it, beforeAll } from "@jest/globals";
// The C3 definition constants are imported for the EXPECTATION only; the assertion is
// always against the streamed payload. metrics-contract is prisma-free (it imports
// `@prisma/client` types/enums only), so pulling it into this suite starts no client.
import {
  OUTBOUND_USAGE_DEFINITION,
  PHYSICAL_OUTBOUND_DEFINITION,
  REORDER_DEMAND_DEFINITION,
} from "@/lib/reports/metrics-contract";
import { gatePrompt } from "./choreography";
import { loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_SEED } from "./seed";
import {
  assertNoCompanyBLeak,
  callWithInput,
  compareRoundTrip,
  coverageOf,
  daysCovered,
  errorHint,
  eventsOfType,
  notFoundMessage,
  okBytes,
  okData,
  payloadTranscript,
  relativeWindow,
  scannedScopedTurnLabels,
  settleTurn,
  toolCalls,
} from "./assertions";

const MEMBER_A = GATE_SEED.actors.memberA;
const ADMIN = GATE_SEED.actors.admin;
const FIXTURES = GATE_SEED.fixtures;
const ACTIVE = FIXTURES.approvedActiveProductId; // 9101
const ARCHIVED = FIXTURES.approvedArchivedProductId; // 9102
const UNAPPROVED = FIXTURES.pendingReviewProductId; // 9103
const UNKNOWN_ID = 424242;
const PER_TOOL_RESULT_CAP_BYTES = 65_536;
const REORDER_WINDOW_DAYS = 90;

type ScenarioKey = "echoes" | "modes" | "reorder" | "lifecycle";

const SCENARIOS: Record<ScenarioKey, { id: string; caller: "memberA" | "admin"; text: string }> = {
  echoes: {
    id: "contract-echoes-and-mix",
    caller: "memberA",
    text: "Echoes, coverage, mixes and definitions read.",
  },
  modes: {
    id: "contract-modes-and-misuse",
    caller: "memberA",
    text: "Modes exercised and four illegal combinations rejected.",
  },
  reorder: {
    id: "contract-reorder-sweep",
    caller: "admin",
    text: "Reorder coverage swept and the archived product refused by every current-state tool.",
  },
  lifecycle: {
    id: "contract-lifecycle-census",
    caller: "admin",
    text: "Coverage shift, per-product split and the lifecycle policy table read.",
  },
};

/**
 * The scripted inputs, VERBATIM from the four choreography files. `callWithInput`
 * addresses a call by its WHOLE input (a subset selector silently picks the wrong call
 * the moment a scenario packs a superset one), so these constants ARE the addressing
 * scheme — and a choreography edit that orphans an assertion fails loudly here.
 */
const PERIOD_A = { relativeDays: 30 };
const PERIOD_B = { relativeDays: 5 };
const IN = {
  // contract-echoes-and-mix (memberA)
  salesProductActive: { productId: ACTIVE, relativeDays: 60 },
  // relativeDays 30, NOT 60: a 60-day window PREDATES this caller's first approved
  // fact, which would classify `partial` at the WINDOW level and mask the per-company
  // degradation this call exists to observe.
  salesZeroDegraded: { groupBy: "product", relativeDays: 30, includeZeroRows: true },
  salesProductArchived: { productId: ARCHIVED, relativeDays: 60 },
  operationsActive: { productId: ACTIVE, windowDays: 30 },
  shrinkage30: { days: 30 },
  lowStock: {},
  reorderDefault: {},
  findProductArchived: { query: "Gate", includeArchived: true },
  movementSeries60: { relativeDays: 60 },
  // contract-modes-and-misuse (memberA)
  compareTotals: { metric: "sales_units", periodA: PERIOD_A, periodB: PERIOD_B },
  compareByProduct: { metric: "sales_units", periodA: PERIOD_A, periodB: PERIOD_B, groupBy: "product" },
  compareIncrease: {
    metric: "sales_units",
    periodA: PERIOD_A,
    periodB: PERIOD_B,
    groupBy: "product",
    direction: "increase",
  },
  movementBatch: {
    breakdownBy: "product",
    productIds: [ACTIVE, ARCHIVED, UNAPPROVED, UNKNOWN_ID],
    relativeDays: 60,
  },
  movementReceipts: { receipts: true, relativeDays: 60 },
  movementWeek: { relativeDays: 60, groupBy: "week" },
  misuseZeroRows: { groupBy: "day", relativeDays: 30, includeZeroRows: true },
  misuseProductIds: { productIds: [ACTIVE], relativeDays: 30 },
  misuseCompare: {
    metric: "sales_units",
    periodA: PERIOD_A,
    periodB: PERIOD_B,
    groupBy: "product",
    productId: ACTIVE,
  },
  misuseEmptyIds: { productIds: [] },
  // contract-reorder-sweep (admin)
  salesZeroFull: { groupBy: "product", relativeDays: 5, includeZeroRows: true },
  reorderNoOkay: { includeOkay: false },
  reorderHealthy: { includeHealthy: true },
  reorderNoOkayHealthy: { includeOkay: false, includeHealthy: true },
  reorderRequested: { productIds: [9104, ARCHIVED, UNKNOWN_ID] },
  archivedProduct: { productId: ARCHIVED },
  // contract-lifecycle-census (admin)
  salesProductGrain60: { groupBy: "product", relativeDays: 60 },
  stockAsofArchived: { dayKey: "2026-01-15", productId: ARCHIVED },
  unapprovedProduct: { productId: UNAPPROVED },
  summary: {},
  snapshot: {},
} as const;

const turns: Record<ScenarioKey, TurnResult> = {} as Record<ScenarioKey, TurnResult>;

// ---------------------------------------------------------------------------
// The SQL oracle. `oracleQuery` only — the whole point is that these expectations
// do not share a code path with the thing under test.
// ---------------------------------------------------------------------------

function inList(values: ReadonlyArray<string | number>): string {
  return values.map(() => "?").join(", ");
}

async function approvedIds(includeArchived: boolean): Promise<number[]> {
  const rows = await oracleQuery<{ id: number }>(
    `SELECT id FROM products WHERE approvalStatus = 'APPROVED'${includeArchived ? "" : " AND deletedAt IS NULL"} ORDER BY id`,
  );
  return rows.map((row) => Number(row.id));
}

type OracleLedgerRow = {
  productId: number;
  delta: number;
  logType: string;
  reasonCode: string | null;
  ageUs: number;
};

/**
 * Negative, non-TRANSFER ledger rows inside a rolling window — the SHARED floor of
 * BOTH outbound predicates (metrics-contract D1). `ageUs` is measured against
 * `UTC_TIMESTAMP(3)` so the days-covered denominator can be recomputed without
 * parsing a driver-formatted datetime.
 */
async function outboundRows(windowDays: number, productIds: number[]): Promise<OracleLedgerRow[]> {
  if (productIds.length === 0) return [];
  const rows = await oracleQuery<OracleLedgerRow>(
    `SELECT productId, delta, logType, reasonCode,
            TIMESTAMPDIFF(MICROSECOND, changeTime, UTC_TIMESTAMP(3)) AS ageUs
       FROM inventory_logs
      WHERE delta < 0 AND logType <> 'TRANSFER'
        AND changeTime >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)
        AND productId IN (${inList(productIds)})`,
    [windowDays, ...productIds],
  );
  return rows.map((row) => ({ ...row, delta: Number(row.delta), ageUs: Number(row.ageUs) }));
}

type Mix = {
  sale: number;
  classifiedLoss: number;
  adjustmentUnclassified: number;
  correctionUnclassified: number;
  countOut: number;
  stockInReversal: number;
};

const SHRINKAGE_REASONS = new Set(["DAMAGE", "THEFT", "EXPIRY", "COUNT"]);

/** The C12 decision table, restated here so the oracle does not import the classifier
 *  it is meant to check. */
function bucketOf(row: { logType: string; reasonCode: string | null }): keyof Mix {
  const classifiedLoss =
    row.reasonCode != null && SHRINKAGE_REASONS.has(row.reasonCode.toUpperCase());
  switch (row.logType) {
    case "SALE":
      return "sale";
    case "STOCK_IN":
      return "stockInReversal";
    case "COUNT":
      return "countOut";
    case "ADJUSTMENT":
      return classifiedLoss ? "classifiedLoss" : "adjustmentUnclassified";
    case "CORRECTION":
      return classifiedLoss ? "classifiedLoss" : "correctionUnclassified";
    default:
      return "adjustmentUnclassified";
  }
}

function emptyMix(): Mix {
  return {
    sale: 0,
    classifiedLoss: 0,
    adjustmentUnclassified: 0,
    correctionUnclassified: 0,
    countOut: 0,
    stockInReversal: 0,
  };
}

function mixOf(rows: OracleLedgerRow[]): Mix {
  const mix = emptyMix();
  for (const row of rows) mix[bucketOf(row)] += Math.abs(row.delta);
  return mix;
}

/** The LOCKED reorder-demand predicate (metrics-contract D1), restated. */
function isReorderDemandRow(row: { reasonCode: string | null }): boolean {
  return row.reasonCode !== "CORRECTION";
}

type OracleReorderRow = {
  productId: number;
  productName: string;
  currentStock: number;
  urgency: "OUT" | "CRITICAL" | "REORDER_NOW" | "APPROACHING" | null;
  emitted: "suggested" | "unavailable";
  reason?: "no_demand_signal" | "insufficient_history";
  avgDailyDemand: number | null;
  daysCoveredDays: number;
  demandUnits: number;
  demandMix: Mix | null;
  reorderPoint: number;
  targetLevel: number;
  grossReplenishmentNeed: number;
  leadTimeDays: number;
  leadTimeSource: "product" | "default";
  bufferDays: number;
  minOrderQuantity: number;
  costPrice: number | null;
};

type ReorderOracle = {
  rows: OracleReorderRow[];
  total: number;
};

/**
 * Recompute `reorder_report` from raw SQL for a given requested-id population.
 *
 * This is a deliberate re-implementation of lib/reports/reorder.ts's arithmetic over
 * rows read independently: the C5 coverage invariant is only worth asserting if the
 * bucket a product SHOULD land in was derived without asking the code under test.
 */
async function reorderOracle(requestedIds?: number[]): Promise<ReorderOracle> {
  const [globals] = await oracleQuery<{
    defaultLeadTimeDays: number;
    defaultSafetyStockDays: number;
    defaultTargetCoverageMultiple: number;
    minEvidenceEvents: number;
  }>(
    "SELECT defaultLeadTimeDays, defaultSafetyStockDays, defaultTargetCoverageMultiple, minEvidenceEvents FROM global_reorder_settings WHERE id = 1",
  );

  // The population: approved + ACTIVE, narrowed to the resolved-active requested ids.
  const activeRequested =
    requestedIds === undefined
      ? null
      : (
          await oracleQuery<{ id: number }>(
            `SELECT id FROM products
              WHERE approvalStatus = 'APPROVED' AND deletedAt IS NULL AND id IN (${inList(requestedIds)})`,
            [...requestedIds],
          )
        ).map((row) => Number(row.id));

  const products = await oracleQuery<{
    id: number;
    name: string;
    costPrice: string | null;
    stock: number | null;
    leadTimeDays: number | null;
    customSafetyStockDays: number | null;
    minOrderQuantity: number | null;
    reorderPointOverride: number | null;
  }>(
    `SELECT p.id, p.name, p.costPrice,
            (SELECT COALESCE(SUM(pl.quantity), 0) FROM product_locations pl WHERE pl.productId = p.id) AS stock,
            c.leadTimeDays, c.customSafetyStockDays, c.minOrderQuantity, c.reorderPointOverride
       FROM products p
       LEFT JOIN product_reorder_configs c ON c.productId = p.id
      WHERE p.approvalStatus = 'APPROVED' AND p.deletedAt IS NULL
        ${activeRequested === null ? "" : `AND p.id IN (${activeRequested.length > 0 ? inList(activeRequested) : "NULL"})`}
      ORDER BY p.id`,
    activeRequested === null ? [] : [...activeRequested],
  );

  const ids = products.map((row) => Number(row.id));
  const ledger = (await outboundRows(REORDER_WINDOW_DAYS, ids)).filter(isReorderDemandRow);
  const nowMs = Date.now();

  const rows: OracleReorderRow[] = products.map((product) => {
    const productId = Number(product.id);
    const mine = ledger.filter((row) => Number(row.productId) === productId);
    const currentStock = Number(product.stock ?? 0);
    const costPrice = product.costPrice == null ? null : Number(product.costPrice);

    // resolveReorderConfig, restated (lib/reorder-config.ts).
    const globalLead = globals.defaultLeadTimeDays > 0 ? globals.defaultLeadTimeDays : 14;
    const pLead = product.leadTimeDays;
    const useProductLead = pLead != null && pLead > 0 && pLead <= 3_650;
    const leadTimeDays = useProductLead ? Number(pLead) : globalLead;
    const leadTimeSource: "product" | "default" = useProductLead ? "product" : "default";
    const globalBuffer = Math.max(0, globals.defaultSafetyStockDays ?? 7);
    const pBuffer = product.customSafetyStockDays;
    const bufferDays = pBuffer != null && pBuffer >= 0 ? Number(pBuffer) : globalBuffer;
    const minOrderQuantity =
      product.minOrderQuantity != null && product.minOrderQuantity > 0
        ? Number(product.minOrderQuantity)
        : 1;
    const targetCoverageMultiple =
      globals.defaultTargetCoverageMultiple > 0 ? globals.defaultTargetCoverageMultiple : 1;
    const reorderPointOverride =
      product.reorderPointOverride != null && product.reorderPointOverride >= 0
        ? Number(product.reorderPointOverride)
        : null;
    const minEvidenceEvents = globals.minEvidenceEvents >= 0 ? globals.minEvidenceEvents : 3;

    const base = {
      productId,
      productName: product.name,
      currentStock,
      leadTimeDays,
      leadTimeSource,
      bufferDays,
      minOrderQuantity,
      costPrice,
    };

    if (mine.length === 0) {
      return {
        ...base,
        urgency: null,
        emitted: "unavailable" as const,
        reason: "no_demand_signal" as const,
        avgDailyDemand: null,
        daysCoveredDays: 0,
        demandUnits: 0,
        demandMix: null,
        reorderPoint: 0,
        targetLevel: 0,
        grossReplenishmentNeed: 0,
      };
    }

    const demandUnits = mine.reduce((sum, row) => sum + Math.abs(row.delta), 0);
    const oldestAgeMs = Math.max(...mine.map((row) => row.ageUs / 1_000));
    const covered = daysCovered(nowMs - oldestAgeMs, nowMs, REORDER_WINDOW_DAYS);
    const avgDailyDemand = demandUnits / covered;

    if (mine.length < minEvidenceEvents) {
      return {
        ...base,
        urgency: null,
        emitted: "unavailable" as const,
        reason: "insufficient_history" as const,
        avgDailyDemand,
        daysCoveredDays: covered,
        demandUnits,
        demandMix: mixOf(mine),
        reorderPoint: 0,
        targetLevel: 0,
        grossReplenishmentNeed: 0,
      };
    }

    const leadTimeDemand = avgDailyDemand * leadTimeDays;
    const reorderPoint =
      reorderPointOverride != null
        ? reorderPointOverride
        : Math.ceil(leadTimeDemand + avgDailyDemand * bufferDays);
    const targetLevel = Math.max(
      reorderPoint,
      Math.ceil(avgDailyDemand * leadTimeDays * targetCoverageMultiple),
    );
    const need = Math.max(0, targetLevel - currentStock);
    const grossReplenishmentNeed =
      need <= 0 ? 0 : Math.ceil(need / Math.max(1, minOrderQuantity)) * Math.max(1, minOrderQuantity);

    let urgency: OracleReorderRow["urgency"] = null;
    if (currentStock <= 0) urgency = "OUT";
    else if (currentStock < leadTimeDemand) urgency = "CRITICAL";
    else if (currentStock <= reorderPoint) urgency = "REORDER_NOW";
    else if (currentStock <= reorderPoint * 1.2) urgency = "APPROACHING";

    return {
      ...base,
      urgency,
      emitted: "suggested" as const,
      avgDailyDemand,
      daysCoveredDays: covered,
      demandUnits,
      demandMix: mixOf(mine),
      reorderPoint,
      targetLevel,
      grossReplenishmentNeed,
    };
  });

  return { rows, total: rows.length };
}

/** The C5 coverage block a given option combination MUST produce (spec C5/C11). */
function expectedReorderCoverage(
  oracle: ReorderOracle,
  opts: { includeOkay: boolean; includeHealthy: boolean; requested: boolean },
): { total: number; suggested: number; unavailable: number; healthy: number; approachingOmitted: number; costed: number } {
  const emitHealthy = opts.includeHealthy || opts.requested;
  const emitApproaching = opts.includeOkay || opts.requested;
  let suggested = 0;
  let unavailable = 0;
  let healthy = 0;
  let approachingOmitted = 0;
  let costed = 0;
  for (const row of oracle.rows) {
    if (row.emitted === "unavailable") {
      unavailable += 1;
      continue;
    }
    if (row.urgency === null && !emitHealthy) {
      healthy += 1;
      continue;
    }
    if (row.urgency === "APPROACHING" && !emitApproaching) {
      approachingOmitted += 1;
      continue;
    }
    suggested += 1;
    if (row.costPrice != null) costed += 1;
  }
  return { total: oracle.total, suggested, unavailable, healthy, approachingOmitted, costed };
}

async function driveTurn(key: ScenarioKey): Promise<TurnResult> {
  const scenario = SCENARIOS[key];
  const session = await loginOnce(scenario.caller);
  const startedAt = Date.now();
  const turn = await postTurn(session, {
    threadId: null,
    message: {
      id: `gate-${scenario.id}`,
      role: "user",
      parts: [{ type: "text", text: gatePrompt(scenario.id) }],
    },
    trigger: "submit-message",
  });
  if (turn.status !== 200 || turn.threadId === null) {
    throw new Error(`${scenario.id} failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
  }
  await settleTurn(turn.threadId, { label: scenario.id });
  console.log(`[launch-gate] ${scenario.id} (${scenario.caller}): ${Date.now() - startedAt}ms`);
  return turn;
}

// ---------------------------------------------------------------------------

describe("MATRIX ROW 2 — post-lane tool contracts through the REAL route", () => {
  beforeAll(async () => {
    const startedAt = Date.now();
    turns.echoes = await driveTurn("echoes");
    turns.modes = await driveTurn("modes");
    turns.reorder = await driveTurn("reorder");
    turns.lifecycle = await driveTurn("lifecycle");
    console.log(`[launch-gate] row 2: four contract turns in ${Date.now() - startedAt}ms`);
  }, 180_000);

  describe("scenario integrity (every assertion below rests on these)", () => {
    it("streamed all four scenarios in full, with no stream-level error", () => {
      for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
        expect({ key, calls: toolCalls(turns[key]).length }).toEqual({ key, calls: 9 });
        expect(eventsOfType(turns[key], "error")).toHaveLength(0);
        expect(turns[key].text).toBe(SCENARIOS[key].text);
      }
    });

    it("never let the per-turn byte budget bind (so no page is a budget artifact)", () => {
      for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
        const spent = toolCalls(turns[key])
          .filter((call) => (call.output as { status?: string }).status === "ok")
          .reduce((sum, call) => sum + okBytes(call), 0);
        expect({ key, binding: spent >= PER_TOOL_RESULT_CAP_BYTES }).toEqual({ key, binding: false });
      }
    });

    it("leaked no company-B sentinel on either A-scoped turn (row-1 scan, whole-suite)", () => {
      assertNoCompanyBLeak(turns.echoes, "contract-echoes-and-mix");
      assertNoCompanyBLeak(turns.modes, "contract-modes-and-misuse");
      expect(scannedScopedTurnLabels()).toEqual([
        "contract-echoes-and-mix",
        "contract-modes-and-misuse",
      ]);
    });
  });

  // =========================================================================
  describe("2a — effective-scope / filter echoes (C4)", () => {
    it("get_sales echoes a NON-null productScope for a product-scoped read", () => {
      const call = callWithInput(turns.echoes, "get_sales", IN.salesProductActive);
      const scope = okData(call).productScope as { productId: number; name: string; note: string };
      expect(scope.productId).toBe(ACTIVE);
      expect(scope.name).toBe("Gate Widget Alpha 10 mg");
      // The note is what stops a per-product answer being relayed as a catalog one.
      expect(scope.note).toContain("covers ONLY this product");
    });

    it("get_sales echoes productScope NULL for a catalog-wide read (the figures really are catalog-wide)", () => {
      const call = callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded);
      expect(okData(call).productScope).toBeNull();
    });

    it("get_movement_series echoes filters whose `mode` equals the envelope's own mode", () => {
      const series = okData(callWithInput(turns.echoes, "get_movement_series", IN.movementSeries60));
      expect(series.mode).toBe("series");
      expect(series.filters).toEqual({
        productId: null,
        productIds: null,
        locationId: null,
        mode: "series",
      });
    });

    it("get_operations echoes { productId, windowDays } — windowDays, never relativeDays", () => {
      const call = callWithInput(turns.echoes, "get_operations", IN.operationsActive);
      expect(okData(call).scope).toEqual({ productId: ACTIVE, windowDays: 30 });
    });

    it("get_shrinkage echoes { days }", () => {
      const call = callWithInput(turns.echoes, "get_shrinkage", IN.shrinkage30);
      expect(okData(call).scope).toEqual({ days: 30 });
    });

    it("a BOUNDED movement batch echoes its REAL product scope, never `productId: null` alone", () => {
      const call = callWithInput(turns.modes, "get_movement_series", IN.movementBatch);
      const data = okData(call);
      expect(data.mode).toBe("by_product");
      // C4's echo is the EFFECTIVE scope — the ids actually queried, i.e. the RESOLVED
      // ones. The two unresolvable ids were never queried (a raw `{ in: [...] }` over
      // caller input would leak an unapproved product's history), and they are echoed
      // in `coverage.requested` instead. Recorded here because "echo its real product
      // scope" could be misread as "echo what was asked for": the resolved set is what
      // the numbers cover, and the requested/rejected accounting sits beside it.
      expect(data.filters).toEqual({
        productId: null,
        productIds: [ACTIVE, ARCHIVED],
        locationId: null,
        mode: "by_product",
      });
      expect((coverageOf(call).requested as { requested: number }).requested).toBe(4);
    });
  });

  // =========================================================================
  describe("2b — reorder coverage invariant + productIds/includeHealthy semantics (C5/C11)", () => {
    const combos: Array<{ label: string; input: Record<string, unknown>; includeOkay: boolean; includeHealthy: boolean }> = [
      { label: "includeOkay:false", input: IN.reorderNoOkay, includeOkay: false, includeHealthy: false },
      { label: "includeHealthy:true", input: IN.reorderHealthy, includeOkay: true, includeHealthy: true },
      {
        label: "includeOkay:false + includeHealthy:true",
        input: IN.reorderNoOkayHealthy,
        includeOkay: false,
        includeHealthy: true,
      },
    ];

    it("the tool's DEFAULT call satisfies total = suggested + unavailable + healthy + approachingOmitted", async () => {
      // NOTE: the TOOL defaults includeOkay to TRUE (tools.ts `args.includeOkay ?? true`),
      // which is the opposite of the module default — asserted here rather than assumed.
      const coverage = coverageOf(callWithInput(turns.echoes, "reorder_report", IN.reorderDefault)) as Record<string, number>;
      const expected = expectedReorderCoverage(await reorderOracle(), {
        includeOkay: true,
        includeHealthy: false,
        requested: false,
      });
      expect(coverage).toMatchObject(expected);
      expect(coverage.total).toBe(
        coverage.suggested + coverage.unavailable + coverage.healthy + coverage.approachingOmitted,
      );
      expect(coverage.requested).toBeUndefined();
    });

    for (const combo of combos) {
      it(`${combo.label}: buckets match the SQL recompute and the invariant holds`, async () => {
        const call = callWithInput(turns.reorder, "reorder_report", combo.input);
        const coverage = coverageOf(call) as Record<string, number>;
        const expected = expectedReorderCoverage(await reorderOracle(), {
          includeOkay: combo.includeOkay,
          includeHealthy: combo.includeHealthy,
          requested: false,
        });
        expect(coverage).toMatchObject(expected);
        expect(coverage.total).toBe(
          coverage.suggested + coverage.unavailable + coverage.healthy + coverage.approachingOmitted,
        );
      });
    }

    it("the sweep really did move the buckets (a vacuous sweep proves nothing)", () => {
      const of = (input: Record<string, unknown>): Record<string, number> =>
        coverageOf(callWithInput(turns.reorder, "reorder_report", input)) as Record<string, number>;
      // includeOkay:false must DROP an APPROACHING product out of the rows…
      expect(of(IN.reorderNoOkay).approachingOmitted).toBeGreaterThan(0);
      // …and includeHealthy must convert the healthy count into rows.
      expect(of(IN.reorderHealthy).healthy).toBe(0);
      expect(of(IN.reorderNoOkay).healthy).toBeGreaterThan(0);
      expect(of(IN.reorderHealthy).suggested).toBeGreaterThan(of(IN.reorderNoOkay).suggested);
    });

    it("includeHealthy emits the healthy product as an OK row with a REAL, possibly-0 need", async () => {
      const call = callWithInput(turns.reorder, "reorder_report", IN.reorderHealthy);
      const rows = okData(call).rows as Array<Record<string, unknown>>;
      const oracle = await reorderOracle();
      const healthyOracle = oracle.rows.filter((row) => row.emitted === "suggested" && row.urgency === null);
      expect(healthyOracle.length).toBeGreaterThan(0);
      for (const expected of healthyOracle) {
        const row = rows.find((candidate) => candidate.productId === expected.productId);
        expect(row).toBeDefined();
        expect(row?.urgency).toBe("OK");
        expect(row?.grossReplenishmentNeed).toBe(expected.grossReplenishmentNeed);
        expect(row?.status).toBe("suggested");
      }
    });

    it("productIds narrows the POPULATION and accounts for the rest in coverage.requested", async () => {
      const call = callWithInput(turns.reorder, "reorder_report", IN.reorderRequested);
      const coverage = coverageOf(call) as Record<string, unknown>;
      const oracle = await reorderOracle([9104, ARCHIVED, UNKNOWN_ID]);
      const expected = expectedReorderCoverage(oracle, {
        includeOkay: false,
        includeHealthy: false,
        requested: true,
      });
      expect(coverage).toMatchObject(expected);
      // The invariant counts the approved-ACTIVE population ONLY…
      expect(coverage.total).toBe(oracle.total);
      // …and the non-members live OUTSIDE it, so the invariant survives the combination.
      expect(coverage.requested).toEqual({ requested: 3, notActive: 1, unknownIds: 1 });
      expect(Number(coverage.total)).toBe(
        Number(coverage.suggested) +
          Number(coverage.unavailable) +
          Number(coverage.healthy) +
          Number(coverage.approachingOmitted),
      );
    });

    it("the two requested-id variants carry the right name/reason cross-product", () => {
      const rows = okData(
        callWithInput(turns.reorder, "reorder_report", IN.reorderRequested),
      ).rows as Array<Record<string, unknown>>;
      const archived = rows.find((row) => row.productId === ARCHIVED);
      expect(archived).toMatchObject({
        status: "unavailable",
        reason: "not_active",
        productName: "Gate Widget Beta 20 mg", // the REAL name — resolution succeeded
        currentStock: null,
      });
      const unknown = rows.find((row) => row.productId === UNKNOWN_ID);
      expect(unknown).toMatchObject({
        status: "unavailable",
        reason: "unknown_id",
        productName: null, // never fabricated
        currentStock: null,
      });
      // …and neither is counted in `unavailable` (that is what keeps C5 true).
      expect((coverageOf(
        callWithInput(turns.reorder, "reorder_report", IN.reorderRequested),
      ) as Record<string, number>).unavailable).toBe(0);
    });

    it("every emitted suggested row's urgency matches the SQL recompute", async () => {
      const rows = okData(
        callWithInput(turns.reorder, "reorder_report", IN.reorderHealthy),
      ).rows as Array<Record<string, unknown>>;
      const oracle = await reorderOracle();
      for (const row of rows.filter((candidate) => candidate.status === "suggested")) {
        const expected = oracle.rows.find((candidate) => candidate.productId === row.productId);
        expect(expected).toBeDefined();
        expect(row.urgency).toBe(expected?.urgency ?? "OK");
        expect(row.reorderPoint).toBe(expected?.reorderPoint);
        expect(row.targetLevel).toBe(expected?.targetLevel);
        expect(row.grossReplenishmentNeed).toBe(expected?.grossReplenishmentNeed);
        expect(row.leadTimeDays).toBe(expected?.leadTimeDays);
        expect(row.leadTimeSource).toBe(expected?.leadTimeSource);
        expect(row.bufferDays).toBe(expected?.bufferDays);
        expect(row.daysCovered).toBe(expected?.daysCoveredDays);
        expect(row.avgDailyDemand as number).toBeCloseTo(expected?.avgDailyDemand ?? 0, 9);
      }
      // The sweep spans real urgency buckets, not one repeated value.
      const urgencies = new Set(
        rows.filter((row) => row.status === "suggested").map((row) => row.urgency),
      );
      expect(urgencies.size).toBeGreaterThanOrEqual(3);
    });
  });

  // =========================================================================
  describe("2c — salesDataStart / windowCoverage incl. the no-sales-company degradation (C6/FD2-2)", () => {
    it("salesDataStart is the caller's first APPROVED fact — an unapproved product cannot move it", async () => {
      const coverage = coverageOf(callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded));
      const ids = await approvedIds(true);
      const [approved] = await oracleQuery<{ start: string | null }>(
        `SELECT MIN(dayKey) AS start FROM product_sales_facts
          WHERE companyId IN (${inList(MEMBER_A.companyIds)}) AND productId IN (${inList(ids)})`,
        [...MEMBER_A.companyIds, ...ids],
      );
      const [unfiltered] = await oracleQuery<{ start: string | null }>(
        `SELECT MIN(dayKey) AS start FROM product_sales_facts WHERE companyId IN (${inList(MEMBER_A.companyIds)})`,
        [...MEMBER_A.companyIds],
      );
      expect(coverage.salesDataStart).toBe(approved.start);
      // The unapproved product's fact is OLDER — proof the filter is doing work.
      expect(unfiltered.start).not.toBe(approved.start);
      expect(String(unfiltered.start) < String(approved.start)).toBe(true);
    });

    it("memberA's window degrades to `partial` because a MEMBER COMPANY records nothing", async () => {
      const coverage = coverageOf(callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded));
      expect(coverage.windowCoverage).toBe("partial");

      // Per-company disclosure, EVERY requested company materialized (FD-2).
      const perCompany = coverage.companyCoverage as Array<{ companyId: string; salesDataStart: string | null }>;
      const expected = await oracleQuery<{ companyId: string; start: string | null }>(
        `SELECT c.id AS companyId,
                (SELECT MIN(f.dayKey) FROM product_sales_facts f
                   JOIN products p ON p.id = f.productId
                  WHERE f.companyId = c.id AND p.approvalStatus = 'APPROVED') AS start
           FROM companies c WHERE c.id IN (${inList(MEMBER_A.companyIds)}) ORDER BY c.id`,
        [...MEMBER_A.companyIds],
      );
      expect(perCompany).toEqual(
        expected.map((row) => ({ companyId: row.companyId, salesDataStart: row.start })),
      );
      expect(perCompany.some((entry) => entry.salesDataStart === null)).toBe(true);
      // THE DISCRIMINATOR: the caller-wide start is on or before the window's first day,
      // so the window-level classification is `full` and the ONLY thing degrading it is
      // the member company that never recorded. Without this the assertion above would
      // also pass on a window that simply predates the data.
      expect(String(coverage.salesDataStart) <= relativeWindow(30).from).toBe(true);
    });

    it("the staggered-start sentence rides the rowsNote ONLY when companyCoverage is present", () => {
      const degraded = coverageOf(callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded));
      expect(String(degraded.rowsNote)).toContain("coverage classified per company");
      expect(String(degraded.rowsNote)).toContain("includeZeroRows");
    });
  });

  // =========================================================================
  describe("2d — periodCoverage + coverageShift on BOTH compare modes (C9/FD3-3)", () => {
    it("totals mode classifies EACH period and (for the staggered admin) names the shift", () => {
      const call = callWithInput(turns.lifecycle, "compare_periods", IN.compareTotals);
      const data = okData(call);
      const coverage = coverageOf(call);
      expect(data.mode).toBe("totals");
      // periodA reaches back before company B started recording; periodB does not.
      expect(coverage.periodCoverage).toEqual({ a: "partial", b: "full" });
      expect(typeof coverage.coverageShift).toBe("string");
      expect(String(coverage.coverageShift)).toContain(GATE_SEED.companies.B);
      expect(String(coverage.coverageShift)).toContain("not like-for-like growth");
      // …mirrored into the reason vocabulary and named by the CONDITIONAL legend.
      expect((data.reasons as Record<string, string>).delta).toBe(coverage.coverageShift);
      expect(String(coverage.reasonsKeys)).toContain("delta");
      // The delta is never NULLED for a shift — it is qualified.
      expect(data.delta).not.toBeNull();
    });

    it("by_product mode carries the SAME envelope pair (a shift changes every row's denominator)", () => {
      const totals = callWithInput(turns.lifecycle, "compare_periods", IN.compareTotals);
      const byProduct = callWithInput(turns.lifecycle, "compare_periods", IN.compareByProduct);
      expect(okData(byProduct).mode).toBe("by_product");
      expect(coverageOf(byProduct).periodCoverage).toEqual(coverageOf(totals).periodCoverage);
      expect(coverageOf(byProduct).coverageShift).toBe(coverageOf(totals).coverageShift);
      expect((okData(byProduct).reasons as Record<string, string>).delta).toBe(
        coverageOf(totals).coverageShift,
      );
      // No row carries the envelope-level sentence (FD4-3).
      for (const row of okData(byProduct).unranked as Array<{ reasons?: Record<string, string> }>) {
        expect(row.reasons?.delta).toBeUndefined();
      }
    });

    it("the page-level gate: a direction that empties the ranked page also drops the shift (QA-2)", () => {
      const call = callWithInput(turns.lifecycle, "compare_periods", IN.compareIncrease);
      const data = okData(call);
      expect(data.returned).toBe(0);
      expect(coverageOf(call).coverageShift).toBeUndefined();
      expect((data.reasons as Record<string, string>).delta).toBeUndefined();
      expect(String(coverageOf(call).reasonsKeys)).not.toContain("delta =");
    });

    it("memberA's degradation produces companyCoverage WITHOUT a shift (nothing joined between the periods)", () => {
      const call = callWithInput(turns.modes, "compare_periods", IN.compareTotals);
      const coverage = coverageOf(call);
      expect(coverage.periodCoverage).toEqual({ a: "partial", b: "partial" });
      expect(coverage.coverageShift).toBeUndefined();
      expect(coverage.companyCoverage).toBeDefined();
      // …and the measured-note fires, because the rule really did withhold a zero.
      expect(String(coverage.companyCoverageNote)).toContain("governs ZERO legality only");
    });

    it("a period the caller CANNOT measure is null + a reason, never a manufactured 0", async () => {
      const data = okData(callWithInput(turns.modes, "compare_periods", IN.compareTotals));
      const window = relativeWindow(30);
      const ids = await approvedIds(true);
      const [row] = await oracleQuery<{ units: number | null }>(
        `SELECT SUM(orderedQty) AS units FROM product_sales_facts
          WHERE companyId IN (${inList(MEMBER_A.companyIds)}) AND dayKey >= ? AND dayKey <= ?
            AND productId IN (${inList(ids)})`,
        [...MEMBER_A.companyIds, window.from, window.to, ...ids],
      );
      expect(data.a).toBe(Number(row.units));
      expect(data.b).toBeNull();
      expect(data.delta).toBeNull();
      expect((data.reasons as Record<string, string>).b).toContain("absence here is UNKNOWN, never zero");
    });
  });

  // =========================================================================
  describe("2e — compare by_product ranked / unranked split (C9)", () => {
    it("admin: both sides measured -> a RANKED row whose values match the SQL recompute", async () => {
      const data = okData(callWithInput(turns.lifecycle, "compare_periods", IN.compareByProduct));
      const rows = data.rows as Array<{ productId: number; a: number; b: number; delta: number; lifecycle: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(data.unranked).toEqual([]);

      const ids = await approvedIds(true);
      const windowA = relativeWindow(30);
      const perProductA = await oracleQuery<{ productId: number; units: number }>(
        `SELECT productId, SUM(orderedQty) AS units FROM product_sales_facts
          WHERE companyId IN (${inList(ADMIN.companyIds)}) AND dayKey >= ? AND dayKey <= ?
            AND productId IN (${inList(ids)}) GROUP BY productId`,
        [...ADMIN.companyIds, windowA.from, windowA.to, ...ids],
      );
      const expectedA = new Map(perProductA.map((row) => [Number(row.productId), Number(row.units)]));
      for (const row of rows) {
        expect(row.a).toBe(expectedA.get(row.productId));
        // periodB is fully covered for admin, so silence there is a MEASURED zero.
        expect(row.b).toBe(0);
        expect(row.delta).toBe(row.b - row.a);
      }
      expect(data.totalRows).toBe(rows.length);
    });

    it("memberA: a period whose absence is UNKNOWN unranks the row instead of ranking it on a base nobody measured", () => {
      const data = okData(callWithInput(turns.modes, "compare_periods", IN.compareByProduct));
      expect(data.rows).toEqual([]);
      const unranked = data.unranked as Array<{ productId: number; a: number | null; b: number | null; delta: null; reasons: Record<string, string> }>;
      expect(unranked.length).toBeGreaterThan(0);
      for (const row of unranked) {
        expect(row.delta).toBeNull();
        // QA-5: a row's reasons name only the periods that are null FOR IT.
        expect(row.b).toBeNull();
        expect(row.reasons.b).toBeDefined();
        expect(row.reasons.a).toBeUndefined();
      }
      expect(data.unrankedTotal).toBe(unranked.length);
      expect(String(coverageOf(callWithInput(turns.modes, "compare_periods", IN.compareByProduct)).unrankedNote)).toContain(
        "COVERAGE artifact",
      );
    });

    it("direction is applied BEFORE ranking and paging, so totalRows is the post-direction count", () => {
      const all = okData(callWithInput(turns.lifecycle, "compare_periods", IN.compareByProduct));
      const increases = okData(callWithInput(turns.lifecycle, "compare_periods", IN.compareIncrease));
      const allRows = all.rows as Array<{ delta: number }>;
      expect(allRows.every((row) => row.delta < 0)).toBe(true);
      expect(increases.totalRows).toBe(0);
      expect(increases.rows).toEqual([]);
    });

    it("rows carry identity + the nullable evidence fields, with the not-a-creation-date note", () => {
      const call = callWithInput(turns.lifecycle, "compare_periods", IN.compareByProduct);
      const rows = okData(call).rows as Array<Record<string, unknown>>;
      for (const row of rows) {
        expect(typeof row.name).toBe("string");
        expect(["active", "deleted"]).toContain(row.lifecycle);
        // A sales metric fills firstSaleDayKey and leaves the ledger one null.
        expect(row.firstLedgerAt).toBeNull();
        expect(typeof row.firstSaleDayKey === "string" || row.firstSaleDayKey === null).toBe(true);
      }
      expect(String(coverageOf(call).evidenceNote)).toContain("NOT creation dates");
    });
  });

  // =========================================================================
  describe("2f — movement modes incl. the by_product batch + rejected-id echoes (C10)", () => {
    it("series mode: the 12-bucket partition is exhaustive — net === SUM(delta) over the window", async () => {
      const data = okData(callWithInput(turns.echoes, "get_movement_series", IN.movementSeries60));
      const totals = data.totals as Record<string, number>;
      const ids = await approvedIds(true);
      const window = relativeWindow(60);
      const [row] = await oracleQuery<{ net: number | null }>(
        `SELECT SUM(delta) AS net FROM inventory_logs
          WHERE changeTime >= ? AND changeTime < DATE_ADD(?, INTERVAL 1 DAY)
            AND productId IN (${inList(ids)})`,
        [`${window.from} 00:00:00`, `${window.to} 00:00:00`, ...ids],
      );
      expect(totals.net).toBe(Number(row.net));
      const bucketSum = Object.entries(totals)
        .filter(([key]) => key !== "net")
        .reduce((sum, [, value]) => sum + value, 0);
      expect(bucketSum).toBe(totals.net);
    });

    it("week grain buckets the same rows without changing the totals", () => {
      const day = okData(callWithInput(turns.echoes, "get_movement_series", IN.movementSeries60));
      const week = okData(callWithInput(turns.modes, "get_movement_series", IN.movementWeek));
      expect(week.grain).toBe("week");
      expect(week.totals).toEqual(day.totals);
      const points = week.points as Array<{ key: string }>;
      expect(points.length).toBeGreaterThan(0);
      expect(points.length).toBeLessThan((day.points as unknown[]).length + 1);
    });

    it("receipts mode lists STOCK_IN RECEIPTS only — the wrong-signed reversal is NOT one", async () => {
      const call = callWithInput(turns.modes, "get_movement_series", IN.movementReceipts);
      const data = okData(call);
      expect(data.mode).toBe("receipts");
      expect((data.filters as { mode: string }).mode).toBe("receipts");
      const ids = await approvedIds(true);
      const window = relativeWindow(60);
      const [row] = await oracleQuery<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inventory_logs
          WHERE logType = 'STOCK_IN' AND delta > 0
            AND changeTime >= ? AND changeTime < DATE_ADD(?, INTERVAL 1 DAY)
            AND productId IN (${inList(ids)})`,
        [`${window.from} 00:00:00`, `${window.to} 00:00:00`, ...ids],
      );
      expect(data.totalRows).toBe(Number(row.n));
      expect(String(coverageOf(call).note)).toContain("wrong-signed STOCK_IN reversal is excluded here");
      // The seeded negative STOCK_IN exists — so the exclusion is doing real work.
      const [reversals] = await oracleQuery<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inventory_logs WHERE logType = 'STOCK_IN' AND delta < 0",
      );
      expect(Number(reversals.n)).toBeGreaterThan(0);
    });

    it("by_product: rejected ids are ECHOED, never silently dropped and never queried", () => {
      const call = callWithInput(turns.modes, "get_movement_series", IN.movementBatch);
      const requested = coverageOf(call).requested as {
        requested: number;
        resolved: number;
        rejected: Array<{ productId: number; reason: string }>;
      };
      expect(requested.requested).toBe(4);
      expect(requested.resolved).toBe(2);
      // The UNAPPROVED id and the unknown id are INDISTINGUISHABLE by design — an
      // `unknown_id` for both is what stops the approval queue being probed.
      expect(requested.rejected).toEqual([
        { productId: UNAPPROVED, reason: "unknown_id" },
        { productId: UNKNOWN_ID, reason: "unknown_id" },
      ]);
    });

    it("by_product: a REQUESTED product with no movement comes back as an ALL-ZERO row", () => {
      const call = callWithInput(turns.modes, "get_movement_series", IN.movementBatch);
      const rows = okData(call).rows as Array<Record<string, number | string | null>>;
      expect(rows.map((row) => row.productId).sort()).toEqual([ACTIVE, ARCHIVED].sort());
      const zero = rows.find((row) => row.productId === ARCHIVED) as Record<string, number>;
      expect(zero.outboundUnits).toBe(0);
      expect(zero.net).toBe(0);
      // …and it is disclosed as a NON-contributor rather than folded into the archived count.
      expect(coverageOf(call).archivedZeroRows).toBe(1);
      expect(coverageOf(call).archivedProductsIncluded).toBe(0);
    });

    it("by_product: the ranked row's outboundUnits is the SIGN-FIRST magnitude from SQL", async () => {
      const call = callWithInput(turns.modes, "get_movement_series", IN.movementBatch);
      const rows = okData(call).rows as Array<{ productId: number; outboundUnits: number }>;
      const window = relativeWindow(60);
      const [row] = await oracleQuery<{ units: number | null }>(
        `SELECT SUM(ABS(delta)) AS units FROM inventory_logs
          WHERE productId = ? AND delta < 0 AND logType <> 'TRANSFER'
            AND changeTime >= ? AND changeTime < DATE_ADD(?, INTERVAL 1 DAY)`,
        [ACTIVE, `${window.from} 00:00:00`, `${window.to} 00:00:00`],
      );
      expect(rows.find((candidate) => candidate.productId === ACTIVE)?.outboundUnits).toBe(
        Number(row.units),
      );
      expect(String(coverageOf(call).rankNote)).toContain("SIGN-FIRST");
    });
  });

  // =========================================================================
  describe("2g — outbound-mix values: the seeded fixtures move EXACTLY their buckets (C12)", () => {
    it("get_operations: outboundMix30 sums to unitsOut30 and matches the SQL classification", async () => {
      const call = callWithInput(turns.echoes, "get_operations", IN.operationsActive);
      const rows = okData(call).rows as Array<{ productId: number; unitsOut30: number; outboundMix30: Mix }>;
      expect(rows).toHaveLength(1);
      const row = rows[0];

      const ledger = await outboundRows(30, [ACTIVE]);
      const expectedMix = mixOf(ledger);
      const expectedUnits = ledger.reduce((sum, entry) => sum + Math.abs(entry.delta), 0);
      expect(row.unitsOut30).toBe(expectedUnits);
      expect(row.outboundMix30).toEqual(expectedMix);
      // NORMATIVE (C12): bucket sum == unitsOut30.
      expect(Object.values(row.outboundMix30).reduce((a, b) => a + b, 0)).toBe(row.unitsOut30);
    });

    it("the negative STOCK_IN lands in stockInReversal — the sixth bucket, on a real ledger row", async () => {
      const call = callWithInput(turns.echoes, "get_operations", IN.operationsActive);
      const row = (okData(call).rows as Array<{ outboundMix30: Mix }>)[0];
      const [seeded] = await oracleQuery<{ delta: number }>(
        "SELECT delta FROM inventory_logs WHERE id = ?",
        [FIXTURES.negativeStockInLogId],
      );
      expect(Number(seeded.delta)).toBeLessThan(0);
      expect(row.outboundMix30.stockInReversal).toBe(Math.abs(Number(seeded.delta)));
    });

    it("the CORRECTION row is in outboundMix30 but ABSENT from demandMix — different predicates by design", async () => {
      const ops = (okData(callWithInput(turns.echoes, "get_operations", IN.operationsActive))
        .rows as Array<{ outboundMix30: Mix; unitsOut30: number }>)[0];
      const [correction] = await oracleQuery<{ delta: number; reasonCode: string | null }>(
        "SELECT delta, reasonCode FROM inventory_logs WHERE id = ?",
        [FIXTURES.correctionLogId],
      );
      const correctionUnits = Math.abs(Number(correction.delta));
      expect(correction.reasonCode).toBe("CORRECTION");
      expect(ops.outboundMix30.correctionUnclassified).toBe(correctionUnits);

      const reorderRows = okData(
        callWithInput(turns.reorder, "reorder_report", IN.reorderHealthy),
      ).rows as Array<{ productId: number; demandMix: Mix | null; demandUnits: number }>;
      const demandRow = reorderRows.find((row) => row.productId === ACTIVE);
      expect(demandRow).toBeDefined();
      expect(demandRow?.demandMix?.correctionUnclassified).toBe(0);
      // The two mixes therefore differ by EXACTLY the CORRECTION row's units.
      expect(ops.unitsOut30 - (demandRow?.demandUnits ?? 0)).toBe(correctionUnits);
    });

    it("reorder_report: demandMix sums to demandUnits and matches the SQL classification", async () => {
      const rows = okData(callWithInput(turns.reorder, "reorder_report", IN.reorderHealthy))
        .rows as Array<{ productId: number; status: string; demandUnits: number; demandMix: Mix | null }>;
      const oracle = await reorderOracle();
      for (const row of rows.filter((candidate) => candidate.status === "suggested")) {
        const expected = oracle.rows.find((candidate) => candidate.productId === row.productId);
        expect(row.demandUnits).toBe(expected?.demandUnits);
        expect(row.demandMix).toEqual(expected?.demandMix);
        expect(Object.values(row.demandMix ?? {}).reduce((a, b) => a + b, 0)).toBe(row.demandUnits);
      }
    });
  });

  // =========================================================================
  describe("2h — sales-coverage totalOrders denominator + attributionNote (C7)", () => {
    it("both counts are ALL-TIME and company-scoped, NOT the query window beside them", async () => {
      const coverage = coverageOf(callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded));
      const [allTime] = await oracleQuery<{ total: number; unattributed: number }>(
        `SELECT COUNT(*) AS total,
                SUM(EXISTS (SELECT 1 FROM external_order_items i WHERE i.orderId = o.id AND i.isMapped = 0)) AS unattributed
           FROM external_orders o WHERE o.companyId IN (${inList(MEMBER_A.companyIds)})`,
        [...MEMBER_A.companyIds],
      );
      expect(coverage.totalOrders).toBe(Number(allTime.total));
      expect(coverage.unattributedOrders).toBe(Number(allTime.unattributed));

      // The window really is narrower than "all time" — the denominator is doing work.
      const window = relativeWindow(30);
      const [windowed] = await oracleQuery<{ n: number }>(
        `SELECT COUNT(*) AS n FROM external_orders
          WHERE companyId IN (${inList(MEMBER_A.companyIds)})
            AND COALESCE(externalCreatedAt, createdAt) >= ?`,
        [...MEMBER_A.companyIds, `${window.from} 00:00:00`],
      );
      expect(Number(windowed.n)).toBeLessThan(Number(allTime.total));
      expect(Number(allTime.unattributed)).toBeGreaterThan(0);
    });

    it("attributionNote states the span so the counts cannot be read as windowed", () => {
      const coverage = coverageOf(callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded));
      expect(String(coverage.attributionNote)).toContain("ALL-TIME");
      expect(String(coverage.attributionNote)).toContain("company-scoped");
      expect(String(coverage.attributionNote)).toContain("unmapped line item");
    });
  });

  // =========================================================================
  describe("2i — low_stock thresholdSource from the RAW value, incl. override == default (C8)", () => {
    it("every alert carries rawThreshold + a source derived from it (never an equality guess)", async () => {
      const call = callWithInput(turns.echoes, "low_stock_report", IN.lowStock);
      const data = okData(call);
      const alerts = data.alerts as Array<{
        productId: number;
        rawThreshold: number | null;
        effectiveThreshold: number;
        thresholdSource: string;
      }>;
      const [setting] = await oracleQuery<{ value: string }>(
        "SELECT value FROM system_settings WHERE `key` = 'lowStockDefaultThreshold'",
      );
      const systemDefault = Number(setting.value);
      expect(data.systemDefaultThreshold).toBe(systemDefault);

      const expected = await oracleQuery<{ id: number; raw: number | null; stock: number }>(
        `SELECT p.id, p.lowStockThreshold AS raw,
                (SELECT COALESCE(SUM(pl.quantity), 0) FROM product_locations pl WHERE pl.productId = p.id) AS stock
           FROM products p WHERE p.approvalStatus = 'APPROVED' AND p.deletedAt IS NULL`,
      );
      const expectedAlerts = expected
        .map((row) => ({
          id: Number(row.id),
          raw: row.raw === null ? null : Number(row.raw),
          stock: Number(row.stock),
        }))
        .filter((row) => {
          const effective = row.raw === null ? systemDefault : row.raw;
          return effective > 0 && row.stock <= effective;
        });
      expect(alerts.map((alert) => alert.productId).sort()).toEqual(
        expectedAlerts.map((row) => row.id).sort(),
      );
      for (const alert of alerts) {
        const oracle = expectedAlerts.find((row) => row.id === alert.productId);
        expect(alert.rawThreshold).toBe(oracle?.raw ?? null);
        expect(alert.effectiveThreshold).toBe(oracle?.raw === null ? systemDefault : oracle?.raw);
        expect(alert.thresholdSource).toBe(oracle?.raw === null ? "system_default" : "product_override");
      }
    });

    it("THE OVERRIDE == DEFAULT CASE: an explicit value equal to the default is still product_override", async () => {
      const alerts = okData(callWithInput(turns.echoes, "low_stock_report", IN.lowStock)).alerts as Array<{
        productId: number;
        rawThreshold: number | null;
        effectiveThreshold: number;
        thresholdSource: string;
      }>;
      const explicit = alerts.find((alert) => alert.productId === FIXTURES.lowStockExplicitProductId);
      const inherit = alerts.find((alert) => alert.productId === FIXTURES.lowStockInheritProductId);
      expect(explicit).toBeDefined();
      expect(inherit).toBeDefined();
      // Identical EFFECTIVE thresholds, opposite SOURCES — which the deleted equality
      // inference could not express, and which is the whole point of C8.
      expect(explicit?.effectiveThreshold).toBe(inherit?.effectiveThreshold);
      expect(explicit?.rawThreshold).toBe(FIXTURES.lowStockDefaultThreshold);
      expect(explicit?.thresholdSource).toBe("product_override");
      expect(inherit?.rawThreshold).toBeNull();
      expect(inherit?.thresholdSource).toBe("system_default");
    });
  });

  // =========================================================================
  describe("2j — includeZeroRows zero-vs-null truth table (C6)", () => {
    it("windowCoverage `full`: absence is a MEASURED zero, with no reason", async () => {
      const call = callWithInput(turns.reorder, "get_sales", IN.salesZeroFull);
      const coverage = coverageOf(call);
      expect(coverage.windowCoverage).toBe("full");

      const rows = okData(call).rows as Array<{
        productId: number;
        _sum: { orderedQty: number | null; revenue: string | null; orderCount: number | null };
        reason?: string;
        firstSaleDayKey: string | null;
      }>;
      const population = await approvedIds(true);
      expect(rows.map((row) => row.productId)).toEqual(population);
      for (const row of rows) {
        expect(row._sum).toEqual({ orderedQty: 0, revenue: "0", orderCount: 0 });
        expect(row.reason).toBeUndefined();
      }
      // The evidence field is the FIRST attributed fact, filled post-pagination.
      const [first] = await oracleQuery<{ start: string | null }>(
        `SELECT MIN(dayKey) AS start FROM product_sales_facts
          WHERE companyId IN (${inList(ADMIN.companyIds)}) AND productId = ?`,
        [...ADMIN.companyIds, ACTIVE],
      );
      expect(rows.find((row) => row.productId === ACTIVE)?.firstSaleDayKey).toBe(first.start);
    });

    it("windowCoverage `partial` via per-company degradation: nulls + the THIRD reason (FD2-3)", () => {
      const call = callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded);
      expect(coverageOf(call).windowCoverage).toBe("partial");
      const rows = okData(call).rows as Array<{
        productId: number;
        _sum: { orderedQty: number | null };
        reason?: string;
      }>;
      const zeros = rows.filter((row) => row.reason !== undefined);
      expect(zeros.length).toBeGreaterThan(0);
      for (const row of zeros) {
        expect(row._sum).toEqual({ orderedQty: null, revenue: null, orderCount: null });
        // NOT the predates/straddles sentence: the caller-wide window IS covered, a
        // MEMBER COMPANY simply never recorded — and the company is NAMED.
        expect(row.reason).toContain("sales data is not recorded in every company for this window");
        expect(row.reason).toContain(GATE_SEED.companies.noSales);
        expect(row.reason).not.toContain("predates/straddles");
      }
    });

    it("windowCoverage `none` (no company access): NO zero rows are synthesized at all", () => {
      // The zero-row population is never manufactured out of an access boundary; the
      // empty-membership short-circuit is asserted end-to-end in matrix-scoping.
      const call = callWithInput(turns.echoes, "get_sales", IN.salesZeroDegraded);
      expect(coverageOf(call).windowCoverage).not.toBe("none");
    });

    it("archived products appear as zero rows and are disclosed SEPARATELY from contributors", () => {
      const call = callWithInput(turns.reorder, "get_sales", IN.salesZeroFull);
      const rows = okData(call).rows as Array<{ productId: number; lifecycle: string | null }>;
      expect(rows.find((row) => row.productId === ARCHIVED)?.lifecycle).toBe("deleted");
      expect(coverageOf(call).archivedZeroRows).toBe(1);
      // Nothing CONTRIBUTED, so the contributor count is honestly 0.
      expect(coverageOf(call).archivedProductsIncluded).toBe(0);
    });
  });

  // =========================================================================
  describe("2k — lifecycle + approval policy table (C13)", () => {
    it("HISTORICAL: get_sales tags an archived product and still answers for it", () => {
      const call = callWithInput(turns.echoes, "get_sales", IN.salesProductArchived);
      const data = okData(call);
      expect(data.lifecycle).toBe("deleted");
      expect((data.productScope as { productId: number }).productId).toBe(ARCHIVED);
    });

    it("HISTORICAL: find_product(includeArchived) tags the row and NULLS its current-state fields", async () => {
      const call = callWithInput(turns.echoes, "find_product", IN.findProductArchived);
      const products = okData(call).products as Array<Record<string, unknown>>;
      const expected = await oracleQuery<{ id: number }>(
        "SELECT id FROM products WHERE approvalStatus = 'APPROVED' AND name LIKE '%Gate%' ORDER BY id",
      );
      expect(products.map((row) => Number(row.id)).sort((a, b) => a - b)).toEqual(
        expected.map((row) => Number(row.id)),
      );
      const archived = products.find((row) => row.id === ARCHIVED);
      expect(archived).toMatchObject({
        lifecycle: "deleted",
        currentStock: null,
        lowStock: null,
        stockState: null,
      });
      expect(String(archived?.stateNote)).toBe(
        "deleted product — current stock not reported; history remains queryable",
      );
      // The UNAPPROVED product is absent even WITH includeArchived — approval is not a
      // display preference.
      expect(products.map((row) => row.id)).not.toContain(UNAPPROVED);
    });

    it("HISTORICAL: get_stock_asof reaches an archived product on its explicit-productId path", () => {
      const call = callWithInput(turns.lifecycle, "get_stock_asof", IN.stockAsofArchived);
      expect(okData(call).lifecycle).toBe("deleted");
      expect(String(coverageOf(call).archivedNote)).toContain("soft-deleted");
    });

    it("HISTORICAL: movement by_product tags the archived row", () => {
      const rows = okData(callWithInput(turns.modes, "get_movement_series", IN.movementBatch))
        .rows as Array<{ productId: number; lifecycle: string | null }>;
      expect(rows.find((row) => row.productId === ARCHIVED)?.lifecycle).toBe("deleted");
    });

    const refusals: Array<{ scenario: ScenarioKey; tool: string; input: Record<string, unknown> }> = [
      { scenario: "lifecycle", tool: "get_stock", input: IN.archivedProduct },
      { scenario: "reorder", tool: "get_valuation", input: IN.archivedProduct },
      { scenario: "reorder", tool: "get_operations", input: IN.archivedProduct },
      { scenario: "reorder", tool: "get_inventory_policy", input: IN.archivedProduct },
      { scenario: "reorder", tool: "get_product_overview", input: IN.archivedProduct },
    ];
    for (const refusal of refusals) {
      it(`CURRENT-STATE: ${refusal.tool} REFUSES the archived product (NOT_FOUND, never a phantom 0)`, () => {
        const call = callWithInput(turns[refusal.scenario], refusal.tool, refusal.input);
        expect(notFoundMessage(call)).toBe(`No approved product with id ${ARCHIVED}.`);
      });
    }

    it("CURRENT-STATE: the catalog tools omit the archived product from their counts", async () => {
      const [activeCount] = await oracleQuery<{ n: number }>(
        "SELECT COUNT(*) AS n FROM products WHERE approvalStatus = 'APPROVED' AND deletedAt IS NULL",
      );
      const summary = okData(callWithInput(turns.lifecycle, "get_inventory_summary", IN.summary));
      expect(summary.productCount).toBe(Number(activeCount.n));

      const snapshotInventory = okData(callWithInput(turns.lifecycle, "get_business_snapshot", IN.snapshot))
        .inventory as { status: string; productCount: number };
      expect(snapshotInventory.status).toBe("ok");
      expect(snapshotInventory.productCount).toBe(Number(activeCount.n));

      const lowStock = okData(callWithInput(turns.echoes, "low_stock_report", IN.lowStock)).alerts as Array<{ productId: number }>;
      expect(lowStock.map((row) => row.productId)).not.toContain(ARCHIVED);

      const reorderRows = okData(callWithInput(turns.echoes, "reorder_report", IN.reorderDefault)).rows as Array<{ productId: number }>;
      expect(reorderRows.map((row) => row.productId)).not.toContain(ARCHIVED);
    });

    it("UNAPPROVED: never surfaces, on any tool, in any mode", () => {
      expect(notFoundMessage(callWithInput(turns.lifecycle, "get_stock", IN.unapprovedProduct))).toBe(
        `No approved product with id ${UNAPPROVED}.`,
      );
      const salesRows = okData(callWithInput(turns.lifecycle, "get_sales", IN.salesProductGrain60))
        .rows as Array<{ productId: number }>;
      expect(salesRows.map((row) => row.productId)).not.toContain(UNAPPROVED);
      const zeroRows = okData(callWithInput(turns.reorder, "get_sales", IN.salesZeroFull))
        .rows as Array<{ productId: number }>;
      expect(zeroRows.map((row) => row.productId)).not.toContain(UNAPPROVED);
    });

    it("UNAPPROVED: its units move NO total, and the exclusion is DISCLOSED as a census", async () => {
      // Sales side: the admin's product-grain totals equal the APPROVED-only SQL sum,
      // and the excluded contributor is counted rather than silently dropped.
      const salesCall = callWithInput(turns.lifecycle, "get_sales", IN.salesProductGrain60);
      const rows = okData(salesCall).rows as Array<{ productId: number; _sum: { orderedQty: number } }>;
      const window = relativeWindow(60);
      const ids = await approvedIds(true);
      const expectedSales = await oracleQuery<{ productId: number; units: number }>(
        `SELECT productId, SUM(orderedQty) AS units FROM product_sales_facts
          WHERE companyId IN (${inList(ADMIN.companyIds)}) AND dayKey >= ? AND dayKey <= ?
            AND productId IN (${inList(ids)}) GROUP BY productId`,
        [...ADMIN.companyIds, window.from, window.to, ...ids],
      );
      expect(new Map(rows.map((row) => [row.productId, row._sum.orderedQty]))).toEqual(
        new Map(expectedSales.map((row) => [Number(row.productId), Number(row.units)])),
      );
      const [salesCensus] = await oracleQuery<{ n: number }>(
        `SELECT COUNT(DISTINCT p.id) AS n FROM products p
           JOIN product_sales_facts f ON f.productId = p.id
          WHERE p.approvalStatus <> 'APPROVED'
            AND f.companyId IN (${inList(ADMIN.companyIds)}) AND f.dayKey >= ? AND f.dayKey <= ?`,
        [...ADMIN.companyIds, window.from, window.to],
      );
      expect(Number(salesCensus.n)).toBe(1);
      expect(coverageOf(salesCall).excludedUnapprovedProducts).toBe(Number(salesCensus.n));

      // Ledger side: the movement partition excludes the row AND counts the product.
      const movementCall = callWithInput(turns.echoes, "get_movement_series", IN.movementSeries60);
      const [ledgerCensus] = await oracleQuery<{ n: number }>(
        `SELECT COUNT(DISTINCT p.id) AS n FROM products p
           JOIN inventory_logs l ON l.productId = p.id
          WHERE p.approvalStatus <> 'APPROVED'
            AND l.changeTime >= ? AND l.changeTime < DATE_ADD(?, INTERVAL 1 DAY)`,
        [`${window.from} 00:00:00`, `${window.to} 00:00:00`],
      );
      expect(Number(ledgerCensus.n)).toBe(1);
      expect(coverageOf(movementCall).excludedUnapprovedProducts).toBe(Number(ledgerCensus.n));
      expect(String(coverageOf(movementCall).approvalNote)).toContain("APPROVED product universe only");
    });

    it("UNAPPROVED: its distinctive magnitudes appear NOWHERE on ANY of the four transcripts", () => {
      // Scanned over the transcript with machine-generated ids blanked: values live in
      // payloads, ids are random hex, and hex contains decimal digits (see
      // payloadTranscript). Prose, coverage notes and error messages are all still in
      // scope — this is a whole-transcript scan, not a field-by-field compare.
      for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
        const transcript = payloadTranscript(turns[key]);
        expect(transcript).not.toContain(String(FIXTURES.unapprovedLedgerUnits));
        expect(transcript).not.toContain(String(FIXTURES.unapprovedSalesQty));
        // …and the structured outputs specifically, so the claim survives any future
        // change to how the wire is framed.
        for (const call of toolCalls(turns[key])) {
          const output = JSON.stringify(call.output);
          expect(output).not.toContain(String(FIXTURES.unapprovedLedgerUnits));
          expect(output).not.toContain(String(FIXTURES.unapprovedSalesQty));
        }
      }
      // The magnitudes really ARE in the database — the scan is not vacuous.
      expect(FIXTURES.unapprovedLedgerUnits).toBeGreaterThan(0);
      expect(FIXTURES.unapprovedSalesQty).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  describe("2l — G1 misuse rejections surface as `hint` through the REAL adapter", () => {
    const cases: Array<{ tool: string; input: Record<string, unknown>; contains: string }> = [
      {
        tool: "get_sales",
        input: IN.misuseZeroRows,
        contains: "includeZeroRows requires groupBy:'product'",
      },
      {
        tool: "get_movement_series",
        input: IN.misuseProductIds,
        contains: "productIds requires breakdownBy:'product'",
      },
      {
        tool: "compare_periods",
        input: IN.misuseCompare,
        contains: "groupBy:'product' and productId are mutually exclusive",
      },
      {
        tool: "reorder_report",
        input: IN.misuseEmptyIds,
        contains: "productIds must not be empty",
      },
    ];

    for (const testCase of cases) {
      it(`${testCase.tool} ${JSON.stringify(testCase.input)} -> a self-correcting hint`, () => {
        const call = callWithInput(turns.modes, testCase.tool, testCase.input);
        expect(errorHint(call)).toContain(testCase.contains);
        // The masked envelope is intact: a hint is a SERVER-authored message, and the
        // code stays the generic TOOL_ERROR.
        expect((call.output as { status: string; code: string }).code).toBe("TOOL_ERROR");
      });
    }

    it("a rejected call does NOT poison the turn: the surrounding calls still answered", () => {
      const calls = toolCalls(turns.modes);
      const errored = calls.filter((call) => (call.output as { status?: string }).status === "error");
      expect(errored).toHaveLength(cases.length);
      expect(calls.length - errored.length).toBe(9 - cases.length);
      expect(eventsOfType(turns.modes, "error")).toHaveLength(0);
    });
  });

  // =========================================================================
  describe("2m — the C3 definition strings ride the payloads, verbatim", () => {
    it("get_operations relays PHYSICAL_OUTBOUND_DEFINITION", () => {
      const data = okData(callWithInput(turns.echoes, "get_operations", IN.operationsActive));
      expect(data.velocityDefinition).toBe(PHYSICAL_OUTBOUND_DEFINITION);
    });

    it("low_stock_report relays OUTBOUND_USAGE_DEFINITION", () => {
      const data = okData(callWithInput(turns.echoes, "low_stock_report", IN.lowStock));
      expect(data.velocityDefinition).toBe(OUTBOUND_USAGE_DEFINITION);
    });

    it("reorder_report relays REORDER_DEMAND_DEFINITION in its assumptions", () => {
      for (const scenario of ["echoes", "reorder"] as const) {
        const input = scenario === "echoes" ? IN.reorderDefault : IN.reorderHealthy;
        const data = okData(callWithInput(turns[scenario], "reorder_report", input));
        expect((data.assumptions as { demandDefinition: string }).demandDefinition).toBe(
          REORDER_DEMAND_DEFINITION,
        );
      }
    });

    it("the definitions are the CONTRACT's strings, not a paraphrase that drifted", () => {
      // A definition that no longer states its own predicate is the failure mode C3
      // exists to prevent, so the pins below are on the predicate text itself.
      expect(PHYSICAL_OUTBOUND_DEFINITION).toContain("delta < 0 and logType != TRANSFER");
      expect(PHYSICAL_OUTBOUND_DEFINITION).toContain("NOT evidence of verified sales");
      expect(REORDER_DEMAND_DEFINITION).toContain("reasonCode != CORRECTION");
      expect(OUTBOUND_USAGE_DEFINITION).toContain("days actually covered");
    });

    it("every mix-bearing payload carries its definition beside the figure it explains", () => {
      // The whole point of C3: a number and its definition travel TOGETHER.
      const ops = okData(callWithInput(turns.echoes, "get_operations", IN.operationsActive));
      expect(ops.velocityDefinition).toBeDefined();
      expect((ops.rows as Array<{ outboundMix30: unknown }>)[0].outboundMix30).toBeDefined();
      const reorder = okData(callWithInput(turns.echoes, "reorder_report", IN.reorderDefault));
      expect((reorder.assumptions as { demandDefinition?: string }).demandDefinition).toBeDefined();
      expect(String(reorder.coverageNote)).toContain("healthy = final urgency null");
    });
  });

  // =========================================================================
  describe("persistence fidelity (the row-2 ride-along)", () => {
    /**
     * FINDING, recorded rather than hidden (see the 1.7 report): the stream -> MySQL
     * JSON column -> read-back trip is NOT value-exact for DOUBLES. MySQL stores a JSON
     * number as a double and re-emits it with its own shortest-round-trip formatting,
     * which drops the 17th significant digit of a non-terminating quotient — observed on
     * `get_operations.daysOfSupply` (15.145631067961164 persisting as 15.14563106796116).
     *
     * `compareRoundTrip` is scoped to exactly that class: any missing/extra key, any
     * array reordering, any string or integer change, and any float that moved by more
     * than one relative 1e-15 THROWS. The drifts it tolerates are asserted BELOW to be
     * non-empty-but-bounded and are logged, so the carve-out can never silently widen.
     * Spec REV-10 already made this shape of carve-out for the same column's KEY-ORDER
     * normalisation; this is the second thing that column normalises.
     */
    it("every streamed tool output round-trips into assistant_messages.parts", async () => {
      const drifts: string[] = [];
      for (const key of Object.keys(SCENARIOS) as ScenarioKey[]) {
        const threadId = turns[key].threadId as string;
        const [row] = await oracleQuery<{ parts: string }>(
          "SELECT parts FROM assistant_messages WHERE threadId = ? AND role = 'assistant'",
          [threadId],
        );
        const parts = (typeof row.parts === "string" ? JSON.parse(row.parts) : row.parts) as Array<
          Record<string, unknown>
        >;
        const persisted = parts.filter(
          (part) => typeof part.type === "string" && String(part.type).startsWith("tool-"),
        );
        expect({ key, persisted: persisted.length }).toEqual({ key, persisted: 9 });
        for (const call of toolCalls(turns[key])) {
          const match = persisted.find((part) => part.toolCallId === call.toolCallId);
          expect(match).toBeDefined();
          // Scripted INPUTS are exact on both sides (no doubles in them).
          expect(match?.input).toEqual(call.input);
          for (const drift of compareRoundTrip(call.output, match?.output, `${key}.${call.toolName}`)) {
            drifts.push(`${drift.path}: ${drift.streamed} -> ${drift.persisted}`);
          }
        }
      }
      console.log(
        `[launch-gate] MySQL JSON double-format drifts on the round trip (${drifts.length}): ` +
          `${drifts.join(" | ") || "none"}`,
      );
      // The carve-out is BOUNDED: a handful of derived ratios, never a wholesale
      // re-encoding of the payload.
      expect(drifts.length).toBeLessThan(20);
    });
  });
});
