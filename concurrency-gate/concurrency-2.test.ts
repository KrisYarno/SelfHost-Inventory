/**
 * concurrency-gate/concurrency-2.test.ts — THE CROSS-ACTOR LOCKING PROOFS (plan
 * P-2; spec §11; pack C7b.1 + C7b.2 scenarios 3-7).
 *
 * `concurrency.test.ts` (M7a) proves what the BOOKING PRIMITIVE does to itself:
 * two batches on one line, one bookingKey twice. This file proves what happens
 * when the primitive races SOMEBODY ELSE — an admin declining the product under
 * it, an admin approving it, a second order stocking the same catalog entry, a
 * recount raising the ceiling mid-batch, two people writing off the same
 * remainder. Those seams cross a transaction boundary and a lock order, and no
 * mocked-tx suite can answer whether they hold.
 *
 * TWO KINDS OF ACTOR, deliberately (C7b.1):
 *
 *   the booking side runs the CORES DIRECTLY over its own `PrismaClient` (one
 *   client = one database session), exactly as `concurrency.test.ts` does;
 *
 *   the approval side runs THE REAL EXPORTED ROUTE HANDLERS. The approve
 *   transaction is route-local — copying it into the test would prove the copy
 *   locks correctly and nothing about the route. So the handler is imported and
 *   called, with the REAL `apiHandler`, the REAL Prisma singleton, the REAL
 *   `declineProduct`, the REAL exception writer and the REAL `recordChange`;
 *   only `requireAdmin`, `requireCSRF` and the rate-limit counter are mocked,
 *   because this harness has no cookies, no session and no HTTP server. The
 *   handler's singleton is one session; the booking client is another.
 *
 * THE SINGLETON'S URL. `@/lib/prisma` reads `DATABASE_URL` when it constructs,
 * so `beforeAll` sets it from the harness state and calls `jest.resetModules()`
 * BEFORE the first import that can reach it — which is why every `@/lib/...`
 * import in this file is dynamic and the static imports are types only. The
 * session's schema is then PROVEN (`SELECT DATABASE()`) before a single write.
 *
 * THE EXCEPTION WRITES ARE REAL HERE (unlike M7a's capture-only recorder):
 * scenarios 4, 5 and 7 assert what the REGISTER holds after the race, and a
 * captured callback argument proves nothing about a row. The recorders below
 * call the same writer, with the same subjects, as the routes in C3b.
 */

import { InboundShipmentStatus, StagingItemStatus, type PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import type {
  BookingArgs,
  BookingRecordContext,
  BookingResult,
  DiscardRecordContext,
  DiscardResult,
} from "@/lib/supply-orders/booking";
import type { VerifyRecordContext, VerifyResult } from "@/lib/supply-orders/verify";
import { openClient } from "./clients";
import { moneyOracle, productOracle, unitsOracle } from "./oracles";
import {
  GATE_ADMIN_ID,
  GATE_ORDER_ID,
  L1_TOTAL_CENTS,
  LINE_L1,
  LINE_L2,
  LOCATION_MAIN,
  P_APPROVED,
  P_PENDING,
  resetGateFixtures,
  SEED_LINE_IDS,
  SEED_PRODUCT_IDS,
} from "./seed";
import { GATE_DB_NAME, gateDatabaseUrl } from "./state";

const ADMIN = { id: GATE_ADMIN_ID, isAdmin: true };

/** L1: 10001 cents over a basis of 10 -> half-even 1000 cents per unit. */
const L1_UNIT_COST = 1000;

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
// cannot produce. `apiHandler`, the Prisma singleton, the retry envelopes,
// `declineProduct`, the exception writer and `recordChange` all stay REAL — they
// are the parts under test.
jest.mock("@/lib/api-utils", () => ({
  ...jest.requireActual("@/lib/api-utils"),
  requireAdmin: jest.fn(async () => ({ user: mockAdminSession })),
  requireCSRF: jest.fn(async () => undefined),
}));

jest.mock("@/lib/rateLimit", () => ({
  ...jest.requireActual("@/lib/rateLimit"),
  // The real counter is a per-process in-memory map; five calls in one test file
  // are not what it is there to defend against.
  enforceRateLimit: jest.fn(() => ({})),
}));

// --------------------------------------------------------------------------
// The dynamically-loaded production modules
// --------------------------------------------------------------------------

type ProductRouteModule = {
  POST: (request: NextRequest, ctx: { params: { id: string } }) => Promise<Response>;
};

let booking: typeof import("@/lib/supply-orders/booking");
let verifyCore: typeof import("@/lib/supply-orders/verify");
let refusals: typeof import("@/lib/supply-orders/refusals");
let exceptionsWrite: typeof import("@/lib/exceptions/write");
let kinds: typeof import("@/lib/exceptions/kinds");
let changeTracking: typeof import("@/lib/change-tracking");
let inventory: typeof import("@/lib/inventory");
let errorHandling: typeof import("@/lib/error-handling");
let approveRoute: ProductRouteModule;
let declineRoute: ProductRouteModule;
let singleton: PrismaClient;

// --------------------------------------------------------------------------
// Scenario 5's second supply order (created per run, deleted by every reset)
// --------------------------------------------------------------------------

const ORDER_TWO_ID = "concurrencygateorder02";
const LINE_L2B = 9204;
const ORDER_TWO_AT = new Date("2026-08-03T09:00:00.000Z");

/**
 * `resetGateFixtures` deletes every NON-SEED header and line, so scenario 5
 * recreates its second order AFTER the reset (pack C7a.1). Its line mirrors L2:
 * a PENDING product, no line total, verified and ready to label.
 */
async function createSecondOrder(client: PrismaClient): Promise<void> {
  await client.inboundShipment.create({
    data: {
      id: ORDER_TWO_ID,
      supplier: "Gate Supplier Two",
      supplierRef: "GATE-REF-2",
      status: InboundShipmentStatus.RECEIVING,
      orderedAt: ORDER_TWO_AT,
      createdBy: GATE_ADMIN_ID,
      feesCents: 0,
    },
  });
  await client.stagingItem.create({
    data: {
      id: LINE_L2B,
      description: "Gate line L2B (second order, same pending product)",
      status: StagingItemStatus.VERIFIED,
      shipmentId: ORDER_TWO_ID,
      orderedProductId: P_PENDING,
      resolvedProductId: P_PENDING,
      orderedQuantity: 4,
      lineTotalCents: null,
      verifiedQuantity: 4,
      verifiedBy: GATE_ADMIN_ID,
      verifiedAt: ORDER_TWO_AT,
      labelingRequired: true,
      stockedQuantity: 0,
      disposedQuantity: 0,
      // EXPLICIT, not omitted (spec REV-10 clause 4): `receivedAt` keeps its
      // DEFAULT CURRENT_TIMESTAMP, and `receivedAt IS NOT NULL` is the legacy
      // discriminator — an omitted field here would seed a "legacy" line.
      receivedAt: null,
      receivedBy: null,
      locationId: null,
    },
  });
}

// --------------------------------------------------------------------------
// Drivers
// --------------------------------------------------------------------------

type BookOutcome = {
  result: BookingResult;
  contexts: BookingRecordContext[];
  batchId: string;
};

/**
 * ONE booking, exactly the way the stock-in route makes it: the batchId minted
 * OUTSIDE the retry envelope, the core inside the client's own interactive
 * transaction, and an `onRecord` that writes THE REAL exception rows (C3b).
 *
 * `duringRecord` (pack amendment C7b.2 — the booking-first variants) fires
 * INSIDE `onRecord`: after the register writes, before the commit, with every
 * lock the primitive took still held. It is the only place a test can PIN the
 * ordering of a cross-actor race rather than hope for it.
 */
async function book(
  client: PrismaClient,
  args: BookingArgs,
  opts: { duringRecord?: () => Promise<void>; timeoutMs?: number } = {},
): Promise<BookOutcome> {
  const batchId = changeTracking.newBatchId();
  const contexts: BookingRecordContext[] = [];
  const result = await booking.withBookingRetry(() => {
    contexts.length = 0;
    return client.$transaction(
      (tx) =>
        booking.bookSupplyOrderBatch(tx, args, {
          batchId,
          onRecord: async (txn, ctx) => {
            contexts.push(ctx);
            if (ctx.costDiffers) {
              await exceptionsWrite.upsertException(txn, {
                kind: "cost-differs",
                key: kinds.costDiffersKey(ctx.lineId),
                subject: { ...ctx.costDiffers },
              });
            }
            if (ctx.pendingWithStock) {
              await exceptionsWrite.upsertException(txn, {
                kind: "pending-with-stock",
                key: kinds.pendingWithStockKey(ctx.productId),
                subject: { ...ctx.pendingWithStock },
              });
            }
            // LAST, so the held locks are exactly the ones a committed booking
            // would have held. The default transaction budget is 5s, so a caller
            // that holds the tx open here raises it explicitly.
            if (opts.duringRecord) await opts.duringRecord();
          },
        }),
      opts.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs },
    );
  });
  return { result, contexts, batchId };
}

type DiscardOutcome = {
  result: DiscardResult;
  contexts: DiscardRecordContext[];
};

/** One discard-remaining, the way the discard-remaining route makes it: the
 *  operator's own reason is what lands in the register row (S25). */
async function discard(
  client: PrismaClient,
  args: { lineId: number; shipmentId: string; reason: string },
): Promise<DiscardOutcome> {
  const batchId = changeTracking.newBatchId();
  const contexts: DiscardRecordContext[] = [];
  const result = await inventory.withDeadlockRetry(() => {
    contexts.length = 0;
    return client.$transaction((tx) =>
      booking.discardRemaining(
        tx,
        { lineId: args.lineId, shipmentId: args.shipmentId, reason: args.reason, actor: ADMIN },
        {
          batchId,
          onRecord: async (txn, ctx) => {
            contexts.push(ctx);
            await exceptionsWrite.upsertException(txn, {
              kind: "labeling-loss",
              key: kinds.labelingLossKey(ctx.lineId),
              subject: { ...ctx.labelingLoss, reason: args.reason },
            });
          },
        },
      ),
    );
  });
  return { result, contexts };
}

type VerifyOutcome = {
  result: VerifyResult;
  contexts: VerifyRecordContext[];
};

/**
 * One verify. The recorder is CAPTURE-ONLY: scenario 6 asserts the ceiling the
 * raise produced and the counters underneath it, not the discrepancy row (whose
 * writing is the verify route's, proven by the route suite).
 */
async function runVerify(
  client: PrismaClient,
  args: { lineId: number; shipmentId: string; verifiedQuantity: number },
): Promise<VerifyOutcome> {
  const batchId = changeTracking.newBatchId();
  const contexts: VerifyRecordContext[] = [];
  const result = await inventory.withDeadlockRetry(() => {
    contexts.length = 0;
    return client.$transaction((tx) =>
      verifyCore.verifyLine(
        tx,
        {
          lineId: args.lineId,
          shipmentId: args.shipmentId,
          verifiedQuantity: args.verifiedQuantity,
          actor: ADMIN,
        },
        {
          batchId,
          onRecord: async (_txn, ctx) => {
            contexts.push(ctx);
          },
        },
      ),
    );
  });
  return { result, contexts };
}

type RouteAnswer = { status: number; body: Record<string, unknown> };

/** The real handler, called the way Next calls it: a `NextRequest` and the
 *  `{ params }` context the route's own `RouteParams` interface declares. */
async function callProductRoute(
  route: ProductRouteModule,
  action: "approve" | "decline",
  productId: number,
): Promise<RouteAnswer> {
  const request = new NextRequest(
    `http://concurrency-gate.invalid/api/admin/products/${productId}/${action}`,
    { method: "POST" },
  );
  const response = await route.POST(request, { params: { id: String(productId) } });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function l1Args(
  overrides: Partial<BookingArgs> & Pick<BookingArgs, "bookingKey" | "quantity">,
): BookingArgs {
  return {
    lineId: LINE_L1,
    shipmentId: GATE_ORDER_ID,
    locationId: LOCATION_MAIN,
    actor: ADMIN,
    ...overrides,
  };
}

function l2Args(
  overrides: Partial<BookingArgs> & Pick<BookingArgs, "bookingKey" | "quantity">,
): BookingArgs {
  return {
    lineId: LINE_L2,
    shipmentId: GATE_ORDER_ID,
    locationId: LOCATION_MAIN,
    actor: ADMIN,
    ...overrides,
  };
}

/** A racer that is still opening its connection is not racing. One trivial
 *  statement per client before `Promise.allSettled` puts both sides on the
 *  starting line together. */
async function warmUp(...clients: PrismaClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.$queryRawUnsafe("SELECT 1")));
}

/**
 * Block until the DATABASE says some session is waiting on a row lock.
 *
 * The deterministic half of the booking-first variants (C7b.2). The handler is
 * fired from inside the booking's `onRecord` and never awaited there, and it
 * CANNOT finish: the booking holds the `product_locations` range (step 5) and
 * the product row (step 6b) until it commits. So the handler is either not yet
 * at its blocking statement or waiting on that lock — and the lock tables are
 * the server itself saying which. By the time it blocks, its own first statement
 * has run, so its REPEATABLE READ snapshot predates the booking's commit. That is
 * precisely the ordering M7B-D1 used to break.
 *
 * A poll, not a sleep: a fixed delay would be a guess about scheduling, and the
 * variants exist to stop guessing.
 *
 * TWO SOURCES, OR'd — `performance_schema.data_lock_waits` (one row per
 * requester/blocker pair) FIRST, because `information_schema.INNODB_TRX` was
 * MEASURED here to omit a session that `PROCESSLIST` showed executing a blocked
 * `UPDATE`: a transaction whose very first InnoDB statement is still acquiring
 * its lock is not always in the transaction list yet.
 *
 * THE BUDGET IS DELIBERATELY SMALL. Every millisecond spent here is spent inside
 * BOTH open transactions, and the handler's is a plain `prisma.$transaction` with
 * the DEFAULT 5s limit — hold it that long and the engine closes its connection
 * (P1017) and the route answers 500. Detection takes tens of milliseconds; 2s is
 * already a generous failure line, not a working budget.
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

const asError = (reason: unknown): { code?: string; statusCode?: number } =>
  reason as { code?: string; statusCode?: number };

// --------------------------------------------------------------------------

beforeAll(async () => {
  // C7b.1, in order and for a reason: the singleton binds `DATABASE_URL` at
  // construction, so the URL is set and the registry cleared BEFORE the first
  // import that can reach `@/lib/prisma` (every `@/lib` module below does).
  process.env.DATABASE_URL = gateDatabaseUrl();
  jest.resetModules();

  booking = await import("@/lib/supply-orders/booking");
  verifyCore = await import("@/lib/supply-orders/verify");
  refusals = await import("@/lib/supply-orders/refusals");
  exceptionsWrite = await import("@/lib/exceptions/write");
  kinds = await import("@/lib/exceptions/kinds");
  changeTracking = await import("@/lib/change-tracking");
  inventory = await import("@/lib/inventory");
  errorHandling = await import("@/lib/error-handling");
  approveRoute = (await import(
    "@/app/api/admin/products/[id]/approve/route"
  )) as unknown as ProductRouteModule;
  declineRoute = (await import(
    "@/app/api/admin/products/[id]/decline/route"
  )) as unknown as ProductRouteModule;

  singleton = (await import("@/lib/prisma")).default;

  // FAIL CLOSED. The singleton is the ONE connection in this file whose URL is
  // not built by `state.ts`'s refusal belt, and the repo's own `.env` names a
  // real database. Prove the session's schema before anything writes.
  const rows = await singleton.$queryRawUnsafe<{ db: string | null }[]>("SELECT DATABASE() AS db");
  if (rows[0]?.db !== GATE_DB_NAME) {
    throw new Error(
      `the @/lib/prisma singleton connected to "${rows[0]?.db}" instead of "${GATE_DB_NAME}" — ` +
        "refusing to drive the approval routes against anything but the throwaway container",
    );
  }
});

afterAll(async () => {
  try {
    // Put the WHOLE fixture back, whichever order jest ran the two gate files in:
    // `concurrency.test.ts`'s scenario 2 asserts ABSOLUTE register and audit
    // counts, and a row this file left behind would break it from the outside.
    await resetGateFixtures({ lineIds: SEED_LINE_IDS, productIds: SEED_PRODUCT_IDS });
  } finally {
    // An open pool holds the jest worker alive past the last assertion.
    if (singleton) await singleton.$disconnect();
  }
});

describe("supply-order cross-actor races — real-DB concurrency", () => {
  jest.setTimeout(120_000);

  test("scenario 3: a booking races the REAL decline handler — either the units are reversed, or the batch never happened", async () => {
    await resetGateFixtures({ lineIds: [LINE_L2], productIds: [P_PENDING] });
    const bookingClient = openClient();
    const probe = openClient();

    try {
      await warmUp(bookingClient, probe);

      // Three units onto a PENDING product, against an admin declining that same
      // product. Both acts are legitimate; only one order of events can be true.
      const race = await Promise.allSettled([
        book(bookingClient, l2Args({ bookingKey: "gate-s3-a", quantity: 3 })),
        callProductRoute(declineRoute, "decline", P_PENDING),
      ]);
      const [bookingRace, declineRace] = race;

      // The decline ALWAYS answers: it has no legal refusal here. A rejection is
      // a harness failure or a route defect, and either way the reason is what
      // the report needs to carry.
      if (declineRace.status === "rejected") throw declineRace.reason;
      expect(declineRace.value.status).toBe(200);
      expect(declineRace.value.body).toEqual({ reversed: true, alreadyDeclined: false });

      const product = await probe.product.findUniqueOrThrow({
        where: { id: P_PENDING },
        select: { deletedAt: true, quantity: true, costPrice: true, approvalStatus: true },
      });
      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L2 } });
      const productLogs = await probe.inventory_logs.findMany({
        where: { productId: P_PENDING },
        orderBy: { id: "asc" },
        select: { logType: true, delta: true, stagingItemId: true },
      });
      const locations = await probe.product_locations.findMany({
        where: { productId: P_PENDING },
        orderBy: { locationId: "asc" },
        select: { locationId: true, quantity: true },
      });
      const pendingRow = await probe.inventoryException.findUnique({
        where: { key: kinds.pendingWithStockKey(P_PENDING) },
      });

      // WHICH ordering this run actually exercised. Both are legal, only one runs,
      // and a report that cannot say which proved nothing about the other.
      console.log(
        `[scenario 3] observed ordering: ${bookingRace.status === "fulfilled" ? "BOOKING first" : "DECLINE first"}`,
      );

      // TRUE IN BOTH ORDERS: the product ends declined and nothing is on hand.
      expect(product.deletedAt).not.toBeNull();
      expect(locations).toEqual([
        { locationId: 1, quantity: 0 },
        { locationId: 2, quantity: 0 },
      ]);
      expect(product.quantity).toBe(0);

      if (bookingRace.status === "fulfilled") {
        // BOOKING FIRST. The batch really happened, so the decline's corrective
        // reversal has 3 units to take back — and the LINE keeps its counter,
        // because those units were stocked and then corrected, not un-stocked.
        expect(bookingRace.value.result.stockedQuantity).toBe(3);
        expect(bookingRace.value.result.batch.receiptCostCents).toBeNull();
        expect(line.stockedQuantity).toBe(3);
        expect(line.status).toBe(StagingItemStatus.LABELING);
        expect(productLogs).toEqual([
          { logType: "STOCK_IN", delta: 3, stagingItemId: LINE_L2 },
          { logType: "CORRECTION", delta: -3, stagingItemId: null },
        ]);
        // The register saw the raise and the decline settled it.
        expect(pendingRow).not.toBeNull();
        expect(pendingRow?.resolvedAt).not.toBeNull();
        expect(pendingRow?.resolvedBy).toBe(GATE_ADMIN_ID);
        expect(pendingRow?.note ?? "").toContain("resolved: product declined");
      } else {
        // DECLINE FIRST. Step 6b reads a soft-deleted product and the WHOLE
        // booking transaction rolls back: no ledger row, no counter, no location
        // delta, no D-COST, no register row, no audit residue. NO THIRD OUTCOME —
        // any other rejection fails right here.
        expect(asError(bookingRace.reason).code).toBe("PRODUCT_DECLINED");
        expect(asError(bookingRace.reason).statusCode).toBe(409);
        expect(productLogs).toEqual([]);
        expect(line.stockedQuantity).toBe(0);
        expect(line.disposedQuantity).toBe(0);
        expect(line.status).toBe(StagingItemStatus.VERIFIED);
        expect(product.costPrice).toBeNull();
        expect(pendingRow).toBeNull();
        // Scoped to THIS race's subjects: the other gate file's fixture is none of
        // this scenario's business, and a global count would couple the two.
        const registerRows = await probe.inventoryException.count({
          where: {
            key: {
              in: [
                kinds.pendingWithStockKey(P_PENDING),
                kinds.costDiffersKey(LINE_L2),
                kinds.labelingLossKey(LINE_L2),
              ],
            },
          },
        });
        expect(registerRows).toBe(0);
        // The decline's own PRODUCT_DECLINE line is the only thing audited.
        const audited = await probe.auditLog.findMany({
          where: {
            OR: [
              { entityType: "PRODUCT", entityId: String(P_PENDING) },
              { entityType: "STAGING", entityId: String(LINE_L2) },
            ],
          },
          orderBy: { id: "asc" },
          select: { actionType: true },
        });
        expect(audited.map((row) => row.actionType)).toEqual(["PRODUCT_DECLINE"]);
      }

      await unitsOracle(LINE_L2);
      await moneyOracle(LINE_L2);
      await productOracle(P_PENDING, 0);
    } finally {
      await Promise.all([bookingClient.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 3b: the BOOKING commits first, then the decline handler — the reversal is exact and the register row is settled (C7b.2)", async () => {
    await resetGateFixtures({ lineIds: [LINE_L2], productIds: [P_PENDING] });
    const bookingClient = openClient();
    const probe = openClient();

    try {
      await warmUp(bookingClient, probe);

      // The other ordering, PINNED. Scenario 3 above is a real race and it lands
      // decline-first every time (the handler reaches its first lock after one
      // statement; the booking needs five). This variant fires the handler from
      // inside the booking's `onRecord` — step 9, `product_locations` and the
      // product row locked — and waits for InnoDB to report it blocked. The
      // decline's own snapshot is therefore older than the booking's commit.
      const fired: Promise<RouteAnswer>[] = [];
      let blocked = false;
      const outcome = await book(
        bookingClient,
        l2Args({ bookingKey: "gate-s3b-a", quantity: 3 }),
        {
          timeoutMs: 20_000,
          duringRecord: async () => {
            fired.push(callProductRoute(declineRoute, "decline", P_PENDING));
            blocked = await waitForLockWait(probe);
          },
        },
      );

      expect(fired).toHaveLength(1);
      expect(blocked).toBe(true);
      console.log(
        "[scenario 3b] observed ordering: BOOKING first (the handler was blocked on the booking's locks)",
      );

      expect(outcome.result.stockedQuantity).toBe(3);
      expect(outcome.result.remaining).toBe(3);

      // Only now can the decline finish — against units that really are on hand.
      const declined = await fired[0];
      expect(declined.status).toBe(200);
      expect(declined.body).toEqual({ reversed: true, alreadyDeclined: false });

      const product = await probe.product.findUniqueOrThrow({
        where: { id: P_PENDING },
        select: { deletedAt: true, quantity: true, costPrice: true },
      });
      expect(product.deletedAt).not.toBeNull();
      // THE EXACTNESS THE LOCKING READ BUYS: declineProduct reverses the quantity
      // it read FOR UPDATE, so it takes back the 3 units this booking had just
      // committed — a snapshot read would have seen 0 and reversed nothing.
      expect(product.quantity).toBe(0);
      expect(product.costPrice).toBeNull();

      const locations = await probe.product_locations.findMany({
        where: { productId: P_PENDING },
        orderBy: { locationId: "asc" },
        select: { locationId: true, quantity: true },
      });
      expect(locations).toEqual([
        { locationId: 1, quantity: 0 },
        { locationId: 2, quantity: 0 },
      ]);

      // The LINE keeps its counter: those units were stocked and then corrected,
      // which is a different fact from never having been stocked.
      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L2 } });
      expect(line.stockedQuantity).toBe(3);
      expect(line.disposedQuantity).toBe(0);
      expect(line.status).toBe(StagingItemStatus.LABELING);

      const productLogs = await probe.inventory_logs.findMany({
        where: { productId: P_PENDING },
        orderBy: { id: "asc" },
        select: { logType: true, delta: true, stagingItemId: true },
      });
      expect(productLogs).toEqual([
        { logType: "STOCK_IN", delta: 3, stagingItemId: LINE_L2 },
        { logType: "CORRECTION", delta: -3, stagingItemId: null },
      ]);

      // The row the OLD writer could not update (M7B-D1): raised by the booking
      // AFTER the decline's snapshot, so the decline's locking read sees a row
      // that its `update`'s plain pre-SELECT could not.
      const pendingRow = await probe.inventoryException.findUniqueOrThrow({
        where: { key: kinds.pendingWithStockKey(P_PENDING) },
      });
      expect(pendingRow.resolvedAt).not.toBeNull();
      expect(pendingRow.resolvedBy).toBe(GATE_ADMIN_ID);
      expect(pendingRow.note ?? "").toContain("resolved: product declined");
      expect(pendingRow.subject).toEqual({
        productId: P_PENDING,
        stagingItemId: LINE_L2,
        units: 3,
      });

      await unitsOracle(LINE_L2);
      await moneyOracle(LINE_L2);
      await productOracle(P_PENDING, 0);
    } finally {
      await Promise.all([bookingClient.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 4: a booking races the REAL approve handler — the product is approved and no pending-with-stock row is left open", async () => {
    await resetGateFixtures({ lineIds: [LINE_L2], productIds: [P_PENDING] });
    const bookingClient = openClient();
    const probe = openClient();

    try {
      await warmUp(bookingClient, probe);

      const race = await Promise.allSettled([
        book(bookingClient, l2Args({ bookingKey: "gate-s4-a", quantity: 3 })),
        callProductRoute(approveRoute, "approve", P_PENDING),
      ]);
      // Neither act refuses the other: approval does not block a booking, and a
      // booking does not block approval. Both MUST fulfil.
      if (race[0].status === "rejected") throw race[0].reason;
      if (race[1].status === "rejected") throw race[1].reason;
      expect(race.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      const approval = race[1].value as RouteAnswer;
      expect(approval.status).toBe(200);
      expect(approval.body).toEqual({ id: P_PENDING, approvalStatus: "APPROVED" });

      const product = await probe.product.findUniqueOrThrow({
        where: { id: P_PENDING },
        select: { approvalStatus: true, deletedAt: true, quantity: true, reviewedBy: true },
      });
      expect(product.approvalStatus).toBe("APPROVED");
      expect(product.deletedAt).toBeNull();
      expect(product.reviewedBy).toBe(GATE_ADMIN_ID);

      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L2 } });
      expect(line.stockedQuantity).toBe(3);
      expect(line.disposedQuantity).toBe(0);
      expect(line.status).toBe(StagingItemStatus.LABELING);

      const ledger = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L2 },
        orderBy: { id: "asc" },
        select: { logType: true, delta: true, locationId: true, receiptCostCents: true },
      });
      expect(ledger).toEqual([
        { logType: "STOCK_IN", delta: 3, locationId: LOCATION_MAIN, receiptCostCents: null },
      ]);

      const locations = await probe.product_locations.findMany({
        where: { productId: P_PENDING },
        orderBy: { locationId: "asc" },
        select: { locationId: true, quantity: true },
      });
      expect(locations).toEqual([
        { locationId: 1, quantity: 3 },
        { locationId: 2, quantity: 0 },
      ]);
      expect(product.quantity).toBe(3);

      // THE POINT OF THE SCENARIO (OCp2-2): whichever order the two committed in,
      // the register never keeps an OPEN row for a product that is now approved.
      // Absent when the approval won (the booking read APPROVED and raised
      // nothing); resolved when the booking won (the approval settled it).
      const pendingRow = await probe.inventoryException.findUnique({
        where: { key: kinds.pendingWithStockKey(P_PENDING) },
      });
      console.log(
        `[scenario 4] observed ordering: ${pendingRow === null ? "APPROVAL first (the booking read APPROVED and raised nothing)" : "BOOKING first (the row was raised, then resolved)"}`,
      );
      if (pendingRow !== null) {
        expect(pendingRow.resolvedAt).not.toBeNull();
        expect(pendingRow.resolvedBy).toBe(GATE_ADMIN_ID);
        expect(pendingRow.note ?? "").toContain("resolved: product approved");
        expect(pendingRow.subject).toEqual({
          productId: P_PENDING,
          stagingItemId: LINE_L2,
          units: 3,
        });
      }
      const openPending = await probe.inventoryException.count({
        where: { kind: "pending-with-stock", resolvedAt: null },
      });
      expect(openPending).toBe(0);

      await unitsOracle(LINE_L2);
      await moneyOracle(LINE_L2);
      await productOracle(P_PENDING, 3);
    } finally {
      await Promise.all([bookingClient.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 4b: the BOOKING commits first, then the approve handler — the raised row is settled, not orphaned (C7b.2)", async () => {
    await resetGateFixtures({ lineIds: [LINE_L2], productIds: [P_PENDING] });
    const bookingClient = openClient();
    const probe = openClient();

    try {
      await warmUp(bookingClient, probe);

      // The ordering scenario 4 never reaches on its own, and the one that
      // matters most: this is the exact shape that broke before M7B-D1 was fixed
      // — the approval's `resolveException` meeting a register row that was
      // inserted after the approval's transaction took its snapshot.
      const fired: Promise<RouteAnswer>[] = [];
      let blocked = false;
      const outcome = await book(
        bookingClient,
        l2Args({ bookingKey: "gate-s4b-a", quantity: 3 }),
        {
          timeoutMs: 20_000,
          duringRecord: async () => {
            fired.push(callProductRoute(approveRoute, "approve", P_PENDING));
            blocked = await waitForLockWait(probe);
          },
        },
      );

      expect(fired).toHaveLength(1);
      expect(blocked).toBe(true);
      console.log(
        "[scenario 4b] observed ordering: BOOKING first (the handler was blocked on the booking's product lock)",
      );

      expect(outcome.result.stockedQuantity).toBe(3);
      // The booking read the product at step 6b BEFORE the approval committed,
      // which is why it raised the row at all.
      expect(outcome.result.approvalStatus).toBe("PENDING_REVIEW");

      const approval = await fired[0];
      expect(approval.status).toBe(200);
      expect(approval.body).toEqual({ id: P_PENDING, approvalStatus: "APPROVED" });

      const product = await probe.product.findUniqueOrThrow({
        where: { id: P_PENDING },
        select: { approvalStatus: true, deletedAt: true, quantity: true, reviewedBy: true },
      });
      expect(product.approvalStatus).toBe("APPROVED");
      expect(product.deletedAt).toBeNull();
      expect(product.quantity).toBe(3);
      expect(product.reviewedBy).toBe(GATE_ADMIN_ID);

      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L2 } });
      expect(line.stockedQuantity).toBe(3);
      expect(line.disposedQuantity).toBe(0);
      expect(line.status).toBe(StagingItemStatus.LABELING);

      const ledger = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L2 },
        orderBy: { id: "asc" },
        select: { logType: true, delta: true, locationId: true, receiptCostCents: true },
      });
      expect(ledger).toEqual([
        { logType: "STOCK_IN", delta: 3, locationId: LOCATION_MAIN, receiptCostCents: null },
      ]);

      const locations = await probe.product_locations.findMany({
        where: { productId: P_PENDING },
        orderBy: { locationId: "asc" },
        select: { locationId: true, quantity: true },
      });
      expect(locations).toEqual([
        { locationId: 1, quantity: 3 },
        { locationId: 2, quantity: 0 },
      ]);

      // RAISED, then SETTLED — the row EXISTS (unlike the approval-first
      // ordering, where nothing was ever raised) and it is resolved.
      const pendingRow = await probe.inventoryException.findUniqueOrThrow({
        where: { key: kinds.pendingWithStockKey(P_PENDING) },
      });
      expect(pendingRow.resolvedAt).not.toBeNull();
      expect(pendingRow.resolvedBy).toBe(GATE_ADMIN_ID);
      expect(pendingRow.note ?? "").toContain("resolved: product approved");
      expect(pendingRow.subject).toEqual({
        productId: P_PENDING,
        stagingItemId: LINE_L2,
        units: 3,
      });

      const openPending = await probe.inventoryException.count({
        where: { kind: "pending-with-stock", resolvedAt: null },
      });
      expect(openPending).toBe(0);

      await unitsOracle(LINE_L2);
      await moneyOracle(LINE_L2);
      await productOracle(P_PENDING, 3);
    } finally {
      await Promise.all([bookingClient.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 5: TWO DISTINCT orders stock the same pending product — one register row, and it names the second committer", async () => {
    await resetGateFixtures({ lineIds: [LINE_L2], productIds: [P_PENDING] });
    const clientA = openClient();
    const clientB = openClient();
    const probe = openClient();

    try {
      // The reset deleted every non-seed header/line; the second order is built
      // back up here. DISTINCT headers are the whole point (PK3-12): two lines of
      // ONE header serialize on the header claim and never reach the product
      // seam, so this race is the only one that exercises product_locations, the
      // product row and the pending-with-stock key together.
      await createSecondOrder(probe);
      await warmUp(clientA, clientB, probe);

      const race = await Promise.allSettled([
        book(clientA, l2Args({ bookingKey: "gate-s5-a", quantity: 3 })),
        book(clientB, {
          lineId: LINE_L2B,
          shipmentId: ORDER_TWO_ID,
          bookingKey: "gate-s5-b",
          quantity: 4,
          locationId: LOCATION_MAIN,
          actor: ADMIN,
        }),
      ]);
      if (race[0].status === "rejected") throw race[0].reason;
      if (race[1].status === "rejected") throw race[1].reason;
      expect(race.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      // The ledger rows are inserted while the product_locations range lock is
      // held, so their auto-increment order IS the commit order.
      const ledger = await probe.inventory_logs.findMany({
        where: { productId: P_PENDING },
        orderBy: { id: "asc" },
        select: { logType: true, delta: true, stagingItemId: true, receiptCostCents: true },
      });
      expect(ledger).toHaveLength(2);
      expect(ledger.every((row) => row.logType === "STOCK_IN")).toBe(true);
      expect([...ledger.map((row) => row.delta)].sort()).toEqual([3, 4]);
      expect(ledger.every((row) => row.receiptCostCents === null)).toBe(true);
      const secondCommitter = ledger[1].stagingItemId;

      // Each line carries ITS OWN counters — the two orders never blur together.
      const lineOne = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L2 } });
      const lineTwo = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L2B } });
      expect(lineOne.stockedQuantity).toBe(3);
      expect(lineOne.verifiedQuantity).toBe(6);
      expect(lineOne.status).toBe(StagingItemStatus.LABELING);
      expect(lineTwo.stockedQuantity).toBe(4);
      expect(lineTwo.verifiedQuantity).toBe(4);
      expect(lineTwo.status).toBe(StagingItemStatus.COMPLETE);

      const locations = await probe.product_locations.findMany({
        where: { productId: P_PENDING },
        orderBy: { locationId: "asc" },
        select: { locationId: true, quantity: true },
      });
      expect(locations).toEqual([
        { locationId: 1, quantity: 7 },
        { locationId: 2, quantity: 0 },
      ]);

      // ONE row for the product, still open, carrying the CUMULATIVE on-hand the
      // second committer read under the lock — not either batch's own quantity.
      const rows = await probe.inventoryException.findMany({ where: { kind: "pending-with-stock" } });
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe(kinds.pendingWithStockKey(P_PENDING));
      expect(rows[0].resolvedAt).toBeNull();
      expect(rows[0].subject).toEqual({
        productId: P_PENDING,
        stagingItemId: secondCommitter,
        units: 7,
      });

      await unitsOracle(LINE_L2);
      await unitsOracle(LINE_L2B);
      await moneyOracle(LINE_L2);
      await moneyOracle(LINE_L2B);
      await productOracle(P_PENDING, 7);
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 6: a verify RAISE races a batch — both land, and the ceiling that follows uses the RAISED count", async () => {
    await resetGateFixtures({ lineIds: [LINE_L1], productIds: [P_APPROVED] });
    const verifyClient = openClient();
    const bookingClient = openClient();
    const probe = openClient();

    try {
      await warmUp(verifyClient, bookingClient, probe);

      // L1 is VERIFIED 10 with nothing stocked. A recount says 12 arrived while a
      // labeler books the 10 they were already told about. Both are true.
      const race = await Promise.allSettled([
        runVerify(verifyClient, {
          lineId: LINE_L1,
          shipmentId: GATE_ORDER_ID,
          verifiedQuantity: 12,
        }),
        book(bookingClient, l1Args({ bookingKey: "gate-s6-a", quantity: 10 })),
      ]);
      if (race[0].status === "rejected") throw race[0].reason;
      if (race[1].status === "rejected") throw race[1].reason;
      expect(race.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L1 } });
      expect({
        verifiedQuantity: line.verifiedQuantity,
        stockedQuantity: line.stockedQuantity,
        disposedQuantity: line.disposedQuantity,
        status: line.status,
      }).toEqual({
        verifiedQuantity: 12,
        stockedQuantity: 10,
        disposedQuantity: 0,
        status: StagingItemStatus.LABELING,
      });
      // Two more units to work, whichever transaction committed first.
      expect(
        (line.verifiedQuantity ?? 0) - line.stockedQuantity - line.disposedQuantity,
      ).toBe(2);

      const ledger = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L1 },
        orderBy: { id: "asc" },
        select: { logType: true, delta: true, receiptCostCents: true },
      });
      expect(ledger).toEqual([
        { logType: "STOCK_IN", delta: 10, receiptCostCents: L1_TOTAL_CENTS },
      ]);

      await unitsOracle(LINE_L1);
      await moneyOracle(LINE_L1);
      await productOracle(P_APPROVED, 10);

      // THE CEILING NOW USES TWELVE. Three units is one too many; the refusal
      // names the counters the LOCKED row carries, raise included.
      const refused = await book(
        bookingClient,
        l1Args({ bookingKey: "gate-s6-b", quantity: 3 }),
      ).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(refusals.CeilingRefusal);
      const ceiling = refused as InstanceType<typeof refusals.CeilingRefusal>;
      expect({
        stocked: ceiling.stocked,
        disposed: ceiling.disposed,
        verified: ceiling.verified,
        requested: ceiling.requested,
      }).toEqual({ stocked: 10, disposed: 0, verified: 12, requested: 3 });

      // Two units is exactly the remainder, and it closes the line.
      const closing = await book(bookingClient, l1Args({ bookingKey: "gate-s6-c", quantity: 2 }));
      expect(closing.result.status).toBe(StagingItemStatus.COMPLETE);
      expect(closing.result.stockedQuantity).toBe(12);
      expect(closing.result.disposedQuantity).toBe(0);
      expect(closing.result.remaining).toBe(0);
      expect(closing.result.batch.unitCostCents).toBe(L1_UNIT_COST);
      // The share of a line whose basis stays the ORDERED 10: cumulative(12) -
      // cumulative(10). The raise moved the count, never the basis (PK-5).
      expect(closing.result.batch.receiptCostCents).toBe(2000);

      await unitsOracle(LINE_L1);
      await moneyOracle(LINE_L1);
      await productOracle(P_APPROVED, 12);
    } finally {
      await Promise.all([
        verifyClient.$disconnect(),
        bookingClient.$disconnect(),
        probe.$disconnect(),
      ]);
    }
  });

  test("scenario 7: two discard-remaining calls race — one write-off, one refusal, and not a single unit moves", async () => {
    await resetGateFixtures({ lineIds: [LINE_L1], productIds: [P_APPROVED] });
    const clientA = openClient();
    const clientB = openClient();
    const probe = openClient();

    try {
      await warmUp(clientA, clientB, probe);

      // The starting state is BOOKED, not seeded: 7 of 10 stocked through the real
      // primitive, so the ledger row the discard must leave alone is a real one.
      const seedBatch = await book(clientA, l1Args({ bookingKey: "gate-s7-seed", quantity: 7 }));
      expect(seedBatch.result.status).toBe(StagingItemStatus.LABELING);
      expect(seedBatch.result.stockedQuantity).toBe(7);
      expect(seedBatch.result.remaining).toBe(3);

      const ledgerBefore = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L1 },
        orderBy: { id: "asc" },
      });
      expect(ledgerBefore).toHaveLength(1);

      const reason = "tray dropped at the labeling bench";
      const race = await Promise.allSettled([
        discard(clientA, { lineId: LINE_L1, shipmentId: GATE_ORDER_ID, reason }),
        discard(clientB, { lineId: LINE_L1, shipmentId: GATE_ORDER_ID, reason }),
      ]);

      const winners = race.filter(
        (r): r is PromiseFulfilledResult<DiscardOutcome> => r.status === "fulfilled",
      );
      const losers = race.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      expect(winners[0].value.result).toEqual({
        lineId: LINE_L1,
        status: "COMPLETE",
        disposedQuantity: 3,
        stockedQuantity: 7,
        remaining: 0,
      });

      // The loser reads `remaining === 0` off the line it waited for and refuses
      // rather than inventing a second loss.
      expect(losers[0].reason).toBeInstanceOf(errorHandling.AppError);
      expect(asError(losers[0].reason).code).toBe("NOT_BOOKABLE");
      expect(asError(losers[0].reason).statusCode).toBe(409);

      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L1 } });
      expect({
        verifiedQuantity: line.verifiedQuantity,
        stockedQuantity: line.stockedQuantity,
        disposedQuantity: line.disposedQuantity,
        status: line.status,
      }).toEqual({
        verifiedQuantity: 10,
        stockedQuantity: 7,
        disposedQuantity: 3,
        status: StagingItemStatus.COMPLETE,
      });

      // ONE cumulative row, still open, carrying the operator's own words and the
      // exact money those 3 units held: 10001 - cumulative(7) = 3001.
      const lossRows = await probe.inventoryException.findMany({
        where: { kind: "labeling-loss" },
      });
      expect(lossRows).toHaveLength(1);
      expect(lossRows[0].key).toBe(kinds.labelingLossKey(LINE_L1));
      expect(lossRows[0].resolvedAt).toBeNull();
      expect(lossRows[0].subject).toEqual({
        stagingItemId: LINE_L1,
        shipmentId: GATE_ORDER_ID,
        productId: P_APPROVED,
        units: 3,
        unitCostCents: L1_UNIT_COST,
        lossCents: 3001,
        reason,
      });

      // A LABELING LOSS IS NOT A STOCK MOVEMENT. The ledger is exactly what the
      // prior batch left, row for row and column for column.
      const ledgerAfter = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L1 },
        orderBy: { id: "asc" },
      });
      expect(ledgerAfter).toEqual(ledgerBefore);

      const locations = await probe.product_locations.findMany({
        where: { productId: P_APPROVED },
        orderBy: { locationId: "asc" },
        select: { locationId: true, quantity: true },
      });
      expect(locations).toEqual([
        { locationId: 1, quantity: 7 },
        { locationId: 2, quantity: 0 },
      ]);

      await unitsOracle(LINE_L1);
      await moneyOracle(LINE_L1);
      await productOracle(P_APPROVED, 7);
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect(), probe.$disconnect()]);
    }
  });
});
