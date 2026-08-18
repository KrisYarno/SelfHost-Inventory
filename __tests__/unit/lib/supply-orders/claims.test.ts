/**
 * @jest-environment node
 *
 * Unit tests for `lib/supply-orders/claims.ts` — the CLAIM IDIOMS every
 * supply-order writer shares (contract pack C2b.1, seams S5/S11).
 *
 * Three rules carry the file, and these tests are those rules:
 *
 *   1. A STATE DECISION IS A CLAIM, never a read. `updateMany` whose WHERE *is*
 *      the precondition — the W1 idiom (`lib/shipments/lifecycle.ts`) — so the
 *      loser sees `count === 0` instead of overwriting the winner. Statuses are
 *      tried ONE AT A TIME because a single `status: { in: [...] }` claim would
 *      have to pick a value to WRITE, and writing ORDERED over a CLOSED header
 *      would silently reopen a settled order.
 *   2. THE MODEL DISCRIMINATOR LIVES INSIDE THE HELPER (PK-9). `orderedAt IS
 *      NULL` means a LEGACY receipt, and legacy rows are history: every caller
 *      would otherwise have to remember to check, and the one that forgot would
 *      book stock against a W1 receipt.
 *   3. LOCK ORDER IS UNIFORM: line(s) -> header -> product_locations ->
 *      products. `lockLinesForUpdate` is the FD2-1 idiom (ascending claims, then
 *      ONE `SELECT ... ORDER BY id FOR UPDATE` that every decision derives from)
 *      so a settle can never decide from a snapshot older than its own locks.
 *
 * Mocked tx: every statement is recorded in ORDER, because the order is the
 * contract as much as the statements are.
 */

import { InboundShipmentStatus, StagingItemStatus } from '@prisma/client';
import {
  claimShipmentIn,
  claimShipmentForBooking,
  claimShipmentForVerify,
  promoteToReceiving,
  claimHeaderTransition,
  lockLinesForUpdate,
} from '@/lib/supply-orders/claims';
import { AppError } from '@/lib/error-handling';

const SHIPMENT = 'ord_1';

type Statement =
  | { kind: 'header-claim'; status: InboundShipmentStatus; to: InboundShipmentStatus }
  | { kind: 'header-read' }
  | { kind: 'line-claim'; id: number }
  | { kind: 'raw'; sql: string; values: unknown[] };

function mkTx(options: {
  /** The status whose claim wins; null = every claim misses. */
  winner?: InboundShipmentStatus | null;
  /** What the post-claim read of the header returns (null = row gone). */
  header?: { status: InboundShipmentStatus } | null;
  /** What the locking `orderedAt` read answers. */
  orderedAt?: Date | null;
  /** The line ids the snapshot read reports, in the order it reports them. */
  lineIds?: number[];
  /** The rows the locking line read returns. */
  lockedLines?: Record<string, unknown>[];
} = {}) {
  const {
    winner = InboundShipmentStatus.RECEIVING,
    header = { status: InboundShipmentStatus.CANCELLED },
    orderedAt = new Date('2026-08-01T00:00:00.000Z'),
    lineIds = [],
    lockedLines = [],
  } = options;

  const statements: Statement[] = [];

  const tx = {
    statements,
    inboundShipment: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        // A transition claim names its FROM set as `{ in: [...] }`; a lock claim
        // names one status at a time. Both are recorded the same way.
        const matched: InboundShipmentStatus[] = where.status?.in ?? [where.status];
        statements.push({ kind: 'header-claim', status: matched[0], to: data.status });
        return { count: winner !== null && matched.includes(winner) ? 1 : 0 };
      }),
      findUnique: jest.fn(async () => {
        statements.push({ kind: 'header-read' });
        return header;
      }),
    },
    stagingItem: {
      findMany: jest.fn(async () => lineIds.map((id) => ({ id }))),
      updateMany: jest.fn(async ({ where }: any) => {
        statements.push({ kind: 'line-claim', id: where.id });
        return { count: 1 };
      }),
    },
    $queryRaw: jest.fn(async (query: any) => {
      statements.push({ kind: 'raw', sql: query.sql, values: query.values });
      if (String(query.sql).includes('inbound_shipments')) return [{ orderedAt }];
      return lockedLines;
    }),
  } as any;

  return tx;
}

const raws = (tx: any) => tx.statements.filter((s: Statement) => s.kind === 'raw');

describe('claimShipmentIn — the moved W1 helper (seam S5)', () => {
  it('tries the allowed statuses ONE AT A TIME and returns the one that won', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.CLOSED });

    const won = await claimShipmentIn(
      tx,
      SHIPMENT,
      [InboundShipmentStatus.ORDERED, InboundShipmentStatus.RECEIVING, InboundShipmentStatus.CLOSED],
      (s) => `blocked: ${s}`,
    );

    expect(won).toBe(InboundShipmentStatus.CLOSED);
    expect(tx.statements).toEqual([
      { kind: 'header-claim', status: 'ORDERED', to: 'ORDERED' },
      { kind: 'header-claim', status: 'RECEIVING', to: 'RECEIVING' },
      { kind: 'header-claim', status: 'CLOSED', to: 'CLOSED' },
    ]);
  });

  it('stops at the FIRST winner (no further claim is taken)', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.ORDERED });

    await claimShipmentIn(tx, SHIPMENT, [InboundShipmentStatus.ORDERED, InboundShipmentStatus.RECEIVING], () => 'x');

    expect(tx.inboundShipment.updateMany).toHaveBeenCalledTimes(1);
  });

  it('WRITES BACK the status it matched — a claim never rewrites the state', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.CLOSED });

    await claimShipmentIn(tx, SHIPMENT, [InboundShipmentStatus.CLOSED], () => 'x');

    const { where, data } = tx.inboundShipment.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: SHIPMENT, status: InboundShipmentStatus.CLOSED });
    expect(data).toEqual({ status: InboundShipmentStatus.CLOSED });
  });

  it('404s an unknown id — the read that separates 404 from 409 runs only after every claim missed', async () => {
    const tx = mkTx({ winner: null, header: null });

    await expect(
      claimShipmentIn(tx, SHIPMENT, [InboundShipmentStatus.ORDERED], () => 'x'),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('409s a blocked status in the CALLER\'s vocabulary', async () => {
    const tx = mkTx({ winner: null, header: { status: InboundShipmentStatus.CANCELLED } });

    await expect(
      claimShipmentIn(tx, SHIPMENT, [InboundShipmentStatus.ORDERED], (s) => `no: ${s}`),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT', message: 'no: CANCELLED' });
  });
});

describe('claimShipmentForBooking — the claim + the model discriminator (PK-9)', () => {
  it('claims over ORDERED | RECEIVING | CLOSED', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.RECEIVING });

    await claimShipmentForBooking(tx, SHIPMENT);

    expect(tx.statements.filter((s: Statement) => s.kind === 'header-claim').map((s: any) => s.status)).toEqual([
      'ORDERED',
      'RECEIVING',
    ]);
  });

  it('REFUSES a cancelled order with a 409 CONFLICT naming it', async () => {
    const tx = mkTx({ winner: null, header: { status: InboundShipmentStatus.CANCELLED } });

    await expect(claimShipmentForBooking(tx, SHIPMENT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    await expect(claimShipmentForBooking(tx, SHIPMENT)).rejects.toThrow(/cancelled/i);
  });

  it('reads orderedAt from the ALREADY-LOCKED header row, after the claim', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.ORDERED });

    await claimShipmentForBooking(tx, SHIPMENT);

    // The claim comes first (it takes the lock); the read is a LOCKING read of
    // the row it just locked, so it answers with the latest committed value.
    expect(tx.statements[0]).toEqual({ kind: 'header-claim', status: 'ORDERED', to: 'ORDERED' });
    const read = raws(tx)[0];
    expect(read.sql).toMatch(/SELECT orderedAt FROM inbound_shipments WHERE id = \? FOR UPDATE/);
    expect(read.values).toEqual([SHIPMENT]);
  });

  it('a LEGACY header (orderedAt NULL) is 409 NOT_BOOKABLE — W1 receipts are history', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.CLOSED, orderedAt: null });

    await expect(claimShipmentForBooking(tx, SHIPMENT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOT_BOOKABLE',
    });
    await expect(claimShipmentForBooking(tx, SHIPMENT)).rejects.toThrow(/legacy receipt/i);
  });

  it('returns the claimed status for a supply order', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.CLOSED });

    await expect(claimShipmentForBooking(tx, SHIPMENT)).resolves.toBe(InboundShipmentStatus.CLOSED);
  });
});

describe('claimShipmentForVerify — the same claim, the verify vocabulary', () => {
  it('claims over ORDERED | RECEIVING | CLOSED (a RAISE on a CLOSED order is legal)', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.CLOSED });

    await expect(claimShipmentForVerify(tx, SHIPMENT)).resolves.toBe(InboundShipmentStatus.CLOSED);
    expect(tx.statements.filter((s: Statement) => s.kind === 'header-claim').map((s: any) => s.status)).toEqual([
      'ORDERED',
      'RECEIVING',
      'CLOSED',
    ]);
  });

  it('a LEGACY header is 409 LEGACY_READ_ONLY — the read-only vocabulary, not NOT_BOOKABLE', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.CLOSED, orderedAt: null });

    await expect(claimShipmentForVerify(tx, SHIPMENT)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LEGACY_READ_ONLY',
    });
  });
});

describe('promoteToReceiving / claimHeaderTransition — the atomic transitions', () => {
  it('promotes ORDERED -> RECEIVING and reports whether THIS caller won', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.ORDERED });

    await expect(promoteToReceiving(tx, SHIPMENT)).resolves.toBe(true);
    expect(tx.inboundShipment.updateMany).toHaveBeenCalledWith({
      where: { id: SHIPMENT, status: InboundShipmentStatus.ORDERED },
      data: { status: InboundShipmentStatus.RECEIVING },
    });
  });

  it('reports FALSE when somebody else promoted it first (the waiter matches RECEIVING)', async () => {
    const tx = mkTx({ winner: null });

    await expect(promoteToReceiving(tx, SHIPMENT)).resolves.toBe(false);
  });

  it('claims an arbitrary transition on the allowed FROM set', async () => {
    const tx = mkTx({ winner: InboundShipmentStatus.RECEIVING });

    await expect(
      claimHeaderTransition(
        tx,
        SHIPMENT,
        [InboundShipmentStatus.RECEIVING],
        InboundShipmentStatus.CLOSED,
      ),
    ).resolves.toBe(true);
    expect(tx.inboundShipment.updateMany).toHaveBeenCalledWith({
      where: { id: SHIPMENT, status: { in: [InboundShipmentStatus.RECEIVING] } },
      data: { status: InboundShipmentStatus.CLOSED },
    });
  });

  it('reports FALSE when the header is not in the FROM set', async () => {
    const tx = mkTx({ winner: null });

    await expect(
      claimHeaderTransition(tx, SHIPMENT, [InboundShipmentStatus.ORDERED], InboundShipmentStatus.CANCELLED),
    ).resolves.toBe(false);
  });
});

describe('lockLinesForUpdate — the FD2-1 idiom', () => {
  it('claims the lines ASCENDING, then takes ONE locking read ordered by id', async () => {
    const tx = mkTx({
      lineIds: [4, 9, 11],
      lockedLines: [{ id: 4 }, { id: 9 }, { id: 11 }],
    });

    const lines = await lockLinesForUpdate(tx, SHIPMENT);

    expect(tx.statements).toEqual([
      { kind: 'line-claim', id: 4 },
      { kind: 'line-claim', id: 9 },
      { kind: 'line-claim', id: 11 },
      {
        kind: 'raw',
        sql: expect.stringMatching(/FROM staging_items WHERE shipmentId = \? ORDER BY id FOR UPDATE$/),
        values: [SHIPMENT],
      },
    ]);
    expect(lines).toEqual([{ id: 4 }, { id: 9 }, { id: 11 }]);
  });

  it('reads the ids ASCENDING so the claim order is a property of the ROW SET, not of the request', async () => {
    const tx = mkTx({ lineIds: [2] });

    await lockLinesForUpdate(tx, SHIPMENT);

    expect(tx.stagingItem.findMany).toHaveBeenCalledWith({
      where: { shipmentId: SHIPMENT },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  });

  it('pins MEMBERSHIP in the claim: the lock is also the question "is this line still mine?"', async () => {
    const tx = mkTx({ lineIds: [7] });

    await lockLinesForUpdate(tx, SHIPMENT);

    const { where, data } = tx.stagingItem.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 7, shipmentId: SHIPMENT });
    expect(data).toEqual({ shipmentId: SHIPMENT });
  });

  it('still takes the locking read on an order with no lines (a gap lock is a lock)', async () => {
    const tx = mkTx({ lineIds: [], lockedLines: [] });

    await expect(lockLinesForUpdate(tx, SHIPMENT)).resolves.toEqual([]);
    expect(raws(tx)).toHaveLength(1);
  });

  it('carries the DECISION columns every consumer reads from the locked rows', async () => {
    const tx = mkTx({ lineIds: [1], lockedLines: [{ id: 1, status: StagingItemStatus.ORDERED }] });

    await lockLinesForUpdate(tx, SHIPMENT);

    const { sql } = raws(tx)[0];
    for (const column of [
      'id',
      'status',
      'verifiedQuantity',
      'stockedQuantity',
      'disposedQuantity',
      'resolvedProductId',
      'orderedQuantity',
      'lineTotalCents',
      'shipmentId',
      'locationId',
      'labelingRequired',
    ]) {
      expect(sql).toContain(column);
    }
  });
});

describe('the house error envelope', () => {
  it('every refusal here is an AppError (the routes render it through apiHandler)', async () => {
    const tx = mkTx({ winner: null, header: { status: InboundShipmentStatus.CANCELLED } });

    await expect(claimShipmentForBooking(tx, SHIPMENT)).rejects.toBeInstanceOf(AppError);
  });
});
