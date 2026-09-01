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
 *       It races OFF the location-1 compatibility mirror, for a measured reason
 *       spelled out at `OFF_MIRROR_1` below: the mirror's write on `products`
 *       has a deadlock of its own with a concurrent prelock's FK parent check,
 *       and it is not this scenario's question.
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
 *       purpose: the first real-engine exercise of the `products` compatibility
 *       mirror on a bundle, which is where the named FK S->X residual lives.
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
 * above prints the engine's own section. The `products` FK S→X residual (every
 * ledger insert takes a shared lock on its product row, and the location-1
 * mirror takes an exclusive one) is the named reason that branch stays open;
 * deduct-simple is single-attempt by design and does not retry into it.
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
import mysql from "mysql2/promise";
import { NextRequest } from "next/server";
import type { PrelockKeyInput, PrelockedRow } from "@/lib/inventory/prelock";
import { openClient } from "./clients";
import {
  GATE_ADMIN_ID,
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
type ParamRoute = {
  POST: (request: NextRequest, ctx: { params: { orderId: string } }) => Promise<Response>;
};

let prelock: typeof import("@/lib/inventory/prelock");
let orderLock: typeof import("@/lib/inventory/order-lock");
let inventory: typeof import("@/lib/inventory");
let deductSimpleRoute: SingleArgRoute;
let batchAdjustRoute: SingleArgRoute;
let fulfillRoute: ParamRoute;
let unfulfillRoute: ParamRoute;
let singleton: PrismaClient;

// --------------------------------------------------------------------------
// The fixture this file races on — SEEDED products only
// --------------------------------------------------------------------------

/**
 * The two overlapping keys scenario 13 races over, at the COMPATIBILITY
 * location — the routes deduct at location 1 in real life, and the
 * `products.quantity` mirror that entails is part of what is under test there.
 * P_APPROVED (9101) sorts before P_APPROVED_2 (9103), so "canonical order" is a
 * statement with observable content: it is NOT the order either racer asks in.
 */
const KEY_1: PrelockKeyInput = { productId: P_APPROVED, locationId: LOCATION_MAIN };
const KEY_2: PrelockKeyInput = { productId: P_APPROVED_2, locationId: LOCATION_MAIN };

/**
 * The same two products OFF THE MIRROR, which is where scenario 9c races.
 *
 * MEASURED, and the reason this pair exists: run 9c's covered writes at
 * location 1 and the race deadlocks — but NOT on the prelock's key order, which
 * is what 9c is about. `applyStockDelta`'s location-1 mirror
 * (`UPDATE products SET quantity = quantity + n`) needs an X lock on the
 * PRODUCT row, while the other session's materialize INSERT is holding a SHARED
 * lock on that same product row (the FK parent check of
 * `product_locations.fk_pl_product`) and waiting for the `product_locations`
 * row the first session holds. That cycle is the `products` FK S→X residual the
 * pack names — `products` sits OUTSIDE the canonical order by spec §2.7, it is
 * why scenario 13's envelope allows a rolled-back writer, and its shape
 * predates B1 (before the prelock, the ledger INSERT's own FK check took the
 * same shared lock at the same point). It is NOT the prelock's ordering, so it
 * does not belong inside the scenario that tests the prelock's ordering: 9c
 * races off the mirror, and the location-1 observation is reported instead.
 */
const OFF_MIRROR_1: PrelockKeyInput = { productId: P_APPROVED, locationId: LOCATION_SECOND };
const OFF_MIRROR_2: PrelockKeyInput = { productId: P_APPROVED_2, locationId: LOCATION_SECOND };

/**
 * THE NEVER-STOCKED KEY (9d and the `{0,0}` pin). The seed gives every seeded
 * product a row at BOTH locations, so a genuinely absent key has to be made:
 * the row is deleted after the reset, which is safe precisely because
 * `resetGateFixtures` rebuilds every scoped `product_locations` row from the
 * snapshot — the next reset puts it back with no help from this file. Off the
 * mirror, for the reason above.
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

/** `products.quantity`, the location-1 compatibility mirror. */
async function mirroredQuantity(productId: number): Promise<number> {
  const rows = await rawRows<{ quantity: number }>(
    "SELECT quantity FROM products WHERE id = ?",
    [productId],
  );
  return Number(rows[0]?.quantity ?? 0);
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
 *     the residual spec §2.7 names and `OFF_MIRROR_1` measures: `products` sits
 *     OUTSIDE the canonical order (the ledger insert's FK parent check takes S
 *     on it, the location-1 mirror takes X), its shape predates B1, and it is
 *     why scenario 13's envelope allows a rolled-back writer at all.
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

const HOLD_TRIGGER = "b1_prelock_hold";

/**
 * The hold point for the ROUTE race, in the database, because a route exposes
 * no callback to put one in and inventing one would be changing app code to
 * make a test pass (`concurrency-3.test.ts`'s doctrine).
 *
 * `BEFORE INSERT` on `inventory_logs`, guarded on this file's own product ids:
 * it fires for the winner's ledger writes and for nothing else this gate does
 * while it is installed. The guard is built from integers this module owns —
 * a trigger body takes no parameters, so the values are checked before they go
 * anywhere near the server.
 */
async function installHoldTrigger(productIds: readonly number[], seconds: number): Promise<void> {
  productIds.forEach((id) => {
    if (!Number.isSafeInteger(id)) throw new Error(`concurrency-4: refusing to inline "${id}"`);
  });
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 5) {
    throw new Error(`concurrency-4: refusing a hold of ${seconds}s`);
  }
  await withRaw(async (conn) => {
    await conn.query(`DROP TRIGGER IF EXISTS ${HOLD_TRIGGER}`);
    await conn.query(
      `CREATE TRIGGER ${HOLD_TRIGGER} BEFORE INSERT ON inventory_logs
       FOR EACH ROW
       BEGIN
         IF NEW.productId IN (${productIds.join(", ")}) THEN
           DO SLEEP(${seconds});
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
async function callParamRoute(
  route: ParamRoute,
  path: string,
  params: { orderId: string },
  body: unknown,
): Promise<RouteAnswer> {
  const request = new NextRequest(`http://concurrency-gate.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await route.POST(request, { params });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

type DeductItem = { productId: number; quantity: number };
type Adjustment = { productId: number; locationId: number; delta: number };

function deductSimple(locationId: number, items: DeductItem[]): Promise<RouteAnswer> {
  return callRoute(deductSimpleRoute, "/api/inventory/deduct-simple", { locationId, items });
}

function batchAdjust(adjustments: Adjustment[]): Promise<RouteAnswer> {
  return callRoute(batchAdjustRoute, "/api/inventory/batch-adjust", { adjustments });
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
  // B1.5 (pack CB1.5a-ii): the first time either of these runs against a real
  // engine. Same registry, same singleton, same fail-closed schema proof below.
  fulfillRoute = (await import(
    "@/app/api/orders/[orderId]/fulfill/route"
  )) as unknown as ParamRoute;
  unfulfillRoute = (await import(
    "@/app/api/orders/[orderId]/unfulfill/route"
  )) as unknown as ParamRoute;

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
 * throwaway run of 9c's race at location 1 — the configuration `OFF_MIRROR_1`
 * says deadlocks on the `products` residual, which is exactly what it did.
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

  test("the location-1 mirror cycle reads as the ACCEPTED `products` residual", () => {
    const verdict = classifyDeadlock(CAPTURED_PRODUCTS_RESIDUAL);

    // The residual's exact signature: one waiter parked on the covered row, the
    // other parked on the `products` row the mirror UPDATE needs exclusively —
    // and the HOLDS lines (a shared `products` lock, held `product_locations`
    // rows) contribute nothing, which is why only the waits are read.
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
    // (Off the location-1 mirror by design — see `OFF_MIRROR_1`.)
    await resetAll();
    const sessionA = openClient();
    const sessionB = openClient();
    const probe = openClient();

    try {
      await warmUp(sessionA, sessionB, probe);

      // The hold point: the winner's ledger writes sleep while it holds BOTH
      // materialized rows, so the loser is unambiguously blocked on the
      // prelock rather than merely late.
      await installHoldTrigger([OFF_MIRROR_1.productId, OFF_MIRROR_2.productId], 0.3);

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
          session(sessionA, GATE_EXT_ORDER_ID, [OFF_MIRROR_1, OFF_MIRROR_2]),
          session(sessionB, GATE_EXT_ORDER_2_ID, [OFF_MIRROR_2, OFF_MIRROR_1]),
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
      for (const key of [OFF_MIRROR_1, OFF_MIRROR_2]) {
        const versions = maps.map((map) => readOf(map, key).version).sort();
        const quantities = maps.map((map) => readOf(map, key).quantity).sort();
        expect(versions).toEqual([0, 1]);
        expect(quantities).toEqual([0, 1]);
      }
      const firstIndex = maps.findIndex((map) => readOf(map, OFF_MIRROR_1).version === 0);
      expect(readOf(maps[firstIndex], OFF_MIRROR_2).version).toBe(0);

      // Both writes landed on both keys — and location 2 is off the
      // compatibility mirror, so `products.quantity` never moved.
      for (const key of [OFF_MIRROR_1, OFF_MIRROR_2]) {
        expect(await locationRow(key)).toMatchObject({ quantity: 2, version: 2 });
        expect(await mirroredQuantity(key.productId)).toBe(0);
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
      // rather than merely late. Location 2 carries no `products.quantity`
      // mirror, so the only contention here is the key itself.
      await installHoldTrigger([NEVER_STOCKED_KEY.productId], 0.5);

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
      // Location 2 is off the compatibility mirror, and stayed off it.
      expect(await mirroredQuantity(NEVER_STOCKED_KEY.productId)).toBe(0);
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

      // Opening stock through the real write path, so the ledger, the rows and
      // the mirror all agree before the race starts.
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
      await installHoldTrigger([KEY_1.productId, KEY_2.productId], 0.3);

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

      // THE OUTCOME ENVELOPE (pack REV-14 PKb-10, widened by REV-22 F3). Both
      // commit, OR one commits and the other comes back rolled back. Two wire
      // codes are legal for that second case and the gate accepts either: the
      // GENERIC 500 the pre-F3 ladder produced (`apiHandler` had no branch for
      // P2034, so the wire never named the deadlock) and the typed 503 `BUSY`
      // F3 adds for P2028/P2034. Which one a run lands on is F3's business, not
      // this gate's — but SOMETHING has to be asserted, and either way the
      // classification below is what makes the branch cost something. Anything
      // else (a 409, a 400, two failures) is a real defect.
      const statuses = [deduct.status, adjust.status].sort();
      const bothCommitted = statuses[0] === 200 && statuses[1] === 200;
      const oneRolledBack =
        statuses[0] === 200 && (statuses[1] === 500 || statuses[1] === 503);
      expect(bothCommitted || oneRolledBack).toBe(true);

      if (oneRolledBack) {
        const failed = answers.find((answer) => answer.status !== 200);
        if (failed?.status === 503) {
          // F3's typed branch: the CODE is the contract, the sentence is F3's
          // copy and is not re-spelled here.
          expect(failed.body).toMatchObject({ code: "BUSY" });
        } else {
          // The generic body, verbatim: no code, no P2034, nothing an operator
          // could act on — which is exactly why the report above prints the
          // engine's own deadlock section instead.
          expect(failed?.body).toEqual({ error: "Internal server error" });
        }

        // AND WHICH DEADLOCK IT WAS (pack REV-22 F9). This branch is tolerated
        // for ONE named reason, so it has to NAME it: the accepted `products`
        // residual passes (recorded), a `product_locations` AB/BA cycle fails
        // with the engine's own trace, and a rollback the section cannot
        // account for fails too rather than borrowing the residual's licence.
        // (The section is global and holds only the LATEST cycle: if a race
        // ever deadlocked twice, this classifies the last one — the printed
        // trace is the evidence either way.)
        const verdict = classifyDeadlock(deadlockFresh ? deadlockAfter : null);
        console.log(
          `[scenario 13] the rolled-back branch fired — deadlock shape: ${verdict.shape}; ` +
            `${verdict.why}`,
        );
        if (verdict.shape !== "products-residual") {
          throw new Error(
            [
              "scenario 13: a request rolled back, and the engine's deadlock section does NOT " +
                "say it was the accepted `products` residual.",
              `shape: ${verdict.shape} — ${verdict.why}`,
              `waits parsed: ${
                verdict.waits.map((wait) => `${wait.table}.${wait.index}`).join(" | ") || "(none)"
              }`,
              `a NEW deadlock was detected during this race: ${deadlockFresh}`,
              "LATEST DETECTED DEADLOCK:",
              deadlockAfter ?? "(the engine has recorded none)",
            ].join("\n"),
          );
        }
      }

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
      expect(await mirroredQuantity(KEY_1.productId)).toBe(expectedFor(DEDUCT_1));
      expect(await mirroredQuantity(KEY_2.productId)).toBe(expectedFor(DEDUCT_2));

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

/** BOTH tables, in ONE assertable object (pack CB1.5a-ii, PKc-4): scenario 14
 *  runs at location 1, so `products.quantity` is a second source of truth that
 *  has to move with `product_locations` — asserting only one of them would let
 *  the mirror drift silently, which is the exact class of bug this lane exists
 *  to kill. */
async function stockIn(productId: number): Promise<{ row: number | null; mirror: number }> {
  const row = await locationRow({ productId, locationId: LOCATION_MAIN });
  return { row: row?.quantity ?? null, mirror: await mirroredQuantity(productId) };
}

/** Arrange, through BOTH tables — the same pair every assertion reads back. */
async function setStock(productId: number, quantity: number): Promise<void> {
  await singleton.product_locations.updateMany({
    where: { productId, locationId: LOCATION_MAIN },
    data: { quantity },
  });
  await singleton.product.update({ where: { id: productId }, data: { quantity } });
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
   * the location-1 `products` mirror on a BUNDLE — the lane's one observed
   * deadlock site.
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

    // The location-1 mirror on a bundle is the named `products` FK S->X residual
    // site, so the engine's own deadlock section is sampled around the request
    // and PRINTED — reported, never asserted (pack REV-14 PKb-10).
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
    expect(await stockIn(P_APPROVED)).toEqual({ row: 7, mirror: 7 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 8, mirror: 8 });

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

    expect(await stockIn(P_APPROVED)).toEqual({ row: 0, mirror: 0 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 10, mirror: 10 });

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
      await installHoldTrigger([P_APPROVED], 2);

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
      expect(await stockIn(P_APPROVED)).toEqual({ row: 8, mirror: 8 });
      expect(await stockIn(P_APPROVED_2)).toEqual({ row: 10, mirror: 10 });
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
    expect(await stockIn(P_APPROVED)).toEqual({ row: 7, mirror: 7 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 8, mirror: 8 });

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
    expect(await stockIn(P_APPROVED)).toEqual({ row: 10, mirror: 10 });
    expect(await stockIn(P_APPROVED_2)).toEqual({ row: 10, mirror: 10 });
    expect(await orderStockedOut()).toBe(false);
  });
});
