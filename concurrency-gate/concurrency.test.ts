/**
 * concurrency-gate/concurrency.test.ts — THE LOCKING PROOF (plan P-2; spec §11;
 * pack C7a.2 scenarios 1-2).
 *
 * Everything else in this lane tests the primitive's SHAPE against a mocked tx:
 * which statement is first, which carries `FOR UPDATE`, which guard rides on the
 * increment. Only this file tests whether those statements actually STOP two
 * labelers from booking the same units — and that question has exactly one
 * honest answer, from two real database sessions racing on real InnoDB locks.
 *
 * THE CORES ARE DRIVEN DIRECTLY, not over HTTP (pack C7a.1): each racer owns its
 * own `PrismaClient` (one client = one session), mints its own `batchId` OUTSIDE
 * `withBookingRetry`, and hands the primitive a CAPTURE-ONLY `onRecord`. The
 * route-owned exception and audit writes are the route suites' business; this
 * gate proves the PRIMITIVE's locking, counters and ledger.
 *
 * M7b appends scenarios 3-7 (the cross-actor races) to this project.
 */

import type { PrismaClient } from "@prisma/client";
import { newBatchId } from "@/lib/change-tracking";
import { AppError } from "@/lib/error-handling";
import {
  bookSupplyOrderBatch,
  withBookingRetry,
  type BookingArgs,
  type BookingRecordContext,
  type BookingResult,
} from "@/lib/supply-orders/booking";
import { CeilingRefusal } from "@/lib/supply-orders/refusals";
import { openClient } from "./clients";
import { moneyOracle, productOracle, unitsOracle } from "./oracles";
import {
  GATE_ADMIN_ID,
  GATE_ORDER_ID,
  L1_TOTAL_CENTS,
  LINE_L1,
  LOCATION_MAIN,
  P_APPROVED,
  resetGateFixtures,
} from "./seed";

const ADMIN = { id: GATE_ADMIN_ID, isAdmin: true };

/** L1: 10001 cents over a basis of 10 -> half-even 1000 cents per unit. */
const L1_UNIT_COST = 1000;

type BookOutcome = {
  result: BookingResult;
  /** The winning attempt's captured contexts (cleared on every re-run, so a
   *  P2002 retry cannot leave a phantom context behind). */
  contexts: BookingRecordContext[];
  batchId: string;
};

/**
 * ONE booking, exactly the way a route will make it: the batchId is minted
 * OUTSIDE the retry envelope and reused by every re-run, and the core is called
 * inside the client's own interactive transaction.
 */
async function book(client: PrismaClient, args: BookingArgs): Promise<BookOutcome> {
  const batchId = newBatchId();
  const contexts: BookingRecordContext[] = [];
  const result = await withBookingRetry(() => {
    contexts.length = 0;
    return client.$transaction((tx) =>
      bookSupplyOrderBatch(tx, args, {
        onRecord: async (_tx, ctx) => {
          contexts.push(ctx);
        },
        batchId,
      }),
    );
  });
  return { result, contexts, batchId };
}

function l1Args(overrides: Partial<BookingArgs> & Pick<BookingArgs, "bookingKey" | "quantity">): BookingArgs {
  return {
    lineId: LINE_L1,
    shipmentId: GATE_ORDER_ID,
    locationId: LOCATION_MAIN,
    actor: ADMIN,
    ...overrides,
  };
}

/** Everything the mismatch case must leave untouched, in one comparable value. */
async function residueSnapshot(probe: PrismaClient, lineId: number, productId: number) {
  const [logs, lineRow, locations, product, exceptions, auditRows] = await Promise.all([
    probe.inventory_logs.findMany({
      where: { stagingItemId: lineId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        delta: true,
        locationId: true,
        logType: true,
        unitCostCents: true,
        receiptCostCents: true,
        bookingKey: true,
        batchId: true,
      },
    }),
    probe.stagingItem.findUniqueOrThrow({
      where: { id: lineId },
      select: {
        status: true,
        stockedQuantity: true,
        disposedQuantity: true,
        verifiedQuantity: true,
        locationId: true,
      },
    }),
    probe.product_locations.findMany({
      where: { productId },
      orderBy: { locationId: "asc" },
      select: { locationId: true, quantity: true, version: true },
    }),
    probe.product.findUniqueOrThrow({
      where: { id: productId },
      select: { costPrice: true, quantity: true, approvalStatus: true, deletedAt: true },
    }),
    probe.inventoryException.count(),
    probe.auditLog.count(),
  ]);
  return {
    logs,
    lineRow,
    locations,
    product: { ...product, costPrice: product.costPrice === null ? null : String(product.costPrice) },
    exceptions,
    auditRows,
  };
}

describe("supply-order booking — real-DB concurrency", () => {
  jest.setTimeout(120_000);

  test("scenario 1: two batches race the ceiling — exactly one wins, and the refusal names the LOCKED counters", async () => {
    await resetGateFixtures({ lineIds: [LINE_L1], productIds: [P_APPROVED] });
    const clientA = openClient();
    const clientB = openClient();
    const probe = openClient();

    try {
      // 10 verified, nothing stocked. Two labelers each claim 7 under DISTINCT
      // booking keys: this is not an idempotency question, it is two genuine
      // batches that cannot both exist.
      const race = await Promise.allSettled([
        book(clientA, l1Args({ bookingKey: "gate-s1-a", quantity: 7 })),
        book(clientB, l1Args({ bookingKey: "gate-s1-b", quantity: 7 })),
      ]);

      const winners = race.filter((r): r is PromiseFulfilledResult<BookOutcome> => r.status === "fulfilled");
      const losers = race.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      // The refusal's `stocked` is what the LOSER's own locked read saw — the
      // winner's committed 7 — not "after this request" and not the request's
      // own quantity.
      const refusal = losers[0].reason;
      expect(refusal).toBeInstanceOf(CeilingRefusal);
      const ceiling = refusal as CeilingRefusal;
      expect({
        stocked: ceiling.stocked,
        disposed: ceiling.disposed,
        verified: ceiling.verified,
        requested: ceiling.requested,
      }).toEqual({ stocked: 7, disposed: 0, verified: 10, requested: 7 });

      const first = winners[0].value;
      expect(first.result.status).toBe("LABELING");
      expect(first.result.stockedQuantity).toBe(7);
      expect(first.result.disposedQuantity).toBe(0);
      expect(first.result.remaining).toBe(3);
      expect(first.result.batch).toEqual({
        quantity: 7,
        locationId: LOCATION_MAIN,
        unitCostCents: L1_UNIT_COST,
        receiptCostCents: 7000,
        replayed: false,
      });

      const afterRace = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L1 },
        orderBy: { id: "asc" },
      });
      expect(afterRace).toHaveLength(1);
      expect(afterRace[0].delta).toBe(7);
      expect(afterRace[0].logType).toBe("STOCK_IN");

      // The remainder, booked by a third key: the exact shares 7000 + 3001 add
      // up to the whole line total, which is the entire point of 10001/10.
      const closing = await book(clientA, l1Args({ bookingKey: "gate-s1-c", quantity: 3 }));
      expect(closing.result.status).toBe("COMPLETE");
      expect(closing.result.stockedQuantity).toBe(10);
      expect(closing.result.disposedQuantity).toBe(0);
      expect(closing.result.remaining).toBe(0);
      expect(closing.result.batch.receiptCostCents).toBe(3001);

      const ledger = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L1 },
        orderBy: { id: "asc" },
      });
      expect(ledger).toHaveLength(2);
      expect(ledger.map((row) => row.delta)).toEqual([7, 3]);
      expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBe(10);
      expect(ledger.map((row) => row.receiptCostCents)).toEqual([7000, 3001]);
      expect(ledger.reduce((sum, row) => sum + (row.receiptCostCents ?? 0), 0)).toBe(L1_TOTAL_CENTS);

      await unitsOracle(LINE_L1);
      await moneyOracle(LINE_L1);
      await productOracle(P_APPROVED, 10);
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect(), probe.$disconnect()]);
    }
  });

  test("scenario 2: the same bookingKey replays instead of double-booking, and a different batch under it is refused", async () => {
    await resetGateFixtures({ lineIds: [LINE_L1], productIds: [P_APPROVED] });
    const clientA = openClient();
    const clientB = openClient();
    const probe = openClient();
    const sharedKey = "gate-s2-shared";

    try {
      // The SAME key from two sessions: one books, the other must answer with
      // what the first one wrote. Whether the loser lost at the line lock or at
      // the UNIQUE (and was re-run by withBookingRetry) is an implementation
      // detail; the OUTCOME is not.
      const race = await Promise.allSettled([
        book(clientA, l1Args({ bookingKey: sharedKey, quantity: 4 })),
        book(clientB, l1Args({ bookingKey: sharedKey, quantity: 4 })),
      ]);
      expect(race.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);

      const outcomes = (race as PromiseFulfilledResult<BookOutcome>[]).map((r) => r.value);
      const replayFlags = outcomes.map((outcome) => outcome.result.batch.replayed).sort();
      expect(replayFlags).toEqual([false, true]);

      for (const outcome of outcomes) {
        expect(outcome.result.batch.quantity).toBe(4);
        expect(outcome.result.batch.locationId).toBe(LOCATION_MAIN);
        expect(outcome.result.batch.unitCostCents).toBe(L1_UNIT_COST);
        expect(outcome.result.batch.receiptCostCents).toBe(4000);
        expect(outcome.result.stockedQuantity).toBe(4);
      }

      const keyed = await probe.inventory_logs.findMany({
        where: { stagingItemId: LINE_L1, bookingKey: sharedKey },
      });
      expect(keyed).toHaveLength(1);
      const line = await probe.stagingItem.findUniqueOrThrow({ where: { id: LINE_L1 } });
      expect(line.stockedQuantity).toBe(4);

      // A DIFFERENT batch under a key that is already spent is a mistake, not a
      // retry: 409, and nothing at all moves.
      const before = await residueSnapshot(probe, LINE_L1, P_APPROVED);
      // Absolute counts, not just a delta: they pin `resetGateFixtures` itself.
      // Scenario 1 left an audit row (its first batch filled a null costPrice) and
      // the reset must have removed it, so the ONLY audit row here is this
      // scenario's own D-COST fill — and a capture-only `onRecord` writes no
      // exception rows at all.
      expect(before.auditRows).toBe(1);
      expect(before.exceptions).toBe(0);
      const mismatch = await book(clientA, l1Args({ bookingKey: sharedKey, quantity: 5 })).then(
        () => null,
        (err: unknown) => err,
      );
      expect(mismatch).toBeInstanceOf(AppError);
      expect((mismatch as AppError).code).toBe("IDEMPOTENCY_MISMATCH");
      expect((mismatch as AppError).statusCode).toBe(409);

      const after = await residueSnapshot(probe, LINE_L1, P_APPROVED);
      expect(after).toEqual(before);

      await unitsOracle(LINE_L1);
      await moneyOracle(LINE_L1);
      await productOracle(P_APPROVED, 4);
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect(), probe.$disconnect()]);
    }
  });
});
