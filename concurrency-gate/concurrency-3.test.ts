/**
 * concurrency-gate/concurrency-3.test.ts — THE MANUAL-ATTRIBUTION RACE (plan
 * P-5; spec REV-7 D4; pack C6.1 + C6.2 scenarios 8 and 8b).
 *
 * `concurrency.test.ts` proves what the booking primitive does to itself and
 * `concurrency-2.test.ts` proves what it does to a second actor. This file is
 * about a different write entirely: two admins looking at the SAME unattributed
 * outbound batch on the Attribution tab, each certain they know which order it
 * belongs to, each pressing Attribute.
 *
 * Exactly one of them may win, and — this is the part no mocked-tx suite can
 * answer — the loser must be told THE TRUTH: not "conflict", not "reason
 * required" for a change it never saw, but `BATCH_MOVED` naming the id the batch
 * now carries, so the page can refresh to something real. That guarantee is made
 * of three things that only exist in a database: the `SELECT ... FOR UPDATE` on
 * the batch's population rows, the guarded `updateMany` whose count must equal
 * what was locked, and the fact that a locking read sees the LATEST committed
 * row rather than the reader's own snapshot.
 *
 * THE ROUTE IS WHAT RUNS (pack C6.2, plan P-5 REV-3). The stale guard's envelope
 * is a route contract — the refusal classes are assembled into their 409 shape
 * there, not in the core — so driving `attributeBatch` directly would prove the
 * ladder and nothing about what an admin's browser receives. The REAL handler is
 * imported and called, with the REAL `apiHandler`, the REAL Prisma singleton,
 * the REAL attempt writer and the REAL `recordChange`; only `requireAdmin`,
 * `requireCSRF` and the rate-limit counter are mocked, because this harness has
 * no cookies, no session and no HTTP server (the `concurrency-2.test.ts`
 * preamble, copied).
 *
 * THE RENDEZVOUS IS A TRIGGER (pack C6.2 [CX-12]). The route exposes no
 * `duringRecord` hook — the booking primitive's per-record callback has no
 * counterpart here, and inventing one would be changing app code to make a test
 * pass. So the hold point is put in the DATABASE instead: a throwaway `BEFORE
 * INSERT` trigger on `order_attribution_attempts` that sleeps when it sees this
 * fixture's batch id. The winner reaches its attempt insert and stops there,
 * holding every lock it took; the loser blocks on the `FOR UPDATE` — which
 * InnoDB itself reports, and which this file waits for rather than guesses at.
 * The trigger is dropped in `finally`, on every path.
 *
 * THE SINGLETON'S URL. `@/lib/prisma` reads `DATABASE_URL` when it constructs,
 * so `beforeAll` sets it from the harness state and calls `jest.resetModules()`
 * BEFORE the first import that can reach it — which is why every `@/lib/...` and
 * `@/app/...` import in this file is dynamic and the static imports are types
 * only. The session's schema is then PROVEN (`SELECT DATABASE()`) before a
 * single write.
 */

import type { PrismaClient } from "@prisma/client";
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";
import { openClient } from "./clients";
import {
  GATE_ADMIN_ID,
  GATE_EXT_ORDER_2_ID,
  GATE_EXT_ORDER_ID,
  installReconAuditEvent,
  LOCATION_MAIN,
  P_RECON_A,
  P_RECON_B,
  RECON_ADJUST_BATCH_ID,
  RECON_BATCH_ID,
  RECON_COUNT_BATCH_ID,
  RECON_LEDGER_IDS,
  RECON_POSITIVE_BATCH_ID,
  RECON_SALE_A_ID,
  RECON_STOCK_IN_BATCH_ID,
  removeReconAuditEvent,
  resetGateFixtures,
  SEED_LINE_IDS,
  SEED_PRODUCT_IDS,
} from "./seed";
import { GATE_DB_NAME, gateDatabaseUrl } from "./state";

/** The session `requireAdmin` would have returned. The gate seeds no password —
 *  it never authenticates — so the guard is the ONE thing that has to be faked. */
const mockAdminSession = {
  id: GATE_ADMIN_ID,
  email: "gate-admin@concurrency.invalid",
  name: "Gate Admin",
  isAdmin: true,
  isApproved: true,
  defaultLocationId: LOCATION_MAIN,
};

// ONLY the three things a route needs from an HTTP request that this harness
// cannot produce. `apiHandler`, the Prisma singleton, the retry envelope, the
// attribution core, the attempt writer and `recordChange` all stay REAL — they
// are the parts under test.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(async () => ({ user: mockAdminSession })),
  requireCSRF: jest.fn(async () => undefined),
}));

jest.mock("@/lib/rateLimit", () => ({
  ...jest.requireActual("@/lib/rateLimit"),
  // The real counter is a per-process in-memory map, and this file makes more
  // than 30 attribution calls in a row; the limit is not what is under test.
  enforceRateLimit: jest.fn(() => ({})),
}));

// --------------------------------------------------------------------------
// The dynamically-loaded production modules
// --------------------------------------------------------------------------

type AttributionRouteModule = {
  POST: (request: NextRequest, ctx: { params: { batchId: string } }) => Promise<Response>;
};

let population: typeof import("@/lib/reconciliation/population");
let attributionRoute: AttributionRouteModule;
let singleton: PrismaClient;

/**
 * The `Prisma` namespace from THE SAME module registry the lane modules were
 * loaded into — dynamic, like everything else here, and for a sharper reason
 * than the singleton's URL.
 *
 * `Prisma.sql` splices a NESTED fragment by testing `instanceof Sql`. This
 * file's `beforeAll` calls `jest.resetModules()`, so a STATIC `@prisma/client`
 * import would hand it a different `Sql` class than `population.ts` got — and a
 * fragment from the other registry fails that test, is treated as an ordinary
 * bound VALUE, and renders as `WHERE '<serialised object>'`. MySQL answers that
 * with zero rows and no error, which is the most expensive kind of green: a
 * parity test that passes because BOTH sides found nothing. MEASURED here.
 */
let prismaNs: typeof import("@prisma/client").Prisma;

// --------------------------------------------------------------------------
// Driving the route
// --------------------------------------------------------------------------

type AttributeBody = {
  orderRecordId: string;
  expectPreviousOrderRecordId: string | null;
  reason?: string;
};

type RouteAnswer = { status: number; body: Record<string, unknown> };

/** The real handler, called the way Next calls it: a `NextRequest` carrying the
 *  JSON body, and the `{ params }` context the route's own `RouteParams`
 *  interface declares. */
async function attribute(batchId: string, body: AttributeBody): Promise<RouteAnswer> {
  const request = new NextRequest(
    `http://concurrency-gate.invalid/api/reconciliation/attribution/${batchId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const response = await attributionRoute.POST(request, { params: { batchId } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The whole seeded fixture, between every ordering and every sub-case (pack
 *  C6.2). The reconciliation family is not IN a scope — the reset owns it by id
 *  (C6.1) — so the scope named here is simply the rest of the gate's fixture,
 *  put back the way `concurrency-2.test.ts`'s `afterAll` puts it back. */
async function resetAll(): Promise<void> {
  await resetGateFixtures({ lineIds: SEED_LINE_IDS, productIds: SEED_PRODUCT_IDS });
}

// --------------------------------------------------------------------------
// The oracles — mysql2 raw, no Prisma, no lane code (the `oracles.ts` doctrine)
// --------------------------------------------------------------------------

async function withRaw<T>(fn: (conn: mysql.Connection) => Promise<T>): Promise<T> {
  const connection = await mysql.createConnection({
    uri: gateDatabaseUrl(),
    multipleStatements: false,
  });
  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

async function rawRows<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withRaw(async (conn) => {
    const [rows] = await conn.query(sql, params);
    return rows as T[];
  });
}

/** mysql2 hands JSON columns back parsed on some server/driver combinations and
 *  as text on others. One coercion at the boundary. */
function json(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string"
    ? (JSON.parse(value) as Record<string, unknown>)
    : (value as Record<string, unknown>);
}

type StampGroup = { orderRecordId: string | null; n: number };

/**
 * WHAT THE POPULATION ROWS OF A BATCH CARRY, grouped. The predicate is spelled
 * out by hand here on purpose: an oracle that imported `rowWhereSql` would agree
 * with the renderer about a bug in the renderer.
 */
async function stampOracle(batchId: string): Promise<StampGroup[]> {
  const rows = await rawRows<{ orderRecordId: string | null; n: number }>(
    `SELECT orderRecordId, COUNT(*) AS n
       FROM inventory_logs
      WHERE batchId = ?
        AND logType IN ('SALE','ADJUSTMENT')
        AND delta < 0
      GROUP BY orderRecordId`,
    [batchId],
  );
  return rows.map((row) => ({ orderRecordId: row.orderRecordId, n: Number(row.n) }));
}

type AttemptRow = {
  id: number;
  ledgerRowId: number | null;
  outcome: string;
  evidence: string | null;
  source: string;
  orderRecordId: string | null;
  previousOrderRecordId: string | null;
  details: Record<string, unknown> | null;
};

async function attemptOracle(batchId: string): Promise<AttemptRow[]> {
  const rows = await rawRows<AttemptRow>(
    `SELECT id, ledgerRowId, outcome, evidence, source, orderRecordId, previousOrderRecordId, details
       FROM order_attribution_attempts
      WHERE batchId = ?
      ORDER BY id`,
    [batchId],
  );
  return rows.map((row) => ({ ...row, details: json(row.details) }));
}

type AuditRow = { id: number; batchId: string | null; entityType: string; entityId: string | null };

async function auditOracle(ledgerBatchId: string): Promise<AuditRow[]> {
  return rawRows<AuditRow>(
    `SELECT id, batchId, entityType, entityId
       FROM audit_logs
      WHERE actionType = 'INVENTORY_ATTRIBUTE'
        AND entityId = ?
      ORDER BY id`,
    [ledgerBatchId],
  );
}

// --------------------------------------------------------------------------
// The rendezvous
// --------------------------------------------------------------------------

const HOLD_TRIGGER = "recon_hold";

/** Long enough that the second racer is unambiguously blocked and short enough
 *  that the winner's interactive transaction stays far inside Prisma's default
 *  5s budget (a blown budget closes the connection and the route answers 500). */
const HOLD_SECONDS = 0.8;

/** The winner's head start. Not a substitute for the lock-wait observation
 *  below — that is what proves the race happened — but it makes WHICH racer wins
 *  follow the launch order, so the two orderings this file runs are two real
 *  orderings rather than two coin flips. Nothing is asserted about who wins. */
const STAGGER_MS = 150;

/** The trigger body interpolates the batch id RAW (a trigger takes no
 *  parameters), so the literal is checked before it goes near the server. */
function assertSqlSafeLiteral(value: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(value)) {
    throw new Error(`concurrency-3: refusing to inline "${value}" into a trigger body`);
  }
  return value;
}

/**
 * The hold point, installed for one race and dropped in `finally`.
 *
 * BEFORE INSERT on the attempts table, guarded on the fixture's batch id: it
 * fires for the winner's attempt row and for nothing else this gate ever writes.
 * The gate database is a throwaway container and no app code changes, which is
 * the whole reason a trigger is the right instrument here.
 */
async function installHoldTrigger(): Promise<void> {
  const literal = assertSqlSafeLiteral(RECON_BATCH_ID);
  await withRaw(async (conn) => {
    await conn.query(`DROP TRIGGER IF EXISTS ${HOLD_TRIGGER}`);
    await conn.query(
      `CREATE TRIGGER ${HOLD_TRIGGER} BEFORE INSERT ON order_attribution_attempts
       FOR EACH ROW
       BEGIN
         IF NEW.batchId = '${literal}' THEN
           DO SLEEP(${HOLD_SECONDS});
         END IF;
       END`,
    );
  });
}

async function dropHoldTrigger(): Promise<void> {
  await withRaw(async (conn) => {
    await conn.query(`DROP TRIGGER IF EXISTS ${HOLD_TRIGGER}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block until the DATABASE says some session is waiting on a row lock (copied
 * from `concurrency-2.test.ts`, whose reasoning holds verbatim here).
 *
 * A poll, not a sleep: a fixed delay would be a guess about scheduling, and this
 * observation is the evidence that the two POSTs really contended rather than
 * running one after the other.
 *
 * TWO SOURCES, OR'd — `performance_schema.data_lock_waits` (one row per
 * requester/blocker pair) FIRST, because `information_schema.INNODB_TRX` was
 * MEASURED here to omit a session that `PROCESSLIST` showed executing a blocked
 * statement: a transaction whose very first InnoDB statement is still acquiring
 * its lock is not always in the transaction list yet.
 */
async function waitForLockWait(probe: PrismaClient, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await probe.$queryRawUnsafe<{ waiting: bigint | number }[]>(
      `SELECT (SELECT COUNT(*) FROM performance_schema.data_lock_waits)
            + (SELECT COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT') AS waiting`,
    );
    if (Number(rows[0]?.waiting ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

type RaceOutcome = {
  answers: RouteAnswer[];
  blocked: boolean;
  winnerIndex: number;
  winnerTarget: string;
};

/**
 * ONE race: two POSTs against the same batch, staggered by a beat, with the hold
 * trigger installed for the duration.
 *
 * Both racers state `expectPreviousOrderRecordId: null` — both are looking at an
 * unattributed batch, which is the only starting state the reset ever leaves.
 */
async function race(targets: [string, string], probe: PrismaClient): Promise<RaceOutcome> {
  await installHoldTrigger();
  try {
    const inFlight: Promise<RouteAnswer>[] = [];
    inFlight.push(
      attribute(RECON_BATCH_ID, { orderRecordId: targets[0], expectPreviousOrderRecordId: null }),
    );
    await sleep(STAGGER_MS);
    inFlight.push(
      attribute(RECON_BATCH_ID, { orderRecordId: targets[1], expectPreviousOrderRecordId: null }),
    );

    const blocked = await waitForLockWait(probe);
    const answers = await Promise.all(inFlight);

    const winnerIndex = answers.findIndex((answer) => answer.status === 200);
    return {
      answers,
      blocked,
      winnerIndex,
      winnerTarget: winnerIndex === -1 ? "" : String(answers[winnerIndex].body.orderRecordId),
    };
  } finally {
    await dropHoldTrigger();
  }
}

/** The whole invariant of scenario 8, asserted the same way in every ordering
 *  and both sub-cases: one winner, one `BATCH_MOVED` loser, and the loser is
 *  told the WINNER's id — never a hard-coded one (pack C6.2). */
function expectOneWinnerOneMovedLoser(outcome: RaceOutcome): void {
  expect(outcome.answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
  expect(outcome.winnerIndex).not.toBe(-1);

  const winner = outcome.answers[outcome.winnerIndex];
  const loser = outcome.answers[outcome.winnerIndex === 0 ? 1 : 0];

  expect(winner.body).toEqual({
    changed: true,
    orderRecordId: outcome.winnerTarget,
    previousOrderRecordId: null,
    rowCount: 2,
    completedFulfillment: false,
  });
  expect(loser.body).toEqual({
    error: `Someone attributed this batch while you were looking (now ${outcome.winnerTarget}) — refresh and try again`,
    code: "BATCH_MOVED",
    currentOrderRecordId: outcome.winnerTarget,
    expected: null,
  });
}

/** The four oracles of scenario 8 (pack C6.2), read straight out of MySQL. */
async function expectSingleAttribution(winnerTarget: string): Promise<void> {
  // ONE id across every population row of the batch — no half-stamped batch.
  const stamps = await stampOracle(RECON_BATCH_ID);
  expect(stamps).toEqual([{ orderRecordId: winnerTarget, n: 2 }]);

  // ONE attempt row: the loser refused before it wrote anything at all.
  const attempts = await attemptOracle(RECON_BATCH_ID);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].source).toBe("manual");
  expect(attempts[0].outcome).toBe("attributed");
  expect(attempts[0].evidence).toBe("manual");
  expect(attempts[0].previousOrderRecordId).toBeNull();
  expect(attempts[0].orderRecordId).toBe(winnerTarget);
  expect(attempts[0].ledgerRowId).toBe(RECON_SALE_A_ID);
  expect(attempts[0].details).toEqual({ rowCount: 2 });

  // ONE audit event, filed AGAINST the ledger batch and UNDER a different one:
  // the derivation reads "the audit event of a batch" as the earliest row
  // carrying the ledger's own batchId, so an attribution event that filed itself
  // there would re-classify the deduction it describes (G1p-8).
  const audits = await auditOracle(RECON_BATCH_ID);
  expect(audits).toHaveLength(1);
  expect(audits[0].entityType).toBe("INVENTORY");
  expect(audits[0].entityId).toBe(RECON_BATCH_ID);
  expect(audits[0].batchId).not.toBeNull();
  expect(audits[0].batchId).not.toBe(RECON_BATCH_ID);
}

// --------------------------------------------------------------------------

beforeAll(async () => {
  // C6.2 / C7b.1, in order and for a reason: the singleton binds `DATABASE_URL`
  // at construction, so the URL is set and the registry cleared BEFORE the first
  // import that can reach `@/lib/prisma` (the route below does, transitively).
  process.env.DATABASE_URL = gateDatabaseUrl();
  jest.resetModules();

  prismaNs = (await import("@prisma/client")).Prisma;
  population = await import("@/lib/reconciliation/population");
  attributionRoute = (await import(
    "@/app/api/reconciliation/attribution/[batchId]/route"
  )) as unknown as AttributionRouteModule;

  singleton = (await import("@/lib/prisma")).default;

  // FAIL CLOSED. The singleton is the ONE connection in this file whose URL is
  // not built by `state.ts`'s refusal belt, and the repo's own `.env` names a
  // real database. Prove the session's schema before anything writes.
  const rows = await singleton.$queryRawUnsafe<{ db: string | null }[]>("SELECT DATABASE() AS db");
  if (rows[0]?.db !== GATE_DB_NAME) {
    throw new Error(
      `the @/lib/prisma singleton connected to "${rows[0]?.db}" instead of "${GATE_DB_NAME}" — ` +
        "refusing to drive the attribution route against anything but the throwaway container",
    );
  }

  // The fixture batch's own INVENTORY_BULK_UPDATE summary, for as long as this
  // file runs (see `installReconAuditEvent` — `concurrency.test.ts` pins a
  // table-wide audit count, so the row is bracketed rather than seeded).
  await removeReconAuditEvent();
  await installReconAuditEvent();
});

afterAll(async () => {
  try {
    // Put the WHOLE fixture back, whichever order jest ran the gate's files in:
    // `concurrency.test.ts`'s scenario 2 asserts ABSOLUTE register and audit
    // counts, and a row this file left behind would break it from the outside.
    await dropHoldTrigger();
    await removeReconAuditEvent();
    await resetAll();
  } finally {
    // An open pool holds the jest worker alive past the last assertion.
    if (singleton) await singleton.$disconnect();
  }
});

describe("manual attribution — real-DB concurrency", () => {
  jest.setTimeout(120_000);

  // Both LAUNCH orderings of the same race (pack C6.2: "in BOTH orderings").
  // With the hold trigger installed the racer that starts first is the one that
  // holds the locks, so these are two genuinely different orderings — but the
  // assertions never say so: they read the winner off the 200 and hold the loser
  // to it.
  const ORDERINGS = [
    { label: "racer 1 launched first", swap: false },
    { label: "racer 2 launched first", swap: true },
  ];

  for (const ordering of ORDERINGS) {
    test(`scenario 8.i (${ordering.label}): two admins attribute the same batch to the SAME order — one 200, one BATCH_MOVED naming the winner`, async () => {
      await resetAll();
      const probe = openClient();

      try {
        // Identical intent, twice. The batch really can go to that order — the
        // question is only whether the second admin is told the truth about who
        // got there first.
        const targets: [string, string] = [GATE_EXT_ORDER_ID, GATE_EXT_ORDER_ID];
        const outcome = await race(
          ordering.swap ? [targets[1], targets[0]] : targets,
          probe,
        );

        console.log(
          `[scenario 8.i / ${ordering.label}] lock wait observed: ${outcome.blocked}; ` +
            `winner: the racer launched ${outcome.winnerIndex === 0 ? "FIRST" : "SECOND"} ` +
            `-> ${outcome.winnerTarget}`,
        );
        // THE RACE REALLY HAPPENED. Without this, a green run could mean the two
        // POSTs simply ran one after the other and never contended.
        expect(outcome.blocked).toBe(true);

        expectOneWinnerOneMovedLoser(outcome);
        expect(outcome.winnerTarget).toBe(GATE_EXT_ORDER_ID);
        await expectSingleAttribution(outcome.winnerTarget);
      } finally {
        await probe.$disconnect();
      }
    });

    test(`scenario 8.ii (${ordering.label}): two admins attribute the same batch to DIFFERENT orders — the loser is BATCH_MOVED, not "reason required"`, async () => {
      await resetAll();
      const probe = openClient();

      try {
        // The sub-case the stale guard exists for. The loser's request is not
        // merely late — it names a DIFFERENT order, which is exactly the shape
        // that would otherwise fall through to the reason rule and ask an
        // operator to justify a change they never saw (spec D4, OCp-8).
        const targets: [string, string] = [GATE_EXT_ORDER_ID, GATE_EXT_ORDER_2_ID];
        const outcome = await race(
          ordering.swap ? [targets[1], targets[0]] : targets,
          probe,
        );

        console.log(
          `[scenario 8.ii / ${ordering.label}] lock wait observed: ${outcome.blocked}; ` +
            `winner: the racer launched ${outcome.winnerIndex === 0 ? "FIRST" : "SECOND"} ` +
            `-> ${outcome.winnerTarget}`,
        );
        expect(outcome.blocked).toBe(true);

        expectOneWinnerOneMovedLoser(outcome);
        // EITHER order may be the one that lands — never hard-code the first.
        expect([GATE_EXT_ORDER_ID, GATE_EXT_ORDER_2_ID]).toContain(outcome.winnerTarget);
        await expectSingleAttribution(outcome.winnerTarget);
      } finally {
        await probe.$disconnect();
      }
    });
  }

  test("scenario 8 follow-up: moving a batch OFF a stamp needs a reason, and both attributions are on the record", async () => {
    await resetAll();

    // A FRESH, explicitly EXT1-winning run (pack C6.2): unraced, so there is no
    // question which order the batch carries when the overwrite arrives.
    const first = await attribute(RECON_BATCH_ID, {
      orderRecordId: GATE_EXT_ORDER_ID,
      expectPreviousOrderRecordId: null,
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      changed: true,
      orderRecordId: GATE_EXT_ORDER_ID,
      previousOrderRecordId: null,
      rowCount: 2,
      completedFulfillment: false,
    });

    // The correction, without saying why. Moving a batch off an existing stamp
    // overrides somebody's earlier decision, so it is recorded with its reason or
    // not at all — a 400, because the client CAN fix it by asking the operator.
    const noReason = await attribute(RECON_BATCH_ID, {
      orderRecordId: GATE_EXT_ORDER_2_ID,
      expectPreviousOrderRecordId: GATE_EXT_ORDER_ID,
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body).toEqual({
      error: "Re-attributing a stamped batch needs a reason",
      code: "REASON_REQUIRED",
    });

    // Nothing moved and nothing was recorded by the refusal.
    expect(await stampOracle(RECON_BATCH_ID)).toEqual([
      { orderRecordId: GATE_EXT_ORDER_ID, n: 2 },
    ]);
    expect(await attemptOracle(RECON_BATCH_ID)).toHaveLength(1);

    const reason = "the packer confirmed it shipped against 1002";
    const moved = await attribute(RECON_BATCH_ID, {
      orderRecordId: GATE_EXT_ORDER_2_ID,
      expectPreviousOrderRecordId: GATE_EXT_ORDER_ID,
      reason,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual({
      changed: true,
      orderRecordId: GATE_EXT_ORDER_2_ID,
      previousOrderRecordId: GATE_EXT_ORDER_ID,
      rowCount: 2,
      completedFulfillment: false,
    });

    expect(await stampOracle(RECON_BATCH_ID)).toEqual([
      { orderRecordId: GATE_EXT_ORDER_2_ID, n: 2 },
    ]);

    // TWO attempts and TWO audit events — the history of a batch that moved is
    // both stamps, not just the one it ended on. The refused call added neither.
    const attempts = await attemptOracle(RECON_BATCH_ID);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((row) => [row.previousOrderRecordId, row.orderRecordId])).toEqual([
      [null, GATE_EXT_ORDER_ID],
      [GATE_EXT_ORDER_ID, GATE_EXT_ORDER_2_ID],
    ]);
    expect(attempts[1].details).toEqual({ rowCount: 2, overwriteReason: reason });

    const audits = await auditOracle(RECON_BATCH_ID);
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.batchId !== null && row.batchId !== RECON_BATCH_ID)).toBe(
      true,
    );
    expect(new Set(audits.map((row) => row.batchId)).size).toBe(2);
  });

  test("scenario 8b: the Prisma renderer and the raw renderer name the SAME batches, over a ledger that holds all six classes", async () => {
    // PRESENT BY CONSTRUCTION (pack C6.1). If a future edit drops a family row,
    // the parity below would still pass while proving less — so the fixture is
    // asserted before it is used.
    const family = await singleton.inventory_logs.findMany({
      where: { id: { in: [...RECON_LEDGER_IDS] } },
      orderBy: { id: "asc" },
      select: { id: true, productId: true, logType: true, delta: true, batchId: true },
    });
    expect(family).toHaveLength(6 + 1);
    expect(family.map((row) => [row.logType, row.delta, row.batchId])).toEqual([
      ["SALE", -1, RECON_BATCH_ID],
      ["SALE", -1, RECON_BATCH_ID],
      ["ADJUSTMENT", -2, RECON_ADJUST_BATCH_ID],
      ["STOCK_IN", -1, RECON_STOCK_IN_BATCH_ID],
      ["COUNT", -1, RECON_COUNT_BATCH_ID],
      ["ADJUSTMENT", 2, RECON_POSITIVE_BATCH_ID],
      ["SALE", -1, null],
    ]);
    expect(family.every((row) => row.productId === P_RECON_A || row.productId === P_RECON_B)).toBe(
      true,
    );

    // THE TWO DIALECTS OF ONE PREDICATE (pack C2a.1 / S6). Both are rendered from
    // the same table, which makes agreement structural — but "structural" is a
    // claim about TypeScript, and only MySQL can say whether the two produce the
    // same rows. This is the one place that asks it.
    const viaPrisma = await singleton.inventory_logs.findMany({
      where: population.rowWhere,
      select: { batchId: true },
      distinct: ["batchId"],
    });
    const fragment = population.rowWhereSql("l");
    const query = prismaNs.sql`SELECT DISTINCT l.batchId FROM inventory_logs l WHERE ${fragment}`;
    // THE FRAGMENT REALLY WAS SPLICED, not bound. A fragment that arrived as a
    // parameter would leave one placeholder and one object value behind, and the
    // parity below would then compare two empty sets and call it agreement.
    expect(query.values).toEqual(["SALE", "ADJUSTMENT"]);
    expect(query.sql).toContain("l.logType IN (?,?)");
    const viaRaw = await singleton.$queryRaw<{ batchId: string | null }[]>(query);

    const prismaBatches = viaPrisma.map((row) => row.batchId);
    const rawBatches = viaRaw.map((row) => row.batchId);
    // The batchId conjunct, in both dialects: an unbatched deduct is not a batch.
    expect(prismaBatches).not.toContain(null);
    expect(rawBatches).not.toContain(null);

    const sortedPrisma = [...prismaBatches].sort();
    const sortedRaw = [...rawBatches].sort();
    expect(sortedRaw).toEqual(sortedPrisma);

    // IN: the two population classes.
    expect(sortedPrisma).toContain(RECON_BATCH_ID);
    expect(sortedPrisma).toContain(RECON_ADJUST_BATCH_ID);
    // OUT: one batch per excluded class, so a renderer that lost the logType or
    // the delta conjunct shows up as a membership difference rather than as a
    // silently wider set.
    for (const excluded of [
      RECON_STOCK_IN_BATCH_ID,
      RECON_COUNT_BATCH_ID,
      RECON_POSITIVE_BATCH_ID,
    ]) {
      expect(sortedPrisma).not.toContain(excluded);
      expect(sortedRaw).not.toContain(excluded);
    }
  });
});
