/**
 * launch-gate/matrix-reconciliation.test.ts — THE R-C RIDE-ALONG (reconciliation lane
 * spec D9 / §4.5; contract pack C5.3; seam S17).
 *
 * THE CLAIM `get_order_reconciliation` makes is a split one, and it is the only tool on
 * this surface that makes it: the BATCH population is GLOBAL — the physical pool, which
 * every caller may see in full — while the ORDER FIELDS inside those batches are
 * MEMBER-SCOPED. A tool that got half of it right would look correct from either side
 * alone: hide the batches and it reads as a normal company-scoped tool; show the orders
 * and it reads as a normal global one. So the gate drives the REAL route as three
 * different people against ONE database holding two companies' orders, and reads every
 * byte that comes back.
 *
 * TWO SCENARIOS, AND ONLY ONE OF THEM IS LEAK-SCANNED [OCk-1]. `assertNoCompanyBLeak`
 * greps the company-B sentinels over `turn.raw`, which is every byte the server sent —
 * INCLUDING the tool-call ARGUMENTS the shim scripted. The order-filter scenario passes
 * company B's order number AS an argument, so scanning that transcript would trip on the
 * caller's own question rather than on anything the tool disclosed. That scenario is
 * therefore asserted on the EXTRACTED TOOL RESULT only (`okData`) — and `payloadTranscript`
 * is not a way around it either: it blanks generated ids, not arguments (assertions.ts:180).
 *
 * WHAT THE SEED GIVES US (seed.ts, the reconciliation block): two SALE batches on two
 * DEDICATED products, `gate-recon-a` stamped with company A's order and `gate-recon-b`
 * with company B's, neither carrying an audit row — so both derive R3
 * (`attributed·derived`, "stamped by an unrecorded path"), the shape years of pre-lane
 * history will take. Every figure below is RECOMPUTED from those rows with raw SQL.
 */

import { describe, expect, it, beforeAll } from "@jest/globals";
import { CHOREOGRAPHY_DIR, gatePrompt, loadChoreographies } from "./choreography";
import { loginOnce, postTurn, type TurnResult } from "./driver";
import { oracleQuery } from "./oracle";
import { GATE_SEED } from "./seed";
import {
  assertNoCompanyBLeak,
  callWithInput,
  canonicalJson,
  coverageOf,
  eventsOfType,
  okData,
  scannedScopedTurnLabels,
  settleTurn,
  toolCalls,
  type ToolCallResult,
} from "./assertions";

const NO_FILTER_SCENARIO = "scope-reconciliation";
const FILTER_SCENARIO = "scope-reconciliation-orderfilter";

const BATCH_A = GATE_SEED.fixtures.reconciliationBatchIds.a;
const BATCH_B = GATE_SEED.fixtures.reconciliationBatchIds.b;

/** The B ORDER NUMBER sentinel — the same value the filter scenario scripts. */
const B_ORDER_NUMBER = GATE_SEED.sentinels.companyB[2];

/**
 * The scripted inputs, VERBATIM from the two choreography files. `callWithInput` matches
 * a call by its WHOLE input, so these are the addressing scheme (the matrix-scoping.test
 * idiom) — and the loader assertion below proves the JSON really carries them, so a
 * scenario edit that orphaned a test fails loudly instead of silently.
 */
const NO_FILTER_INPUT = { relativeDays: 30 } as const;
const FILTER_INPUT = { relativeDays: 30, orderNumber: B_ORDER_NUMBER } as const;

/** The producer's redaction reason, verbatim on the wire (spec D9). */
const REDACTED_REASON = "order belongs to a company you are not a member of";

/** The coverage sentence a member gets for a number outside their companies (D9). */
const NO_MEMBER_ORDER_NOTE = "no order matching that number in your companies";

/** Both seeded batches derive R3 — no attempt row, no audit event. */
const DERIVED_CLASS = "attributed·derived";
const DERIVED_SENTENCE = "stamped by an unrecorded path";

type Caller = "memberA" | "zeroUser" | "admin";
type Scenario = typeof NO_FILTER_SCENARIO | typeof FILTER_SCENARIO;

/**
 * Short per-scenario slugs for the uploaded message id. The C2 envelope caps
 * `message.id` at 40 characters (`userMessageSchema`, thread-contracts.ts:90), and
 * "gate-recon-scope-reconciliation-orderfilter-memberA" is 50 — a 400 before the turn
 * ever reaches a tool.
 */
const SLUG: Record<Scenario, string> = {
  [NO_FILTER_SCENARIO]: "nofilter",
  [FILTER_SCENARIO]: "filter",
};

/** One reconciliation row as the TOOL shapes it (spec §4.5) — no actor, no free text. */
type ReconRow = {
  batchId: string;
  at: string;
  source: string;
  logTypes: string[];
  units: number;
  productCount: number;
  class: string;
  ruleId?: string;
  sentence: string;
  order: Record<string, unknown> | null;
};

const turns: Record<string, TurnResult> = {};

const keyOf = (scenario: Scenario, caller: Caller): string => `${scenario}:${caller}`;

async function driveTurn(scenario: Scenario, caller: Caller): Promise<TurnResult> {
  const session = await loginOnce(caller);
  const turn = await postTurn(session, {
    threadId: null,
    message: {
      id: `gate-recon-${SLUG[scenario]}-${caller}`,
      role: "user",
      parts: [{ type: "text", text: gatePrompt(scenario) }],
    },
    trigger: "submit-message",
  });
  if (turn.status !== 200 || turn.threadId === null) {
    throw new Error(
      `R1 ride-along turn ${scenario}/${caller} failed (${turn.status}): ${turn.raw.slice(0, 2_000)}`,
    );
  }
  // THE SETTLE BARRIER before any DB read taken off this turn.
  await settleTurn(turn.threadId, { label: `the ${caller} ${scenario} turn` });
  return turn;
}

/** The ONE reconciliation call of a turn, addressed by its whole scripted input. */
function reconCall(scenario: Scenario, caller: Caller): ToolCallResult {
  const input = scenario === FILTER_SCENARIO ? FILTER_INPUT : NO_FILTER_INPUT;
  return callWithInput(turns[keyOf(scenario, caller)], "get_order_reconciliation", { ...input });
}

function reconRows(scenario: Scenario, caller: Caller): ReconRow[] {
  return okData(reconCall(scenario, caller)).rows as ReconRow[];
}

function rowFor(rows: ReconRow[], batchId: string): ReconRow {
  const row = rows.find((candidate) => candidate.batchId === batchId);
  if (row === undefined) {
    throw new Error(
      `batch ${batchId} is absent from the reconciliation page (batches seen: ${JSON.stringify(
        rows.map((candidate) => candidate.batchId),
      )}) — the batch population is supposed to be GLOBAL`,
    );
  }
  return row;
}

/** Units / product count / the ONE stamp of a seeded batch, straight from the ledger. */
async function batchOracle(
  batchId: string,
): Promise<{ units: number; productCount: number; stamps: number; stamp: string }> {
  const [row] = await oracleQuery<{
    units: number;
    productCount: number;
    stamps: number;
    stamp: string;
  }>(
    `SELECT CAST(SUM(-delta) AS SIGNED) AS units,
            COUNT(DISTINCT productId) AS productCount,
            COUNT(DISTINCT orderRecordId) AS stamps,
            MIN(orderRecordId) AS stamp
       FROM inventory_logs WHERE batchId = ?`,
    [batchId],
  );
  return {
    units: Number(row.units),
    productCount: Number(row.productCount),
    stamps: Number(row.stamps),
    stamp: row.stamp,
  };
}

/** The order projection D6 allows, recomputed — never read back through prisma. */
async function orderOracle(orderRecordId: string): Promise<{
  companyId: string;
  projection: Record<string, unknown>;
}> {
  const [row] = await oracleQuery<{
    id: string;
    orderNumber: string;
    internalStatus: string;
    companyId: string;
    externalCreatedAt: string | null;
    platform: string;
  }>(
    `SELECT o.id, o.orderNumber, o.internalStatus, o.companyId, o.externalCreatedAt,
            i.platform
       FROM external_orders o JOIN integrations i ON i.id = o.integrationId
      WHERE o.id = ?`,
    [orderRecordId],
  );
  return {
    companyId: row.companyId,
    projection: {
      id: row.id,
      orderNumber: row.orderNumber,
      internalStatus: row.internalStatus,
      platform: row.platform,
      // `dateStrings: true` on the oracle connection (oracle.ts:96): a DATETIME(3) comes
      // back as the stored UTC wall clock, which is exactly what the producer serialized.
      externalCreatedAt:
        row.externalCreatedAt === null
          ? null
          : new Date(`${row.externalCreatedAt.replace(" ", "T")}Z`).toISOString(),
    },
  };
}

// TOP-LEVEL on purpose: all three describes read the same four turns, and a hook parked
// inside the first one would make the other two depend on jest's describe ORDER.
beforeAll(async () => {
  const startedAt = Date.now();
  // SERIAL, like row 1: concurrent turns interleave in the app log and in the in-process
  // limiter's bookkeeping for no gain (this project is maxWorkers 1).
  turns[keyOf(NO_FILTER_SCENARIO, "memberA")] = await driveTurn(NO_FILTER_SCENARIO, "memberA");
  turns[keyOf(NO_FILTER_SCENARIO, "zeroUser")] = await driveTurn(NO_FILTER_SCENARIO, "zeroUser");
  turns[keyOf(FILTER_SCENARIO, "memberA")] = await driveTurn(FILTER_SCENARIO, "memberA");
  turns[keyOf(FILTER_SCENARIO, "admin")] = await driveTurn(FILTER_SCENARIO, "admin");
  console.log(`[launch-gate] R1 ride-along: four turns in ${Date.now() - startedAt}ms`);
});

describe("RIDE-ALONG R1 — get_order_reconciliation: member-only order fields over GLOBAL batches", () => {
  it("the committed scenarios script exactly the inputs these assertions address", () => {
    const scenarios = loadChoreographies(CHOREOGRAPHY_DIR);
    const noFilter = scenarios.get(NO_FILTER_SCENARIO);
    const filtered = scenarios.get(FILTER_SCENARIO);
    expect(noFilter?.steps[0].toolCalls).toEqual([
      { name: "get_order_reconciliation", input: { ...NO_FILTER_INPUT } },
    ]);
    // The JSON cannot import the seed, so the B sentinel is a literal there — this is
    // what proves the literal is still the seeded one.
    expect(filtered?.steps[0].toolCalls).toEqual([
      { name: "get_order_reconciliation", input: { ...FILTER_INPUT } },
    ]);
  });

  it("streamed the whole scenario for both no-filter callers (1 call, no error events)", () => {
    for (const caller of ["memberA", "zeroUser"] as const) {
      const turn = turns[keyOf(NO_FILTER_SCENARIO, caller)];
      expect({ caller, calls: toolCalls(turn).length }).toEqual({ caller, calls: 1 });
      expect(eventsOfType(turn, "error")).toHaveLength(0);
      expect(turn.text).toBe("Reconciliation surfaces read.");
    }
  });

  it("memberA sees BOTH batches — the population is the physical pool, not its companies", async () => {
    const rows = reconRows(NO_FILTER_SCENARIO, "memberA");
    expect(rows.map((row) => row.batchId).sort()).toEqual([BATCH_A, BATCH_B].sort());

    for (const batchId of [BATCH_A, BATCH_B]) {
      const oracle = await batchOracle(batchId);
      const row = rowFor(rows, batchId);
      expect({ units: row.units, productCount: row.productCount }).toEqual({
        units: oracle.units,
        productCount: oracle.productCount,
      });
      expect(row.logTypes).toEqual(["SALE"]);
      // Neither seeded batch has an attempt row or an audit event, so both take the
      // derivation's terminal stamped branch — labelled as derived, never dressed up as
      // one of the recorded evidence classes.
      expect(row.source).toBe("derived");
      expect(row.class).toBe(DERIVED_CLASS);
      expect(row.ruleId).toBe("R3");
      expect(row.sentence).toBe(DERIVED_SENTENCE);
    }
  });

  it("…and exactly ONE of them carries order fields: A's own, field for field", async () => {
    const rows = reconRows(NO_FILTER_SCENARIO, "memberA");
    const aStamp = (await batchOracle(BATCH_A)).stamp;
    const a = await orderOracle(aStamp);
    // The fixture is only meaningful if the two orders really belong to different
    // companies, and only one of them to the caller.
    expect(GATE_SEED.actors.memberA.companyIds).toContain(a.companyId);
    expect(rowFor(rows, BATCH_A).order).toEqual(a.projection);
  });

  it("…while company B's order is REDACTED with a reason, never omitted and never blank", async () => {
    const rows = reconRows(NO_FILTER_SCENARIO, "memberA");
    const bStamp = (await batchOracle(BATCH_B)).stamp;
    const b = await orderOracle(bStamp);
    expect(GATE_SEED.actors.memberA.companyIds).not.toContain(b.companyId);
    expect(rowFor(rows, BATCH_B).order).toEqual({
      orderRedacted: true,
      reason: REDACTED_REASON,
    });
  });

  it("the result declares MIXED scope and states BOTH scoping sentences in coverage", () => {
    const call = reconCall(NO_FILTER_SCENARIO, "memberA");
    expect((call.output as { meta: { scope: string } }).meta.scope).toBe("mixed");
    const coverage = coverageOf(call);
    expect(coverage.batchScope).toBe("global — the physical pool, no actor identity");
    expect(coverage.orderFieldScope).toBe("your companies only");
    expect(coverage.orderFilterScope).toBe("your companies only");
    // The bounds this page did not show, said out loud rather than implied by the count.
    expect(typeof coverage.moreCount).toBe("number");
    expect(typeof coverage.exclusionsNote).toBe("string");
  });

  it("no row carries an actor: a member learns WHAT moved, never WHO moved it (D9)", () => {
    for (const row of reconRows(NO_FILTER_SCENARIO, "memberA")) {
      expect(row).not.toHaveProperty("actor");
    }
  });

  it("THE LEAK SCAN: no company-B sentinel anywhere in the memberA transcript", () => {
    assertNoCompanyBLeak(turns[keyOf(NO_FILTER_SCENARIO, "memberA")], "memberA reconciliation turn");
  });
});

describe("RIDE-ALONG R1 — get_order_reconciliation: the orderNumber filter is member-scoped", () => {
  // NO `assertNoCompanyBLeak` AND NO `payloadTranscript` IN THIS BLOCK [CX-9]. The
  // scripted argument IS company B's order number, so both would fail on the caller's own
  // question. What must be clean is the RESULT, and that is what is asserted.

  it("memberA + B's number: ZERO rows and the coverage sentence that says why", () => {
    const call = reconCall(FILTER_SCENARIO, "memberA");
    const data = okData(call);
    expect(data.rows).toEqual([]);
    expect((data.totals as { attributable: number }).attributable).toBe(0);
    expect(coverageOf(call).notes).toContain(NO_MEMBER_ORDER_NOTE);
  });

  it("…and the extracted result carries NO company-B value at all (never a redacted row)", () => {
    // The leak claim, made where it is legitimate to make it: over the canonical JSON of
    // the tool RESULT rather than the transcript that also carries the argument.
    const payload = canonicalJson(okData(reconCall(FILTER_SCENARIO, "memberA")));
    for (const sentinel of GATE_SEED.sentinels.companyB) {
      expect(payload).not.toContain(sentinel);
    }
  });

  it("POSITIVE CONTROL: a caller who IS a member of B gets B's batch and its order", async () => {
    const rows = reconRows(FILTER_SCENARIO, "admin");
    expect(GATE_SEED.actors.admin.companyIds).toContain(GATE_SEED.companies.B);
    expect(rows.map((row) => row.batchId)).toEqual([BATCH_B]);

    const bStamp = (await batchOracle(BATCH_B)).stamp;
    const b = await orderOracle(bStamp);
    expect(rowFor(rows, BATCH_B).order).toEqual(b.projection);
    // Without this the negative assertion above would pass on a filter that matches
    // nothing for anybody.
    expect(canonicalJson(okData(reconCall(FILTER_SCENARIO, "admin")))).toContain(B_ORDER_NUMBER);
  });

  it("streamed the filter scenario for both callers (1 call, no error events)", () => {
    for (const caller of ["memberA", "admin"] as const) {
      const turn = turns[keyOf(FILTER_SCENARIO, caller)];
      expect({ caller, calls: toolCalls(turn).length }).toEqual({ caller, calls: 1 });
      expect(eventsOfType(turn, "error")).toHaveLength(0);
      expect(turn.text).toBe("Reconciliation order filter read.");
    }
  });
});

describe("RIDE-ALONG R1 — get_order_reconciliation: zeroUser sees every batch and no order", () => {
  it("both batches are present for a caller with NO company access", async () => {
    const rows = reconRows(NO_FILTER_SCENARIO, "zeroUser");
    expect(rows.map((row) => row.batchId).sort()).toEqual([BATCH_A, BATCH_B].sort());
    for (const batchId of [BATCH_A, BATCH_B]) {
      const oracle = await batchOracle(batchId);
      expect(rowFor(rows, batchId).units).toBe(oracle.units);
    }
  });

  it("…and EVERY order is redacted with a reason — the hard-isolation half of the split", () => {
    for (const row of reconRows(NO_FILTER_SCENARIO, "zeroUser")) {
      expect(row.order).toEqual({ orderRedacted: true, reason: REDACTED_REASON });
    }
  });

  it("zeroUser's payload is byte-comparable to memberA's EXCEPT the order fields", () => {
    const strip = (caller: Caller): string =>
      canonicalJson(
        reconRows(NO_FILTER_SCENARIO, caller).map(({ order: _order, ...rest }) => rest),
      );
    // The GLOBAL half must not vary by caller (a difference there would be a bug in the
    // other direction), while the order half must — which the two blocks above assert.
    expect(strip("zeroUser")).toBe(strip("memberA"));
  });

  it("THE LEAK SCAN: no company-B sentinel in the zeroUser transcript either", () => {
    assertNoCompanyBLeak(
      turns[keyOf(NO_FILTER_SCENARIO, "zeroUser")],
      "zeroUser reconciliation turn",
    );
    // Both no-filter turns were scanned, and ONLY those two — the filter turns carry B's
    // number as an argument and are asserted on their extracted results instead.
    expect(scannedScopedTurnLabels()).toEqual([
      "memberA reconciliation turn",
      "zeroUser reconciliation turn",
    ]);
  });
});
