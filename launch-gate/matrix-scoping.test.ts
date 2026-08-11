/**
 * launch-gate/matrix-scoping.test.ts — ASSERTION MATRIX ROW 1: membership scoping
 * (plan Task 1.7; spec C7 row 1).
 *
 * THE CLAIM: the assistant's company scope is the platform trust boundary, and the
 * only honest way to test a boundary is to put two companies' data in one database,
 * drive the REAL route as three different people, and look at every byte that comes
 * back.
 *
 * ONE SCENARIO, THREE CALLERS. All three turns replay `scope-all-surfaces`, so the
 * comparison is exact: the GLOBAL sections must be byte-comparable across callers
 * (inventory has no company dimension — a difference there would be a bug in the
 * other direction), while every company-scoped section must differ exactly as the
 * memberships differ.
 *
 * THE GLOBAL CALLS RUN FIRST, deliberately. The route threads a MUTABLE per-turn byte
 * budget through the tools, so a global tool called AFTER a caller-dependent one could
 * page differently for different callers and the "identical" claim would be about the
 * budget, not the scope. Running them in step 1 removes the variable; the budget
 * assertion below proves the budget never bound at all.
 *
 * THE LEAK SCAN is a raw-transcript grep for the banded company-B sentinels over
 * EVERY A-scoped turn, with a POSITIVE CONTROL on the admin turn — a negative scan
 * that cannot fail is not evidence.
 */

import { describe, expect, it, beforeAll } from "@jest/globals";
import { gatePrompt } from "./choreography";
import { loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_SEED } from "./seed";
import {
  assertCompanyBSentinelPresent,
  assertNoCompanyBLeak,
  callWithInput,
  canonicalJson,
  coverageOf,
  eventsOfType,
  okBytes,
  okData,
  relativeWindow,
  scannedScopedTurnLabels,
  settleTurn,
  toolCalls,
} from "./assertions";

const SCENARIO = "scope-all-surfaces";
const MEMBER_A = GATE_SEED.actors.memberA;
const ADMIN = GATE_SEED.actors.admin;
const ZERO_USER = GATE_SEED.actors.zeroUser;

/** The three global tools whose results must not vary by caller (spec C7 row 1). */
const GLOBAL_CALLS: Array<{ tool: string; input: Record<string, unknown> }> = [
  { tool: "get_stock", input: { productId: GATE_SEED.fixtures.approvedActiveProductId } },
  { tool: "get_valuation", input: { groupBy: "total" } },
  { tool: "get_inventory_summary", input: {} },
];

/** The route's per-turn budget. Every result of a turn must fit inside the per-tool
 *  cap's worth of it, or a later tool would page against a smaller budget and the
 *  cross-caller comparisons would be measuring the budget. */
const PER_TOOL_RESULT_CAP_BYTES = 65_536;

/**
 * The scripted inputs, VERBATIM from `scope-all-surfaces.json`. `callWithInput` matches
 * a call by its WHOLE input, so these constants are the addressing scheme — and keeping
 * them beside the assertions makes a choreography edit that silently orphans a test fail
 * loudly instead.
 */
const IN = {
  stock: { productId: GATE_SEED.fixtures.approvedActiveProductId },
  valuation: { groupBy: "total" },
  summary: {},
  salesByCompany: { groupBy: "company", relativeDays: 60 },
  salesByDay: { groupBy: "day", relativeDays: 60 },
  orderPipeline: { relativeDays: 60, groupBy: "status" },
  freshness: {},
  compare: {
    metric: "sales_units",
    periodA: { relativeDays: 30 },
    periodB: { relativeDays: 5 },
  },
  snapshot: {},
} as const;

type Caller = "memberA" | "zeroUser" | "admin";

const turns: Record<Caller, TurnResult> = {} as Record<Caller, TurnResult>;

/** Approved product ids as the SQL oracle sees them (archived INCLUDED — get_sales is
 *  a historical read, spec C13). Never prisma. */
async function approvedIds(includeArchived: boolean): Promise<number[]> {
  const rows = await oracleQuery<{ id: number }>(
    `SELECT id FROM products WHERE approvalStatus = 'APPROVED'${includeArchived ? "" : " AND deletedAt IS NULL"}`,
  );
  return rows.map((row) => Number(row.id));
}

function inList(values: ReadonlyArray<string | number>): string {
  return values.map(() => "?").join(", ");
}

/** SUM(orderedQty) per company over a day-key window, approved products only. */
async function salesUnitsByCompany(
  companyIds: readonly string[],
  window: { from: string; to: string },
): Promise<Map<string, number>> {
  if (companyIds.length === 0) return new Map();
  const ids = await approvedIds(true);
  const rows = await oracleQuery<{ companyId: string; units: number }>(
    `SELECT companyId, SUM(orderedQty) AS units FROM product_sales_facts
      WHERE companyId IN (${inList(companyIds)})
        AND dayKey >= ? AND dayKey <= ?
        AND productId IN (${inList(ids)})
      GROUP BY companyId`,
    [...companyIds, window.from, window.to, ...ids],
  );
  return new Map(rows.map((row) => [row.companyId, Number(row.units)]));
}

/** The C7 order-coverage pair, caller-scoped and ALL-TIME (never windowed). */
async function orderCounts(
  companyIds: readonly string[],
): Promise<{ totalOrders: number; unattributedOrders: number }> {
  if (companyIds.length === 0) return { totalOrders: 0, unattributedOrders: 0 };
  const [rows] = await Promise.all([
    oracleQuery<{ total: number; unattributed: number }>(
      `SELECT
         COUNT(*) AS total,
         SUM(EXISTS (SELECT 1 FROM external_order_items i WHERE i.orderId = o.id AND i.isMapped = 0)) AS unattributed
       FROM external_orders o WHERE o.companyId IN (${inList(companyIds)})`,
      [...companyIds],
    ),
  ]);
  return {
    totalOrders: Number(rows[0].total),
    unattributedOrders: Number(rows[0].unattributed ?? 0),
  };
}

async function driveScopeTurn(caller: Caller): Promise<TurnResult> {
  const session = await loginOnce(caller);
  const turn = await postTurn(session, {
    threadId: null,
    message: {
      id: `gate-scope-${caller}`,
      role: "user",
      parts: [{ type: "text", text: gatePrompt(SCENARIO) }],
    },
    trigger: "submit-message",
  });
  if (turn.status !== 200 || turn.threadId === null) {
    throw new Error(`row-1 turn for ${caller} failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`);
  }
  // THE SETTLE BARRIER (pack REV-8) before any DB read taken off this turn.
  await settleTurn(turn.threadId, { label: `the ${caller} scope turn` });
  return turn;
}

describe("MATRIX ROW 1 — membership scoping through the REAL route", () => {
  beforeAll(async () => {
    const startedAt = Date.now();
    // SERIAL on purpose: three concurrent turns would interleave in the app's logs and
    // in the in-process rate limiter's bookkeeping for no gain (the suite is maxWorkers 1).
    turns.memberA = await driveScopeTurn("memberA");
    turns.zeroUser = await driveScopeTurn("zeroUser");
    turns.admin = await driveScopeTurn("admin");
    console.log(`[launch-gate] row 1: three scope turns in ${Date.now() - startedAt}ms`);
  });

  describe("the leak scan (spec C7 row 1: ZERO B-sentinel leakage)", () => {
    it("finds NO company-B sentinel in any A-scoped transcript", () => {
      assertNoCompanyBLeak(turns.memberA, "memberA scope turn");
      assertNoCompanyBLeak(turns.zeroUser, "zeroUser scope turn");
      expect(scannedScopedTurnLabels()).toEqual([
        "memberA scope turn",
        "zeroUser scope turn",
      ]);
    });

    it("POSITIVE CONTROL: the admin transcript DOES carry a company-B sentinel", () => {
      // Without this the scan above would pass on a route that returned nothing at all.
      // The company-grain sales row is where a B sentinel survives verbatim (a
      // product-grain row would sum A and B into a value that matches no literal).
      assertCompanyBSentinelPresent(
        turns.admin,
        GATE_SEED.sentinels.companyB[0],
        "admin scope turn",
      );
    });

    it("streamed the whole scenario for every caller (9 calls, no error events)", () => {
      for (const caller of ["memberA", "zeroUser", "admin"] as const) {
        const calls = toolCalls(turns[caller]);
        expect({ caller, calls: calls.length }).toEqual({ caller, calls: 9 });
        expect(eventsOfType(turns[caller], "error")).toHaveLength(0);
        expect(turns[caller].text).toBe("Scope surfaces read.");
      }
    });

    it("never let the per-turn byte budget bind (so every page is the same page)", () => {
      for (const caller of ["memberA", "zeroUser", "admin"] as const) {
        const spent = toolCalls(turns[caller])
          .filter((call) => (call.output as { status?: string }).status === "ok")
          .reduce((sum, call) => sum + okBytes(call), 0);
        // Under the per-tool cap => byteBudget(ctx) is the cap for EVERY call in the
        // turn, so pagination cannot vary with call order or with caller.
        expect({ caller, binding: spent >= PER_TOOL_RESULT_CAP_BYTES }).toEqual({
          caller,
          binding: false,
        });
      }
    });
  });

  describe("memberA sees ONLY its own companies in every company-scoped tool", () => {
    it("get_sales(company grain) names A and noSales — never B", async () => {
      const call = callWithInput(turns.memberA, "get_sales", IN.salesByCompany);
      const data = okData(call);
      const rows = data.rows as Array<{ companyId: string; name: string | null; _sum: { orderedQty: number } }>;
      for (const row of rows) {
        expect(MEMBER_A.companyIds).toContain(row.companyId);
      }

      // Oracle: recompute the caller's per-company units from raw SQL.
      const expected = await salesUnitsByCompany(MEMBER_A.companyIds, relativeWindow(60));
      expect(new Map(rows.map((row) => [row.companyId, row._sum.orderedQty]))).toEqual(expected);
      // The no-sales company contributes no ROW at all (it has no facts) — which is
      // exactly why its degradation has to be disclosed in coverage instead.
      expect(rows.map((row) => row.companyId)).not.toContain(GATE_SEED.companies.noSales);
    });

    it("get_sales(day grain) carries the A sentinel verbatim and no B value", async () => {
      const call = callWithInput(turns.memberA, "get_sales", IN.salesByDay);
      const rows = okData(call).rows as Array<{ dayKey: string; _sum: { orderedQty: number } }>;
      const window = relativeWindow(60);
      const expected = await oracleQuery<{ dayKey: string; units: number }>(
        `SELECT f.dayKey, SUM(f.orderedQty) AS units FROM product_sales_facts f
           JOIN products p ON p.id = f.productId
          WHERE f.companyId IN (${inList(MEMBER_A.companyIds)})
            AND f.dayKey >= ? AND f.dayKey <= ?
            AND p.approvalStatus = 'APPROVED'
          GROUP BY f.dayKey ORDER BY f.dayKey`,
        [...MEMBER_A.companyIds, window.from, window.to],
      );
      expect(rows.map((row) => [row.dayKey, row._sum.orderedQty])).toEqual(
        expected.map((row) => [row.dayKey, Number(row.units)]),
      );
      // The seeded A sentinel really is on the wire (the scan's other half).
      expect(turns.memberA.raw).toContain(GATE_SEED.sentinels.companyA[0]);
    });

    it("get_order_pipeline counts only the caller's orders", async () => {
      const call = callWithInput(turns.memberA, "get_order_pipeline", IN.orderPipeline);
      const data = okData(call);
      const orders = data.orders as Array<{ orderCount: number }>;
      const streamed = orders.reduce((sum, row) => sum + row.orderCount, 0);
      const window = relativeWindow(60);
      const [row] = await oracleQuery<{ n: number }>(
        `SELECT COUNT(*) AS n FROM external_orders
          WHERE companyId IN (${inList(MEMBER_A.companyIds)})
            AND COALESCE(externalCreatedAt, createdAt) >= ?
            AND COALESCE(externalCreatedAt, createdAt) < DATE_ADD(?, INTERVAL 1 DAY)`,
        [...MEMBER_A.companyIds, `${window.from} 00:00:00`, `${window.to} 00:00:00`],
      );
      expect(streamed).toBe(Number(row.n));
    });

    it("compare_periods' SALES metric is company-scoped, and says so", async () => {
      const call = callWithInput(turns.memberA, "compare_periods", IN.compare);
      const data = okData(call);
      expect(data.mode).toBe("totals");
      expect(coverageOf(call).metricScopes).toEqual({ sales: "company", ledger: "global" });

      const window = relativeWindow(30);
      const ids = await approvedIds(true);
      const [row] = await oracleQuery<{ units: number | null }>(
        `SELECT SUM(orderedQty) AS units FROM product_sales_facts
          WHERE companyId IN (${inList(MEMBER_A.companyIds)})
            AND dayKey >= ? AND dayKey <= ?
            AND productId IN (${inList(ids)})`,
        [...MEMBER_A.companyIds, window.from, window.to, ...ids],
      );
      expect(data.a).toBe(row.units === null ? null : Number(row.units));
    });

    it("get_business_snapshot's SALES section is caller-scoped while inventory is global", () => {
      const memberSnapshot = okData(callWithInput(turns.memberA, "get_business_snapshot", IN.snapshot));
      const adminSnapshot = okData(callWithInput(turns.admin, "get_business_snapshot", IN.snapshot));
      // The company-scoped halves MUST differ (admin can see company B's orders/sales).
      expect(canonicalJson(memberSnapshot.sales)).not.toBe(canonicalJson(adminSnapshot.sales));
      expect(canonicalJson(memberSnapshot.orderPipeline)).not.toBe(
        canonicalJson(adminSnapshot.orderPipeline),
      );
      // The global halves must NOT.
      expect(canonicalJson(memberSnapshot.inventory)).toBe(canonicalJson(adminSnapshot.inventory));
      expect(canonicalJson(memberSnapshot.reorderNow)).toBe(canonicalJson(adminSnapshot.reorderNow));
    });
  });

  describe("admin sees exactly A + B (memberships-only, even for an admin)", () => {
    it("get_sales(company grain) names exactly the admin's two companies", async () => {
      const call = callWithInput(turns.admin, "get_sales", IN.salesByCompany);
      const rows = okData(call).rows as Array<{ companyId: string; _sum: { orderedQty: number } }>;
      const expected = await salesUnitsByCompany(ADMIN.companyIds, relativeWindow(60));
      expect(new Map(rows.map((row) => [row.companyId, row._sum.orderedQty]))).toEqual(expected);
      expect(rows.map((row) => row.companyId).sort()).toEqual([...ADMIN.companyIds].sort());
      // isAdmin is NOT a scope: the no-sales company memberA holds is absent here.
      expect(rows.map((row) => row.companyId)).not.toContain(GATE_SEED.companies.noSales);
    });

    it("carries strictly MORE sales than memberA over the same window", () => {
      const unitsOf = (turn: TurnResult): number =>
        (okData(callWithInput(turn, "get_sales", IN.salesByCompany)).rows as Array<{
          _sum: { orderedQty: number };
        }>).reduce((sum, row) => sum + row._sum.orderedQty, 0);
      expect(unitsOf(turns.admin)).toBeGreaterThan(unitsOf(turns.memberA));
    });
  });

  describe("zeroUser gets the hard-isolation short-circuit", () => {
    it("get_sales returns the empty-membership shape with a stated reason", () => {
      const call = callWithInput(turns.zeroUser, "get_sales", IN.salesByCompany);
      const data = okData(call);
      expect(data.rows).toEqual([]);
      expect(data.totalRows).toBe(0);
      expect(data.nextOffset).toBeNull();
      expect(data.note).toBe("You have no company access, so there are no sales to report.");

      const coverage = coverageOf(call);
      expect(coverage.unattributedOrders).toBe(0);
      expect(coverage.totalOrders).toBe(0);
      expect(coverage.salesDataStart).toBeNull();
      // No companies => no attributed sales data at all => nothing is measurable.
      expect(coverage.windowCoverage).toBe("none");
      // Structural 0s, not a query: nothing was excluded because nothing was in scope.
      expect(coverage.excludedUnapprovedProducts).toBe(0);
      expect(coverage.archivedProductsIncluded).toBe(0);
    });

    it("get_order_pipeline returns an empty aggregate rather than another caller's", () => {
      const data = okData(callWithInput(turns.zeroUser, "get_order_pipeline", IN.orderPipeline));
      expect(data.orders).toEqual([]);
      expect(data.items).toEqual([]);
    });

    it("compare_periods' sales metric is null-with-a-reason, never a manufactured 0", () => {
      const call = callWithInput(turns.zeroUser, "compare_periods", IN.compare);
      const data = okData(call);
      expect(data.a).toBeNull();
      expect(data.b).toBeNull();
      expect(data.delta).toBeNull();
      expect((data.reasons as Record<string, string>).a).toBe("no sales_units data recorded");
    });

    it("get_data_freshness zeroes only its ORDER-derived fields", () => {
      const data = okData(callWithInput(turns.zeroUser, "get_data_freshness", IN.freshness));
      expect((data.sales as { unattributedOrders: number }).unattributedOrders).toBe(0);
      expect((data.dataStarts as { ordersFirstSeen: string | null }).ordersFirstSeen).toBeNull();
      expect(coverageOf(callWithInput(turns.zeroUser, "get_data_freshness", IN.freshness)).sectionScopes).toEqual({
        rebuild: "global",
        sales: "company",
        fulfillmentSync: "global",
        dataStarts: "mixed",
        snapshots: "global",
      });
    });
  });

  describe("global sections are IDENTICAL across callers", () => {
    for (const { tool, input } of GLOBAL_CALLS) {
      it(`${tool} returns byte-comparable results for memberA, zeroUser and admin`, () => {
        const member = callWithInput(turns.memberA, tool, input);
        const zero = callWithInput(turns.zeroUser, tool, input);
        const admin = callWithInput(turns.admin, tool, input);
        expect(canonicalJson(zero.output)).toBe(canonicalJson(member.output));
        expect(canonicalJson(admin.output)).toBe(canonicalJson(member.output));
        // …and the scope label says why that is CORRECT rather than a leak.
        expect((member.output as { meta: { scope: string } }).meta.scope).toBe("global");
      });
    }
  });

  describe("coverage counts are caller-scoped", () => {
    const cases: Array<{ caller: Caller; companyIds: readonly string[] }> = [
      { caller: "memberA", companyIds: MEMBER_A.companyIds },
      { caller: "zeroUser", companyIds: ZERO_USER.companyIds },
      { caller: "admin", companyIds: ADMIN.companyIds },
    ];
    for (const { caller, companyIds } of cases) {
      it(`${caller}: unattributedOrders/totalOrders match a raw-SQL recount of its own companies`, async () => {
        const coverage = coverageOf(callWithInput(turns[caller], "get_sales", IN.salesByCompany));
        expect({
          totalOrders: coverage.totalOrders,
          unattributedOrders: coverage.unattributedOrders,
        }).toEqual(await orderCounts(companyIds));
      });
    }

    it("the three callers do NOT share one denominator (the counts really are scoped)", () => {
      const totalsOf = (caller: Caller): unknown =>
        coverageOf(callWithInput(turns[caller], "get_sales", IN.salesByCompany)).totalOrders;
      expect(totalsOf("admin")).not.toBe(totalsOf("memberA"));
      expect(totalsOf("memberA")).not.toBe(totalsOf("zeroUser"));
    });

    it("salesDataStart is measured over the CALLER's companies", async () => {
      const memberStart = coverageOf(
        callWithInput(turns.memberA, "get_sales", IN.salesByCompany),
      ).salesDataStart;
      const ids = await approvedIds(true);
      const [row] = await oracleQuery<{ start: string | null }>(
        `SELECT MIN(dayKey) AS start FROM product_sales_facts
          WHERE companyId IN (${inList(MEMBER_A.companyIds)}) AND productId IN (${inList(ids)})`,
        [...MEMBER_A.companyIds, ...ids],
      );
      expect(memberStart).toBe(row.start);
    });
  });
});
