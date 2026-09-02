/**
 * THE RESTORATION LEDGER (reconciliation Part 2, pack CB2a.2; spec §2.5).
 *
 * `priorRestorations` answers "how much of this batch has already been put back,
 * and has it been moved" — the figure that BOUNDS every later correction. Two
 * properties are pinned here:
 *
 *   THE SUM IS CORRECTION + REVERSE ONLY. A MOVE's legs are a reclassification
 *   (one negative at the physical location, one equal positive at the ledger
 *   location), so they net to zero and contribute location metadata, never units
 *   (spec REV-9 CX6-2). Summing them would make a moved batch look restored.
 *
 *   A MALFORMED EVENT IS A REFUSAL, NOT A ZERO. Every figure here becomes a cap
 *   on how much stock a later writer puts back, and a cap computed from a blob
 *   we cannot read is the one number this lane never writes.
 *
 * The READ is plain and it is a delegate call — never `FOR UPDATE` (a locking
 * read over an empty range gap-locks, and two first-restorations of different
 * batches would deadlock), never raw.
 */

import { mockDeep } from 'jest-mock-extended';
import type { Prisma } from '@prisma/client';

import { prelockKey } from '@/lib/inventory/prelock';
import {
  priorRestorations,
  RESTORATION_ACTION_TYPES,
  RestorationLedgerCorrupt,
} from '@/lib/reconciliation/restorations';

const BATCH = 'ledger-batch-1';
const AT = new Date('2026-09-02T14:31:22.000Z');

type Event = {
  id: number;
  actionType: string;
  details: unknown;
  createdAt: Date;
};

function correction(over: Partial<Event> = {}): Event {
  return {
    id: 41,
    actionType: 'INVENTORY_CORRECTION',
    details: { rows: [{ productId: 9, locationId: 3, delta: 4 }] },
    createdAt: AT,
    ...over,
  };
}

function moveEvent(over: Partial<Event> = {}): Event {
  return {
    id: 43,
    actionType: 'INVENTORY_BATCH_MOVE',
    details: {
      ledgerLocationId: 3,
      physicalLocationId: 7,
      rows: [
        { productId: 9, locationId: 7, delta: -4 },
        { productId: 9, locationId: 3, delta: 4 },
      ],
    },
    createdAt: AT,
    ...over,
  };
}

function makeTx(events: Event[]) {
  const tx = mockDeep<Prisma.TransactionClient>();
  (tx.auditLog.findMany as unknown as jest.Mock).mockResolvedValue(events);
  return tx;
}

describe('priorRestorations — the read', () => {
  it('is ONE plain delegate read over the three restoring action types, id-ascending', async () => {
    const tx = makeTx([]);
    await priorRestorations(tx, BATCH);

    expect(tx.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        entityType: 'INVENTORY',
        entityId: BATCH,
        actionType: {
          in: ['INVENTORY_CORRECTION', 'INVENTORY_BATCH_REVERSE', 'INVENTORY_BATCH_MOVE'],
        },
      },
      orderBy: { id: 'asc' },
      select: { id: true, actionType: true, details: true, createdAt: true },
    });
    // Never raw, never locking: a FOR UPDATE over the (usually empty) range
    // gap-locks, and two first-restorations of different batches deadlock.
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('spreads the frozen action-type tuple (a readonly tuple is not Prisma string[])', () => {
    expect(RESTORATION_ACTION_TYPES).toEqual([
      'INVENTORY_CORRECTION',
      'INVENTORY_BATCH_REVERSE',
      'INVENTORY_BATCH_MOVE',
    ]);
  });

  it('a batch with no restoration events reads empty, not absent', async () => {
    const prior = await priorRestorations(makeTx([]), BATCH);
    expect(prior.restoredByKey.size).toBe(0);
    expect(prior.move).toBeNull();
  });
});

describe('priorRestorations — the sum', () => {
  it('adds CORRECTION and REVERSE rows per (product, location) key', async () => {
    const prior = await priorRestorations(
      makeTx([
        correction({
          id: 41,
          details: {
            rows: [
              { productId: 9, locationId: 3, delta: 4 },
              { productId: 10, locationId: 3, delta: 2 },
            ],
          },
        }),
        correction({
          id: 42,
          actionType: 'INVENTORY_BATCH_REVERSE',
          details: { rows: [{ productId: 9, locationId: 3, delta: 5 }] },
        }),
      ]),
      BATCH,
    );

    expect(prior.restoredByKey.get(prelockKey(9, 3))).toBe(9);
    expect(prior.restoredByKey.get(prelockKey(10, 3))).toBe(2);
    expect(prior.restoredByKey.size).toBe(2);
  });

  it('keys by the location RESTORED AT — the same product at two locations is two keys', async () => {
    const prior = await priorRestorations(
      makeTx([
        correction({
          details: {
            rows: [
              { productId: 9, locationId: 3, delta: 4 },
              { productId: 9, locationId: 7, delta: 6 },
            ],
          },
        }),
      ]),
      BATCH,
    );

    expect(prior.restoredByKey.get(prelockKey(9, 3))).toBe(4);
    expect(prior.restoredByKey.get(prelockKey(9, 7))).toBe(6);
  });

  it('a MOVE contributes METADATA ONLY — its legs are never summed (CX6-2)', async () => {
    const prior = await priorRestorations(makeTx([moveEvent()]), BATCH);

    expect(prior.restoredByKey.size).toBe(0);
    expect(prior.move).toEqual({
      ledgerLocationId: 3,
      physicalLocationId: 7,
      eventId: 43,
      at: '2026-09-02T14:31:22.000Z',
    });
  });

  it('`at` is an ISO STRING — no Date ever leaves the module', async () => {
    const prior = await priorRestorations(makeTx([moveEvent()]), BATCH);
    expect(typeof prior.move?.at).toBe('string');
    expect(prior.move?.at).toBe(AT.toISOString());
  });

  it("a MOVE and a restoration coexist: the units are the restoration's alone", async () => {
    const prior = await priorRestorations(makeTx([moveEvent({ id: 43 }), correction({ id: 44 })]), BATCH);
    expect(prior.restoredByKey.get(prelockKey(9, 3))).toBe(4);
    expect(prior.move?.eventId).toBe(43);
  });
});

describe('priorRestorations — fail closed on a malformed event', () => {
  async function corrupt(events: Event[], eventId: number) {
    const promise = priorRestorations(makeTx(events), BATCH);
    await expect(promise).rejects.toBeInstanceOf(RestorationLedgerCorrupt);
    await expect(promise).rejects.toMatchObject({
      code: 'RESTORATION_LEDGER_CORRUPT',
      statusCode: 409,
      eventId,
      message: `Restoration event ${eventId} is malformed — the batch cannot be reversed or moved until it is repaired`,
    });
  }

  it('a SECOND MOVE event — never "latest wins", and it names the LATER id', async () => {
    await corrupt([moveEvent({ id: 43 }), moveEvent({ id: 51 })], 51);
  });

  it('details that are not an object, or carry no rows', async () => {
    await corrupt([correction({ details: null })], 41);
    await corrupt([correction({ details: {} })], 41);
    await corrupt([correction({ details: { rows: 40 } })], 41);
  });

  it('an EMPTY rows array — a restoration that restored nothing is not a restoration', async () => {
    await corrupt([correction({ details: { rows: [] } })], 41);
  });

  it('a row that is not an object', async () => {
    await corrupt([correction({ details: { rows: [7] } })], 41);
  });

  it('an unsafe, non-positive or over-Int32 id', async () => {
    await corrupt([correction({ details: { rows: [{ productId: 0, locationId: 3, delta: 4 }] } })], 41);
    await corrupt([correction({ details: { rows: [{ productId: 9, locationId: -3, delta: 4 }] } })], 41);
    await corrupt(
      [correction({ details: { rows: [{ productId: 9, locationId: 2147483648, delta: 4 }] } })],
      41,
    );
    await corrupt([correction({ details: { rows: [{ productId: 9.5, locationId: 3, delta: 4 }] } })], 41);
    await corrupt([correction({ details: { rows: [{ productId: '9', locationId: 3, delta: 4 }] } })], 41);
  });

  it('delta <= 0 on a restoration — a readable -N would INFLATE the remainder', async () => {
    await corrupt([correction({ details: { rows: [{ productId: 9, locationId: 3, delta: 0 }] } })], 41);
    await corrupt([correction({ details: { rows: [{ productId: 9, locationId: 3, delta: -4 }] } })], 41);
    await corrupt(
      [correction({ details: { rows: [{ productId: 9, locationId: 3, delta: 1.5 }] } })],
      41,
    );
  });

  it('a MOVE missing either location, or naming the SAME one twice', async () => {
    await corrupt([moveEvent({ details: { physicalLocationId: 7, rows: [] } })], 43);
    await corrupt(
      [
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 3,
            rows: [
              { productId: 9, locationId: 3, delta: -4 },
              { productId: 9, locationId: 3, delta: 4 },
            ],
          },
        }),
      ],
      43,
    );
  });

  it('an UNPAIRED MOVE leg — one row, or three, for a product', async () => {
    await corrupt(
      [
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [{ productId: 9, locationId: 7, delta: -4 }],
          },
        }),
      ],
      43,
    );
    await corrupt(
      [
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [
              { productId: 9, locationId: 7, delta: -4 },
              { productId: 9, locationId: 3, delta: 2 },
              { productId: 9, locationId: 3, delta: 2 },
            ],
          },
        }),
      ],
      43,
    );
  });

  it('a MOVE leg at the WRONG location, or two legs with the same sign', async () => {
    await corrupt(
      [
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [
              { productId: 9, locationId: 5, delta: -4 },
              { productId: 9, locationId: 3, delta: 4 },
            ],
          },
        }),
      ],
      43,
    );
    await corrupt(
      [
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [
              { productId: 9, locationId: 7, delta: 4 },
              { productId: 9, locationId: 3, delta: 4 },
            ],
          },
        }),
      ],
      43,
    );
  });

  it('a MOVE pair that does NOT net to zero', async () => {
    await corrupt(
      [
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [
              { productId: 9, locationId: 7, delta: -4 },
              { productId: 9, locationId: 3, delta: 5 },
            ],
          },
        }),
      ],
      43,
    );
  });

  it('an actionType outside the three — the `in` filter makes it unreachable, not tolerated', async () => {
    await corrupt(
      [correction({ id: 61, actionType: 'INVENTORY_ADJUSTMENT' })],
      61,
    );
  });

  it('a MOVE with two products, each properly paired, is fine', async () => {
    const prior = await priorRestorations(
      makeTx([
        moveEvent({
          details: {
            ledgerLocationId: 3,
            physicalLocationId: 7,
            rows: [
              { productId: 9, locationId: 7, delta: -4 },
              { productId: 9, locationId: 3, delta: 4 },
              { productId: 10, locationId: 7, delta: -1 },
              { productId: 10, locationId: 3, delta: 1 },
            ],
          },
        }),
      ]),
      BATCH,
    );
    expect(prior.restoredByKey.size).toBe(0);
    expect(prior.move?.physicalLocationId).toBe(7);
  });

  it('`details.pairs` is not read — only `rows`', async () => {
    await corrupt(
      [correction({ details: { pairs: [{ productId: 9, locationId: 3, delta: 4 }] } })],
      41,
    );
  });
});
