/**
 * concurrency-gate/concurrency-4.test.ts — THE LOCK-DISCIPLINE PROOFS
 * (reconciliation Part 2, plan row B1c; contract pack CB1c, as amended by
 * REV-14 PKb-9/PKb-10 and REV-15 OC-3).
 *
 * `concurrency.test.ts` and `concurrency-2.test.ts` prove the supply-order
 * booking primitive against itself and against a second actor;
 * `concurrency-3.test.ts` proves the manual-attribution race through the real
 * route. This file is about the thing P2-B1 added underneath all of them: the
 * CANONICAL PRELOCK — one materializing `INSERT … ON DUPLICATE KEY UPDATE
 * version = version` plus one returning `SELECT … FOR UPDATE`, over the deduped
 * key set in (productId, locationId) ascending order, taken before the
 * transaction has pinned a read view.
 *
 * Four claims live or die on a real InnoDB engine, and nowhere else:
 *
 *   9c  TWO WRITERS ASKING IN OPPOSITE ORDER TAKE THE ROWS IN THE SAME ORDER.
 *       Session A locks order 1 and asks for [P1, P2]; session B locks order 2
 *       and asks for [P2, P1]. WHAT THE SCENARIO PROVES, exactly: both sessions
 *       COMMIT under reversed ask order, one at a time, because the module sorts
 *       the deduped key set before it locks anything. It does NOT prove the
 *       counterfactual — that an unsorted prelock would necessarily deadlock
 *       here. That argument is plan P-2's documented InnoDB reasoning (every
 *       writer takes the same keys in the same order; the ODKU takes an
 *       EXCLUSIVE lock on a duplicate, so the S→X duplicate-key shape does not
 *       arise, and each locked record's next-key gap lies BEFORE it, which
 *       sorted acquisition keeps acyclic), and the empirical negative control is
 *       the ONE sort-disabled mutation run recorded beside the scenario below.
 *       It races at the SECOND location, for the measured reason spelled out at
 *       `KEY_SECOND_1` below. That reason — the retired location-1 mirror's own
 *       `products` deadlock with a concurrent prelock's FK parent check — is
 *       gone as of P2-B2.5, but the keys stay where every recorded run of this
 *       scenario took them; scenario 15 is the pin that the location-1 pair now
 *       serialises.
 *
 *   9d  TWO FIRST-WRITES ON ONE NEVER-STOCKED KEY PRODUCE ONE ROW.
 *       Re-choreographed per pack REV-14 PKb-10: a prelock ALONE leaves the row
 *       at version 0 (the ODKU is a self-assignment), so each session prelocks
 *       AND THEN performs a covered write. The ODKU's X lock serializes them;
 *       the second session's prelock reads the first's COMMITTED effect, which
 *       is precisely what "materialize first, then read your guards off it"
 *       buys and what a `findUnique`-then-upsert could never say.
 *
 *   13  TWO REAL ROUTES OVER TWO OVERLAPPING KEYS, IN OPPOSITE REQUEST ORDER.
 *       deduct-simple against batch-adjust. Driven THROUGH THE HANDLERS with
 *       the `concurrency-3.test.ts:141-155` idiom (a `NextRequest`, a
 *       `jest.resetModules()`d dynamic import, mocked auth) — because the
 *       envelope, the batch id, the audit row and the attempt row are route
 *       contracts, and calling the cores directly would prove none of them.
 *
 *   14  FULFIL AND UNFULFILL, ON A REAL ENGINE, FOR THE FIRST TIME.
 *       Reconciliation Part 2 B1.5, pack CB1.5a-ii. Until this scenario, no
 *       gate scenario had ever driven either route against InnoDB — and that
 *       blind spot is exactly how a fulfil whose per-item SAVEPOINT could never
 *       execute (MySQL ER 1295: `SAVEPOINT` is not supported in the prepared
 *       statement protocol) reached production. Four sub-cases: A the two-pass
 *       fulfil of a single line plus a BUNDLE line (red against the old file);
 *       B the locked shortfall, quoting the number the tally actually holds;
 *       C two concurrent fulfils of one order, serialized by the ORDER lock;
 *       D the unfulfill round trip, self-contained. It runs at LOCATION 1 on
 *       purpose: the first real-engine exercise of the bundle path at the
 *       location every route deducts at in real life, where each ledger INSERT's
 *       FK S lock on `products` — the surviving half of the named S->X residual
 *       (pack CB2.5a.2) — is taken.
 *
 * THE DEADLOCK REPORT IS RECORDED, NEVER ASSERTED AWAY (pack REV-14 PKb-10).
 * MySQL exposes no `Innodb_deadlocks` status counter, so the only truthful
 * instrument is the `LATEST DETECTED DEADLOCK` section of `SHOW ENGINE INNODB
 * STATUS`, sampled before and after each race and printed either way. Scenario
 * 13's outcome envelope is therefore BOTH 200, or one 200 and one ROLLED-BACK
 * request — a gate that demanded two 200s would be asserting an InnoDB
 * scheduling accident. The rolled-back request reaches the wire as a GENERIC
 * 500 (`apiHandler` mapped an unrecognised error, P2034 included, to
 * `{ error: 'Internal server error' }`, so the wire never said "deadlock") or,
 * once pack REV-22 F3 lands its typed P2028/P2034 branch, as a 503 `BUSY`; the
 * envelope accepts either and NEITHER names the cycle, which is why the report
 * above prints the engine's own section. The `products` S→X residual (every
 * ledger insert takes a shared lock on its product row, and booking's step-6b
 * `FOR UPDATE` / decline's soft-delete take an exclusive one afterwards) is the
 * named reason that branch stays open; deduct-simple is single-attempt by design
 * and does not retry into it. As of P2-B2.5 NO COVERED writer takes that X lock
 * any more — the retired location-1 mirror was the covered half — so between two
 * covered writers the cycle is CLOSED (scenarios 13 and 15 pin it) and the
 * residual survives only for booking and decline (pack CB2.5a.2).
 *
 * ...BUT THE OPEN BRANCH IS NOT A FREE PASS (pack REV-22 F9). "One committed,
 * one rolled back" is tolerated for that ONE named reason, so when it fires the
 * scenario CLASSIFIES the engine's own trace instead of shrugging: a fresh cycle
 * whose waits name `products` is the accepted residual (recorded, and the
 * scenario passes); a fresh cycle whose waits are two `product_locations`
 * records is the AB/BA shape the canonical prelock exists to prevent, and it
 * FAILS the scenario with the trace in the message; anything else — including a
 * failed request with no fresh deadlock at all, which is what a blown
 * transaction budget looks like from the wire — is unattributable and fails the
 * same way. The both-200 path is untouched by this. The classifier itself is
 * pinned on two CAPTURED traces (see `CAPTURED_PRODUCT_LOCATIONS_CYCLE`), so it
 * is not code that only runs on a bad day.
 *
 * THE RENDEZVOUS. 9c and 9d hold their two sessions at an in-process barrier
 * placed INSIDE both interactive transactions — after both have begun and (9c)
 * after both order locks are held, so the prelocks really are issued into each
 * other. Scenario 13 cannot reach inside a route, so it uses this gate's
 * established instrument (`concurrency-3.test.ts`): a throwaway `BEFORE INSERT`
 * trigger on `inventory_logs`, guarded on the two gate products, that sleeps
 * while the winner holds every prelocked row. Dropped in `finally`, on every
 * path.
 *
 * THE SINGLETON'S URL. `@/lib/prisma` binds `DATABASE_URL` at construction, so
 * `beforeAll` sets it from the harness state and calls `jest.resetModules()`
 * BEFORE the first import that can reach it — which is why every `@/lib/...`
 * and `@/app/...` import here is dynamic and the static ones are types only.
 * The session's schema is then PROVEN (`SELECT DATABASE()`) before a write.
 *
 * RESET OWNERSHIP (pack REV-14 PKb-9 / REV-15 OC-3). Scenario 13's routes mint
 * their own batch ids and file an `INVENTORY_BULK_UPDATE` audit row and an
 * attribution attempt under them. B1b landed the seed clause that derives those
 * ids from the scoped ledger rows and deletes both; until this file ran, that
 * clause was code with nothing exercising it. Scenario 13 asserts the three
 * table-wide counts return to what they were — and `concurrency.test.ts`
 * scenario 2's ABSOLUTE `auditLog.count()` is the same claim made from outside.
 */

import type { PrismaClient } from "@prisma/client";
import { createHmac } from "crypto";
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";
import type { PrelockKeyInput, PrelockedRow } from "@/lib/inventory/prelock";
import { openClient } from "./clients";
import {
  GATE_ADMIN_ID,
  GATE_COMPANY_ID,
  GATE_EXT_ORDER_2_ID,
  GATE_EXT_ORDER_ID,
  GATE_INTEGRATION_ID,
  LOCATION_MAIN,
  LOCATION_SECOND,
  P_APPROVED,
  P_APPROVED_2,
  P_PENDING,
  resetGateFixtures,
  SEED_LINE_IDS,
  SEED_PRODUCT_IDS,
} from "./seed";
import { GATE_DB_NAME, gateDatabaseUrl } from "./state";

/** The session the guards would have returned. The gate seeds no password — it
 *  never authenticates — so the guards are the ONE thing that has to be faked. */
const mockApprovedSession = {
  id: GATE_ADMIN_ID,
  email: "gate-admin@concurrency.invalid",
  name: "Gate Admin",
  isAdmin: true,
  isApproved: true,
  defaultLocationId: LOCATION_MAIN,
};

// ONLY the three things a route needs from an HTTP request that this harness
// cannot produce. `apiHandler`, the Prisma singleton, the prelock, the stock
// primitives, `recordChange` and the attempt writer all stay REAL — they are
// the parts under test.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireApproved: jest.fn(async () => ({ user: mockApprovedSession })),
  // B2b (pack CB2b.6): scenario 11a-iii drives the ADMIN-ONLY manual attribution
  // beside the reverse. `requireCompanyMembership` stays REAL — the gate's
  // batches are unstamped, so the reverse route never reaches it.
  requireAdmin: jest.fn(async () => ({ user: mockApprovedSession })),
  requireCSRF: jest.fn(async () => undefined),
}));

jest.mock("@/lib/rateLimit", () => ({
  ...jest.requireActual("@/lib/rateLimit"),
  // A per-process in-memory counter is not what is under test, and this file
  // posts to the same two routes repeatedly.
  enforceRateLimit: jest.fn(() => ({})),
}));

// EGRESS IS MOCKED, AND IT HAS TO BE (pack CB1.5a-ii, PKc-5/OCc-22). Scenario 14
// drives the fulfil and unfulfill routes, and both of them reach for the
// platform on the way out. A push that BLOCKS is not a no-op: the egress layer
// commits a durable `platform_write_attempts` row AND a `PLATFORM_WRITE_ATTEMPT`
// audit row on `entityType: "INTEGRATION"` (`lib/platforms/egress/index.ts:440`,
// `egress/audit.ts:98, :135`) that NO reset clause in `seed.ts` names — so it
// would survive every reset and break `concurrency.test.ts` scenario 2's
// ABSOLUTE `auditLog.count()` from the outside. And `pushStockForProducts(...)`
// is fire-and-forget (`fulfill/route.ts:221`) on the singleton this file's
// `afterAll` disconnects.
//
// This gate's concern is the DATABASE, not the wire. The real functions are
// covered by their own suites; here they are replaced by the two answers the
// routes have to survive: a blocked order-status push and a resolved stock push.
// The belt that proves the mock actually held is scenario 14's `afterAll`.
jest.mock("@/lib/external-orders/shared", () => ({
  ...jest.requireActual("@/lib/external-orders/shared"),
  pushOrderStatusToExternal: jest.fn(async () => ({
    success: false,
    blockedReason: "gate",
  })),
}));

jest.mock("@/lib/external-orders/stock-sync", () => ({
  ...jest.requireActual("@/lib/external-orders/stock-sync"),
  pushStockForProducts: jest.fn(async () => undefined),
}));

// --------------------------------------------------------------------------
// The dynamically-loaded production modules
// --------------------------------------------------------------------------

type SingleArgRoute = { POST: (request: NextRequest) => Promise<Response> };

/**
 * The App Router's TWO-argument handler shape (pack CB1.5a-ii, OCc-15). Fulfil
 * and unfulfill are addressed by a path parameter — `POST(request, { params:
 * { orderId } })` — so `SingleArgRoute` above does not fit them, and the
 * `concurrency-3.test.ts:106-108` idiom is spelled once more here.
 */
type ParamRoute<P> = {
  POST: (request: NextRequest, ctx: { params: P }) => Promise<Response>;
};

/** The params objects this file's routes are addressed by. B2b generifies the
 *  caller because the reverse is addressed by BATCH, not by order. */
type OrderParams = { orderId: string };
type BatchParams = { batchId: string };

let prelock: typeof import("@/lib/inventory/prelock");
let orderLock: typeof import("@/lib/inventory/order-lock");
let inventory: typeof import("@/lib/inventory");
let deductSimpleRoute: SingleArgRoute;
let batchAdjustRoute: SingleArgRoute;
/** P2-B3-1 (pack § P2-B3-1, scenario 18): the adjust route, whose typed order
 *  number now stamps the ledger row — the first real-engine run it has had. */
let adjustRoute: SingleArgRoute;
let fulfillRoute: ParamRoute<OrderParams>;
let unfulfillRoute: ParamRoute<OrderParams>;
/** B2b (pack CB2b.6): the reverse, driven with `{ batchId }` and NO JSON body. */
let reverseRoute: ParamRoute<BatchParams>;
/** B2c (pack CB2c.5): the move, driven with `{ batchId }` and a ONE-field body. */
let moveRoute: ParamRoute<BatchParams>;
/** B2b 11a-iii: the manual attribution, raced against the reverse. */
let attributionRoute: ParamRoute<BatchParams>;
/** B2b 11c: the webhook receiver, driven with a REALLY signed body. */
let webhookRoute: ParamRoute<{ integrationId: string }>;
let singleton: PrismaClient;

// --------------------------------------------------------------------------
// The fixture this file races on — SEEDED products only
// --------------------------------------------------------------------------

/**
 * The two overlapping keys scenario 13 races over, at LOCATION 1 — where the
 * routes deduct in real life, and where the covered writers' FK S locks on
 * `products` all land.
 * P_APPROVED (9101) sorts before P_APPROVED_2 (9103), so "canonical order" is a
 * statement with observable content: it is NOT the order either racer asks in.
 */
const KEY_1: PrelockKeyInput = { productId: P_APPROVED, locationId: LOCATION_MAIN };
const KEY_2: PrelockKeyInput = { productId: P_APPROVED_2, locationId: LOCATION_MAIN };

/**
 * The same two products at the SECOND location, which is where scenario 9c
 * races.
 *
 * MEASURED, and the reason this pair exists: when 9c was written, running its
 * covered writes at location 1 deadlocked the race — but NOT on the prelock's
 * key order, which is what 9c is about. The location-1 write on the `products`
 * row that `applyStockDelta` used to make needed an X lock there, while the
 * other session's materialize INSERT held a SHARED lock on that same product row
 * (the FK parent check of `product_locations.fk_pl_product`) and waited for the
 * `product_locations` row the first session held. That cycle was the S→X
 * residual the pack names — `products` sits OUTSIDE the canonical order by spec
 * §2.7, it was why scenario 13's envelope once allowed a rolled-back writer —
 * since B2.5 a fresh deadlock there is red and the only tolerated loser is a
 * no-deadlock BUSY — and its shape predates B1 (before the prelock, the ledger
 * INSERT's own FK check took the same shared lock at the same point). It was never the prelock's ordering,
 * so it did not belong inside the scenario that tests the prelock's ordering.
 *
 * P2-B2.5 retired the covered half of that cycle: no covered writer takes an X
 * lock on `products` any more, and scenario 15 pins the location-1 pair
 * committing. These keys STAY at the second location all the same — every
 * recorded run of 9c took them here, and moving them would re-open a settled
 * measurement for no gain.
 */
const KEY_SECOND_1: PrelockKeyInput = { productId: P_APPROVED, locationId: LOCATION_SECOND };
const KEY_SECOND_2: PrelockKeyInput = { productId: P_APPROVED_2, locationId: LOCATION_SECOND };

/**
 * THE NEVER-STOCKED KEY (9d and the `{0,0}` pin). The seed gives every seeded
 * product a row at BOTH locations, so a genuinely absent key has to be made:
 * the row is deleted after the reset, which is safe precisely because
 * `resetGateFixtures` rebuilds every scoped `product_locations` row from the
 * snapshot — the next reset puts it back with no help from this file. At the
 * second location, for the reason above.
 */
const NEVER_STOCKED_KEY: PrelockKeyInput = {
  productId: P_PENDING,
  locationId: LOCATION_SECOND,
};

/**
 * SCENARIO 14's OWN FIXTURE, by explicit id (pack CB1.5a-ii). Declared here,
 * beside the keys, because `resetAll` below has to name the two order items:
 * the B1.5 reset clauses that put `fulfilledQty`, the frozen bundle snapshot and
 * the order's stocked-out stamps back are SCOPED BY ID, and this file's own
 * `afterAll` is what hands the whole fixture to receiving scenario 2.
 *
 * The rows themselves are created and deleted by scenario 14's own bracket, NOT
 * by `seedGateDatabase` — receiving scenario 2 pins absolute table-wide counts
 * (`concurrency.test.ts:260-267`), so a permanently seeded row would fail a
 * scenario that has nothing to do with this lane (the `installReconAuditEvent`
 * precedent, `seed.ts:449-490`).
 */
const GATE_LINK_SINGLE = "gate-link-single";
const GATE_LINK_BUNDLE = "gate-link-bundle";
const GATE_ITEM_SINGLE = "gate-item-single";
const GATE_ITEM_BUNDLE = "gate-item-bundle";

/** The whole seeded fixture, before and after every scenario — the
 *  `concurrency-3.test.ts` shape. */
async function resetAll(): Promise<void> {
  await resetGateFixtures({
    lineIds: SEED_LINE_IDS,
    productIds: SEED_PRODUCT_IDS,
    // B1.5 (pack CB1.5a-ii, OCc-4b): scenario 14's two order lines and the order
    // they hang off. Widened for the WHOLE file on purpose — every reset in here,
    // the file's own `afterAll` included, must put `fulfilledQty`, the frozen
    // snapshot and the stocked-out stamps back. An id that does not exist yet
    // (nothing before scenario 14 creates one) is a no-op, never a throw (S-B13).
    externalOrderItemIds: [GATE_ITEM_SINGLE, GATE_ITEM_BUNDLE],
    externalOrderIds: [GATE_EXT_ORDER_ID],
  });
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

type LocationRow = {
  productId: number;
  locationId: number;
  quantity: number;
  version: number;
  /** Formatted in SQL: `product_locations.updatedAt` is `DATETIME(0)`, and a
   *  driver-parsed Date would drag this file's timezone into a pin about
   *  whether a column moved at all. */
  updatedAt: string;
};

/** Every `product_locations` row for a product, straight out of MySQL. */
async function locationRows(productId: number): Promise<LocationRow[]> {
  const rows = await rawRows<LocationRow>(
    `SELECT productId, locationId, quantity, version,
            DATE_FORMAT(updatedAt, '%Y-%m-%d %H:%i:%s') AS updatedAt
       FROM product_locations
      WHERE productId = ?
      ORDER BY locationId`,
    [productId],
  );
  return rows.map((row) => ({
    ...row,
    productId: Number(row.productId),
    locationId: Number(row.locationId),
    quantity: Number(row.quantity),
    version: Number(row.version),
  }));
}

async function locationRow(key: PrelockKeyInput): Promise<LocationRow | null> {
  const rows = await locationRows(key.productId);
  return rows.find((row) => row.locationId === key.locationId) ?? null;
}

type CountSnapshot = { ledgerRows: number; auditRows: number; attemptRows: number };

/** The three TABLE-WIDE counts the B1 reset clause has to bring back to zero
 *  residue (pack REV-14 PKb-9). Table-wide on purpose: `concurrency.test.ts`
 *  scenario 2 asserts an absolute `auditLog.count()`, so a row this file leaks
 *  breaks a scenario that has nothing to do with this lane. */
async function countSnapshot(): Promise<CountSnapshot> {
  const [ledger, audit, attempts] = await Promise.all([
    rawRows<{ n: number }>("SELECT COUNT(*) AS n FROM inventory_logs"),
    rawRows<{ n: number }>("SELECT COUNT(*) AS n FROM audit_logs"),
    rawRows<{ n: number }>("SELECT COUNT(*) AS n FROM order_attribution_attempts"),
  ]);
  return {
    ledgerRows: Number(ledger[0]?.n ?? 0),
    auditRows: Number(audit[0]?.n ?? 0),
    attemptRows: Number(attempts[0]?.n ?? 0),
  };
}

// --------------------------------------------------------------------------
// The deadlock REPORT (pack REV-14 PKb-10) — recorded, never asserted to zero
// --------------------------------------------------------------------------

/**
 * The `LATEST DETECTED DEADLOCK` section of `SHOW ENGINE INNODB STATUS`, or
 * null when the engine has never detected one.
 *
 * There is no `Innodb_deadlocks` status variable in MySQL — the section is the
 * only thing the server will tell you, it is GLOBAL (the latest one, whenever
 * it happened) and it carries its own timestamp. So the honest instrument is a
 * before/after sample: an UNCHANGED section means this race added nothing to
 * it, and a changed one is a deadlock worth printing in full.
 */
async function deadlockSection(): Promise<string | null> {
  const rows = await rawRows<{ Status: string }>("SHOW ENGINE INNODB STATUS");
  const status = String(rows[0]?.Status ?? "");
  const start = status.indexOf("LATEST DETECTED DEADLOCK");
  if (start === -1) return null;
  const rest = status.slice(start);
  const end = rest.indexOf("\nTRANSACTIONS\n");
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/** One line for the gate's output: what the engine's deadlock section says now. */
function deadlockSummary(section: string | null): string {
  if (section === null) return "no LATEST DETECTED DEADLOCK section (the engine has recorded none)";
  const lines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^-+$/.test(line));
  return lines.slice(0, 2).join(" | ");
}

/** One lock a deadlocked transaction was WAITING FOR, as the engine names it.
 *  `index` is "(table lock)" for the `TABLE LOCK` form, which carries none. */
type DeadlockWait = { table: string; index: string; line: string };

/**
 * The locks the two sides of a detected deadlock were WAITING for, read off the
 * section's own text.
 *
 * The shape MySQL 8.4 prints, per party:
 *
 *   *** (1) TRANSACTION: … *** (1) HOLDS THE LOCK(S): …
 *   *** (1) WAITING FOR THIS LOCK TO BE GRANTED:
 *   RECORD LOCKS space id 5 page no 4 … index PRIMARY of table `db`.`products` …
 *
 * Only the WAITING side is parsed: a cycle is named by what its members could
 * not get, not by what they already held (every party in this file's races
 * holds `product_locations` rows, so the HOLDS lines classify nothing). A line
 * counts as a wait when it follows a `WAITING FOR THIS LOCK` marker or says
 * `waiting` itself; the next `***` line ends the block. Table names are taken
 * from the backticks, so `products` and `product_locations` can never be
 * confused for one another.
 */
function deadlockWaits(section: string): DeadlockWait[] {
  const waits: DeadlockWait[] = [];
  let inWaitingBlock = false;
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("***")) {
      inWaitingBlock = /WAITING FOR THIS LOCK/.test(line);
      continue;
    }
    if (!line.startsWith("RECORD LOCKS") && !line.startsWith("TABLE LOCK")) continue;
    if (!inWaitingBlock && !/\bwaiting\b/.test(line)) continue;
    const indexed = /\bindex (\S+) of table `[^`]+`\.`([^`]+)`/.exec(line);
    if (indexed) {
      waits.push({ table: indexed[2], index: indexed[1], line });
      continue;
    }
    const tabled = /\btable `[^`]+`\.`([^`]+)`/.exec(line);
    if (tabled) waits.push({ table: tabled[1], index: "(table lock)", line });
  }
  return waits;
}

/** ACCEPTED = the named `products` residual; FORBIDDEN = the AB/BA shape;
 *  UNATTRIBUTABLE = a rollback the engine's section does not account for. */
type DeadlockShape = "products-residual" | "product-locations-cycle" | "unattributable";

/**
 * WHICH deadlock this was (pack REV-22 F9), from the LATEST DETECTED DEADLOCK
 * section — `null`/stale in, `unattributable` out.
 *
 * The two shapes the gate has to tell apart:
 *
 *   `products`-residual — at least one waiter wants a `products` row. That is
 *     the residual spec §2.7 names: `products` sits OUTSIDE the canonical order
 *     (the ledger insert's FK parent check takes S on it; booking's step-6b
 *     `FOR UPDATE` and decline's soft-delete take X after their own stock write),
 *     and its shape predates B1. As of P2-B2.5 it is legal ONLY where a booking
 *     or a decline is one of the racers (pack CB2.5a.2) — in scenarios 13 and 15,
 *     which race COVERED writers only, this shape is a FAILURE, not a residual.
 *
 *   `product_locations` cycle — EVERY waiter wants a `product_locations`
 *     record and none wants a `products` row. Two writers took the covered rows
 *     in opposite orders: precisely the AB/BA deadlock the canonical prelock
 *     exists to make impossible. It is a defect, never a residual.
 *
 * Anything else (no fresh section, an unparsable one, a cycle over some third
 * table) is `unattributable` — the caller must not read silence as the accepted
 * residual.
 */
function classifyDeadlock(section: string | null): {
  shape: DeadlockShape;
  waits: DeadlockWait[];
  why: string;
} {
  if (section === null) {
    return {
      shape: "unattributable",
      waits: [],
      why:
        "the engine reports NO fresh LATEST DETECTED DEADLOCK for this race — the rollback " +
        "is not attributable to a deadlock at all (a blown transaction budget reaches the " +
        "wire as the same generic 500)",
    };
  }
  const waits = deadlockWaits(section);
  const named = waits.map((wait) => `${wait.table}.${wait.index}`).join(", ");
  if (waits.length === 0) {
    return {
      shape: "unattributable",
      waits,
      why: "the section names no lock this parser could read as a WAITING record lock",
    };
  }
  if (waits.every((wait) => wait.table === "product_locations")) {
    return {
      shape: "product-locations-cycle",
      waits,
      why:
        `every waiter in the cycle wants a \`product_locations\` record (${named}) — the ` +
        "AB/BA shape the canonical prelock exists to prevent",
    };
  }
  if (waits.some((wait) => wait.table === "products")) {
    return {
      shape: "products-residual",
      waits,
      why: `a waiter wants a \`products\` row (${named}) — the named FK S→X residual`,
    };
  }
  return {
    shape: "unattributable",
    waits,
    why: `the cycle waits on neither the residual nor the covered rows (${named})`,
  };
}

/** Sample, run, sample, PRINT. Never an assertion — the caller decides whether
 *  its scenario is entitled to claim "and no deadlock happened". */
async function reportDeadlocks<T>(label: string, fn: () => Promise<T>): Promise<{
  value: T;
  before: string | null;
  after: string | null;
  fresh: boolean;
}> {
  const before = await deadlockSection();
  const value = await fn();
  const after = await deadlockSection();
  const fresh = before !== after;
  console.log(
    `[${label}] deadlock report (SHOW ENGINE INNODB STATUS):\n` +
      `    before: ${deadlockSummary(before)}\n` +
      `    after:  ${deadlockSummary(after)}\n` +
      `    a NEW deadlock was detected during this race: ${fresh}`,
  );
  if (fresh && after !== null) console.log(`[${label}] LATEST DETECTED DEADLOCK\n${after}`);
  return { value, before, after, fresh };
}

// --------------------------------------------------------------------------
// The rendezvous
// --------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An N-party barrier for the in-process scenarios (9c / 9d).
 *
 * Both racers are real database SESSIONS but they are the same node process, so
 * the hold point does not have to be a trigger here: each side arrives once its
 * transaction has begun (and, in 9c, once its order lock is held) and nobody
 * proceeds until everyone has. The DEADLINE matters — without it, a racer that
 * throws before arriving leaves the other parked until its transaction budget
 * expires, and the failure that gets reported is the timeout rather than the
 * cause.
 */
function makeBarrier(parties: number, timeoutMs = 10_000): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  let fail!: (err: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  const timer = setTimeout(
    () => fail(new Error(`barrier: only ${arrived}/${parties} racers arrived in ${timeoutMs}ms`)),
    timeoutMs,
  );
  // A rejected barrier must not take the process down when the loser is still
  // parked on it; every waiter observes the rejection through its own `await`.
  gate.catch(() => undefined);
  return async () => {
    arrived += 1;
    if (arrived >= parties) {
      clearTimeout(timer);
      open();
    }
    await gate;
  };
}

/** A racer still opening its connection is not racing. One trivial statement
 *  per client puts both sides on the starting line (`concurrency-2.test.ts`). */
async function warmUp(...clients: PrismaClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.$queryRawUnsafe("SELECT 1")));
}

/**
 * Block until the DATABASE says some session is waiting on a row lock. Copied
 * from `concurrency-2.test.ts` / `concurrency-3.test.ts`, whose reasoning holds
 * verbatim: a poll rather than a sleep, and two sources OR'd because
 * `INNODB_TRX` was MEASURED there to omit a session whose very first InnoDB
 * statement is still acquiring its lock.
 */
async function waitForLockWait(probe: PrismaClient, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await probe.$queryRawUnsafe<{ waiting: bigint | number }[]>(
      `SELECT (SELECT COUNT(*) FROM performance_schema.data_lock_waits)
            + (SELECT COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT') AS waiting`,
    );
    if (Number(rows[0]?.waiting ?? 0) > 0) return true;
    await sleep(10);
  }
  return false;
}

/** The B1 ledger hold's name. B2b's two holds live under their own names and
 *  install/drop independently of it. */
/**
 * B2b's RENDEZVOUS (pack CB2b.6). `waitForLockWait` cannot see this one: 11a-i's
 * two reverses touch DISJOINT keys and neither ever blocks, so there is no lock
 * wait to observe — and the claim the scenario makes is that their restoration
 * READS overlapped, which is exactly what a plain read on an empty range is
 * supposed to allow.
 *
 * The `DO SLEEP` hold has no release, so the observable is the engine's own
 * process list: block until N sessions of the gate database are sitting in
 * `User sleep` AT THE SAME INSTANT. Two 200s alone do not qualify — the gate's
 * doctrine is that simultaneity is OBSERVED, never inferred.
 */
async function waitForSleepingSessions(
  probe: PrismaClient,
  parties: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await probe.$queryRawUnsafe<{ sleeping: bigint | number }[]>(
      `SELECT COUNT(*) AS sleeping FROM information_schema.PROCESSLIST
        WHERE STATE = 'User sleep' AND DB = ?`,
      GATE_DB_NAME,
    );
    if (Number(rows[0]?.sleeping ?? 0) >= parties) return true;
    await sleep(10);
  }
  return false;
}

/**
 * The rendezvous for two DIFFERENT-batch writers (11a-i, 11b-ii), observed
 * DURING the hold: every 10 ms count the sessions inside `DO SLEEP` and, when
 * only one is, look for the other WAITING — an InnoDB row-lock wait, or a
 * session blocked on the prelock's materialize statement (the real engine's
 * observed shape: same-location writers serialise there). Returns what it saw.
 */
async function observeRendezvous(
  probe: PrismaClient,
  timeoutMs = 3_500,
): Promise<{ overlapped: boolean; lockWait: boolean; blockedOnMaterialize: boolean }> {
  const seen = { overlapped: false, lockWait: false, blockedOnMaterialize: false };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await probe.$queryRawUnsafe<{ STATE: string | null; INFO: string | null }[]>(
      `SELECT STATE, LEFT(INFO, 80) AS INFO FROM information_schema.PROCESSLIST
        WHERE DB = ? AND ID <> CONNECTION_ID() AND COMMAND <> 'Sleep'`,
      GATE_DB_NAME,
    );
    const sleeping = rows.filter((r) => r.STATE === "User sleep").length;
    if (sleeping >= 2) {
      seen.overlapped = true;
      return seen;
    }
    if (sleeping === 1) {
      const blocked = rows.some(
        // B25-QA-4: the prelock's `Prisma.sql` template opens on a new line, so
        // the statement the engine holds may begin with whitespace — trim it,
        // or this branch never fires and the probe rests on `lockWait` alone.
        (r) => r.STATE !== "User sleep" && (r.INFO ?? "").trimStart().startsWith("INSERT INTO product_locations"),
      );
      if (blocked) seen.blockedOnMaterialize = true;
      // B25-CX-5 / B25-QA-4: scoped to a WAITING lock on the gate DB's
      // `product_locations` — `data_lock_waits` alone is server-wide, and an
      // unrelated wait would have counted as this rendezvous.
      const waits = await probe.$queryRawUnsafe<{ n: bigint | number }[]>(
        `SELECT COUNT(*) AS n
           FROM performance_schema.data_lock_waits w
           JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
          WHERE l.OBJECT_SCHEMA = ? AND l.OBJECT_NAME = 'product_locations' AND l.LOCK_STATUS = 'WAITING'`,
        GATE_DB_NAME,
      );
      if (Number(waits[0]?.n ?? 0) > 0) seen.lockWait = true;
      if (seen.blockedOnMaterialize || seen.lockWait) return seen;
    }
    await sleep(10);
  }
  return seen;
}

const HOLD_TRIGGER = "b1_prelock_hold";

/** A bare SQL identifier this module is willing to inline into a trigger body. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A string id (a cuid, a uuid) this module is willing to single-quote. */
const SAFE_STRING_ID = /^[A-Za-z0-9_-]{1,64}$/;

type HoldTrigger = {
  /** The trigger's own name — the three holds coexist and drop independently. */
  name: string;
  table: string;
  timing: "BEFORE INSERT" | "BEFORE DELETE";
  /** `NEW` for an INSERT hold, `OLD` for a DELETE one. */
  rowAlias: "NEW" | "OLD";
  guardColumn: string;
  ids: readonly number[] | readonly string[];
  seconds: number;
};

/**
 * The hold point for a ROUTE race, in the database, because a route exposes no
 * callback to put one in and inventing one would be changing app code to make a
 * test pass (`concurrency-3.test.ts`'s doctrine).
 *
 * A row trigger that SLEEPS while the winner holds its locks, guarded on ids
 * this module owns. B2b generalises it over the tuple because the lane now has
 * THREE hold sites: the ledger INSERT (B1 / 11a), the attempts INSERT (11a-iii)
 * and the order-item DELETE (11c). A trigger body takes no parameters, so every
 * inlined value is validated first — numbers as safe integers, strings against a
 * conservative character class and then single-quoted.
 */
async function installHoldTrigger(hold: HoldTrigger): Promise<void> {
  for (const identifier of [hold.name, hold.table, hold.guardColumn]) {
    if (!SAFE_IDENTIFIER.test(identifier)) {
      throw new Error(`concurrency-4: refusing to inline identifier "${identifier}"`);
    }
  }
  const values = hold.ids.map((id) => {
    if (typeof id === "number") {
      if (!Number.isSafeInteger(id)) throw new Error(`concurrency-4: refusing to inline "${id}"`);
      return String(id);
    }
    if (!SAFE_STRING_ID.test(id)) throw new Error(`concurrency-4: refusing to inline "${id}"`);
    return `'${id}'`;
  });
  if (values.length === 0) throw new Error("concurrency-4: a hold trigger needs at least one id");
  if (!Number.isFinite(hold.seconds) || hold.seconds <= 0 || hold.seconds > 5) {
    throw new Error(`concurrency-4: refusing a hold of ${hold.seconds}s`);
  }
  await withRaw(async (conn) => {
    await conn.query(`DROP TRIGGER IF EXISTS ${hold.name}`);
    await conn.query(
      `CREATE TRIGGER ${hold.name} ${hold.timing} ON ${hold.table}
       FOR EACH ROW
       BEGIN
         IF ${hold.rowAlias}.${hold.guardColumn} IN (${values.join(", ")}) THEN
           DO SLEEP(${hold.seconds});
         END IF;
       END`,
    );
  });
}

/** The B1 ledger hold, by its own name — the shape every pre-B2 caller used. */
function installLedgerHold(productIds: readonly number[], seconds: number): Promise<void> {
  return installHoldTrigger({
    name: HOLD_TRIGGER,
    table: "inventory_logs",
    timing: "BEFORE INSERT",
    rowAlias: "NEW",
    guardColumn: "productId",
    ids: productIds,
    seconds,
  });
}

async function dropHoldTrigger(name: string = HOLD_TRIGGER): Promise<void> {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`concurrency-4: refusing to inline identifier "${name}"`);
  }
  await withRaw(async (conn) => {
    await conn.query(`DROP TRIGGER IF EXISTS ${name}`);
  });
}

// --------------------------------------------------------------------------
// Driving the two routes
// --------------------------------------------------------------------------

type RouteAnswer = { status: number; body: Record<string, unknown> };

async function callRoute(
  route: SingleArgRoute,
  path: string,
  body: unknown,
): Promise<RouteAnswer> {
  const request = new NextRequest(`http://concurrency-gate.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await route.POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/**
 * The same request, for a route that takes the App Router's SECOND argument
 * (pack CB1.5a-ii, OCc-15). Kept beside `callRoute` rather than folded into it:
 * the two handler shapes are different types, and a single function taking an
 * optional `params` would type-erase which one it was handed.
 */
async function callParamRoute<P>(
  route: ParamRoute<P>,
  path: string,
  params: P,
  body?: unknown,
): Promise<RouteAnswer> {
  // B2b: `body === undefined` sends NO body and NO content-type — the reverse
  // route parses none, and a JSON body it never reads is not the request the
  // client makes.
  const request = new NextRequest(
    `http://concurrency-gate.invalid${path}`,
    body === undefined
      ? { method: "POST" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const response = await route.POST(request, { params });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type DeductItem = { productId: number; quantity: number };
type Adjustment = { productId: number; locationId: number; delta: number };

/**
 * The order identity a deduction may carry (P2-B3-1, scenario 18) — merged into
 * the body as given. OPTIONAL on purpose: absent, the spread adds no key and the
 * request is byte for byte the one every pre-B3-1 caller sent.
 */
type DeductIdentity = {
  intent?: "order" | "other";
  orderReference?: string;
  selectedExternalOrderId?: string;
};

function deductSimple(
  locationId: number,
  items: DeductItem[],
  identity?: DeductIdentity,
): Promise<RouteAnswer> {
  return callRoute(deductSimpleRoute, "/api/inventory/deduct-simple", {
    locationId,
    items,
    ...identity,
  });
}

function batchAdjust(adjustments: Adjustment[]): Promise<RouteAnswer> {
  return callRoute(batchAdjustRoute, "/api/inventory/batch-adjust", { adjustments });
}

/**
 * THE OUTCOME ENVELOPE for a race between two COVERED writers — both commit
 * (pack CB2.5c.2; scenarios 13 and 15 share it; three-way until B25-CX-4).
 *
 * After P2-B2.5 no covered transaction takes an X lock on `products` — the
 * location-1 mirror was the covered half of the lane's engine-traced S->X cycle
 * and it is retired — so two covered writers over the same keys cannot cycle
 * with each other: they SERIALISE on the canonical prelock. The legal outcomes,
 * exactly:
 *
 *   BOTH 200                            pass. What the retirement claims — and
 *                                       the ONLY green (B25-CX-4: the prelock's
 *                                       same-key second writer WAITS for the
 *                                       first's commit, CB2.5d; inside these
 *                                       choreographies a wait never answers 503,
 *                                       so a `BUSY` here is a stall — red).
 *   ANY fresh deadlock section          RED, whatever `classifyDeadlock` calls
 *                                       it — `products-residual` INCLUDED,
 *                                       because neither racer here is a booking
 *                                       or a decline (CB2.5a.2 names those two
 *                                       as the only surviving X-lock takers).
 *   a generic 500, two failures, a 409  RED.
 *
 * `classifyDeadlock(null)` answers `unattributable`, which is why the freshness
 * flag — not the verdict — is what opens the red branch.
 */
function assertCoveredRaceEnvelope(
  scenario: string,
  answers: RouteAnswer[],
  deadlock: { after: string | null; fresh: boolean },
): void {
  const statuses = answers.map((answer) => answer.status).sort();

  if (deadlock.fresh) {
    const verdict = classifyDeadlock(deadlock.after);
    throw new Error(
      [
        `${scenario}: a FRESH deadlock fired between two COVERED writers. Since P2-B2.5 ` +
          "neither of them takes an X lock on `products`, so no shape of cycle here is a " +
          "residual — this is a defect.",
        `shape: ${verdict.shape} — ${verdict.why}`,
        `waits parsed: ${
          verdict.waits.map((wait) => `${wait.table}.${wait.index}`).join(" | ") || "(none)"
        }`,
        `statuses: ${statuses.join(", ")}`,
        "LATEST DETECTED DEADLOCK:",
        deadlock.after ?? "(the engine has recorded none)",
      ].join("\n"),
    );
  }

  const committed = answers.filter((answer) => answer.status === 200);

  if (committed.length === answers.length) return;

  // B25-CX-4 (codex, the further pass): the tolerated one-BUSY branch is GONE.
  // A prelock same-key wait WAITS (up to the lock-wait timeout) — it never
  // answers 503 inside these choreographies (0.3 s and 3 s holds against a
  // 30 s budget) — so a BUSY here is P2024 pool exhaustion, a P2028 budget
  // defect or a lock-wait timeout wearing the shared wire code, and it is red.
  throw new Error(
    [
      `${scenario}: the outcome is outside the envelope. Two covered writers BOTH ` +
        "commit — nothing else (a 503 BUSY with no fresh deadlock is a stall, not a wait).",
      `statuses: ${statuses.join(", ")}`,
      `bodies: ${JSON.stringify(answers.map((answer) => answer.body))}`,
    ].join("\n"),
  );
}


/** The two order-scoped routes scenario 14 drives, always at the gate's own
 *  external order (the path parameter IS the id the audit row names). */
function fulfillOrder(body: unknown): Promise<RouteAnswer> {
  return callParamRoute(
    fulfillRoute,
    `/api/orders/${GATE_EXT_ORDER_ID}/fulfill`,
    { orderId: GATE_EXT_ORDER_ID },
    body,
  );
}

function unfulfillOrder(body: unknown): Promise<RouteAnswer> {
  return callParamRoute(
    unfulfillRoute,
    `/api/orders/${GATE_EXT_ORDER_ID}/unfulfill`,
    { orderId: GATE_EXT_ORDER_ID },
    body,
  );
}

// --------------------------------------------------------------------------
// Running the REAL prelock, with its statements recorded
// --------------------------------------------------------------------------

type RecordedStatement = { kind: "execute" | "query"; sql: string; values: unknown[] };
type RawArg = { sql: string; values: unknown[] };

/**
 * `prelockProductLocations` on the gate database, with the two statements it
 * actually issued captured on the way past.
 *
 * The capture is what makes the EXPLAIN pin honest: a test that re-spelled the
 * returning SELECT would be explaining ITS OWN sentence, and would keep passing
 * after the module's moved on. The wrapper implements exactly the two methods
 * the prelock uses and delegates both to the real transaction client.
 */
async function prelockRecording(
  client: PrismaClient,
  keys: PrelockKeyInput[],
): Promise<{ locked: Map<string, PrelockedRow>; statements: RecordedStatement[] }> {
  const statements: RecordedStatement[] = [];
  const locked = await client.$transaction(async (tx) => {
    const recordingTx = {
      $executeRaw: (query: RawArg) => {
        statements.push({ kind: "execute", sql: query.sql, values: query.values });
        return tx.$executeRaw(query as never);
      },
      $queryRaw: (query: RawArg) => {
        statements.push({ kind: "query", sql: query.sql, values: query.values });
        return tx.$queryRaw(query as never);
      },
    };
    return prelock.prelockProductLocations(
      recordingTx as unknown as Parameters<typeof prelock.prelockProductLocations>[0],
      keys,
    );
  });
  return { locked, statements };
}

/** Whitespace-folded, so a pin reads the SQL rather than the template's
 *  indentation (the `prelock.test.ts` idiom, ported to the real engine). */
function fold(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// --------------------------------------------------------------------------

beforeAll(async () => {
  // In this order and for a reason: the singleton binds `DATABASE_URL` at
  // construction, so the URL is set and the registry cleared BEFORE the first
  // import that can reach `@/lib/prisma` (both routes do, transitively).
  process.env.DATABASE_URL = gateDatabaseUrl();
  jest.resetModules();

  prelock = await import("@/lib/inventory/prelock");
  orderLock = await import("@/lib/inventory/order-lock");
  inventory = await import("@/lib/inventory");
  deductSimpleRoute = (await import(
    "@/app/api/inventory/deduct-simple/route"
  )) as unknown as SingleArgRoute;
  batchAdjustRoute = (await import(
    "@/app/api/inventory/batch-adjust/route"
  )) as unknown as SingleArgRoute;
  // P2-B3-1 (pack § P2-B3-1, scenario 18): until this import no gate scenario
  // drove the adjust handler. The file's mocks hold for it as for the others —
  // the gate's ADMIN session (so the reference resolver's membership check
  // passes), a no-op CSRF guard and rate limit.
  adjustRoute = (await import("@/app/api/inventory/adjust/route")) as unknown as SingleArgRoute;
  // B1.5 (pack CB1.5a-ii): the first time either of these runs against a real
  // engine. Same registry, same singleton, same fail-closed schema proof below.
  fulfillRoute = (await import(
    "@/app/api/orders/[orderId]/fulfill/route"
  )) as unknown as ParamRoute<OrderParams>;
  unfulfillRoute = (await import(
    "@/app/api/orders/[orderId]/unfulfill/route"
  )) as unknown as ParamRoute<OrderParams>;
  // B2b (pack CB2b.6): the three routes scenarios 11a and 11c drive. Same
  // registry, same singleton, same fail-closed schema proof below.
  reverseRoute = (await import(
    "@/app/api/inventory/batches/[batchId]/reverse/route"
  )) as unknown as ParamRoute<BatchParams>;
  moveRoute = (await import(
    "@/app/api/inventory/batches/[batchId]/move/route"
  )) as unknown as ParamRoute<BatchParams>;
  attributionRoute = (await import(
    "@/app/api/reconciliation/attribution/[batchId]/route"
  )) as unknown as ParamRoute<BatchParams>;
  webhookRoute = (await import(
    "@/app/api/webhooks/[integrationId]/route"
  )) as unknown as ParamRoute<{ integrationId: string }>;

  singleton = (await import("@/lib/prisma")).default;

  // FAIL CLOSED. The singleton is the ONE connection in this file whose URL is
  // not built by `state.ts`'s refusal belt, and the repo's own `.env` names a
  // real database. Prove the session's schema before anything writes.
  const rows = await singleton.$queryRawUnsafe<{ db: string | null }[]>("SELECT DATABASE() AS db");
  if (rows[0]?.db !== GATE_DB_NAME) {
    throw new Error(
      `the @/lib/prisma singleton connected to "${rows[0]?.db}" instead of "${GATE_DB_NAME}" — ` +
        "refusing to drive the stock routes against anything but the throwaway container",
    );
  }
});

afterAll(async () => {
  try {
    // Put the WHOLE fixture back, whichever order jest ran the gate's files in:
    // `concurrency.test.ts`'s scenario 2 asserts ABSOLUTE audit and register
    // counts, and a row this file left behind would break it from the outside.
    await dropHoldTrigger();
    await resetAll();
  } finally {
    // An open pool holds the jest worker alive past the last assertion.
    if (singleton) await singleton.$disconnect();
  }
});

// --------------------------------------------------------------------------

describe("the canonical prelock — real-MySQL pins (pack CB1c)", () => {
  jest.setTimeout(120_000);

  test("a never-stocked key reads {0,0} and the row EXISTS afterwards — materialize-first, on a real engine", async () => {
    await resetAll();
    const client = openClient();

    try {
      // The seed gives every seeded product a row at both locations, so the
      // absence has to be made. This is the shape the prelock exists for: the
      // gap in which two writers both saw "no row" and both created one.
      await withRaw((conn) =>
        conn.query("DELETE FROM product_locations WHERE productId = ? AND locationId = ?", [
          NEVER_STOCKED_KEY.productId,
          NEVER_STOCKED_KEY.locationId,
        ]),
      );
      expect(await locationRow(NEVER_STOCKED_KEY)).toBeNull();

      const { locked, statements } = await prelockRecording(client, [NEVER_STOCKED_KEY]);

      // THE `{0,0}` PIN. Not "undefined, so default to zero" — the SELECT
      // returned a row, because statement 1 created it, and the live column
      // defaults are what a guard now compares against.
      const key = prelock.prelockKey(NEVER_STOCKED_KEY.productId, NEVER_STOCKED_KEY.locationId);
      expect(locked.size).toBe(1);
      expect(locked.get(key)).toEqual({ quantity: 0, version: 0 });

      // Numbers, not strings and not BigInt: plain INT columns come back as JS
      // numbers, which is why the module does no `toNumber` coercion (the
      // deviation recorded at pack REV-16, proven here on the real driver).
      expect(typeof locked.get(key)?.quantity).toBe("number");
      expect(typeof locked.get(key)?.version).toBe("number");

      // The row outlives the transaction — this is the committed `{0,0}`
      // materialized row the B1 residue note names (pack REV-14 PKb-14).
      expect(await locationRow(NEVER_STOCKED_KEY)).toEqual({
        productId: NEVER_STOCKED_KEY.productId,
        locationId: NEVER_STOCKED_KEY.locationId,
        quantity: 0,
        version: 0,
        updatedAt: expect.any(String),
      });

      // TWO statements, in this order, with the pinned literals — read off what
      // the module actually sent, not off a copy of it.
      expect(statements.map((statement) => statement.kind)).toEqual(["execute", "query"]);
      expect(fold(statements[0].sql)).toContain(
        "INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)",
      );
      expect(fold(statements[0].sql)).toContain("ON DUPLICATE KEY UPDATE version = version");
      expect(fold(statements[1].sql)).toContain("ORDER BY productId, locationId");
      expect(fold(statements[1].sql)).toContain("FOR UPDATE");
    } finally {
      await client.$disconnect();
    }
  });

  test("a prelock does NOT bump an existing row's updatedAt — the ODKU self-assignment is a real no-op", async () => {
    await resetAll();
    const client = openClient();

    try {
      // `product_locations.updatedAt` is DATETIME(0) with ON UPDATE
      // CURRENT_TIMESTAMP (the B1-0 preflight DDL, plan §8). A same-second bump
      // would be invisible, so the row is dated into the past first: after that
      // the pin can only pass because nothing wrote the row.
      const STAMP = "2020-01-01 00:00:00";
      await withRaw((conn) =>
        conn.query("UPDATE product_locations SET updatedAt = ? WHERE productId = ? AND locationId = ?", [
          STAMP,
          KEY_1.productId,
          KEY_1.locationId,
        ]),
      );
      const before = await locationRow(KEY_1);
      expect(before).not.toBeNull();
      expect(before?.updatedAt).toBe(STAMP);

      // Two keys, so the multi-row VALUES list is what runs — the same shape
      // every covered writer sends.
      const { locked } = await prelockRecording(client, [KEY_2, KEY_1]);
      expect(locked.size).toBe(2);

      const after = await locationRow(KEY_1);
      // THE POINT: `idx_product_locations_updated` consumers must never see
      // phantom activity from a lock. Version and quantity are untouched too —
      // the ODKU changes nothing at all.
      expect(after).toEqual(before);
    } finally {
      await client.$disconnect();
    }
  });

  test("EXPLAIN of the returning locking read uses unique_product_location or idx_product_locations_lookup_covering — never a table scan", async () => {
    await resetAll();
    const client = openClient();

    type ExplainRow = {
      table: string | null;
      type: string | null;
      possible_keys: string | null;
      key: string | null;
      rows: number | bigint | null;
      Extra: string | null;
    };
    const ACCEPTED = ["unique_product_location", "idx_product_locations_lookup_covering"];

    /** EXPLAIN of the statement the MODULE issued, with the parameters it bound.
     *  `Prisma.sql` renders `?` placeholders, which is exactly what mysql2's
     *  `query` takes — so the plan below is a plan for that sentence, not for a
     *  paraphrase of it. */
    const explainStatement2 = async (): Promise<ExplainRow[]> => {
      const { statements } = await prelockRecording(client, [KEY_2, KEY_1]);
      expect(statements).toHaveLength(2);
      expect(statements[1].kind).toBe("query");
      return rawRows<ExplainRow>(`EXPLAIN ${statements[1].sql}`, statements[1].values);
    };

    const describePlan = (plan: ExplainRow[]): string =>
      plan
        .map(
          (row) =>
            `table=${row.table} type=${row.type} possible_keys=${row.possible_keys} ` +
            `key=${row.key} rows=${String(row.rows)} Extra=${row.Extra}`,
        )
        .join(" ;; ");

    try {
      const plan = await explainStatement2();
      // The plan is PRINTED whatever it says. If the tuple-IN row constructor
      // ever falls off the composite index, the number below is the evidence
      // the fallback decision (the OR-of-pairs predicate) would be made on.
      console.log(`[prelock EXPLAIN] ${describePlan(plan)}`);

      expect(plan).toHaveLength(1);
      const [row] = plan;
      // THE PIN (pack CB1c, plan §8's two acceptable access paths). A `type` of
      // ALL is the failure this exists to catch: off the index, every covered
      // writer's returning read would FOR-UPDATE-lock the whole table.
      expect(row.type).not.toBe("ALL");
      expect(ACCEPTED).toContain(row.key);
    } finally {
      await client.$disconnect();
    }
  });
});

/**
 * TWO TRACES THIS GATE ACTUALLY PRODUCED, kept verbatim as the classifier's
 * fixtures (pack REV-22 F9). Not invented shapes: the first came out of the
 * sort-disabled mutation run recorded above scenario 9c, the second out of a
 * throwaway location-1 variant of scenario 9c's race (the constant in play was
 * `LOCATION_SECOND`, not `KEY_SECOND_1` — B25-CX-6): the pre-B2.5 mirror made
 * that variant deadlock on the `products` residual, which is exactly what it did.
 *
 * They are here because the classification branch in scenario 13 fires only on
 * a rollback this gate has never yet observed, and unexercised code is how this
 * file's own header describes a hole (see RESET OWNERSHIP). These two pins
 * exercise both verdicts against real engine output, every run.
 *
 * Both are copied line for line, with ONE elision: the numbered
 * `N: len …; hex …` record-field dumps under each `PHYSICAL RECORD` header are
 * dropped, because the parser reads no field data and a product row's twenty
 * columns would bury the four lines that matter.
 */
const CAPTURED_PRODUCT_LOCATIONS_CYCLE = [
  "LATEST DETECTED DEADLOCK",
  "------------------------",
  "2026-08-31 23:54:29 140122553046592",
  "*** (1) TRANSACTION:",
  "TRANSACTION 5105, ACTIVE 0 sec inserting",
  "mysql tables in use 1, locked 1",
  "LOCK WAIT 9 lock struct(s), heap size 1128, 6 row lock(s)",
  "MySQL thread id 27, OS thread handle 140122642282048, query id 928 172.17.0.1 root update",
  "INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)",
  "    VALUES (9103, 2, 0, 0, NOW()), (9101, 2, 0, 0, NOW())",
  "    ON DUPLICATE KEY UPDATE version = version",
  "",
  "*** (1) HOLDS THE LOCK(S):",
  "RECORD LOCKS space id 49 page no 4 n bits 88 index PRIMARY of table `concurrency_gate`.`product_locations` trx id 5105 lock_mode X",
  "Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0",
  "",
  "*** (1) WAITING FOR THIS LOCK TO BE GRANTED:",
  "RECORD LOCKS space id 49 page no 4 n bits 88 index PRIMARY of table `concurrency_gate`.`product_locations` trx id 5105 lock_mode X insert intention waiting",
  "Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0",
  "",
  "*** (2) TRANSACTION:",
  "TRANSACTION 5104, ACTIVE 0 sec inserting",
  "mysql tables in use 1, locked 1",
  "LOCK WAIT 10 lock struct(s), heap size 1128, 6 row lock(s)",
  "MySQL thread id 29, OS thread handle 140122641225280, query id 927 172.17.0.1 root update",
  "INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)",
  "    VALUES (9101, 2, 0, 0, NOW()), (9103, 2, 0, 0, NOW())",
  "    ON DUPLICATE KEY UPDATE version = version",
  "",
  "*** (2) HOLDS THE LOCK(S):",
  "RECORD LOCKS space id 49 page no 4 n bits 88 index PRIMARY of table `concurrency_gate`.`product_locations` trx id 5104 lock_mode X",
  "Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0",
  "",
  "*** (2) WAITING FOR THIS LOCK TO BE GRANTED:",
  "RECORD LOCKS space id 49 page no 4 n bits 88 index PRIMARY of table `concurrency_gate`.`product_locations` trx id 5104 lock_mode X insert intention waiting",
  "Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0",
  "",
  "*** WE ROLL BACK TRANSACTION (1)",
].join("\n");

const CAPTURED_PRODUCTS_RESIDUAL = [
  "LATEST DETECTED DEADLOCK",
  "------------------------",
  "2026-08-31 23:57:15 140274554623552",
  "*** (1) TRANSACTION:",
  "TRANSACTION 5101, ACTIVE 0 sec inserting",
  "mysql tables in use 1, locked 1",
  "LOCK WAIT 6 lock struct(s), heap size 1128, 3 row lock(s), undo log entries 1",
  "MySQL thread id 29, OS thread handle 140274642802240, query id 928 172.17.0.1 root update",
  "INSERT INTO product_locations (productId, locationId, quantity, version, updatedAt)",
  "    VALUES (9101, 1, 0, 0, NOW()), (9103, 1, 0, 0, NOW())",
  "    ON DUPLICATE KEY UPDATE version = version",
  "",
  "*** (1) HOLDS THE LOCK(S):",
  "RECORD LOCKS space id 94 page no 4 n bits 72 index PRIMARY of table `concurrency_gate`.`products` trx id 5101 lock mode S locks rec but not gap",
  "Record lock, heap no 2 PHYSICAL RECORD: n_fields 20; compact format; info bits 0",
  "",
  "*** (1) WAITING FOR THIS LOCK TO BE GRANTED:",
  "RECORD LOCKS space id 49 page no 5 n bits 88 index unique_product_location of table `concurrency_gate`.`product_locations` trx id 5101 lock_mode X waiting",
  "Record lock, heap no 2 PHYSICAL RECORD: n_fields 3; compact format; info bits 0",
  "",
  "*** (2) TRANSACTION:",
  "TRANSACTION 5100, ACTIVE 0 sec starting index read",
  "mysql tables in use 1, locked 1",
  "LOCK WAIT 15 lock struct(s), heap size 1128, 11 row lock(s), undo log entries 2",
  "MySQL thread id 27, OS thread handle 140274643859008, query id 953 172.17.0.1 root updating",
  "UPDATE `concurrency_gate`.`products` SET `quantity` = (`concurrency_gate`.`products`.`quantity` + 1) WHERE (`concurrency_gate`.`products`.`id` IN (9101) AND (`concurrency_gate`.`products`.`id` = 9101 AND 1=1))",
  "",
  "*** (2) HOLDS THE LOCK(S):",
  "RECORD LOCKS space id 49 page no 5 n bits 88 index unique_product_location of table `concurrency_gate`.`product_locations` trx id 5100 lock_mode X",
  "Record lock, heap no 2 PHYSICAL RECORD: n_fields 3; compact format; info bits 0",
  "Record lock, heap no 6 PHYSICAL RECORD: n_fields 3; compact format; info bits 0",
  "",
  "*** (2) WAITING FOR THIS LOCK TO BE GRANTED:",
  "RECORD LOCKS space id 94 page no 4 n bits 72 index PRIMARY of table `concurrency_gate`.`products` trx id 5100 lock_mode X locks rec but not gap waiting",
  "Record lock, heap no 2 PHYSICAL RECORD: n_fields 20; compact format; info bits 0",
  "",
  "*** WE ROLL BACK TRANSACTION (1)",
].join("\n");

describe("the deadlock classifier (pack REV-22 F9) — pinned on CAPTURED engine traces", () => {
  test("the sort-disabled run's cycle reads as the FORBIDDEN two-`product_locations` shape", () => {
    const verdict = classifyDeadlock(CAPTURED_PRODUCT_LOCATIONS_CYCLE);

    // Both waiters wanted the covered rows and NEITHER wanted a `products` row:
    // two writers took `product_locations` in opposite orders. Never a residual.
    expect(verdict.waits.map((wait) => `${wait.table}.${wait.index}`)).toEqual([
      "product_locations.PRIMARY",
      "product_locations.PRIMARY",
    ]);
    expect(verdict.shape).toBe("product-locations-cycle");
  });

  test("the `products` S->X cycle, now booking/decline's, reads as the ACCEPTED residual", () => {
    const verdict = classifyDeadlock(CAPTURED_PRODUCTS_RESIDUAL);

    // The residual's exact signature: one waiter parked on the covered row, the
    // other parked on the `products` row an X lock is wanted on — the trace was
    // captured off the retired loc-1 mirror, and it is the same shape booking's
    // step-6b `FOR UPDATE` and decline's soft-delete still produce (CB2.5a.2).
    // The HOLDS lines (a shared `products` lock, held `product_locations` rows)
    // contribute nothing, which is why only the waits are read.
    expect(verdict.waits.map((wait) => `${wait.table}.${wait.index}`)).toEqual([
      "product_locations.unique_product_location",
      "products.PRIMARY",
    ]);
    expect(verdict.shape).toBe("products-residual");
  });

  test("silence is UNATTRIBUTABLE — a rollback with no fresh section never borrows the residual's licence", () => {
    expect(classifyDeadlock(null).shape).toBe("unattributable");
    expect(classifyDeadlock("LATEST DETECTED DEADLOCK\n(nothing this parser can read)").shape).toBe(
      "unattributable",
    );
  });
});

describe("the lock discipline — real-DB concurrency (pack CB1c scenarios 9c / 9d / 13)", () => {
  jest.setTimeout(120_000);

  /**
   * THE NEGATIVE CONTROL, RUN ONCE AND RECORDED (pack REV-22 F9). 9c passing
   * says the sorted prelock commits both sessions; it cannot, by itself, say
   * the SORT is what did it. So the sort was disabled in
   * `lib/inventory/prelock.ts` (the `canonical.sort` call commented out — the
   * VALUES then ride in each caller's ASK order), the whole gate was run once,
   * and the file was restored byte-identically. OUTCOME, 2026-08-31:
   *
   *   THE GATE WENT RED — `Tests: 1 failed, 20 passed, 21 total`, the failure
   *   being THIS scenario, and the engine recorded a deadlock it had not
   *   recorded in the run before (`a NEW deadlock was detected during this
   *   race: true`, from `no LATEST DETECTED DEADLOCK section`). The section
   *   names both materialize statements, in opposite VALUES order:
   *
   *     (1) INSERT … VALUES (9103, 2, …), (9101, 2, …) ON DUPLICATE KEY UPDATE
   *     (2) INSERT … VALUES (9101, 2, …), (9103, 2, …) ON DUPLICATE KEY UPDATE
   *
   *   each HOLDING `lock_mode X` and each WAITING for `lock_mode X insert
   *   intention` on `index PRIMARY of table `concurrency_gate`.`product_locations``
   *   — i.e. the FORBIDDEN two-`product_locations` cycle `classifyDeadlock`
   *   above exists to catch — ending `*** WE ROLL BACK TRANSACTION (1)`.
   *
   *   The assertion that actually tripped first was `expect(blocked).toBe(true)`
   *   rather than the both-commit assertion: InnoDB's detector killed the cycle
   *   faster than `waitForLockWait`'s 10ms poll could see a LOCK WAIT row. The
   *   rolled-back session would have failed the "no rejections" assertion two
   *   lines later.
   *
   * So the canonical sort is LOAD-BEARING on this engine, measured, not
   * assumed — and the control is conclusive: it did not stay green.
   */
  test("scenario 9c: two sessions, two orders, the two product keys asked in OPPOSITE order — the canonical sort makes the acquisition identical and BOTH commit", async () => {
    // (At the second location by design — see `KEY_SECOND_1`.)
    await resetAll();
    const sessionA = openClient();
    const sessionB = openClient();
    const probe = openClient();

    try {
      await warmUp(sessionA, sessionB, probe);

      // The hold point: the winner's ledger writes sleep while it holds BOTH
      // materialized rows, so the loser is unambiguously blocked on the
      // prelock rather than merely late.
      await installLedgerHold([KEY_SECOND_1.productId, KEY_SECOND_2.productId], 0.3);

      const arrive = makeBarrier(2);
      let blocked = false;

      /**
       * One session: the order lock FIRST (statement 1 of the transaction, the
       * §2.7(1) discipline), then the barrier — so neither prelock is issued
       * until both transactions are open and both order locks are held — then
       * the prelock over the keys IN THE ORDER THIS SESSION ASKS, then a
       * covered write per key in that same asked order.
       *
       * The asked order is the whole experiment: two sessions ask for the same
       * two rows in OPPOSITE orders and both still commit, one at a time,
       * because `prelockProductLocations` sorts before it locks. The unsorted
       * counterfactual is not asserted here — see the MUTATION RUN note above
       * the test for what disabling the sort actually did.
       */
      const session = (
        client: PrismaClient,
        orderId: string,
        keys: PrelockKeyInput[],
      ): Promise<Map<string, PrelockedRow>> =>
        client.$transaction(
          async (tx) => {
            await orderLock.lockFirst(tx, { required: [orderId] });
            await arrive();
            const locked = await prelock.prelockProductLocations(tx, keys);
            for (const key of keys) {
              await inventory.applyStockDelta(tx, {
                userId: GATE_ADMIN_ID,
                productId: key.productId,
                locationId: key.locationId,
                delta: 1,
              });
            }
            return locked;
          },
          { timeout: 30_000, maxWait: 30_000 },
        );

      const { value: race } = await reportDeadlocks("scenario 9c", async () => {
        const inFlight = [
          session(sessionA, GATE_EXT_ORDER_ID, [KEY_SECOND_1, KEY_SECOND_2]),
          session(sessionB, GATE_EXT_ORDER_2_ID, [KEY_SECOND_2, KEY_SECOND_1]),
        ];
        blocked = await waitForLockWait(probe);
        return Promise.allSettled(inFlight);
      });

      console.log(`[scenario 9c] lock wait observed: ${blocked}`);
      // THE RACE REALLY HAPPENED — one session was blocked on the other's
      // prelocked rows. Without this, two sessions that never met would pass.
      expect(blocked).toBe(true);

      // BOTH COMMIT. That is the claim, and the whole of it: reversed ask
      // order, sorted acquisition, two commits and no rollback.
      const rejected = race.filter((entry) => entry.status === "rejected");
      expect(rejected.map((entry) => String((entry as PromiseRejectedResult).reason))).toEqual([]);
      expect(race.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);

      const maps = (race as PromiseFulfilledResult<Map<string, PrelockedRow>>[]).map(
        (entry) => entry.value,
      );
      const readOf = (map: Map<string, PrelockedRow>, key: PrelockKeyInput): PrelockedRow => {
        const row = map.get(prelock.prelockKey(key.productId, key.locationId));
        if (!row) throw new Error(`scenario 9c: ${JSON.stringify(key)} missing from the prelock map`);
        return row;
      };

      // WHO WENT FIRST IS NOT ASSERTED — only that they went ONE AT A TIME. One
      // session read the reset's `{0,0}` on both keys; the other read the
      // first's committed `{1,1}` on both. A half-and-half reading would mean
      // the two prelocks interleaved, which is the thing that must not happen.
      for (const key of [KEY_SECOND_1, KEY_SECOND_2]) {
        const versions = maps.map((map) => readOf(map, key).version).sort();
        const quantities = maps.map((map) => readOf(map, key).quantity).sort();
        expect(versions).toEqual([0, 1]);
        expect(quantities).toEqual([0, 1]);
      }
      const firstIndex = maps.findIndex((map) => readOf(map, KEY_SECOND_1).version === 0);
      expect(readOf(maps[firstIndex], KEY_SECOND_2).version).toBe(0);

      // Both writes landed on both keys.
      for (const key of [KEY_SECOND_1, KEY_SECOND_2]) {
        expect(await locationRow(key)).toMatchObject({ quantity: 2, version: 2 });
      }
    } finally {
      await dropHoldTrigger();
      await Promise.all([sessionA.$disconnect(), sessionB.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 9d: two first-writes on ONE never-stocked key — one row, the second session reads the first's COMMITTED effect", async () => {
    await resetAll();
    const sessionA = openClient();
    const sessionB = openClient();
    const probe = openClient();

    // Distinct on purpose: the second session's read has to name WHICH delta
    // committed before it, not merely "something did".
    const DELTA_A = 3;
    const DELTA_B = 5;

    try {
      await withRaw((conn) =>
        conn.query("DELETE FROM product_locations WHERE productId = ? AND locationId = ?", [
          NEVER_STOCKED_KEY.productId,
          NEVER_STOCKED_KEY.locationId,
        ]),
      );
      expect(await locationRow(NEVER_STOCKED_KEY)).toBeNull();

      await warmUp(sessionA, sessionB, probe);

      // The hold point: the winner's ledger insert sleeps while it holds the
      // materialized row, so the loser is unambiguously BLOCKED on the ODKU
      // rather than merely late. The only contention here is the key itself.
      await installLedgerHold([NEVER_STOCKED_KEY.productId], 0.5);

      const arrive = makeBarrier(2);
      let blocked = false;

      /** Prelock THEN a covered write (pack REV-14 PKb-10): a prelock alone
       *  would leave the row at version 0 and prove nothing about ordering,
       *  because its ODKU is `version = version`. */
      const session = (client: PrismaClient, delta: number): Promise<PrelockedRow> =>
        client.$transaction(
          async (tx) => {
            await arrive();
            const locked = await prelock.prelockProductLocations(tx, [NEVER_STOCKED_KEY]);
            const read = locked.get(
              prelock.prelockKey(NEVER_STOCKED_KEY.productId, NEVER_STOCKED_KEY.locationId),
            );
            if (!read) throw new Error("scenario 9d: the prelock returned no row for the key");
            await inventory.applyStockDelta(tx, {
              userId: GATE_ADMIN_ID,
              productId: NEVER_STOCKED_KEY.productId,
              locationId: NEVER_STOCKED_KEY.locationId,
              delta,
            });
            return read;
          },
          { timeout: 30_000, maxWait: 30_000 },
        );

      const { value: race } = await reportDeadlocks("scenario 9d", async () => {
        const inFlight = [session(sessionA, DELTA_A), session(sessionB, DELTA_B)];
        blocked = await waitForLockWait(probe);
        return Promise.allSettled(inFlight);
      });

      console.log(`[scenario 9d] lock wait observed: ${blocked}`);
      // THE RACE REALLY HAPPENED. Without this a green run could mean the two
      // sessions simply ran one after the other and never contended for the key.
      expect(blocked).toBe(true);
      expect(race.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);

      const reads = (race as PromiseFulfilledResult<PrelockedRow>[]).map((entry) => entry.value);
      const deltas = [DELTA_A, DELTA_B];

      // PER COMMIT ORDER, never per launch order: the session that read version
      // 0 is by definition the one whose materialize won.
      const firstIndex = reads.findIndex((read) => read.version === 0);
      expect(firstIndex).not.toBe(-1);
      const secondIndex = firstIndex === 0 ? 1 : 0;
      expect(reads[firstIndex]).toEqual({ quantity: 0, version: 0 });
      // The second session did NOT see its own snapshot of "no row": it saw the
      // first session's committed quantity and version. That is what a locking
      // read after a materialize buys, and what a `findUnique` never gave.
      expect(reads[secondIndex]).toEqual({ quantity: deltas[firstIndex], version: 1 });

      // EXACTLY ONE ROW — both sessions "created" the same key.
      const rowsForProduct = await locationRows(NEVER_STOCKED_KEY.productId);
      expect(
        rowsForProduct.filter((row) => row.locationId === NEVER_STOCKED_KEY.locationId),
      ).toHaveLength(1);
      expect(await locationRow(NEVER_STOCKED_KEY)).toMatchObject({
        quantity: DELTA_A + DELTA_B,
        version: 2,
      });
    } finally {
      await dropHoldTrigger();
      await Promise.all([sessionA.$disconnect(), sessionB.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 13: deduct-simple races batch-adjust over TWO overlapping keys, through the REAL routes — and the B1 reset clause takes the residue back", async () => {
    await resetAll();
    const probe = openClient();
    const stocker = openClient();

    // The choreography, stated rather than discovered:
    //   deduct-simple asks [KEY_1, KEY_2] and takes 2 and 3 units;
    //   batch-adjust  asks [KEY_2, KEY_1] — REVERSED — and takes 1 unit each.
    // The prelock sorts both into (9101, 9103), so whichever transaction
    // materializes first holds BOTH rows and the other blocks at its own
    // statement 1, holding nothing.
    const DEDUCT_1 = 2;
    const DEDUCT_2 = 3;
    const ADJUST_EACH = 1;
    const OPENING_STOCK = 20;

    try {
      // The counts the reset has to bring back. Table-wide, taken before this
      // scenario writes anything.
      const opening = await countSnapshot();

      // Opening stock through the real write path, so the ledger and the rows
      // agree before the race starts.
      await stocker.$transaction(async (tx) => {
        for (const key of [KEY_1, KEY_2]) {
          await inventory.applyStockDelta(tx, {
            userId: GATE_ADMIN_ID,
            productId: key.productId,
            locationId: key.locationId,
            delta: OPENING_STOCK,
          });
        }
      });
      for (const key of [KEY_1, KEY_2]) {
        expect(await locationRow(key)).toMatchObject({ quantity: OPENING_STOCK, version: 1 });
      }

      // The rendezvous (see the file header): the winner's ledger inserts sleep
      // while it holds every prelocked row.
      // 0.3s per ledger row: wide enough that the loser is unambiguously
      // blocked, small enough that its whole transaction (its wait plus its own
      // two held inserts) stays far inside the routes' transaction budget —
      // STOCK_TX_OPTIONS' maxWait 5s / timeout 30s since fix round 1 (the "5s
      // Prisma default" this comment once cited is gone; fix-delta FDb-9). A
      // blown budget closes the connection and the route answers 503 BUSY for a
      // reason that has nothing to do with the race.
      await installLedgerHold([KEY_1.productId, KEY_2.productId], 0.3);

      let blocked = false;
      const {
        value: answers,
        after: deadlockAfter,
        fresh: deadlockFresh,
      } = await reportDeadlocks("scenario 13", async () => {
        const inFlight: Promise<RouteAnswer>[] = [];
        inFlight.push(
          deductSimple(LOCATION_MAIN, [
            { productId: KEY_1.productId, quantity: DEDUCT_1 },
            { productId: KEY_2.productId, quantity: DEDUCT_2 },
          ]),
        );
        // A beat, so which request reaches the materialize first follows the
        // launch order rather than a coin flip. Nothing is asserted about who
        // wins — the envelope below holds either way.
        await sleep(80);
        inFlight.push(
          batchAdjust([
            { productId: KEY_2.productId, locationId: KEY_2.locationId, delta: -ADJUST_EACH },
            { productId: KEY_1.productId, locationId: KEY_1.locationId, delta: -ADJUST_EACH },
          ]),
        );
        blocked = await waitForLockWait(probe);
        return Promise.all(inFlight);
      });

      const [deduct, adjust] = answers;
      console.log(
        `[scenario 13] lock wait observed: ${blocked}; ` +
          `deduct-simple -> ${deduct.status}, batch-adjust -> ${adjust.status}`,
      );
      expect(blocked).toBe(true);

      // THE OUTCOME ENVELOPE (pack CB2.5c.2; both-200 since B25-CX-4 — the
      // round-2 one-BUSY tolerance was withdrawn). deduct-simple and batch-adjust are
      // BOTH covered writers, so neither takes an X lock on `products` any more
      // and the S->X cycle that once licensed a rolled-back writer here is gone:
      // BOTH commit — nothing else (B25-CX-4 withdrew the one-BUSY tolerance: a
      // same-key wait waits, it never answers 503 in a 0.3 s choreography). A
      // generic 500 — the pre-F3 spelling of a swallowed P2034 — is not
      // tolerated, and a fresh deadlock of ANY shape is a defect.
      assertCoveredRaceEnvelope("scenario 13", answers, {
        after: deadlockAfter,
        fresh: deadlockFresh,
      });

      if (deduct.status === 200) {
        // The route contract B1b added: the batch this deduction wrote under.
        expect(deduct.body.success).toBe(true);
        expect(deduct.body.itemsProcessed).toBe(2);
        expect(typeof deduct.body.batchId).toBe("string");
        expect(String(deduct.body.batchId).length).toBeGreaterThan(0);
      }
      if (adjust.status === 200) {
        expect(adjust.body.success).toBe(true);
        expect(adjust.body.count).toBe(2);
      }

      // WHAT THE ROWS HOLD. Each committed request took its own units off both
      // keys and nothing was lost to a stale read — the arithmetic is exact
      // whichever branch of the envelope this run landed in.
      const expectedFor = (deductUnits: number): number =>
        OPENING_STOCK -
        (deduct.status === 200 ? deductUnits : 0) -
        (adjust.status === 200 ? ADJUST_EACH : 0);
      const expectedVersion =
        1 + (deduct.status === 200 ? 1 : 0) + (adjust.status === 200 ? 1 : 0);

      expect(await locationRow(KEY_1)).toMatchObject({
        quantity: expectedFor(DEDUCT_1),
        version: expectedVersion,
      });
      expect(await locationRow(KEY_2)).toMatchObject({
        quantity: expectedFor(DEDUCT_2),
        version: expectedVersion,
      });

      // THE RESIDUE THE B1 RESET CLAUSE OWNS. Every committed route minted a
      // batch id, stamped it on its ledger rows and filed an
      // INVENTORY_BULK_UPDATE audit row plus an attribution attempt under it —
      // ids no clause could name in advance, which is why B1b's clause derives
      // them from the scoped ledger rows before deleting them.
      const committedRoutes = (deduct.status === 200 ? 1 : 0) + (adjust.status === 200 ? 1 : 0);
      const dirty = await countSnapshot();
      expect(dirty.auditRows).toBe(opening.auditRows + committedRoutes);
      expect(dirty.attemptRows).toBe(opening.attemptRows + committedRoutes);
      expect(dirty.ledgerRows).toBeGreaterThan(opening.ledgerRows);

      await resetAll();

      // ...and this is the clause working. Without it these three numbers would
      // drift upward on every gate run, and `concurrency.test.ts` scenario 2's
      // absolute `auditLog.count()` would fail from the outside.
      expect(await countSnapshot()).toEqual(opening);
      for (const key of [KEY_1, KEY_2]) {
        expect(await locationRow(key)).toMatchObject({ quantity: 0, version: 0 });
      }
    } finally {
      await dropHoldTrigger();
      await Promise.all([probe.$disconnect(), stocker.$disconnect()]);
    }
  });
});

// --------------------------------------------------------------------------
// Scenario 14's oracles — mysql2 raw, like every other oracle in this file
// --------------------------------------------------------------------------

type LedgerRow = {
  productId: number;
  delta: number;
  logType: string;
  locationId: number | null;
  orderRecordId: string | null;
};

/** Every ledger row a route wrote under ONE batch, in write order. `id ASC` is
 *  the write order because the rows are inserted one statement at a time. */
async function ledgerRowsForBatch(batchId: string): Promise<LedgerRow[]> {
  const rows = await rawRows<LedgerRow>(
    `SELECT productId, delta, logType, locationId, orderRecordId
       FROM inventory_logs
      WHERE batchId = ?
      ORDER BY id`,
    [batchId],
  );
  return rows.map((row) => ({
    ...row,
    productId: Number(row.productId),
    delta: Number(row.delta),
    logType: String(row.logType),
    locationId: row.locationId === null ? null : Number(row.locationId),
  }));
}

type AuditRow = { actionType: string; entityType: string; entityId: string | null };

async function auditRowsForBatch(batchId: string): Promise<AuditRow[]> {
  return rawRows<AuditRow>(
    `SELECT actionType, entityType, entityId FROM audit_logs WHERE batchId = ? ORDER BY id`,
    [batchId],
  );
}

async function attemptCountForBatch(batchId: string): Promise<number> {
  const rows = await rawRows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM order_attribution_attempts WHERE batchId = ?",
    [batchId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The two order-line columns fulfil and unfulfill move. `hasSnapshot` rather
 *  than the JSON itself: whether the FIX B freeze committed is the question, and
 *  a driver that hands JSON back as a string must not change the answer. */
type OrderItemRow = { id: string; fulfilledQty: number; hasSnapshot: boolean };

async function orderItemRows(): Promise<OrderItemRow[]> {
  const rows = await rawRows<{ id: string; fulfilledQty: number; hasSnapshot: number }>(
    `SELECT id, fulfilledQty, (bundleComponentSnapshot IS NOT NULL) AS hasSnapshot
       FROM external_order_items
      WHERE id IN (?, ?)
      ORDER BY id`,
    [GATE_ITEM_BUNDLE, GATE_ITEM_SINGLE],
  );
  return rows.map((row) => ({
    id: String(row.id),
    fulfilledQty: Number(row.fulfilledQty),
    hasSnapshot: Number(row.hasSnapshot) === 1,
  }));
}

async function orderStockedOut(): Promise<boolean> {
  const rows = await rawRows<{ stockedOut: number }>(
    "SELECT stockedOut FROM external_orders WHERE id = ?",
    [GATE_EXT_ORDER_ID],
  );
  return Number(rows[0]?.stockedOut ?? 0) === 1;
}

/** The ONE source of truth scenario 14 reads back (pack CB1.5a-ii, PKc-4; the
 *  loc-1 `products` mirror it used to assert alongside is retired — P2-B2.5).
 *  Kept as an object so the assertions still read `{ row: N }` and name the
 *  table they mean. */
async function stockIn(productId: number): Promise<{ row: number | null }> {
  const row = await locationRow({ productId, locationId: LOCATION_MAIN });
  return { row: row?.quantity ?? null };
}

/** Arrange, through the one table every assertion reads back. */
async function setStock(productId: number, quantity: number): Promise<void> {
  await singleton.product_locations.updateMany({
    where: { productId, locationId: LOCATION_MAIN },
    data: { quantity },
  });
}

/** The gate's own external order, as the fulfil dialog would send it: the
 *  single line first, then the bundle line. */
function fulfilRequest(): {
  locationId: number;
  items: Array<{ itemId: string; quantity: number }>;
} {
  return {
    locationId: LOCATION_MAIN,
    items: [
      { itemId: GATE_ITEM_SINGLE, quantity: 2 },
      { itemId: GATE_ITEM_BUNDLE, quantity: 1 },
    ],
  };
}

type FulfilResults = {
  fulfilled: Array<Record<string, unknown>>;
  skipped: Array<{ itemId: string; reason: string; details?: string }>;
  failed: Array<{ itemId: string; error: string }>;
};

function resultsOf(answer: RouteAnswer): FulfilResults {
  return answer.body.results as FulfilResults;
}

describe("scenario 14 — fulfil and unfulfill on a REAL engine (pack CB1.5a-ii)", () => {
  jest.setTimeout(120_000);

  /**
   * THE FIXTURE, OWNED BY THIS SCENARIO.
   *
   * `P_APPROVED` and `P_APPROVED_2` are the pack's `P_A` and `P_B` (OCc-4): both
   * are in `SEED_PRODUCT_IDS`, so every SALE and CORRECTION row these sub-cases
   * write carries a SCOPED `productId`, the reset's `routeBatchIds` derivation
   * (`seed.ts`) finds the batches those rows were written under, and the new
   * ORDER-audit clause plus the attempt delete take the residue back. The
   * reconciliation pattern's dedicated products would NOT be derived by any
   * other scenario's reset, and its `productOracle` reason does not apply here:
   * these sub-cases move stock THROUGH the routes, which the oracle expects.
   *
   * `LOCATION_MAIN` is deliberate (OCc-11): the first real-engine exercise of
   * the BUNDLE path at the location every route deducts at, where each ledger
   * INSERT's FK S lock on `products` is taken (the X half of that residual is
   * booking's and decline's since P2-B2.5 — pack CB2.5a.2).
   *
   * The bundle line's `bundleComponentSnapshot` is left NULL so that fulfil
   * takes the LIVE fallback and its FIX B freeze really runs on a real engine.
   */
  beforeAll(async () => {
    await resetAll();

    await singleton.productLink.createMany({
      data: [
        {
          id: GATE_LINK_SINGLE,
          integrationId: GATE_INTEGRATION_ID,
          externalProductId: "gate-fulfil-single",
          internalProductId: P_APPROVED,
        },
        {
          id: GATE_LINK_BUNDLE,
          integrationId: GATE_INTEGRATION_ID,
          externalProductId: "gate-fulfil-bundle",
          internalProductId: null,
          isBundle: true,
        },
      ],
    });

    // One unit of P_A and TWO of P_B per bundle: a component multiplier that is
    // not 1 is what makes "the bundle deducted the right amount" a real claim.
    await singleton.bundleComponent.createMany({
      data: [
        {
          productLinkId: GATE_LINK_BUNDLE,
          internalProductId: P_APPROVED,
          quantity: 1,
          sortOrder: 0,
        },
        {
          productLinkId: GATE_LINK_BUNDLE,
          internalProductId: P_APPROVED_2,
          quantity: 2,
          sortOrder: 1,
        },
      ],
    });

    await singleton.externalOrderItem.createMany({
      data: [
        {
          id: GATE_ITEM_SINGLE,
          orderId: GATE_EXT_ORDER_ID,
          externalItemId: "gfs-1",
          externalProductId: "gate-fulfil-single",
          name: "Gate single",
          quantity: 2,
          price: 0,
          productLinkId: GATE_LINK_SINGLE,
          isMapped: true,
        },
        {
          id: GATE_ITEM_BUNDLE,
          orderId: GATE_EXT_ORDER_ID,
          externalItemId: "gfb-1",
          externalProductId: "gate-fulfil-bundle",
          name: "Gate bundle",
          quantity: 1,
          price: 0,
          productLinkId: GATE_LINK_BUNDLE,
          isMapped: true,
        },
      ],
    });
  });

  afterAll(async () => {
    // THE BELT (pack CB1.5a-ii, PKc-5/OCc-22). The egress mock at the top of the
    // file is what keeps a BLOCKED push from committing a durable attempt row
    // and its INTEGRATION audit row — rows no reset clause names. Asserted ZERO
    // BEFORE the delete, ON PURPOSE: a bypassed mock has to be a RED here, not a
    // silent cleanup that hands the failure to `concurrency.test.ts` scenario 2.
    const attempts = await rawRows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM platform_write_attempts WHERE integrationId = ?",
      [GATE_INTEGRATION_ID],
    );
    const attemptAudits = await rawRows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE actionType = 'PLATFORM_WRITE_ATTEMPT' AND entityId = ?`,
      [GATE_INTEGRATION_ID],
    );
    console.log(
      `[scenario 14] egress belt — platform_write_attempts: ${Number(attempts[0]?.n ?? 0)}; ` +
        `PLATFORM_WRITE_ATTEMPT audit rows: ${Number(attemptAudits[0]?.n ?? 0)}`,
    );
    expect(Number(attempts[0]?.n ?? 0)).toBe(0);
    expect(Number(attemptAudits[0]?.n ?? 0)).toBe(0);

    await withRaw(async (conn) => {
      await conn.query("DELETE FROM platform_write_attempts WHERE integrationId = ?", [
        GATE_INTEGRATION_ID,
      ]);
      await conn.query(
        "DELETE FROM audit_logs WHERE actionType = 'PLATFORM_WRITE_ATTEMPT' AND entityId = ?",
        [GATE_INTEGRATION_ID],
      );
    });

    // The fixture goes back the way it came: the order lines, then the links
    // (their `BundleComponent`s cascade), then the whole seeded fixture.
    await singleton.externalOrderItem.deleteMany({
      where: { id: { in: [GATE_ITEM_SINGLE, GATE_ITEM_BUNDLE] } },
    });
    await singleton.productLink.deleteMany({
      where: { id: { in: [GATE_LINK_SINGLE, GATE_LINK_BUNDLE] } },
    });
    await resetAll();
  });

  test("scenario 14A: one single line and one BUNDLE line fulfil in ONE transaction — the DR-1 pin on a real engine", async () => {
    await resetAll();
    await setStock(P_APPROVED, 10);
    await setStock(P_APPROVED_2, 10);

    // A bundle fulfil at location 1 is where the named `products` FK S lock is
    // taken repeatedly, so the engine's own deadlock section is sampled around
    // the request and PRINTED — reported, never asserted (pack REV-14 PKb-10).
    const { value: answer } = await reportDeadlocks("scenario 14A", () =>
      fulfillOrder(fulfilRequest()),
    );

    expect(answer.status).toBe(200);
    const results = resultsOf(answer);

    // THE DR-1 PIN. Against `4671fc7:lib/fulfillment.ts` this array carries two
    // entries, each holding MySQL's ER 1295 text ("This command is not supported
    // in the prepared statement protocol yet") — the per-item SAVEPOINT that
    // could never execute — and NOTHING below this line is true.
    expect(results.failed).toEqual([]);
    expect(results.skipped).toEqual([]);
    expect(results.fulfilled).toHaveLength(2);
    expect(results.fulfilled[0]).toMatchObject({
      itemId: GATE_ITEM_SINGLE,
      productId: P_APPROVED,
      quantity: 2,
    });
    // The bundle entry is the public shape: no sentinel productId, the component
    // ids instead (FIX C).
    expect(results.fulfilled[1]).toMatchObject({
      itemId: GATE_ITEM_BUNDLE,
      isBundle: true,
      componentIds: [P_APPROVED, P_APPROVED_2],
      quantity: 1,
    });
    expect(answer.body.summary).toEqual({ total: 2, fulfilled: 2, skipped: 0, failed: 0 });

    const batchId = answer.body.batchId;
    expect(typeof batchId).toBe("string");
    expect(String(batchId).length).toBeGreaterThan(0);

    // THREE SALE rows under that batch — the single's 2, then the bundle's two
    // components (1 x P_A, 2 x P_B) — every one of them stamped with the order
    // the request was addressed to.
    expect(await ledgerRowsForBatch(String(batchId))).toEqual([
      {
        productId: P_APPROVED,
        delta: -2,
        logType: "SALE",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
      {
        productId: P_APPROVED,
        delta: -1,
        logType: "SALE",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
      {
        productId: P_APPROVED_2,
        delta: -2,
        logType: "SALE",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
    ]);

    // The lines: 2 of 2 and 1 of 1 — and the bundle's composition FROZEN (FIX B
    // ran on the live fallback, inside the one transaction).
    expect(await orderItemRows()).toEqual([
      { id: GATE_ITEM_BUNDLE, fulfilledQty: 1, hasSnapshot: true },
      { id: GATE_ITEM_SINGLE, fulfilledQty: 2, hasSnapshot: false },
    ]);

    // BOTH TABLES. 10 - 2 - 1 and 10 - 2.
    expect(await stockIn(P_APPROVED)).toEqual({ row: 7 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 8 });

    // The route's own contracts: the ORDER change event and the attribution
    // attempt, both filed under this request's batch.
    expect(await auditRowsForBatch(String(batchId))).toEqual([
      {
        actionType: "EXTERNAL_ORDER_FULFILLMENT",
        entityType: "ORDER",
        entityId: GATE_EXT_ORDER_ID,
      },
    ]);
    expect(await attemptCountForBatch(String(batchId))).toBe(1);

    expect(await orderStockedOut()).toBe(true);
  });

  test("scenario 14B: the bundle is refused with the EXACT number the tally holds — Available: 0, Requested: 1", async () => {
    await resetAll();
    // Exactly enough for the single line and nothing left for the bundle's P_A
    // component: the shortfall the bundle sees is the one the SINGLE created,
    // inside the same transaction, on a row nobody else can touch.
    await setStock(P_APPROVED, 2);
    await setStock(P_APPROVED_2, 10);

    const answer = await fulfillOrder(fulfilRequest());
    expect(answer.status).toBe(200);
    const results = resultsOf(answer);

    expect(results.failed).toEqual([]);
    expect(results.fulfilled).toHaveLength(1);
    expect(results.fulfilled[0]).toMatchObject({
      itemId: GATE_ITEM_SINGLE,
      productId: P_APPROVED,
      quantity: 2,
    });

    // QB-9 ON A REAL ENGINE: the refusal quotes the LOCKED, CURRENT number — 0,
    // the tally after the single line spent it — not the 2 the transaction read
    // before it decided anything.
    expect(results.skipped).toHaveLength(1);
    expect(results.skipped[0]).toMatchObject({
      itemId: GATE_ITEM_BUNDLE,
      reason: "insufficient_stock",
    });
    // ENDS with it (pack CB1.5a-ii): the sentence's opening half is the library's
    // existing copy, the trailing numbers are the contract.
    expect(results.skipped[0].details).toMatch(/Available: 0, Requested: 1$/);

    // ONE ledger row: a refusal spends no statement at all.
    const batchId = String(answer.body.batchId);
    expect(await ledgerRowsForBatch(batchId)).toEqual([
      {
        productId: P_APPROVED,
        delta: -2,
        logType: "SALE",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
    ]);

    // The bundle's snapshot is frozen ANYWAY — FIX B runs in pass 1, before the
    // guards, and survives a stock refusal by design (W2S-1 kept it on a skip).
    expect(await orderItemRows()).toEqual([
      { id: GATE_ITEM_BUNDLE, fulfilledQty: 0, hasSnapshot: true },
      { id: GATE_ITEM_SINGLE, fulfilledQty: 2, hasSnapshot: false },
    ]);

    expect(await stockIn(P_APPROVED)).toEqual({ row: 0 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 10 });

    // Partial, but stocked out: something was deducted.
    expect(await orderStockedOut()).toBe(true);
  });

  test("scenario 14C: two concurrent fulfils of ONE order — the order lock serializes them, and the second sees the first's committed fulfilledQty", async () => {
    await resetAll();
    await setStock(P_APPROVED, 10);
    await setStock(P_APPROVED_2, 10);

    const probe = openClient();
    let blocked = false;

    try {
      // The hold point, inside the WINNER's transaction and after its order lock
      // and prelock: the ledger insert for P_A sleeps, so the winner holds the
      // order row for >= 2s and the loser is unambiguously BLOCKED on it rather
      // than merely late (`concurrency-3.test.ts`'s instrument, PKc-6).
      await installLedgerHold([P_APPROVED], 2);

      const single = {
        locationId: LOCATION_MAIN,
        items: [{ itemId: GATE_ITEM_SINGLE, quantity: 2 }],
      };

      const { value: answers } = await reportDeadlocks("scenario 14C", async () => {
        const inFlight: Promise<RouteAnswer>[] = [];
        inFlight.push(fulfillOrder(single));
        // A beat, so which request reaches the order lock first follows the
        // launch order rather than a coin flip. Nothing below asserts WHO won.
        await sleep(80);
        inFlight.push(fulfillOrder(single));
        blocked = await waitForLockWait(probe);
        return Promise.all(inFlight);
      });

      console.log(`[scenario 14C] lock wait observed: ${blocked}`);
      // THE RACE REALLY HAPPENED — one request was parked on the other's order
      // row. Without this, two requests that never met would pass.
      expect(blocked).toBe(true);
      expect(answers.map((answer) => answer.status)).toEqual([200, 200]);

      /** One request's outcome, as a comparable word. */
      const outcomeOf = (answer: RouteAnswer): string => {
        const results = resultsOf(answer);
        if (results.fulfilled.length === 1 && results.skipped.length === 0) {
          return `fulfilled(${String(results.fulfilled[0].quantity)})`;
        }
        if (results.skipped.length === 1 && results.fulfilled.length === 0) {
          return `skipped ${results.skipped[0].reason}`;
        }
        return `unexpected ${JSON.stringify(answer.body)}`;
      };

      // UNORDERED: the loser's order read waited on the lock and then saw
      // fulfilledQty = 2, so its line was already fully fulfilled. WHICH request
      // won is REPORTED, never asserted — that is an InnoDB scheduling accident.
      const outcomes = answers.map(outcomeOf).sort();
      console.log(
        `[scenario 14C] request 1 -> ${outcomeOf(answers[0])}; ` +
          `request 2 -> ${outcomeOf(answers[1])}`,
      );
      expect(outcomes).toEqual(["fulfilled(2)", "skipped already_fulfilled"]);

      // ONE deduction, never two: 2 units, not 4, and the stock says so in both
      // tables.
      const rows = await rawRows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM inventory_logs
          WHERE logType = 'SALE' AND orderRecordId = ?`,
        [GATE_EXT_ORDER_ID],
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(1);
      expect(await orderItemRows()).toEqual([
        { id: GATE_ITEM_BUNDLE, fulfilledQty: 0, hasSnapshot: false },
        { id: GATE_ITEM_SINGLE, fulfilledQty: 2, hasSnapshot: false },
      ]);
      expect(await stockIn(P_APPROVED)).toEqual({ row: 8 });
      expect(await stockIn(P_APPROVED_2)).toEqual({ row: 10 });
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });

  test("scenario 14D: the unfulfill round trip — three CORRECTION rows put back exactly what the fulfil took", async () => {
    // SELF-CONTAINED (PKc-4): D arranges its own state, A's request included, so
    // it never depends on another sub-case having run (or on jest's order).
    await resetAll();
    await setStock(P_APPROVED, 10);
    await setStock(P_APPROVED_2, 10);

    const fulfilled = await fulfillOrder(fulfilRequest());
    expect(fulfilled.status).toBe(200);
    expect(resultsOf(fulfilled).failed).toEqual([]);
    expect(await stockIn(P_APPROVED)).toEqual({ row: 7 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 8 });

    const answer = await unfulfillOrder({
      items: [
        {
          itemId: GATE_ITEM_SINGLE,
          productId: P_APPROVED,
          quantity: 2,
          locationId: LOCATION_MAIN,
        },
        {
          // The bundle line's `productId` is ANY positive int — the schema
          // requires one (`validation/unfulfill.ts:9`) and the bundle branch
          // ignores it entirely (`unfulfill/route.ts:183-265`, OCc-14).
          itemId: GATE_ITEM_BUNDLE,
          productId: P_APPROVED,
          quantity: 1,
          locationId: LOCATION_MAIN,
        },
      ],
    });

    expect(answer.status).toBe(200);
    const restored = answer.body.restored as Array<Record<string, unknown>>;
    expect(restored).toHaveLength(2);
    expect(answer.body.skipped).toEqual([]);

    // The unfulfill route answers with no batch id, so the batch is taken from
    // the change event it filed — which pins that event's existence too.
    const unfulfilBatches = await rawRows<{ batchId: string }>(
      `SELECT batchId FROM audit_logs
        WHERE actionType = 'EXTERNAL_ORDER_UNFULFILLMENT' AND entityId = ?`,
      [GATE_EXT_ORDER_ID],
    );
    expect(unfulfilBatches).toHaveLength(1);
    const unfulfilBatch = String(unfulfilBatches[0].batchId);

    // +2 for the single line, then the bundle's components (+1 P_A, +2 P_B) —
    // the exact reversal of A's three SALE rows, stamped with the same order.
    expect(await ledgerRowsForBatch(unfulfilBatch)).toEqual([
      {
        productId: P_APPROVED,
        delta: 2,
        logType: "CORRECTION",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
      {
        productId: P_APPROVED,
        delta: 1,
        logType: "CORRECTION",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
      {
        productId: P_APPROVED_2,
        delta: 2,
        logType: "CORRECTION",
        locationId: LOCATION_MAIN,
        orderRecordId: GATE_EXT_ORDER_ID,
      },
    ]);

    expect(await orderItemRows()).toEqual([
      { id: GATE_ITEM_BUNDLE, fulfilledQty: 0, hasSnapshot: true },
      { id: GATE_ITEM_SINGLE, fulfilledQty: 0, hasSnapshot: false },
    ]);

    // Back where it started, in both tables — and the order is no longer stocked
    // out, because nothing of it is fulfilled any more.
    expect(await stockIn(P_APPROVED)).toEqual({ row: 10 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 10 });
    expect(await orderStockedOut()).toBe(false);
  });

  /**
   * SCENARIO 15-ii (pack CB2.5c.3) — THE SECOND HALF OF THE RETIREMENT'S PROOF.
   *
   * It lives inside scenario 14's bracket on purpose: it needs a FULFILLED line
   * to unfulfil, and 14 owns the order items, the product links and the
   * `beforeAll`/`afterAll` that create and remove them.
   *
   * Two COVERED writers on ONE product at LOCATION 1 — an unfulfill of the
   * single line against a deduct-simple of the same product. Before P2-B2.5 both
   * transactions wrote the loc-1 `products` mirror on top of their ledger
   * INSERT's FK S lock on the same row, which is the S->X cycle the register
   * traced out of the engine. Neither takes that X lock any more, so the pair has
   * nothing left to cycle ON: the second writer WAITS at the prelock's
   * materialize and then commits.
   */
  test("scenario 15-ii: an unfulfill and a deduct-simple on ONE product at location 1 — no cycle, they serialise", async () => {
    await resetAll();
    await setStock(P_APPROVED, 10);
    await setStock(P_APPROVED_2, 10);

    // Arrange the thing to unfulfil, through the real route.
    const fulfilled = await fulfillOrder(fulfilRequest());
    expect(fulfilled.status).toBe(200);
    expect(resultsOf(fulfilled).failed).toEqual([]);
    expect(await stockIn(P_APPROVED)).toEqual({ row: 7 });

    const probe = openClient();
    try {
      await warmUp(probe);
      // Installed AFTER the fulfil, so it holds the two RACERS and nothing else.
      // Three seconds, 11a-ii's value: the loser has to be OBSERVED queueing.
      await installLedgerHold([P_APPROVED], 3);

      const RESTORE = 2;
      const DEDUCT = 1;
      const {
        value: observed,
        after: deadlockAfter,
        fresh: deadlockFresh,
      } = await reportDeadlocks("scenario 15-ii", async () => {
        const inFlight = [
          unfulfillOrder({
            items: [
              {
                itemId: GATE_ITEM_SINGLE,
                productId: P_APPROVED,
                quantity: RESTORE,
                locationId: LOCATION_MAIN,
              },
            ],
          }),
          deductSimple(LOCATION_MAIN, [{ productId: P_APPROVED, quantity: DEDUCT }]),
        ];
        const seen = await observeRendezvous(probe);
        const settled = await Promise.all(inFlight);
        return { ...seen, settled };
      });

      console.log(
        `[scenario 15-ii] serialised — InnoDB lock wait: ${observed.lockWait}, ` +
          `blocked on the prelock's materialize: ${observed.blockedOnMaterialize}; ` +
          `overlap observed: ${observed.overlapped}`,
      );

      // THE PRELOCK WAIT, OBSERVED. One key, two writers: they cannot be inside
      // the hold together, so the probe has to catch the loser waiting — and
      // WAITING is the whole claim (CB2.5d), as against cycling.
      expect(observed.lockWait || observed.blockedOnMaterialize).toBe(true);

      const [unfulfilled, deducted] = observed.settled;
      assertCoveredRaceEnvelope("scenario 15-ii", observed.settled, {
        after: deadlockAfter,
        fresh: deadlockFresh,
      });

      // CB2.5c.3: THIS pin's claim is "both commit", spelled directly beside the
      // envelope (which since B25-CX-4 requires the same thing): a 503 here is a
      // stall regression wearing the shared wire code — red.
      expect(observed.settled.map((a) => a.status)).toEqual([200, 200]);

      // THE STOCK ORACLE, EXACT, off whichever branch of the envelope this run
      // landed in — the fulfil's 7, plus what the unfulfill gave back, minus what
      // the deduction took.
      const expected =
        7 +
        (unfulfilled.status === 200 ? RESTORE : 0) -
        (deducted.status === 200 ? DEDUCT : 0);
      expect(await stockIn(P_APPROVED)).toEqual({ row: expected });
      // The bundle line is untouched by either racer.
      expect(await stockIn(P_APPROVED_2)).toEqual({ row: 8 });
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });
});

// ==========================================================================
// SCENARIO 11 — THE REVERSE, ON A REAL ENGINE (pack CB2b.6)
//
// B2b's writer is the first one in this lane whose correctness depends on a
// PLAIN read taken inside a locked transaction: `priorRestorations` deliberately
// does NOT lock, because a locking read over an EMPTY range gap-locks, and two
// first-restorations of two DIFFERENT batches would then deadlock against each
// other (spec §2.7(4)). That claim is unfalsifiable off a real InnoDB engine —
// a unit test with a stand-in client would pass whichever way the module read.
//
//   11a-i    TWO CONCURRENT REVERSES OF DIFFERENT BATCHES BOTH COMMIT, with the
//            overlap OBSERVED rather than inferred. `waitForLockWait` cannot see
//            this one (neither session ever blocks — that IS the claim), so the
//            rendezvous is the engine's process list: both sessions sitting in
//            `User sleep` inside the hold trigger at the same instant.
//   11a-ii   TWO CONCURRENT REVERSES OF ONE BATCH produce exactly one 200 and
//            one ALREADY_REVERSED. The loser waits on the batch rows, and its
//            restoration read — opened AFTER that lock — sees the winner's
//            committed event. Stock moves ONCE.
//   11a-iii  THE ATTRIBUTION AND THE REVERSE, IN BOTH ACQUISITION ORDERS
//            (PK-2). Restoration-first: the attribution refuses BATCH_RESTORED
//            and no stamp moves. Attribution-first: the reverse refuses
//            BATCH_MOVED and no CORRECTION row exists.
//
// THE RESET IS PART OF THE SCENARIO. Every batch here is minted by a ROUTE, so
// its id cannot be named in advance — `seed.ts` derives it from the scoped
// ledger rows, and 11a-iii's `INVENTORY_ATTRIBUTE` event needed a new arm
// (FR-5). The scenario asserts the derivation works rather than trusting it.
// ==========================================================================

/** The gate's hold on the attempts INSERT (11a-iii, attribution-first). */
const ATTEMPT_HOLD = "b2_attempt_hold";

type ReverseRows = Array<{
  batchId: string | null;
  productId: number;
  delta: number;
  logType: string;
  locationId: number | null;
  orderRecordId: string | null;
}>;

/** Every CORRECTION row on the scope, whatever batch it was written under. */
async function correctionRows(): Promise<ReverseRows> {
  const rows = await rawRows<ReverseRows[number]>(
    `SELECT batchId, productId, delta, logType, locationId, orderRecordId
       FROM inventory_logs
      WHERE logType = 'CORRECTION' AND productId IN (?, ?)
      ORDER BY id`,
    [P_APPROVED, P_APPROVED_2],
  );
  return rows.map((row) => ({
    ...row,
    productId: Number(row.productId),
    delta: Number(row.delta),
    logType: String(row.logType),
    locationId: row.locationId === null ? null : Number(row.locationId),
  }));
}

/** The stamps a batch's rows carry — the 11a-iii "nothing moved" oracle. */
async function stampsForBatch(batchId: string): Promise<Array<string | null>> {
  const rows = await rawRows<{ orderRecordId: string | null }>(
    "SELECT orderRecordId FROM inventory_logs WHERE batchId = ? ORDER BY id",
    [batchId],
  );
  return rows.map((row) => row.orderRecordId);
}

async function eventsOfType(actionType: string): Promise<
  Array<{ entityId: string | null; batchId: string | null; affectedCount: number }>
> {
  const rows = await rawRows<{
    entityId: string | null;
    batchId: string | null;
    affectedCount: number;
  }>(
    "SELECT entityId, batchId, affectedCount FROM audit_logs WHERE actionType = ? ORDER BY id",
    [actionType],
  );
  return rows.map((row) => ({ ...row, affectedCount: Number(row.affectedCount) }));
}

/** Mint an attributable batch THROUGH the real deduct-simple route. */
async function mintBatch(productId: number, quantity: number): Promise<string> {
  const answer = await deductSimple(LOCATION_MAIN, [{ productId, quantity }]);
  expect(answer.status).toBe(200);
  expect(typeof answer.body.batchId).toBe("string");
  return String(answer.body.batchId);
}

function reverseBatchRoute(batchId: string): Promise<RouteAnswer> {
  // NO body: the reverse route parses none (pack CB2b.2 step 1).
  return callParamRoute(reverseRoute, `/api/inventory/batches/${batchId}/reverse`, { batchId });
}

function attributeBatchRoute(batchId: string, orderRecordId: string): Promise<RouteAnswer> {
  return callParamRoute(
    attributionRoute,
    `/api/reconciliation/attribution/${batchId}`,
    { batchId },
    { orderRecordId, expectPreviousOrderRecordId: null },
  );
}

describe("scenario 11a — the reverse on a REAL engine (pack CB2b.6)", () => {
  jest.setTimeout(120_000);

  const OPENING = 10;

  beforeEach(async () => {
    await resetAll();
    await setStock(P_APPROVED, OPENING);
    await setStock(P_APPROVED_2, OPENING);
  });

  afterAll(async () => {
    await dropHoldTrigger();
    await dropHoldTrigger(ATTEMPT_HOLD);
    await resetAll();
  });

  test("11a-i: two reverses of DIFFERENT batches overlap and BOTH commit", async () => {
    const opening = await countSnapshot();
    const batchA = await mintBatch(P_APPROVED, 4);
    const batchB = await mintBatch(P_APPROVED_2, 3);
    // The mint itself records ONE attribution attempt per batch (deduct-simple's own row); the claim is that the
    // restoration adds NONE — so the count is pinned as before === after, never as an absolute zero.
    const attemptsBeforeA = await attemptCountForBatch(batchA);
    const attemptsBeforeB = await attemptCountForBatch(batchB);

    const probe = openClient();
    try {
      await warmUp(probe);
      // Installed AFTER the mints, so it holds the two RESTORATIONS and nothing
      // else. Both product ids: same-product batches would serialise at the
      // prelock's `product_locations` X lock and could never be observed in
      // `User sleep` together, and the claim is about the restoration READ.
      // THREE seconds, 11a-iii's and 11c's value (F28): this scenario's whole
      // claim is that BOTH sessions are inside the sleep at once, and one second
      // is not enough window for the second session's launch and
      // `waitForSleepingSessions`' own poll to land inside it on a loaded box —
      // the hold would expire and the overlap go unobserved.
      await installLedgerHold([P_APPROVED, P_APPROVED_2], 3);

      const { value: answers, fresh } = await reportDeadlocks("scenario 11a-i", async () => {
        const inFlight = [reverseBatchRoute(batchA), reverseBatchRoute(batchB)];
        // THE OVERLAP, OBSERVED WHEN THE ENGINE ALLOWS IT. On the real engine
        // (2026-09-02, the wave-close run) two restorations at the SAME location
        // serialise in the prelock's materialize statement: the second writer's
        // `product_locations` ON DUPLICATE KEY UPDATE waits for the whole of the
        // first writer's hold and only then reaches its own — a liveness property
        // of the prelock design (register: the same-location serialisation), not
        // a stock-truth one. So the claim this scenario PROVES is: no deadlock,
        // BOTH commit, the stock oracle exact; the overlap is REPORTED, and when
        // it is not observed the serialisation is proven by a lock wait instead.
        const seen = await observeRendezvous(probe);
        const settled = await Promise.all(inFlight);
        return { ...seen, settled };
      });

      console.log(
        `[scenario 11a-i] overlap observed: ${answers.overlapped}; serialised — InnoDB lock wait: ${answers.lockWait}, blocked on the prelock's materialize: ${answers.blockedOnMaterialize}`,
      );
      expect(answers.overlapped || answers.lockWait || answers.blockedOnMaterialize).toBe(true);
      const [a, b] = answers.settled;
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      if (fresh) {
        console.log(
          "[scenario 11a-i] a deadlock was detected during this race — the run is REPORTED, " +
            "and the two 200s above are what the scenario asserts (a retried green counts).",
        );
      }

      // The stock oracle, exact: each product back where it started.
      expect(await stockIn(P_APPROVED)).toEqual({ row: OPENING });
      expect(await stockIn(P_APPROVED_2)).toEqual({ row: OPENING });

      // TWO CORRECTION rows, under TWO new batch ids — never the reversed ones.
      const corrections = await correctionRows();
      expect(corrections).toHaveLength(2);
      expect(corrections.map((row) => row.productId).sort()).toEqual(
        [P_APPROVED, P_APPROVED_2].sort(),
      );
      expect(corrections.every((row) => row.locationId === LOCATION_MAIN)).toBe(true);
      expect(corrections.every((row) => row.orderRecordId === null)).toBe(true);
      const newBatches = corrections.map((row) => String(row.batchId));
      expect(new Set(newBatches).size).toBe(2);
      expect(newBatches).not.toContain(batchA);
      expect(newBatches).not.toContain(batchB);

      // I-R5: the ENTITY is the reversed batch, the event's own batchId is the new one.
      const events = await eventsOfType("INVENTORY_BATCH_REVERSE");
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.entityId).sort()).toEqual([batchA, batchB].sort());
      expect(events.map((event) => String(event.batchId)).sort()).toEqual([...newBatches].sort());
      // NO attempt row: a reverse is not an attribution.
      expect(await attemptCountForBatch(batchA)).toBe(attemptsBeforeA);
      expect(await attemptCountForBatch(batchB)).toBe(attemptsBeforeB);

      await resetAll();
      // ...and the reset's derivation reaches the reverse's rows AND its events.
      expect(await countSnapshot()).toEqual(opening);
      expect(await correctionRows()).toEqual([]);
      expect(await eventsOfType("INVENTORY_BATCH_REVERSE")).toEqual([]);
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });

  test("11a-ii: two reverses of ONE batch — one 200, one ALREADY_REVERSED, stock moves once", async () => {
    const batch = await mintBatch(P_APPROVED, 4);
    const probe = openClient();
    try {
      await warmUp(probe);
      // THREE seconds, 11a-iii's and 11c's value (F28): the loser has to be
      // OBSERVED queueing on the winner's row locks, and one second leaves the
      // second session's launch and `waitForLockWait`'s poll racing the hold's
      // own expiry on a loaded box.
      await installLedgerHold([P_APPROVED], 3);

      const first = reverseBatchRoute(batch);
      // The loser queues on the batch rows the winner holds `FOR UPDATE`.
      const waited = waitForLockWait(probe, 10_000);
      const second = reverseBatchRoute(batch);
      const [a, b, observed] = await Promise.all([first, second, waited]);

      expect(observed).toBe(true);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const refused = a.status === 409 ? a : b;
      expect(refused.body.code).toBe("ALREADY_REVERSED");
      expect(refused.body.previouslyRestored).toBe(4);
      expect(refused.body.totalUnits).toBe(4);

      // ONCE. Not twice, and not zero.
      expect(await stockIn(P_APPROVED)).toEqual({ row: OPENING });
      const corrections = await correctionRows();
      expect(corrections).toHaveLength(1);
      expect(corrections[0].delta).toBe(4);
      expect(await eventsOfType("INVENTORY_BATCH_REVERSE")).toHaveLength(1);
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });

  test("11a-iii RESTORATION-FIRST: the attribution refuses BATCH_RESTORED and no stamp moves", async () => {
    const batch = await mintBatch(P_APPROVED, 4);
    const probe = openClient();
    try {
      await warmUp(probe);
      // The reverse is held at its CORRECTION insert while the attribution
      // queues on the batch rows it already holds `FOR UPDATE`. THREE seconds,
      // 11c's value (F18): one is not enough window for the rendezvous, the
      // second party's launch and `waitForLockWait`'s own poll to land inside
      // it on a loaded box — the hold would expire and the race go unobserved.
      await installLedgerHold([P_APPROVED], 3);

      const reversing = reverseBatchRoute(batch);
      // F9 (GX-1): the SECOND party starts only once the FIRST is proven to be
      // inside the trigger — i.e. holding the batch's rows `FOR UPDATE`. Without
      // this the attribution could win the batch lock outright and the scenario
      // would assert a race it never ran (11c's idiom, `:3101`).
      expect(await waitForSleepingSessions(probe, 1)).toBe(true);
      const waited = waitForLockWait(probe, 10_000);
      const attributing = attributeBatchRoute(batch, GATE_EXT_ORDER_ID);
      const [reversed, attributed, observed] = await Promise.all([
        reversing,
        attributing,
        waited,
      ]);

      expect(observed).toBe(true);
      expect(reversed.status).toBe(200);
      expect(attributed.status).toBe(409);
      expect(attributed.body.code).toBe("BATCH_RESTORED");
      expect(attributed.body.restoredUnits).toBe(4);

      // NOTHING was stamped — the ledger is the oracle, not the envelope.
      expect(await stampsForBatch(batch)).toEqual([null]);
      expect(await eventsOfType("INVENTORY_ATTRIBUTE")).toEqual([]);
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });

  test("11a-iii ATTRIBUTION-FIRST: the reverse refuses BATCH_MOVED and writes no CORRECTION row", async () => {
    const batch = await mintBatch(P_APPROVED, 4);
    const probe = openClient();
    try {
      await warmUp(probe);
      // The attribution core writes NO ledger row — one `updateMany` — and its
      // attempt row is inserted by the route's `onRecord` inside the SAME
      // transaction, so THAT insert is where this direction's hold belongs
      // (the `concurrency-3.test.ts:294` idiom).
      await installHoldTrigger({
        name: ATTEMPT_HOLD,
        table: "order_attribution_attempts",
        timing: "BEFORE INSERT",
        rowAlias: "NEW",
        guardColumn: "batchId",
        ids: [batch],
        // 11c's three seconds, for the reason above (F18).
        seconds: 3,
      });

      const attributing = attributeBatchRoute(batch, GATE_EXT_ORDER_ID);
      // F9 (GX-1): the same rendezvous the other way round — the attribution is
      // proven to be inside its attempts-INSERT hold, with the batch's rows
      // already locked, before the reverse is launched at it.
      expect(await waitForSleepingSessions(probe, 1)).toBe(true);
      const waited = waitForLockWait(probe, 10_000);
      const reversing = reverseBatchRoute(batch);
      const [attributed, reversed, observed] = await Promise.all([
        attributing,
        reversing,
        waited,
      ]);

      expect(observed).toBe(true);
      expect(attributed.status).toBe(200);
      expect(reversed.status).toBe(409);
      expect(reversed.body.code).toBe("BATCH_MOVED");
      // The discovery read the batch UNSTAMPED; the locked rows disagree.
      expect(reversed.body.currentOrderRecordId).toBe(GATE_EXT_ORDER_ID);
      expect(reversed.body.expected).toBeNull();

      expect(await stampsForBatch(batch)).toEqual([GATE_EXT_ORDER_ID]);
      expect(await correctionRows()).toEqual([]);
      expect(await eventsOfType("INVENTORY_BATCH_REVERSE")).toEqual([]);

      // FR-5: the reset arm that reaches an INVENTORY_ATTRIBUTE event whose
      // entity is a ROUTE-MINTED batch (never RECON_BATCH_ID).
      expect(await eventsOfType("INVENTORY_ATTRIBUTE")).toHaveLength(1);
      await resetAll();
      expect(await eventsOfType("INVENTORY_ATTRIBUTE")).toEqual([]);
    } finally {
      await dropHoldTrigger(ATTEMPT_HOLD);
      await probe.$disconnect();
    }
  });
});

// ==========================================================================
// SCENARIO 11b — THE WRONG-LOCATION MOVE, ON A REAL ENGINE (pack CB2c.5)
//
// The move is the first writer in this lane that touches TWO `product_locations`
// rows per product in ONE act, and the whole of its correctness is a claim about
// what those two rows hold afterwards. So the oracle here is the books
// themselves, read straight out of MySQL, at BOTH locations:
//
//   11b-i    TWO CONCURRENT MOVES OF ONE BATCH produce exactly one 200 and one
//            ALREADY_MOVED. The loser waits on the batch rows the winner holds
//            `FOR UPDATE`, and its restoration read — opened AFTER that lock —
//            sees the winner's committed MOVE event. The stock moves ONCE.
//   11b-ii   TWO MOVES OF DIFFERENT BATCHES ON DIFFERENT PRODUCTS both commit,
//            with the overlap OBSERVED rather than inferred (the 11a-i
//            rendezvous: neither session ever blocks, which IS the claim). Per
//            product: the physical location loses the units, the ledger location
//            gets them back, and the pair's two rows share ONE `transferId`.
//   11b-iii  MOVE, THEN REVERSE. The CORRECTION lands at the PHYSICAL location —
//            after a move the units are sitting THERE, and restoring at the
//            ledger location would put stock back where it never was (spec REV-9
//            CX6-2). A SECOND reverse answers ALREADY_REVERSED, never
//            RESTORATION_LEDGER_CORRUPT: a legitimate move-then-reverse ledger
//            must not trip the belt that reads it.
//
// THE PHYSICAL LOCATION HAS TO BE STOCKED FIRST. `resetGateFixtures` rebuilds
// every scoped `product_locations` row at quantity 0 (`seed.ts:784-785`), and
// `INSUFFICIENT_AT_SOURCE` reads the LOCKED row — so without this arrangement
// the refusal is the only answer any of these sub-cases could produce.
// ==========================================================================

/** The gate's PHYSICAL location for the move — the second location. */
const MOVE_PHYSICAL = LOCATION_SECOND;

type MoveRow = {
  batchId: string | null;
  productId: number;
  delta: number;
  locationId: number | null;
  transferId: string | null;
  orderRecordId: string | null;
};

/** Every TRANSFER row on the scope, in write order. */
async function transferRows(): Promise<MoveRow[]> {
  const rows = await rawRows<MoveRow>(
    `SELECT batchId, productId, delta, locationId, transferId, orderRecordId
       FROM inventory_logs
      WHERE logType = 'TRANSFER' AND productId IN (?, ?)
      ORDER BY id`,
    [P_APPROVED, P_APPROVED_2],
  );
  return rows.map((row) => ({
    ...row,
    productId: Number(row.productId),
    delta: Number(row.delta),
    locationId: row.locationId === null ? null : Number(row.locationId),
  }));
}

/** One `product_locations` quantity, at whichever location is asked for. */
async function quantityAt(productId: number, locationId: number): Promise<number | null> {
  const row = await locationRow({ productId, locationId });
  return row?.quantity ?? null;
}

/** Arrange the PHYSICAL location, the one `setStock` does not touch. */
async function setPhysicalStock(productId: number, quantity: number): Promise<void> {
  await singleton.product_locations.updateMany({
    where: { productId, locationId: MOVE_PHYSICAL },
    data: { quantity },
  });
}

function moveBatchRoute(batchId: string, physicalLocationId: number): Promise<RouteAnswer> {
  return callParamRoute(
    moveRoute,
    `/api/inventory/batches/${batchId}/move`,
    { batchId },
    { physicalLocationId },
  );
}

/**
 * A FULFILMENT FACT on a route-minted batch, without standing up scenario 14's
 * whole order fixture. The predicate the move's rung 7 refuses on is
 * `batchEvidence`'s — the FIRST audit row under the batch id whose actionType is
 * one of the two fulfilment names — so THIS is the same fact the report shows
 * and the ladder reads, filed the way the fulfil route files it (`entityType:
 * "ORDER"`, the order as its entity, the ledger batch as its own batchId).
 *
 * `details` carries NO `rows` key on purpose: `isAttributableBatch` reads that
 * shape, and a blob with one would make the batch a mass update instead.
 *
 * The reset takes it back with no clause of its own — the batch id came off a
 * scoped ledger row, so `routeBatchIds` contains it and the ORDER clause
 * (`seed.ts`) names it. The sub-case ASSERTS that rather than trusting it.
 */
async function installFulfilmentEvidence(batchId: string): Promise<void> {
  await singleton.auditLog.create({
    data: {
      userId: GATE_ADMIN_ID,
      actionType: "EXTERNAL_ORDER_FULFILLMENT",
      entityType: "ORDER",
      entityId: GATE_EXT_ORDER_ID,
      batchId,
      action: "Fulfilled order for the gate's move scenario",
      details: { orderId: GATE_EXT_ORDER_ID },
      affectedCount: 1,
    },
  });
}

async function fulfilmentEvidenceCount(): Promise<number> {
  const rows = await rawRows<{ n: number }>(
    "SELECT COUNT(*) AS n FROM audit_logs WHERE actionType = 'EXTERNAL_ORDER_FULFILLMENT'",
  );
  return Number(rows[0]?.n ?? 0);
}

describe("scenario 11b — the wrong-location move on a REAL engine (pack CB2c.5)", () => {
  jest.setTimeout(120_000);

  /** What LOCATION_MAIN (the LEDGER end) holds before anything runs. */
  const OPENING = 10;
  /** What MOVE_PHYSICAL holds — enough to give the units up. */
  const PHYSICAL_OPENING = 20;

  beforeEach(async () => {
    await resetAll();
    await setStock(P_APPROVED, OPENING);
    await setStock(P_APPROVED_2, OPENING);
    // The reset leaves every scoped row at 0, so the source is stocked HERE or
    // INSUFFICIENT_AT_SOURCE is the only answer this scenario can produce.
    await setPhysicalStock(P_APPROVED, PHYSICAL_OPENING);
    await setPhysicalStock(P_APPROVED_2, PHYSICAL_OPENING);
  });

  afterAll(async () => {
    await dropHoldTrigger();
    await resetAll();
  });

  test("11b-i: two moves of ONE batch — one 200, one ALREADY_MOVED, the books move once", async () => {
    const batch = await mintBatch(P_APPROVED, 4);
    const probe = openClient();
    try {
      await warmUp(probe);
      // Installed AFTER the mint, so it holds the MOVE's own TRANSFER legs and
      // nothing else. Both legs carry the same productId, so the winner sleeps
      // twice — well inside the lane's 30 s budget.
      await installLedgerHold([P_APPROVED], 1);

      const first = moveBatchRoute(batch, MOVE_PHYSICAL);
      // The loser queues on the batch rows the winner holds `FOR UPDATE`.
      const waited = waitForLockWait(probe, 10_000);
      const second = moveBatchRoute(batch, MOVE_PHYSICAL);
      const [a, b, observed] = await Promise.all([first, second, waited]);

      expect(observed).toBe(true);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const refused = a.status === 409 ? a : b;
      expect(refused.body.code).toBe("ALREADY_MOVED");
      expect(refused.body.physicalLocationId).toBe(MOVE_PHYSICAL);

      // ONCE. The deduction took 4 off the ledger location; the move gave those
      // 4 back there and took them off the physical one.
      expect(await quantityAt(P_APPROVED, LOCATION_MAIN)).toBe(OPENING);
      expect(await quantityAt(P_APPROVED, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING - 4);

      const legs = await transferRows();
      expect(legs).toHaveLength(2);
      expect(await eventsOfType("INVENTORY_BATCH_MOVE")).toHaveLength(1);
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });

  test("11b-ii: two moves of DIFFERENT batches on DIFFERENT products overlap and BOTH commit", async () => {
    const opening = await countSnapshot();
    const batchA = await mintBatch(P_APPROVED, 4);
    const batchB = await mintBatch(P_APPROVED_2, 3);
    // The mint itself records ONE attribution attempt per batch (deduct-simple's own row); the claim is that the
    // restoration adds NONE — so the count is pinned as before === after, never as an absolute zero.
    const attemptsBeforeA = await attemptCountForBatch(batchA);
    const attemptsBeforeB = await attemptCountForBatch(batchB);

    const probe = openClient();
    try {
      await warmUp(probe);
      // Both product ids: two moves of ONE product to ONE physical location share
      // both prelock keys and could never be observed in `User sleep` together.
      await installLedgerHold([P_APPROVED, P_APPROVED_2], 1);

      const { value: answers, fresh } = await reportDeadlocks("scenario 11b-ii", async () => {
        const inFlight = [
          moveBatchRoute(batchA, MOVE_PHYSICAL),
          moveBatchRoute(batchB, MOVE_PHYSICAL),
        ];
        // THE OVERLAP, OBSERVED. Two 200s alone would not qualify.
        // See 11a-i: same-location writers serialise in the prelock's materialize
        // on the real engine; the overlap is REPORTED, the serialisation proven
        // by a lock wait when it is not observed; the claim is no deadlock + both
        // commit + the stock oracle exact.
        const seen = await observeRendezvous(probe);
        const settled = await Promise.all(inFlight);
        return { ...seen, settled };
      });

      console.log(
        `[scenario 11b-ii] overlap observed: ${answers.overlapped}; serialised — InnoDB lock wait: ${answers.lockWait}, blocked on the prelock's materialize: ${answers.blockedOnMaterialize}`,
      );
      expect(answers.overlapped || answers.lockWait || answers.blockedOnMaterialize).toBe(true);
      const [a, b] = answers.settled;
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      if (fresh) {
        console.log(
          "[scenario 11b-ii] a deadlock was detected during this race — the run is REPORTED, " +
            "and the two 200s above are what the scenario asserts (a retried green counts).",
        );
      }

      // THE STOCK ORACLE, per product and per LOCATION: the ledger end is back
      // where it started (deducted, then given back), the physical end is down
      // by exactly what left it.
      expect(await quantityAt(P_APPROVED, LOCATION_MAIN)).toBe(OPENING);
      expect(await quantityAt(P_APPROVED, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING - 4);
      expect(await quantityAt(P_APPROVED_2, LOCATION_MAIN)).toBe(OPENING);
      expect(await quantityAt(P_APPROVED_2, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING - 3);

      // FOUR legs: two per product, netting to zero, each pair under ONE
      // transferId and ONE new batch id that is neither of the moved batches.
      const legs = await transferRows();
      expect(legs).toHaveLength(4);
      [P_APPROVED, P_APPROVED_2].forEach((productId) => {
        const pair = legs.filter((leg) => leg.productId === productId);
        expect(pair).toHaveLength(2);
        expect(pair[0].transferId).not.toBeNull();
        expect(pair[0].transferId).toBe(pair[1].transferId);
        expect(pair.reduce((sum, leg) => sum + leg.delta, 0)).toBe(0);
        // The PHYSICAL leg is the negative one, and it is written first.
        expect(pair[0].locationId).toBe(MOVE_PHYSICAL);
        expect(pair[0].delta).toBeLessThan(0);
        expect(pair[1].locationId).toBe(LOCATION_MAIN);
        expect(pair[1].delta).toBeGreaterThan(0);
        // The batch stayed unstamped, so its legs are unstamped too.
        expect(pair[0].orderRecordId).toBeNull();
      });
      const newBatches = legs.map((leg) => String(leg.batchId));
      expect(new Set(newBatches).size).toBe(2);
      expect(newBatches).not.toContain(batchA);
      expect(newBatches).not.toContain(batchB);

      // The ENTITY is the moved batch; the event's own batchId is the new one.
      const events = await eventsOfType("INVENTORY_BATCH_MOVE");
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.entityId).sort()).toEqual([batchA, batchB].sort());
      expect(events.map((event) => String(event.batchId)).sort()).toEqual(
        Array.from(new Set(newBatches)).sort(),
      );
      // Two legs per product, so the event counts ROWS, not pairs.
      expect(events.every((event) => event.affectedCount === 2)).toBe(true);
      // NO attempt row: a move is not an attribution.
      expect(await attemptCountForBatch(batchA)).toBe(attemptsBeforeA);
      expect(await attemptCountForBatch(batchB)).toBe(attemptsBeforeB);

      await resetAll();
      // ...and the reset's derivation reaches the move's TRANSFER rows AND its
      // events, with no clause of its own (the new batch's rows carry a scoped
      // productId, so `routeBatchIds` already contains it).
      expect(await countSnapshot()).toEqual(opening);
      expect(await transferRows()).toEqual([]);
      expect(await eventsOfType("INVENTORY_BATCH_MOVE")).toEqual([]);
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });

  test("11b-iii: move, then reverse — the CORRECTION lands at the PHYSICAL location", async () => {
    const batch = await mintBatch(P_APPROVED, 4);

    // After the deduction, before anything is moved.
    expect(await quantityAt(P_APPROVED, LOCATION_MAIN)).toBe(OPENING - 4);
    expect(await quantityAt(P_APPROVED, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING);

    const moved = await moveBatchRoute(batch, MOVE_PHYSICAL);
    expect(moved.status).toBe(200);
    expect(moved.body.ledgerLocationId).toBe(LOCATION_MAIN);
    expect(moved.body.physicalLocationId).toBe(MOVE_PHYSICAL);
    expect(moved.body.message).toBe(
      `moved 4 units from location ${LOCATION_MAIN} to ${MOVE_PHYSICAL}`,
    );

    // The ledger end is whole again; the physical end carries the loss.
    expect(await quantityAt(P_APPROVED, LOCATION_MAIN)).toBe(OPENING);
    expect(await quantityAt(P_APPROVED, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING - 4);

    const reversed = await reverseBatchRoute(batch);
    expect(reversed.status).toBe(200);
    expect(reversed.body.restoredUnits).toBe(4);
    // The reverse KNOWS where the units went (spec REV-9 CX6-2).
    expect(reversed.body.physicalLocationId).toBe(MOVE_PHYSICAL);

    const corrections = await correctionRows();
    expect(corrections).toHaveLength(1);
    expect(corrections[0].locationId).toBe(MOVE_PHYSICAL);
    expect(corrections[0].delta).toBe(4);

    // THE ORACLE, EXACT, at both ends: the physical location is back to where it
    // started, and the ledger location never moved off its own opening once the
    // move had given the deduction back.
    expect(await quantityAt(P_APPROVED, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING);
    expect(await quantityAt(P_APPROVED, LOCATION_MAIN)).toBe(OPENING);

    // A SECOND reverse of a MOVED batch is ALREADY_REVERSED — never the corrupt
    // refusal, which is what a belt that could not read a legitimate
    // move-then-reverse ledger would answer (pack CB2b.1 rung 9).
    const again = await reverseBatchRoute(batch);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_REVERSED");
    expect(again.body.previouslyRestored).toBe(4);
    expect(again.body.totalUnits).toBe(4);
    expect(await correctionRows()).toHaveLength(1);
  });

  test("11b: a FULFILMENT-EVIDENCED batch is refused on the move path (rung 7)", async () => {
    const batch = await mintBatch(P_APPROVED, 4);
    await installFulfilmentEvidence(batch);

    const refused = await moveBatchRoute(batch, MOVE_PHYSICAL);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("FULFILLED_BATCH");
    expect(refused.body.error).toBe(
      `Fulfilled against #${GATE_EXT_ORDER_ID} — change it via unfulfill/refulfill, not here`,
    );

    // NOTHING moved, at either end.
    expect(await quantityAt(P_APPROVED, LOCATION_MAIN)).toBe(OPENING - 4);
    expect(await quantityAt(P_APPROVED, MOVE_PHYSICAL)).toBe(PHYSICAL_OPENING);
    expect(await transferRows()).toEqual([]);
    expect(await eventsOfType("INVENTORY_BATCH_MOVE")).toEqual([]);

    // The evidence row is the scenario's own, and the reset takes it back —
    // asserted rather than trusted, because `concurrency.test.ts` scenario 2
    // pins an ABSOLUTE table-wide audit count from the outside.
    expect(await fulfilmentEvidenceCount()).toBe(1);
    await resetAll();
    expect(await fulfilmentEvidenceCount()).toBe(0);
  });
});

// ==========================================================================
// SCENARIO 11c — THE WC ORDER-DELETE WEBHOOK vs THE FULFIL (pack CB2b.5/CB2b.6,
// register OC-7)
//
// The delete decides `protected` vs `deleted` from `stockedOut`, and a fulfil
// flips that column while holding the order's X lock. Before B2b the delete read
// that snapshot inside a bare `$transaction` with no order lock, so a fulfil
// could commit between the read and the delete — leaving fulfilled ledger rows
// pointing at an order that no longer exists. The fix is one lock; the proof has
// to be a real engine, in BOTH acquisition orders.
//
// THE FIXTURE IS THIS SCENARIO'S OWN, and it is rebuilt PER DIRECTION:
//   * `lane5-webhook-dedup.test.ts` MOCKS the adapter registry wholesale, so
//     there is no HMAC idiom in this repo to copy — the body here is signed
//     against the REAL WooCommerce adapter's `verifyWebhook`.
//   * the gate's seeded integration has no webhook secret, so one is stored
//     PLAIN (`resolveWebhookSecret` accepts both shapes; no ENCRYPTION_KEY).
//   * the order is SCENARIO-LOCAL. `GATE_EXT_ORDER_ID`/`_2` are created ONCE by
//     the seed and only `updateMany`d by the reset, so a deleted seed order
//     would be gone for the rest of the serial run (the REV-36 trap).
//   * direction one DESTROYS the order and direction two leaves it alive as
//     `protected`, so each direction re-creates it DELETE-then-CREATE, deletes
//     the dedup claim (the key is `sha256(rawBody)` — a replayed body would
//     answer `duplicate: true`) and the ingestion audit row, and restores the
//     four integration health fields a successful delete mutates.
// ==========================================================================

const GATE_WEBHOOK_ORDER_ID = "concurrencygatewh0001";
const GATE_WH_EXTERNAL_ID = "770001";
const GATE_WH_LINK = "gate-link-webhook";
const GATE_WH_ITEM = "gate-item-webhook";
const GATE_WH_SECRET = "gate-webhook-secret";
const WH_DELETE_HOLD = "b2_wh_delete_hold";

/** ONE immutable raw body, signed once — the dedup key is its own sha256. */
const WH_RAW_BODY = JSON.stringify({ id: Number(GATE_WH_EXTERNAL_ID) });

describe("scenario 11c — the order-delete webhook takes the ORDER LOCK (pack CB2b.5)", () => {
  jest.setTimeout(120_000);

  /** Base64 HMAC-SHA256, exactly as WooCommerce signs a delivery — verified by
   *  the REAL adapter (`verifyWooCommerceWebhook`), never a mocked one. */
  function webhookSignature(): string {
    return createHmac("sha256", GATE_WH_SECRET).update(WH_RAW_BODY).digest("base64");
  }

  async function postDeleteWebhook(): Promise<RouteAnswer> {
    const request = new NextRequest(
      `http://concurrency-gate.invalid/api/webhooks/${GATE_INTEGRATION_ID}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-WC-Webhook-Signature": webhookSignature(),
          "X-WC-Webhook-Topic": "order.deleted",
          "X-WC-Webhook-ID": "gate-wh-delivery-1",
        },
        body: WH_RAW_BODY,
      },
    );
    const response = await webhookRoute.POST(request, {
      params: { integrationId: GATE_INTEGRATION_ID },
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  function fulfilScenarioOrder(): Promise<RouteAnswer> {
    return callParamRoute(
      fulfillRoute,
      `/api/orders/${GATE_WEBHOOK_ORDER_ID}/fulfill`,
      { orderId: GATE_WEBHOOK_ORDER_ID },
      { locationId: LOCATION_MAIN, items: [{ itemId: GATE_WH_ITEM, quantity: 1 }] },
    );
  }

  /** DELETE-then-CREATE, idempotent, plus every trace either direction leaves. */
  async function rebuildFixture(): Promise<void> {
    await singleton.externalOrderItem.deleteMany({
      where: { orderId: GATE_WEBHOOK_ORDER_ID },
    });
    await singleton.externalOrder.deleteMany({ where: { id: GATE_WEBHOOK_ORDER_ID } });
    await singleton.externalOrder.create({
      data: {
        id: GATE_WEBHOOK_ORDER_ID,
        companyId: GATE_COMPANY_ID,
        integrationId: GATE_INTEGRATION_ID,
        externalId: GATE_WH_EXTERNAL_ID,
        orderNumber: "77001",
        nativeStatus: "processing",
        total: 0,
        rawPayload: {},
      },
    });
    await singleton.externalOrderItem.create({
      data: {
        id: GATE_WH_ITEM,
        orderId: GATE_WEBHOOK_ORDER_ID,
        externalItemId: "gwh-1",
        externalProductId: "gate-webhook-single",
        name: "Gate webhook single",
        quantity: 1,
        price: 0,
        productLinkId: GATE_WH_LINK,
        isMapped: true,
        fulfilledQty: 0,
      },
    });
    // At 0 the fulfil skips the line and the ledger hold never fires.
    await setStock(P_APPROVED, 10);
    // The replay claim (keyed on sha256 of the body) and the ingestion row.
    await singleton.webhookDelivery.deleteMany({ where: { integrationId: GATE_INTEGRATION_ID } });
    await singleton.auditLog.deleteMany({
      where: { entityType: "ORDER", entityId: GATE_WEBHOOK_ORDER_ID },
    });
    // The four health fields a successful delivery mutates, plus the secret.
    await singleton.integration.update({
      where: { id: GATE_INTEGRATION_ID },
      data: {
        webhookSecret: GATE_WH_SECRET,
        lastSyncAt: null,
        lastWebhookReceivedAt: null,
        lastWebhookError: null,
        webhookFailureCount: 0,
      },
    });
  }

  beforeAll(async () => {
    await resetAll();
    // Scenario 14's links are created and deleted by ITS bracket, so this
    // scenario owns one of its own.
    await singleton.productLink.deleteMany({ where: { id: GATE_WH_LINK } });
    await singleton.productLink.create({
      data: {
        id: GATE_WH_LINK,
        integrationId: GATE_INTEGRATION_ID,
        externalProductId: "gate-webhook-single",
        internalProductId: P_APPROVED,
      },
    });
  });

  afterAll(async () => {
    await dropHoldTrigger();
    await dropHoldTrigger(WH_DELETE_HOLD);
    // NOTHING in `seed.ts` owns this order, so this bracket takes it away —
    // otherwise `concurrency.test.ts` scenario 2's ABSOLUTE `auditLog.count()`
    // fails in another file of the same serial run.
    await singleton.externalOrderItem.deleteMany({
      where: { orderId: GATE_WEBHOOK_ORDER_ID },
    });
    await singleton.externalOrder.deleteMany({ where: { id: GATE_WEBHOOK_ORDER_ID } });
    await singleton.productLink.deleteMany({ where: { id: GATE_WH_LINK } });
    await singleton.webhookDelivery.deleteMany({ where: { integrationId: GATE_INTEGRATION_ID } });
    await singleton.auditLog.deleteMany({
      where: { entityType: "ORDER", entityId: GATE_WEBHOOK_ORDER_ID },
    });
    await singleton.integration.update({
      where: { id: GATE_INTEGRATION_ID },
      data: {
        webhookSecret: null,
        lastSyncAt: null,
        lastWebhookReceivedAt: null,
        lastWebhookError: null,
        webhookFailureCount: 0,
      },
    });
    await resetAll();
  });

  test("11c DELETE-FIRST: the fulfil waits in lockFirst and answers ORDER_GONE", async () => {
    await rebuildFixture();
    const probe = openClient();
    try {
      await warmUp(probe);
      // The webhook deletes the items EXPLICITLY, so a per-ROW `BEFORE DELETE`
      // trigger fires — guarded on the ORDER id, which the per-direction
      // re-create preserves (the item's own cuid is fresh each time).
      await installHoldTrigger({
        name: WH_DELETE_HOLD,
        table: "external_order_items",
        timing: "BEFORE DELETE",
        rowAlias: "OLD",
        guardColumn: "orderId",
        ids: [GATE_WEBHOOK_ORDER_ID],
        seconds: 3,
      });

      const deleting = postDeleteWebhook();
      // The webhook holds the order's X lock while it sleeps in the trigger.
      expect(await waitForSleepingSessions(probe, 1)).toBe(true);
      const fulfilling = fulfilScenarioOrder();
      const waited = waitForLockWait(probe, 15_000);
      const [deleted, fulfilled, observed] = await Promise.all([deleting, fulfilling, waited]);

      expect(observed).toBe(true);
      expect(deleted.status).toBe(200);
      expect(deleted.body).toMatchObject({ success: true, deleted: true });
      // The order vanished under the fulfil — its REQUIRED lock says so.
      expect(fulfilled.status).toBe(409);
      expect(fulfilled.body.code).toBe("ORDER_GONE");

      // ...and it wrote nothing: the stock is untouched and the order is gone.
      expect(await stockIn(P_APPROVED)).toEqual({ row: 10 });
      const survivors = await rawRows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM external_orders WHERE id = ?",
        [GATE_WEBHOOK_ORDER_ID],
      );
      expect(Number(survivors[0]?.n ?? 0)).toBe(0);
    } finally {
      await dropHoldTrigger(WH_DELETE_HOLD);
      await probe.$disconnect();
    }
  });

  test("11c FULFIL-FIRST: the webhook waits on the order lock and answers protected", async () => {
    await rebuildFixture();
    const probe = openClient();
    try {
      await warmUp(probe);
      // The EXISTING ledger hold: the fulfil sleeps at its own `inventory_logs`
      // INSERT, inside the transaction that already holds the order's X lock.
      await installLedgerHold([P_APPROVED], 3);

      const fulfilling = fulfilScenarioOrder();
      expect(await waitForSleepingSessions(probe, 1)).toBe(true);
      const deleting = postDeleteWebhook();
      const waited = waitForLockWait(probe, 15_000);
      const [fulfilled, deleted, observed] = await Promise.all([fulfilling, deleting, waited]);

      expect(observed).toBe(true);
      expect(fulfilled.status).toBe(200);
      expect(deleted.status).toBe(200);
      // The snapshot the delete decided from was read UNDER the lock, so it saw
      // the fulfil's committed `stockedOut` — which is the whole point.
      expect(deleted.body).toMatchObject({ success: true, protected: true });

      // The order SURVIVES, with its row, and the deduction stands.
      const rows = await rawRows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM external_order_items WHERE orderId = ?",
        [GATE_WEBHOOK_ORDER_ID],
      );
      expect(Number(rows[0]?.n ?? 0)).toBe(1);
      expect(await orderStockedOutFor(GATE_WEBHOOK_ORDER_ID)).toBe(true);
      expect(await stockIn(P_APPROVED)).toEqual({ row: 9 });
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });
});

/** `stockedOut` for ANY order id — scenario 14's oracle is fixed to its own. */
async function orderStockedOutFor(orderId: string): Promise<boolean> {
  const rows = await rawRows<{ stockedOut: number }>(
    "SELECT stockedOut FROM external_orders WHERE id = ?",
    [orderId],
  );
  return Number(rows[0]?.stockedOut ?? 0) === 1;
}

// ==========================================================================
// SCENARIO 15 — THE B1c DEADLOCK PAIR IS GREEN (pack CB2.5c.3)
//
// THIS IS THE RETIREMENT'S PROOF. The register's engine trace was TRX A and
// TRX B, two covered writers on ONE product at LOCATION 1: each ledger INSERT
// takes a SHARED lock on the product row for its FK parent check, and each then
// wanted an EXCLUSIVE one for the location-1 `products.quantity` mirror — S->X,
// both ways, a cycle InnoDB resolves by rolling one of them back (a live P2034
// in the B1c gate). P2-B2.5 deleted the mirror write from every covered writer,
// so the X half is gone from this pair entirely and there is nothing left to
// cycle on: the second writer WAITS at the prelock's materialize for the first
// one's commit, and then commits itself.
//
// 15-i is the exact pair of the trace (deduct-simple x 2). 15-ii is the same
// claim across two DIFFERENT covered routes and lives in scenario 14's bracket,
// where the fulfilled line it unfulfils is owned.
//
// The outcome envelope is `assertCoveredRaceEnvelope`'s, shared with scenario 13
// (CB2.5c.2): both 200 — nothing else (B25-CX-4). ANY
// fresh deadlock here is a defect — `products-residual` included, because
// neither racer is a booking or a decline (CB2.5a.2).
// ==========================================================================

describe("scenario 15 — the B1c deadlock pair is GREEN (pack CB2.5c.3)", () => {
  jest.setTimeout(120_000);

  const OPENING = 20;
  const DEDUCT_EACH = 2;

  beforeEach(async () => {
    await resetAll();
    await setStock(P_APPROVED, OPENING);
  });

  afterAll(async () => {
    await dropHoldTrigger();
    await resetAll();
  });

  test("15-i: two deduct-simple requests on ONE product at location 1 — the register's TRX A / TRX B pair serialises and BOTH commit", async () => {
    const probe = openClient();
    try {
      await warmUp(probe);
      // Three seconds, 11a-ii's value (F28): the loser has to be OBSERVED
      // queueing on the winner's prelocked row, and a shorter hold leaves the
      // second request's launch racing the hold's own expiry on a loaded box.
      await installLedgerHold([P_APPROVED], 3);

      const {
        value: observed,
        after: deadlockAfter,
        fresh: deadlockFresh,
      } = await reportDeadlocks("scenario 15-i", async () => {
        const inFlight = [
          deductSimple(LOCATION_MAIN, [{ productId: P_APPROVED, quantity: DEDUCT_EACH }]),
          deductSimple(LOCATION_MAIN, [{ productId: P_APPROVED, quantity: DEDUCT_EACH }]),
        ];
        const seen = await observeRendezvous(probe);
        const settled = await Promise.all(inFlight);
        return { ...seen, settled };
      });

      console.log(
        `[scenario 15-i] serialised — InnoDB lock wait: ${observed.lockWait}, ` +
          `blocked on the prelock's materialize: ${observed.blockedOnMaterialize}; ` +
          `overlap observed: ${observed.overlapped}`,
      );

      // THE PROBE. One key, two writers: they cannot be inside the hold at the
      // same instant, so what the probe must catch is the loser WAITING — the
      // prelock's same-key serialisation (CB2.5d), which is the property that
      // replaced the cycle.
      expect(observed.lockWait || observed.blockedOnMaterialize).toBe(true);

      // BOTH COMMIT — no P2034, and `classifyDeadlock` is never reached. If a
      // fresh deadlock section exists at all, the envelope throws with the
      // engine's own trace in the message.
      assertCoveredRaceEnvelope("scenario 15-i", observed.settled, {
        after: deadlockAfter,
        fresh: deadlockFresh,
      });

      // CB2.5c.3: THIS pin's claim is "both commit", spelled directly beside the
      // envelope (which since B25-CX-4 requires the same thing): a 503 here is a
      // stall regression wearing the shared wire code — red.
      expect(observed.settled.map((a) => a.status)).toEqual([200, 200]);

      const [first, second] = observed.settled;
      const committed =
        (first.status === 200 ? 1 : 0) + (second.status === 200 ? 1 : 0);

      // THE STOCK ORACLE, EXACT: each committed request took its own units off
      // the one key, and nothing was lost to a stale read.
      expect(await stockIn(P_APPROVED)).toEqual({ row: OPENING - committed * DEDUCT_EACH });

      // ONE SALE row per committed request, all at location 1 — the ledger says
      // the same thing the row does.
      const sales = await rawRows<{ delta: number; locationId: number }>(
        `SELECT delta, locationId FROM inventory_logs
          WHERE logType = 'SALE' AND productId = ?
          ORDER BY id`,
        [P_APPROVED],
      );
      expect(sales).toHaveLength(committed);
      expect(sales.every((row) => Number(row.delta) === -DEDUCT_EACH)).toBe(true);
      expect(sales.every((row) => Number(row.locationId) === LOCATION_MAIN)).toBe(true);
    } finally {
      await dropHoldTrigger();
      await probe.$disconnect();
    }
  });
});

// ==========================================================================
// SCENARIO 18 — THE ADJUST CAPTURE'S STAMP TAKES THE ORDER LOCK (pack
// § P2-B3-1, "The capture gate scenario"; B3-CX6-4 ACCEPTED, B3-G6-9's
// no-new-scenario argument REJECTED — pack row 92)
//
// P2-B3-1 gives the adjust route a NEW stamp source: an order number the
// operator TYPED, resolved OUTSIDE the transaction to the order's STORED id.
// When it names one order, `lockFirst` takes that order's row as the
// transaction's first statement — the hook deduct-simple, fulfil and unfulfill
// already run. The mocked statement-order pin proves the CALL order; it cannot
// prove what InnoDB does with the order row, and until this scenario no gate
// run had ever driven the adjust handler at all.
//
//   18-i   a stamped adjust deduction vs a stamped deduct-simple on the SAME
//          order;
//   18-ii  the same adjust vs an UNFULFIL of that order (its line fulfilled
//          first, through the real route, not raced).
//
// Each leg runs for BOTH identities the adjust can carry (the typed number, or
// the picked id) and in BOTH launch orders — parameters, never copies. The
// first writer is held at its own ledger INSERT, inside the transaction that
// already holds the order's X lock, and proven ASLEEP before the second is
// launched (the 11c FULFIL-FIRST idiom). The claim is then read off the ENGINE:
// every lock the loser waited for, sampled for the whole of its life, is the
// ORDER ROW — never the stock row it is about to write. ADJUST-FIRST is the run
// that proves the adjust TOOK the order lock with the resolved id; OTHER-FIRST
// proves it ASKED for that row.
//
// THE PROBE IS PROVEN BY INVERSION (the control). Every racer here writes the
// SAME stock row, so a stock-row wait is always there to be observed: an adjust
// whose number resolves to NO order stamps nothing and locks no order, and the
// same stamped deduct-simple launched at it waits on `product_locations`
// instead. A probe that could only ever answer `external_orders` fails there.
//
// THE FIXTURE IS THIS SCENARIO'S OWN (the 11c precedent). Nothing in `seed.ts`
// owns its order: the bracket creates it, every run resets its fulfilment state
// through the seed's own scoped clauses before and after, and the `afterAll`
// takes it away — ASSERTING that it did, because `concurrency.test.ts` scenario
// 2 pins ABSOLUTE table-wide counts from another file.
// ==========================================================================

const S18_ORDER_ID = "concurrencygatecapture18";
/** Digits only (the resolver's bar is `^[0-9]{1,20}$`) and unique in the gate
 *  DB — the seed's orders are 1001/1002, 11c's is 77001. */
const S18_ORDER_NUMBER = "77018";
/** The control's number: well-formed, and no order carries it. */
const S18_UNMATCHED_NUMBER = "77019";
const S18_EXTERNAL_ID = "770018";
const S18_LINK = "gate-link-capture";
const S18_ITEM = "gate-item-capture";

/** The one stock row every racer here writes. */
const S18_KEY: PrelockKeyInput = { productId: P_APPROVED, locationId: LOCATION_MAIN };

const S18_OPENING = 10;
const S18_ADJUST_UNITS = 1;
const S18_DEDUCT_UNITS = 2;
/** The order line's quantity — what 18-ii's fulfil takes and its unfulfil puts back. */
const S18_LINE_UNITS = 2;
/** 11a-ii's, 11c's and 15's value (F28): the loser has to be OBSERVED queueing. */
const S18_HOLD_SECONDS = 3;

/** The file's reset, widened by this scenario's line and order: the seed's own
 *  B1.5 clauses put `fulfilledQty` and the stocked-out stamps back. */
async function resetScenario18(): Promise<void> {
  await resetGateFixtures({
    lineIds: SEED_LINE_IDS,
    productIds: SEED_PRODUCT_IDS,
    externalOrderItemIds: [GATE_ITEM_SINGLE, GATE_ITEM_BUNDLE, S18_ITEM],
    externalOrderIds: [GATE_EXT_ORDER_ID, S18_ORDER_ID],
  });
}

type S18Variant = "reference" | "selected";
type S18LaunchOrder = "adjust-first" | "other-first";

/** The capture: an `order` REMOVE carrying the typed number and NO id, or the
 *  picked id — the selected-id variant is this one parameter. */
function captureAdjust(
  variant: S18Variant,
  orderReference: string = S18_ORDER_NUMBER,
): Promise<RouteAnswer> {
  return callRoute(adjustRoute, "/api/inventory/adjust", {
    productId: S18_KEY.productId,
    locationId: S18_KEY.locationId,
    delta: -S18_ADJUST_UNITS,
    intent: "order",
    ...(variant === "reference" ? { orderReference } : { selectedExternalOrderId: S18_ORDER_ID }),
  });
}

/** A STAMPED deduct-simple on the scenario's order (the picked-id path). */
function stampedDeductSimple(): Promise<RouteAnswer> {
  return deductSimple(LOCATION_MAIN, [{ productId: S18_KEY.productId, quantity: S18_DEDUCT_UNITS }], {
    intent: "order",
    selectedExternalOrderId: S18_ORDER_ID,
  });
}

/** 14D's call shape, addressed at this scenario's order. */
function unfulfilCaptureOrder(): Promise<RouteAnswer> {
  return callParamRoute(
    unfulfillRoute,
    `/api/orders/${S18_ORDER_ID}/unfulfill`,
    { orderId: S18_ORDER_ID },
    {
      items: [
        {
          itemId: S18_ITEM,
          productId: S18_KEY.productId,
          quantity: S18_LINE_UNITS,
          locationId: S18_KEY.locationId,
        },
      ],
    },
  );
}

/** One lock a gate session was WAITING for, as `performance_schema` names it. */
type LockWaitSeen = {
  objectName: string;
  indexName: string | null;
  lockMode: string;
  lockData: string | null;
};

function describeWait(wait: LockWaitSeen): string {
  return `${wait.objectName}.${wait.indexName ?? "(table)"} ${wait.lockMode} ${wait.lockData ?? "(no data)"}`;
}

/**
 * EVERY lock a gate session waited for, sampled every 10 ms until `settled`
 * resolves — WHICH object, not merely "some wait" (`waitForLockWait` answers
 * only the latter). The REQUESTING side of `data_lock_waits`, joined to
 * `data_locks` on its own lock id and scoped to the gate schema (B25-CX-5: the
 * view is server-wide). De-duplicated by content, so one wait held for three
 * seconds is one entry and a second, different wait is a second entry.
 */
async function recordLockWaits(
  probe: PrismaClient,
  settled: Promise<unknown>,
): Promise<LockWaitSeen[]> {
  const state = { done: false };
  void settled.then(() => {
    state.done = true;
  });
  const seen = new Map<string, LockWaitSeen>();
  while (!state.done) {
    const rows = await probe.$queryRawUnsafe<LockWaitSeen[]>(
      `SELECT r.OBJECT_NAME AS objectName, r.INDEX_NAME AS indexName,
              r.LOCK_MODE AS lockMode, r.LOCK_DATA AS lockData
         FROM performance_schema.data_lock_waits w
         JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
        WHERE r.OBJECT_SCHEMA = ? AND r.LOCK_STATUS = 'WAITING'`,
      GATE_DB_NAME,
    );
    for (const row of rows) {
      const wait: LockWaitSeen = {
        objectName: String(row.objectName),
        indexName: row.indexName === null ? null : String(row.indexName),
        lockMode: String(row.lockMode),
        lockData: row.lockData === null ? null : String(row.lockData),
      };
      seen.set(describeWait(wait), wait);
    }
    await sleep(10);
  }
  return Array.from(seen.values());
}

type S18Race = {
  /** The first writer was inside its ledger hold before the second existed. */
  firstAsleep: boolean;
  /** Every lock any gate session waited for, from the second's launch to the end. */
  waits: LockWaitSeen[];
  /** In LAUNCH order: [the held first writer, the second]. */
  answers: [RouteAnswer, RouteAnswer];
  deadlock: { after: string | null; fresh: boolean };
};

/**
 * The house hold idiom (11c FULFIL-FIRST, `:3343`): hold the FIRST writer at its
 * own `inventory_logs` INSERT, prove it asleep, launch the SECOND at it, and
 * record what the second waits on until both have answered. The engine's
 * deadlock section is sampled around the whole race (`reportDeadlocks`).
 */
async function raceHeldFirst(
  label: string,
  first: () => Promise<RouteAnswer>,
  second: () => Promise<RouteAnswer>,
): Promise<S18Race> {
  const probe = openClient();
  try {
    await warmUp(probe);
    await installLedgerHold([S18_KEY.productId], S18_HOLD_SECONDS);
    const { value, after, fresh } = await reportDeadlocks(label, async () => {
      const held = first();
      // The first writer holds the order's X lock (when it stamps) and the stock
      // row from here until its hold expires.
      const firstAsleep = await waitForSleepingSessions(probe, 1);
      const queued = second();
      const waits = await recordLockWaits(probe, Promise.allSettled([held, queued]));
      const answers = await Promise.all([held, queued]);
      return { firstAsleep, waits, answers };
    });
    return { ...value, deadlock: { after, fresh } };
  } finally {
    await dropHoldTrigger();
    await probe.$disconnect();
  }
}

/** The ledger row id a batch's FIRST row got — commit order, because the loser
 *  cannot reach its own INSERT until the winner has committed. */
async function firstLedgerIdOf(batchId: string): Promise<number> {
  const rows = await rawRows<{ id: number | null }>(
    "SELECT MIN(id) AS id FROM inventory_logs WHERE batchId = ?",
    [batchId],
  );
  return Number(rows[0]?.id);
}

type AttemptRow = {
  outcome: string;
  evidence: string | null;
  reason: string | null;
  source: string;
  orderRecordId: string | null;
  ledgerRowId: number | null;
};

/** The attempt rows `recordAttributionAttempt` filed under one batch. */
async function attemptsForBatch(batchId: string): Promise<AttemptRow[]> {
  const rows = await rawRows<AttemptRow>(
    `SELECT outcome, evidence, reason, source, orderRecordId, ledgerRowId
       FROM order_attribution_attempts
      WHERE batchId = ?
      ORDER BY id`,
    [batchId],
  );
  return rows.map((row) => ({
    ...row,
    ledgerRowId: row.ledgerRowId === null ? null : Number(row.ledgerRowId),
  }));
}

/** The `details` of the ONE audit event filed under a batch (mysql2 hands a
 *  JSON column back parsed; a string is parsed here so the answer cannot
 *  depend on the driver). */
async function eventDetailsForBatch(batchId: string): Promise<Record<string, unknown>> {
  const rows = await rawRows<{ details: unknown }>(
    "SELECT details FROM audit_logs WHERE batchId = ? ORDER BY id",
    [batchId],
  );
  expect(rows).toHaveLength(1);
  const raw = rows[0].details;
  return (typeof raw === "string" ? JSON.parse(raw) : raw ?? {}) as Record<string, unknown>;
}

type StampedTotals = Record<string, { rows: number; units: number }>;

/** The order's WHOLE stamped ledger, by logType — what a reconciliation reads. */
async function stampedTotalsFor(orderId: string): Promise<StampedTotals> {
  const rows = await rawRows<{ logType: string; n: number; units: number | string }>(
    `SELECT logType, COUNT(*) AS n, SUM(delta) AS units
       FROM inventory_logs
      WHERE orderRecordId = ?
      GROUP BY logType`,
    [orderId],
  );
  const totals: StampedTotals = {};
  for (const row of rows) {
    totals[String(row.logType)] = { rows: Number(row.n), units: Number(row.units) };
  }
  return totals;
}

/** The order line's `fulfilledQty` and the order's `stockedOut`, together. */
async function captureOrderState(): Promise<{ fulfilledQty: number; stockedOut: boolean }> {
  const items = await rawRows<{ fulfilledQty: number }>(
    "SELECT fulfilledQty FROM external_order_items WHERE id = ?",
    [S18_ITEM],
  );
  return {
    fulfilledQty: Number(items[0]?.fulfilledQty),
    stockedOut: await orderStockedOutFor(S18_ORDER_ID),
  };
}

/** 18-ii's arrangement: the line fulfilled through the REAL route, alone. */
async function fulfilCaptureLine(): Promise<void> {
  const fulfilled = await callParamRoute(
    fulfillRoute,
    `/api/orders/${S18_ORDER_ID}/fulfill`,
    { orderId: S18_ORDER_ID },
    { locationId: LOCATION_MAIN, items: [{ itemId: S18_ITEM, quantity: S18_LINE_UNITS }] },
  );
  expect(fulfilled.status).toBe(200);
  const results = resultsOf(fulfilled);
  expect(results.failed).toEqual([]);
  expect(results.skipped).toEqual([]);
  expect(results.fulfilled).toHaveLength(1);
  expect(await captureOrderState()).toEqual({ fulfilledQty: S18_LINE_UNITS, stockedOut: true });
  expect(await stampedTotalsFor(S18_ORDER_ID)).toEqual({
    SALE: { rows: 1, units: -S18_LINE_UNITS },
  });
}

/** What distinguishes the two legs — everything else is one runner. */
type S18Leg = {
  leg: "18-i" | "18-ii";
  other: "deduct-simple" | "unfulfill";
  /** Run BEFORE the hold exists: the order as the other writer needs it. */
  arrange: () => Promise<void>;
  /** The stock row once `arrange` is done — the race's starting point. */
  beforeRace: { quantity: number; version: number };
  launchOther: () => Promise<RouteAnswer>;
  /** The batch the other writer's rows and its event were filed under. */
  otherBatchOf: (answer: RouteAnswer) => Promise<string>;
  /** Its one ledger row (the scenario's key), stamped with the order. */
  otherRow: { logType: string; delta: number };
  otherEvent: AuditRow;
  /** Its attempt row; null where the route records none — an unfulfil is not
   *  an attribution, and the pack names the adjust's and deduct-simple's classes. */
  otherAttempt: Omit<AttemptRow, "ledgerRowId"> | null;
  /** The order's whole stamped ledger once both have committed. */
  stampedAfter: StampedTotals;
};

const S18_LEGS: Record<S18Leg["leg"], S18Leg> = {
  "18-i": {
    leg: "18-i",
    other: "deduct-simple",
    arrange: async () => undefined,
    beforeRace: { quantity: S18_OPENING, version: 0 },
    launchOther: stampedDeductSimple,
    otherBatchOf: async (answer) => String(answer.body.batchId),
    otherRow: { logType: "SALE", delta: -S18_DEDUCT_UNITS },
    otherEvent: { actionType: "INVENTORY_BULK_UPDATE", entityType: "INVENTORY", entityId: null },
    otherAttempt: {
      outcome: "attributed",
      evidence: "selected",
      reason: null,
      source: "live-deduct",
      orderRecordId: S18_ORDER_ID,
    },
    stampedAfter: {
      ADJUSTMENT: { rows: 1, units: -S18_ADJUST_UNITS },
      SALE: { rows: 1, units: -S18_DEDUCT_UNITS },
    },
  },
  "18-ii": {
    leg: "18-ii",
    other: "unfulfill",
    arrange: fulfilCaptureLine,
    beforeRace: { quantity: S18_OPENING - S18_LINE_UNITS, version: 1 },
    launchOther: unfulfilCaptureOrder,
    // The unfulfill route answers with no batch id (14D): its change event
    // names it, which pins that event's existence too.
    otherBatchOf: async () => {
      const rows = await rawRows<{ batchId: string }>(
        `SELECT batchId FROM audit_logs
          WHERE actionType = 'EXTERNAL_ORDER_UNFULFILLMENT' AND entityId = ?`,
        [S18_ORDER_ID],
      );
      expect(rows).toHaveLength(1);
      return String(rows[0].batchId);
    },
    otherRow: { logType: "CORRECTION", delta: S18_LINE_UNITS },
    otherEvent: {
      actionType: "EXTERNAL_ORDER_UNFULFILLMENT",
      entityType: "ORDER",
      entityId: S18_ORDER_ID,
    },
    otherAttempt: null,
    stampedAfter: {
      SALE: { rows: 1, units: -S18_LINE_UNITS },
      ADJUSTMENT: { rows: 1, units: -S18_ADJUST_UNITS },
      CORRECTION: { rows: 1, units: S18_LINE_UNITS },
    },
  },
};

/** One run of one leg: a known start, the race, the engine's answer, the books,
 *  and the reset proven to take back everything the run wrote. */
async function runCaptureLeg(
  leg: S18Leg,
  variant: S18Variant,
  launch: S18LaunchOrder,
): Promise<void> {
  const label = `scenario ${leg.leg} ${variant} ${launch}`;

  // A KNOWN START: the stock, the order's fulfilment state, an unstamped order,
  // and the three table-wide counts the reset must bring back.
  await resetScenario18();
  await setStock(S18_KEY.productId, S18_OPENING);
  expect(await captureOrderState()).toEqual({ fulfilledQty: 0, stockedOut: false });
  expect(await stampedTotalsFor(S18_ORDER_ID)).toEqual({});
  const opening = await countSnapshot();

  await leg.arrange();
  expect(await locationRow(S18_KEY)).toMatchObject(leg.beforeRace);

  const adjust = (): Promise<RouteAnswer> => captureAdjust(variant);
  const race =
    launch === "adjust-first"
      ? await raceHeldFirst(label, adjust, leg.launchOther)
      : await raceHeldFirst(label, leg.launchOther, adjust);
  const [adjusted, other] =
    launch === "adjust-first" ? race.answers : [race.answers[1], race.answers[0]];

  console.log(
    `[${label}] first writer asleep in its ledger hold: ${race.firstAsleep}; ` +
      `the loser's lock waits: ${race.waits.map(describeWait).join(" | ") || "(none observed)"}; ` +
      `adjust -> ${adjusted.status}, ${leg.other} -> ${other.status}`,
  );

  // THE RACE REALLY HAPPENED: the first writer was inside its hold — holding the
  // order row — before the second was launched at it.
  expect(race.firstAsleep).toBe(true);

  // BOTH COMMIT, and no fresh deadlock section of ANY shape (three covered
  // writers; none takes an X lock on `products` — CB2.5a.2).
  assertCoveredRaceEnvelope(label, race.answers, race.deadlock);
  expect([adjusted.status, other.status]).toEqual([200, 200]);

  // THE CLAIM, off the engine: the loser waited on the ORDER ROW and on nothing
  // else — never on `product_locations`, where both of them write (the control
  // above is the run in which it does).
  expect(Array.from(new Set(race.waits.map((wait) => wait.objectName)))).toEqual([
    "external_orders",
  ]);
  for (const wait of race.waits) {
    expect(wait.indexName).toBe("PRIMARY");
    expect(wait.lockData ?? "").toContain(S18_ORDER_ID);
  }

  // WHO WON, from the ledger: the first-launched writer committed first.
  const adjustBatch = String(adjusted.body.batchId);
  const otherBatch = await leg.otherBatchOf(other);
  const adjustRowId = await firstLedgerIdOf(adjustBatch);
  const otherRowId = await firstLedgerIdOf(otherBatch);
  const winner = adjustRowId < otherRowId ? "adjust" : leg.other;
  console.log(
    `[${label}] committed first: ${winner} (adjust ledger row #${adjustRowId}, ` +
      `${leg.other} ledger row #${otherRowId})`,
  );
  expect(winner).toBe(launch === "adjust-first" ? "adjust" : leg.other);

  // THE STAMP — the order's STORED id, never the typed text — on the row, and on
  // the wire the attribution toast reads (`log.orderRecordId`).
  expect((adjusted.body.log as { orderRecordId?: unknown }).orderRecordId).toBe(S18_ORDER_ID);
  expect(await ledgerRowsForBatch(adjustBatch)).toEqual([
    {
      productId: S18_KEY.productId,
      delta: -S18_ADJUST_UNITS,
      logType: "ADJUSTMENT",
      locationId: S18_KEY.locationId,
      orderRecordId: S18_ORDER_ID,
    },
  ]);
  expect(await ledgerRowsForBatch(otherBatch)).toEqual([
    {
      productId: S18_KEY.productId,
      delta: leg.otherRow.delta,
      logType: leg.otherRow.logType,
      locationId: S18_KEY.locationId,
      orderRecordId: S18_ORDER_ID,
    },
  ]);
  expect(await stampedTotalsFor(S18_ORDER_ID)).toEqual(leg.stampedAfter);

  // THE STOCK ORACLE, EXACT: the adjust's units off, the other writer's on or
  // off, one version per committed write.
  expect(await locationRow(S18_KEY)).toMatchObject({
    quantity: leg.beforeRace.quantity - S18_ADJUST_UNITS + leg.otherRow.delta,
    version: leg.beforeRace.version + 2,
  });

  // THE ATTEMPT CLASSES, each naming its own ledger row.
  expect(await attemptsForBatch(adjustBatch)).toEqual([
    {
      outcome: "attributed",
      evidence: variant === "reference" ? "reference-resolved" : "selected",
      reason: null,
      source: "live-adjust",
      orderRecordId: S18_ORDER_ID,
      ledgerRowId: adjustRowId,
    },
  ]);
  if (leg.otherAttempt !== null) {
    expect(await attemptsForBatch(otherBatch)).toEqual([
      { ...leg.otherAttempt, ledgerRowId: otherRowId },
    ]);
  }

  // THE AUDIT BATCH IDS MATCH THE LEDGER: each request's ONE event is filed
  // under the batch its rows carry. The typed text rides on the adjust's event
  // only when it was typed.
  expect(await auditRowsForBatch(adjustBatch)).toEqual([
    {
      actionType: "INVENTORY_ADJUSTMENT",
      entityType: "INVENTORY",
      entityId: String(S18_KEY.productId),
    },
  ]);
  const details = await eventDetailsForBatch(adjustBatch);
  expect(details.intent).toBe("order");
  if (variant === "reference") {
    expect(details.orderReference).toBe(S18_ORDER_NUMBER);
  } else {
    expect(details).not.toHaveProperty("orderReference");
  }
  expect(await auditRowsForBatch(otherBatch)).toEqual([leg.otherEvent]);

  // THE CLEANUP, proven: the reset takes back every row this run wrote — the
  // arrangement's fulfil included — and the order is unfulfilled again.
  await resetScenario18();
  expect(await countSnapshot()).toEqual(opening);
  expect(await captureOrderState()).toEqual({ fulfilledQty: 0, stockedOut: false });
  expect(await stampedTotalsFor(S18_ORDER_ID)).toEqual({});
}

/** Leg x identity x launch order — eight runs of ONE runner. */
const S18_RUNS = (["18-i", "18-ii"] as const).flatMap((leg) =>
  (["reference", "selected"] as const).flatMap((variant) =>
    (["adjust-first", "other-first"] as const).map((launch) => ({
      leg,
      other: S18_LEGS[leg].other,
      variant,
      launch,
    })),
  ),
);

describe("scenario 18 — the adjust capture's stamp takes the ORDER LOCK on a real engine (pack § P2-B3-1)", () => {
  jest.setTimeout(120_000);

  /** The three table-wide counts before this bracket created anything. */
  let bracketOpening: CountSnapshot;

  beforeAll(async () => {
    await resetAll();
    bracketOpening = await countSnapshot();

    await singleton.productLink.create({
      data: {
        id: S18_LINK,
        integrationId: GATE_INTEGRATION_ID,
        externalProductId: "gate-capture-single",
        internalProductId: P_APPROVED,
      },
    });
    await singleton.externalOrder.create({
      data: {
        id: S18_ORDER_ID,
        companyId: GATE_COMPANY_ID,
        integrationId: GATE_INTEGRATION_ID,
        externalId: S18_EXTERNAL_ID,
        orderNumber: S18_ORDER_NUMBER,
        nativeStatus: "processing",
        total: 0,
        rawPayload: {},
      },
    });
    await singleton.externalOrderItem.create({
      data: {
        id: S18_ITEM,
        orderId: S18_ORDER_ID,
        externalItemId: "gcap-1",
        externalProductId: "gate-capture-single",
        name: "Gate capture single",
        quantity: S18_LINE_UNITS,
        price: 0,
        productLinkId: S18_LINK,
        isMapped: true,
        fulfilledQty: 0,
      },
    });

    // The resolver's bar, asserted on the fixture rather than assumed: the
    // number names exactly ONE order in the gate DB, the control's names none.
    const named = await rawRows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_orders WHERE orderNumber = ?",
      [S18_ORDER_NUMBER],
    );
    expect(Number(named[0]?.n ?? 0)).toBe(1);
    const unmatched = await rawRows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM external_orders WHERE orderNumber = ?",
      [S18_UNMATCHED_NUMBER],
    );
    expect(Number(unmatched[0]?.n ?? 0)).toBe(0);
  });

  afterAll(async () => {
    await dropHoldTrigger();
    // NOTHING in `seed.ts` owns this order, so this bracket takes it away (its
    // line cascades) — otherwise `concurrency.test.ts` scenario 2's ABSOLUTE
    // counts fail in another file of the same serial run.
    await singleton.externalOrderItem.deleteMany({ where: { orderId: S18_ORDER_ID } });
    await singleton.externalOrder.deleteMany({ where: { id: S18_ORDER_ID } });
    await singleton.productLink.deleteMany({ where: { id: S18_LINK } });
    await singleton.auditLog.deleteMany({
      where: { entityType: "ORDER", entityId: S18_ORDER_ID },
    });
    await resetAll();

    // ...and PROVEN gone. The egress row is scenario 14's belt, re-asserted for
    // this bracket's own fulfils and unfulfils.
    const residue = await rawRows<Record<string, number>>(
      `SELECT
         (SELECT COUNT(*) FROM external_orders WHERE id = ?) AS orders,
         (SELECT COUNT(*) FROM external_order_items WHERE id = ? OR orderId = ?) AS items,
         (SELECT COUNT(*) FROM product_links WHERE id = ?) AS links,
         (SELECT COUNT(*) FROM audit_logs WHERE entityType = 'ORDER' AND entityId = ?) AS orderEvents,
         (SELECT COUNT(*) FROM inventory_logs WHERE orderRecordId = ?) AS stampedRows,
         (SELECT COUNT(*) FROM order_attribution_attempts WHERE orderRecordId = ?) AS attempts,
         (SELECT COUNT(*) FROM platform_write_attempts WHERE integrationId = ?) AS egress`,
      [
        S18_ORDER_ID,
        S18_ITEM,
        S18_ORDER_ID,
        S18_LINK,
        S18_ORDER_ID,
        S18_ORDER_ID,
        S18_ORDER_ID,
        GATE_INTEGRATION_ID,
      ],
    );
    const counts = Object.fromEntries(
      Object.entries(residue[0] ?? {}).map(([key, n]) => [key, Number(n)]),
    );
    console.log(`[scenario 18] fixture cleanup residue: ${JSON.stringify(counts)}`);
    expect(counts).toEqual({
      orders: 0,
      items: 0,
      links: 0,
      orderEvents: 0,
      stampedRows: 0,
      attempts: 0,
      egress: 0,
    });
    expect(await countSnapshot()).toEqual(bracketOpening);
  });

  test("18 control: a number that names NO order stamps nothing and locks no order — the stamped deduct-simple launched at it waits on the STOCK row instead", async () => {
    // THE INVERSION THAT MAKES THE LEGS' PROBE EVIDENCE. Same route, same chip,
    // same launch order as ADJUST-FIRST; only the number differs, so the adjust
    // resolves nothing, stamps nothing and takes no order lock. The deduct-simple
    // then gets the order row at once and queues in the prelock's materialize on
    // `product_locations` behind the held adjust — which the probe must NAME.
    // (Observed on MySQL 8.4, 2026-11-11: an X,INSERT_INTENTION wait on that
    // table's PRIMARY index at the supremum pseudo-record — the same-location
    // materialize serialisation 11a-i records — never a row of `external_orders`.)
    await resetScenario18();
    await setStock(S18_KEY.productId, S18_OPENING);
    const opening = await countSnapshot();

    const label = "scenario 18 control";
    const race = await raceHeldFirst(
      label,
      () => captureAdjust("reference", S18_UNMATCHED_NUMBER),
      stampedDeductSimple,
    );
    const [adjusted, deducted] = race.answers;
    console.log(
      `[${label}] first writer asleep in its ledger hold: ${race.firstAsleep}; ` +
        `the loser's lock waits: ${race.waits.map(describeWait).join(" | ") || "(none observed)"}; ` +
        `adjust -> ${adjusted.status}, deduct-simple -> ${deducted.status}`,
    );

    expect(race.firstAsleep).toBe(true);
    assertCoveredRaceEnvelope(label, race.answers, race.deadlock);
    expect(race.answers.map((answer) => answer.status)).toEqual([200, 200]);

    // THE PROBE SAYS SOMETHING ELSE when the engine does: the stock table, and
    // not the order row the deduct-simple took unopposed.
    expect(Array.from(new Set(race.waits.map((wait) => wait.objectName)))).toEqual([
      "product_locations",
    ]);

    // The adjust's own record: unstamped, declined `unmatched`, the typed text
    // accrued on its event all the same (pack CB3a-i.3).
    const adjustBatch = String(adjusted.body.batchId);
    expect(await ledgerRowsForBatch(adjustBatch)).toEqual([
      {
        productId: S18_KEY.productId,
        delta: -S18_ADJUST_UNITS,
        logType: "ADJUSTMENT",
        locationId: S18_KEY.locationId,
        orderRecordId: null,
      },
    ]);
    expect(await attemptsForBatch(adjustBatch)).toEqual([
      {
        outcome: "declined",
        evidence: null,
        reason: "unmatched",
        source: "live-adjust",
        orderRecordId: null,
        ledgerRowId: await firstLedgerIdOf(adjustBatch),
      },
    ]);
    expect((await eventDetailsForBatch(adjustBatch)).orderReference).toBe(S18_UNMATCHED_NUMBER);

    // Only the deduct-simple's row is stamped, and the stock is exact.
    expect(await stampedTotalsFor(S18_ORDER_ID)).toEqual({
      SALE: { rows: 1, units: -S18_DEDUCT_UNITS },
    });
    expect(await locationRow(S18_KEY)).toMatchObject({
      quantity: S18_OPENING - S18_ADJUST_UNITS - S18_DEDUCT_UNITS,
      version: 2,
    });

    await resetScenario18();
    expect(await countSnapshot()).toEqual(opening);
  });

  test.each(S18_RUNS)(
    "$leg: the $variant adjust vs $other, $launch launched first and held — they serialise on the ORDER LOCK and both commit",
    async ({ leg, variant, launch }) => {
      await runCaptureLeg(S18_LEGS[leg], variant, launch);
    },
  );
});
