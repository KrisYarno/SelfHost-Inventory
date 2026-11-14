/**
 * @jest-environment node
 *
 * THE SPOT COUNT'S CORE (reconciliation Part 2, pack § P2-B3-2 C2-1).
 *
 * `countAtLocation` is the whole decision: prelock, compare the operator's
 * version against the locked row, then book the difference as ONE COUNT/COUNT
 * row or book nothing at all. Its two collaborators are mocked here so the
 * suite can read exactly what the core asked of them, in what order:
 *
 *   - `prelockProductLocations` answers the locked row (or an EMPTY map, the
 *     case the local `{ 0, 0 }` fallback exists for);
 *   - `applyStockDelta` records the one write it may make.
 *
 * The `tx` is a recording stub: the core must reach the database ONLY through
 * those two, so a direct delegate call on it is a defect, and the prelock must
 * come before every other call. The materialised `{ 0, 0 }` on a real engine is
 * the concurrency gate's (scenario 16), not this suite's.
 */

jest.mock('@/lib/inventory/prelock', () => ({
  ...jest.requireActual('@/lib/inventory/prelock'),
  prelockProductLocations: jest.fn(),
}));
jest.mock('@/lib/inventory', () => ({
  applyStockDelta: jest.fn(),
}));

import { inventory_logs_logType, type Prisma } from '@prisma/client';

import { applyStockDelta } from '@/lib/inventory';
import { countAtLocation, type CountResult } from '@/lib/inventory/count';
import { prelockKey, prelockProductLocations } from '@/lib/inventory/prelock';
import { OptimisticLockError } from '@/lib/inventory/tx-errors';

const prelockMock = prelockProductLocations as jest.Mock;
const applyMock = applyStockDelta as jest.Mock;

const PRODUCT_ID = 41;
const LOCATION_ID = 3;
const BATCH_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const LOG = { id: 9001, delta: 0 };

/** Every delegate a stock writer could plausibly touch, each a recording stub. */
function makeTx() {
  return {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    product_locations: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
    inventory_logs: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
}

type RecordingTx = ReturnType<typeof makeTx>;

function txStubs(tx: RecordingTx): jest.Mock[] {
  return [
    tx.$executeRaw,
    tx.$queryRaw,
    tx.product_locations.findUnique,
    tx.product_locations.upsert,
    tx.product_locations.update,
    tx.inventory_logs.create,
    tx.auditLog.create,
  ];
}

/** The prelock answers this row for the one key the count names. */
function lockedRow(row: { quantity: number; version: number }) {
  prelockMock.mockResolvedValue(new Map([[prelockKey(PRODUCT_ID, LOCATION_ID), row]]));
}

function run(
  tx: RecordingTx,
  over: Partial<{ countedQuantity: number; expectedVersion: number }>,
  onRecord: jest.Mock
): Promise<CountResult> {
  return countAtLocation(
    tx as unknown as Prisma.TransactionClient,
    {
      userId: 7,
      productId: PRODUCT_ID,
      locationId: LOCATION_ID,
      countedQuantity: 10,
      expectedVersion: 4,
      batchId: BATCH_ID,
      ...over,
    },
    onRecord
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  applyMock.mockImplementation(async (_tx: unknown, args: { delta: number }) => ({
    log: { ...LOG, delta: args.delta },
    newVersion: 5,
  }));
});

describe('countAtLocation — the prelock comes first', () => {
  it('locks exactly the one key, on the route tx, before anything else is called', async () => {
    const tx = makeTx();
    const onRecord = jest.fn().mockResolvedValue(undefined);
    lockedRow({ quantity: 12, version: 4 });

    await run(tx, { countedQuantity: 10 }, onRecord);

    expect(prelockMock).toHaveBeenCalledTimes(1);
    expect(prelockMock).toHaveBeenCalledWith(tx, [
      { productId: PRODUCT_ID, locationId: LOCATION_ID },
    ]);
    const first = prelockMock.mock.invocationCallOrder[0];
    const later = [applyMock, onRecord].flatMap((fn) => fn.mock.invocationCallOrder);
    expect(later.length).toBeGreaterThan(0);
    for (const order of later) expect(order).toBeGreaterThan(first);
    // The core reaches the database ONLY through the prelock and the primitive.
    for (const stub of txStubs(tx)) expect(stub).not.toHaveBeenCalled();
  });
});

describe('countAtLocation — the version is the guard', () => {
  it('a stale version throws OptimisticLockError carrying BOTH versions, and writes nothing', async () => {
    const tx = makeTx();
    const onRecord = jest.fn().mockResolvedValue(undefined);
    lockedRow({ quantity: 12, version: 5 });

    const thrown = await run(tx, { expectedVersion: 4 }, onRecord).catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(OptimisticLockError);
    expect(thrown).toMatchObject({
      message: 'Stock changed while you counted',
      currentVersion: 5,
      expectedVersion: 4,
    });
    expect(applyMock).not.toHaveBeenCalled();
    expect(onRecord).not.toHaveBeenCalled();
    for (const stub of txStubs(tx)) expect(stub).not.toHaveBeenCalled();
  });
});

describe('countAtLocation — a match books nothing', () => {
  it('counted == record: no ledger write, onRecord once with changed: false', async () => {
    const tx = makeTx();
    const onRecord = jest.fn().mockResolvedValue(undefined);
    lockedRow({ quantity: 10, version: 4 });

    const result = await run(tx, { countedQuantity: 10, expectedVersion: 4 }, onRecord);

    const confirmed = { changed: false, previousQuantity: 10, version: 4 };
    expect(result).toEqual(confirmed);
    expect(applyMock).not.toHaveBeenCalled();
    expect(onRecord).toHaveBeenCalledTimes(1);
    expect(onRecord).toHaveBeenCalledWith(tx, confirmed);
  });
});

describe('countAtLocation — a difference is ONE COUNT/COUNT row', () => {
  it.each([
    ['down', { quantity: 12, version: 4 }, 9, -3],
    ['up', { quantity: 5, version: 4 }, 8, 3],
  ])(
    'counted %s: applyStockDelta once, logType COUNT, reasonCode COUNT, the batch id, delta signed',
    async (_dir, row, countedQuantity, delta) => {
      const tx = makeTx();
      const onRecord = jest.fn().mockResolvedValue(undefined);
      lockedRow(row);

      const result = await run(tx, { countedQuantity, expectedVersion: 4 }, onRecord);

      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(applyMock).toHaveBeenCalledWith(tx, {
        userId: 7,
        productId: PRODUCT_ID,
        locationId: LOCATION_ID,
        delta,
        logType: inventory_logs_logType.COUNT,
        reasonCode: 'COUNT',
        batchId: BATCH_ID,
      });
      const counted = {
        changed: true,
        previousQuantity: row.quantity,
        delta,
        log: { ...LOG, delta },
        newVersion: 5,
      };
      expect(result).toEqual(counted);
      expect(onRecord).toHaveBeenCalledTimes(1);
      expect(onRecord).toHaveBeenCalledWith(tx, counted);
      // The event follows the row it describes.
      expect(onRecord.mock.invocationCallOrder[0]).toBeGreaterThan(
        applyMock.mock.invocationCallOrder[0]
      );
    }
  );

  it('the prelock answering an EMPTY map reads { 0, 0 }: version 0 passes and a count of 3 books +3', async () => {
    const tx = makeTx();
    const onRecord = jest.fn().mockResolvedValue(undefined);
    prelockMock.mockResolvedValue(new Map());

    const result = await run(tx, { countedQuantity: 3, expectedVersion: 0 }, onRecord);

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock.mock.calls[0][1]).toMatchObject({ delta: 3, logType: 'COUNT' });
    expect(result).toMatchObject({ changed: true, previousQuantity: 0, delta: 3 });
  });

  it('the EMPTY map against a non-zero version is still the 409 (the fallback is { 0, 0 }, not a pass)', async () => {
    const tx = makeTx();
    const onRecord = jest.fn().mockResolvedValue(undefined);
    prelockMock.mockResolvedValue(new Map());

    await expect(run(tx, { countedQuantity: 3, expectedVersion: 1 }, onRecord)).rejects.toMatchObject(
      { currentVersion: 0, expectedVersion: 1 }
    );
    expect(applyMock).not.toHaveBeenCalled();
  });
});

describe('countAtLocation — onRecord owns the event', () => {
  it.each([
    ['a match', { quantity: 10, version: 4 }, 10],
    ['a difference', { quantity: 12, version: 4 }, 10],
  ])('%s: an onRecord rejection propagates (no ledger row without its event)', async (_l, row, n) => {
    const tx = makeTx();
    const failure = new Error('audit insert failed');
    const onRecord = jest.fn().mockRejectedValue(failure);
    lockedRow(row);

    await expect(run(tx, { countedQuantity: n, expectedVersion: 4 }, onRecord)).rejects.toBe(
      failure
    );
    expect(onRecord).toHaveBeenCalledTimes(1);
  });
});
