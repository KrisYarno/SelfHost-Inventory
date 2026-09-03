/**
 * THE REVERSE CORE (reconciliation Part 2, pack CB2b.1; spec §2.5 / §2.7).
 *
 * Every rung of the frozen ladder, the statement ORDER that makes the arithmetic
 * trustworthy, and the cap that is the whole reason the restoration ledger
 * exists: a reverse restores the REMAINDER, once, at the location the units are
 * actually sitting at.
 *
 * The transaction client is a stand-in that RECORDS what it was asked, in order,
 * so "the lock precedes the ledger read" and "the prelock precedes the first
 * write" are pinned as facts rather than as intentions.
 */

import { mockDeep } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

import { prelockKey } from '@/lib/inventory/prelock';
import { reverseBatch, type ReverseContext } from '@/lib/reconciliation/reverse-batch';
import { RestorationLedgerCorrupt } from '@/lib/reconciliation/restorations';
import {
  AlreadyReversedRefusal,
  BatchMovedRefusal,
  FulfilledBatchRefusal,
  MixedStampsRefusal,
  NotAttributableRefusal,
  NullLocationRowRefusal,
  PartiallyStampedRefusal,
  TooManyRowsRefusal,
  UnattributedRefusal,
} from '@/lib/reconciliation/refusals';

const BATCH = 'ledger-batch-1';
const NEW_BATCH = 'new-batch-9';

type LockedRow = {
  id: number;
  productId: number;
  locationId: number | null;
  delta: number;
  userId: number | null;
  logType: string;
  orderRecordId: string | null;
};

type AuditRow = {
  id: number;
  actionType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
};

type RestorationEvent = {
  id: number;
  actionType: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
};

const AT = new Date('2026-09-02T14:31:22.000Z');

const DEDUCT_EVENT: AuditRow = {
  id: 3,
  actionType: 'INVENTORY_DEDUCT',
  entityId: '9',
  details: { intent: 'order' },
};

function row(over: Partial<LockedRow> = {}): LockedRow {
  return {
    id: 501,
    productId: 9,
    locationId: 3,
    delta: -4,
    userId: 7,
    logType: 'SALE',
    orderRecordId: null,
    ...over,
  };
}

function correctionEvent(rows: unknown[], id = 41): RestorationEvent {
  return { id, actionType: 'INVENTORY_CORRECTION', details: { rows }, createdAt: AT };
}

function moveEvent(rows: unknown[], id = 43, ledger = 3, physical = 7): RestorationEvent {
  return {
    id,
    actionType: 'INVENTORY_BATCH_MOVE',
    details: { ledgerLocationId: ledger, physicalLocationId: physical, rows },
    createdAt: AT,
  };
}

interface TxFixture {
  locked?: LockedRow[];
  auditEvents?: AuditRow[];
  restorationEvents?: RestorationEvent[];
  latestAttempt?: { evidence: string | null } | null;
}

/** A transaction client that answers the core's reads and RECORDS the order. */
function makeTx(fixture: TxFixture = {}) {
  const trace: string[] = [];
  const tx = mockDeep<Prisma.TransactionClient>();
  const locked = fixture.locked ?? [row()];

  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes('product_locations')) {
      trace.push('prelock SELECT FOR UPDATE');
      return [];
    }
    trace.push('lock batch rows FOR UPDATE');
    return locked;
  });
  (tx.$executeRaw as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('prelock materialize');
    return 0;
  });
  (tx.auditLog.findMany as unknown as jest.Mock).mockImplementation(
    async (args: { where?: { batchId?: string; entityId?: string } }) => {
      if (args?.where?.entityId !== undefined) {
        trace.push('restoration ledger read');
        return fixture.restorationEvents ?? [];
      }
      trace.push('auditLog.findMany');
      return fixture.auditEvents ?? [DEDUCT_EVENT];
    },
  );
  (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('orderAttributionAttempt.findFirst');
    return fixture.latestAttempt ?? null;
  });
  (tx.inventory_logs.create as unknown as jest.Mock).mockImplementation(
    async (args: { data: Record<string, unknown> }) => {
      trace.push('inventory_logs.create');
      return { id: 900, ...args.data };
    },
  );
  (tx.product_locations.upsert as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('product_locations.upsert');
    return { version: 2 };
  });
  (tx.product.update as unknown as jest.Mock).mockImplementation(async () => {
    trace.push('product.update');
    return {};
  });

  return { tx, trace };
}

const ADMIN = { userId: 1, isAdmin: true };

function run(
  tx: Prisma.TransactionClient,
  over: {
    discovered?: string | null;
    actor?: { userId: number; isAdmin: boolean };
    onRecord?: (tx: Prisma.TransactionClient, ctx: ReverseContext) => Promise<void>;
  } = {},
) {
  return reverseBatch(
    tx,
    {
      batchId: BATCH,
      discovered: { orderRecordId: over.discovered === undefined ? null : over.discovered },
      actor: over.actor ?? ADMIN,
      newBatchId: NEW_BATCH,
    },
    over.onRecord ?? (async () => undefined),
  );
}

// ---------------------------------------------------------------------------
// The ladder, rung by rung
// ---------------------------------------------------------------------------

describe('reverseBatch — the preamble refusals it inherits (rung 1)', () => {
  it('NOT_ATTRIBUTABLE when the batch has no population rows', async () => {
    const { tx } = makeTx({ locked: [] });
    await expect(run(tx)).rejects.toBeInstanceOf(NotAttributableRefusal);
  });

  it('TOO_MANY_ROWS above the bound, before any stamp is considered', async () => {
    const locked = Array.from({ length: 51 }, (_, i) => row({ id: 501 + i, productId: 9 + i }));
    const { tx } = makeTx({ locked });
    await expect(run(tx)).rejects.toBeInstanceOf(TooManyRowsRefusal);
  });

  it('MIXED_STAMPS when the rows disagree about their order', async () => {
    const { tx } = makeTx({
      locked: [row({ orderRecordId: 'ord-1' }), row({ id: 502, orderRecordId: 'ord-2' })],
    });
    await expect(run(tx, { discovered: 'ord-1' })).rejects.toBeInstanceOf(MixedStampsRefusal);
  });
});

describe('reverseBatch — rung 2: the actor rule comes FIRST', () => {
  it('refuses UNATTRIBUTED for a non-admin who is not the provable actor', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 7 }), row({ id: 502, userId: 8 })] });
    await expect(run(tx, { actor: { userId: 7, isAdmin: false } })).rejects.toBeInstanceOf(
      UnattributedRefusal,
    );
  });

  it('refuses UNATTRIBUTED when ANY row carries no actor at all', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 7 }), row({ id: 502, userId: null })] });
    await expect(run(tx, { actor: { userId: 7, isAdmin: false } })).rejects.toBeInstanceOf(
      UnattributedRefusal,
    );
  });

  it('the PROVABLE actor of an unstamped batch reverses it', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 7 }), row({ id: 502, userId: 7 })] });
    const ctx = await run(tx, { actor: { userId: 7, isAdmin: false } });
    expect(ctx.restoredUnits).toBe(8);
  });

  it('an ADMIN reverses an unstamped batch somebody else recorded', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 99 })] });
    await expect(run(tx)).resolves.toMatchObject({ restoredUnits: 4 });
  });

  it('a STAMPED batch never reaches the actor rule (membership is the route’s)', async () => {
    const { tx } = makeTx({ locked: [row({ orderRecordId: 'ord-9', userId: 99 })] });
    await expect(run(tx, { discovered: 'ord-9', actor: { userId: 7, isAdmin: false } })).resolves
      .toMatchObject({ orderRecordId: 'ord-9' });
  });

  it('the actor rule precedes the STALE-DISCOVERY guard — authorisation before data', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 99 })] });
    // Discovery said `ord-1`, the locked rows say unstamped: BATCH_MOVED would
    // fire for an admin. A non-actor non-admin gets the authorisation answer.
    await expect(
      run(tx, { discovered: 'ord-1', actor: { userId: 7, isAdmin: false } }),
    ).rejects.toBeInstanceOf(UnattributedRefusal);
  });
});

describe('reverseBatch — rungs 3 to 6', () => {
  it('rung 3: BATCH_MOVED when the locked stamp differs from what discovery read', async () => {
    const { tx } = makeTx({ locked: [row({ orderRecordId: 'ord-9' })] });
    const err = await run(tx, { discovered: null }).catch((e) => e);
    expect(err).toBeInstanceOf(BatchMovedRefusal);
    expect(err.currentOrderRecordId).toBe('ord-9');
    expect(err.expected).toBeNull();
  });

  it('rung 4: PARTIALLY_STAMPED with both figures', async () => {
    const { tx } = makeTx({
      locked: [row({ orderRecordId: 'ord-9' }), row({ id: 502, orderRecordId: null })],
    });
    const err = await run(tx, { discovered: 'ord-9' }).catch((e) => e);
    expect(err).toBeInstanceOf(PartiallyStampedRefusal);
    expect(err.stamped).toBe(1);
    expect(err.unstamped).toBe(1);
  });

  it('rung 5: NULL_LOCATION_ROW names the row to repair', async () => {
    const { tx } = makeTx({ locked: [row(), row({ id: 502, locationId: null })] });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(NullLocationRowRefusal);
    expect(err.rowId).toBe(502);
  });

  it('rung 6: a FULFILLED batch is refused — unfulfill owns the line bookkeeping', async () => {
    const { tx } = makeTx({
      locked: [row()],
      auditEvents: [
        {
          id: 4,
          actionType: 'EXTERNAL_ORDER_FULFILLMENT',
          entityId: 'ord-5',
          details: { orderId: 'ord-5' },
        },
      ],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(FulfilledBatchRefusal);
    // The EVENT's order, even though the ledger rows carry none.
    expect(err.orderRecordId).toBe('ord-5');
    expect(err.orderNumber).toBeNull();
    expect(err.message).toBe(
      'Fulfilled against #ord-5 — change it via unfulfill/refulfill, not here',
    );
  });

  it('rung 6: an ATTEMPT-ONLY fulfilment is refused too, and names no order', async () => {
    const { tx } = makeTx({ locked: [row()], latestAttempt: { evidence: 'fulfillment' } });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(FulfilledBatchRefusal);
    expect(err.orderRecordId).toBeNull();
    expect(err.message).toBe('This fulfilled batch names no order — repair via unfulfill/refulfill');
  });

  it('rung 6 is NOT gated on the stamp: a STAMPED fulfilled batch refuses the same way', async () => {
    const { tx } = makeTx({
      locked: [row({ orderRecordId: 'ord-9' })],
      auditEvents: [
        { id: 4, actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityId: null, details: {} },
      ],
    });
    const err = await run(tx, { discovered: 'ord-9' }).catch((e) => e);
    expect(err).toBeInstanceOf(FulfilledBatchRefusal);
    expect(err.orderRecordId).toBe('ord-9');
  });
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe('reverseBatch — the remainder (rungs 8 to 12)', () => {
  it('restores the WHOLE batch when nothing was put back, one CORRECTION row per key', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 9, locationId: 3, delta: -4 }),
        row({ id: 502, productId: 9, locationId: 3, delta: -1 }),
        row({ id: 503, productId: 10, locationId: 3, delta: -2 }),
      ],
    });
    const ctx = await run(tx);

    expect(ctx.rows).toEqual([
      { productId: 9, locationId: 3, delta: 5 },
      { productId: 10, locationId: 3, delta: 2 },
    ]);
    expect(ctx.restoredUnits).toBe(7);
    expect(ctx.previouslyRestored).toBe(0);
    expect(ctx.totalUnits).toBe(7);
    expect(ctx.physicalLocationId).toBeNull();
    expect(tx.inventory_logs.create).toHaveBeenCalledTimes(2);
  });

  it('THE CAP (I-R2): a prior PARTIAL correction leaves only the remainder', async () => {
    const { tx } = makeTx({
      locked: [row({ delta: -10 })],
      restorationEvents: [correctionEvent([{ productId: 9, locationId: 3, delta: 4 }])],
    });
    const ctx = await run(tx);

    expect(ctx.rows).toEqual([{ productId: 9, locationId: 3, delta: 6 }]);
    expect(ctx.restoredUnits).toBe(6);
    expect(ctx.previouslyRestored).toBe(4);
    expect(ctx.totalUnits).toBe(10);
  });

  it('the CORRECTION row carries the NEW batch id, the batch’s stamp and the reason code', async () => {
    const { tx } = makeTx({ locked: [row({ orderRecordId: 'ord-9' })] });
    await run(tx, { discovered: 'ord-9' });

    expect((tx.inventory_logs.create as unknown as jest.Mock).mock.calls[0][0].data).toMatchObject({
      productId: 9,
      locationId: 3,
      delta: 4,
      logType: 'CORRECTION',
      reasonCode: 'CORRECTION',
      batchId: NEW_BATCH,
      orderRecordId: 'ord-9',
      userId: 1,
    });
  });

  it('rung 10: nothing owed on any key answers ALREADY_REVERSED with both numbers', async () => {
    const { tx } = makeTx({
      locked: [row({ delta: -4 })],
      restorationEvents: [correctionEvent([{ productId: 9, locationId: 3, delta: 4 }])],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyReversedRefusal);
    expect(err.previouslyRestored).toBe(4);
    expect(err.totalUnits).toBe(4);
    expect(err.message).toBe('This batch was already reversed — 4 of 4 units were put back');
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it('I-R3: reversing the SAME batch twice refuses the second time', async () => {
    const first = makeTx({ locked: [row({ delta: -4 })] });
    const ctx = await run(first.tx);
    expect(ctx.restoredUnits).toBe(4);

    // The second call sees the first call's committed event.
    const second = makeTx({
      locked: [row({ delta: -4 })],
      restorationEvents: [
        { id: 44, actionType: 'INVENTORY_BATCH_REVERSE', details: { rows: ctx.rows }, createdAt: AT },
      ],
    });
    await expect(run(second.tx)).rejects.toBeInstanceOf(AlreadyReversedRefusal);
  });

  it('a key with a partial restoration and a key with none are both settled in one call', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 9, locationId: 3, delta: -10 }),
        row({ id: 502, productId: 10, locationId: 3, delta: -3 }),
      ],
      restorationEvents: [correctionEvent([{ productId: 9, locationId: 3, delta: 10 }])],
    });
    const ctx = await run(tx);
    expect(ctx.rows).toEqual([{ productId: 10, locationId: 3, delta: 3 }]);
    expect(ctx.previouslyRestored).toBe(10);
    expect(ctx.totalUnits).toBe(13);
    expect(ctx.restoredUnits).toBe(3);
  });

  it('the ctx rows ARE the applied deltas — same keys, same numbers, same order', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 12, locationId: 3, delta: -1 }),
        row({ id: 502, productId: 9, locationId: 5, delta: -2 }),
        row({ id: 503, productId: 9, locationId: 3, delta: -3 }),
      ],
    });
    const ctx = await run(tx);

    const applied = (tx.inventory_logs.create as unknown as jest.Mock).mock.calls.map(
      (call) => ({
        productId: call[0].data.productId,
        locationId: call[0].data.locationId,
        delta: call[0].data.delta,
      }),
    );
    expect(applied).toEqual(ctx.rows);
    // (productId, locationId) ASCENDING — the prelock's own comparator.
    expect(applied).toEqual([
      { productId: 9, locationId: 3, delta: 3 },
      { productId: 9, locationId: 5, delta: 2 },
      { productId: 12, locationId: 3, delta: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// After a MOVE
// ---------------------------------------------------------------------------

describe('reverseBatch — a batch whose stock was MOVED', () => {
  const MOVE_LEGS = [
    { productId: 9, locationId: 7, delta: -4 },
    { productId: 9, locationId: 3, delta: 4 },
  ];

  it('restores at the PHYSICAL location, and says so on the context', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 3, delta: -4 })],
      restorationEvents: [moveEvent(MOVE_LEGS)],
    });
    const ctx = await run(tx);

    expect(ctx.rows).toEqual([{ productId: 9, locationId: 7, delta: 4 }]);
    expect(ctx.physicalLocationId).toBe(7);
    expect(ctx.previouslyRestored).toBe(0);
    expect((tx.inventory_logs.create as unknown as jest.Mock).mock.calls[0][0].data.locationId).toBe(
      7,
    );
  });

  it('the remainder looks up the location it RESTORED AT, not the ledger one', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 3, delta: -4 })],
      restorationEvents: [
        moveEvent(MOVE_LEGS),
        correctionEvent([{ productId: 9, locationId: 7, delta: 1 }], 44),
      ],
    });
    const ctx = await run(tx);
    expect(ctx.rows).toEqual([{ productId: 9, locationId: 7, delta: 3 }]);
    expect(ctx.previouslyRestored).toBe(1);
  });

  it('a MOVED batch reversed TWICE answers ALREADY_REVERSED, never the corrupt refusal', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 3, delta: -4 })],
      restorationEvents: [
        moveEvent(MOVE_LEGS),
        {
          id: 44,
          actionType: 'INVENTORY_BATCH_REVERSE',
          details: { rows: [{ productId: 9, locationId: 7, delta: 4 }] },
          createdAt: AT,
        },
      ],
    });
    await expect(run(tx)).rejects.toBeInstanceOf(AlreadyReversedRefusal);
  });

  it('rung 8: a MOVE whose ledger location is not where these rows sit is CORRUPT', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 5, delta: -4 })],
      restorationEvents: [moveEvent(MOVE_LEGS)],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(RestorationLedgerCorrupt);
    expect(err.eventId).toBe(43);
  });

  it('rung 8: a MOVE naming a product this batch never carried is CORRUPT', async () => {
    const { tx } = makeTx({
      locked: [row({ productId: 9, locationId: 3, delta: -4 })],
      restorationEvents: [
        moveEvent([
          ...MOVE_LEGS,
          { productId: 77, locationId: 7, delta: -1 },
          { productId: 77, locationId: 3, delta: 1 },
        ]),
      ],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(RestorationLedgerCorrupt);
    expect(err.eventId).toBe(43);
  });
});

describe('reverseBatch — rung 9, the belt over the ledger', () => {
  it('a restoration on a key this batch never touched is CORRUPT, naming its event', async () => {
    const { tx } = makeTx({
      locked: [row({ productId: 9, locationId: 3, delta: -4 })],
      restorationEvents: [correctionEvent([{ productId: 11, locationId: 3, delta: 1 }], 41)],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(RestorationLedgerCorrupt);
    expect(err.eventId).toBe(41);
  });

  it('a restoration at the LEDGER location after a MOVE is outside the mapped set', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 3, delta: -4 })],
      restorationEvents: [
        moveEvent([
          { productId: 9, locationId: 7, delta: -4 },
          { productId: 9, locationId: 3, delta: 4 },
        ]),
        correctionEvent([{ productId: 9, locationId: 3, delta: 1 }], 45),
      ],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(RestorationLedgerCorrupt);
    expect(err.eventId).toBe(45);
  });

  it('more units restored than the batch ever took out is CORRUPT — never a negative cap', async () => {
    const { tx } = makeTx({
      locked: [row({ delta: -4 })],
      restorationEvents: [
        correctionEvent([{ productId: 9, locationId: 3, delta: 3 }], 41),
        correctionEvent([{ productId: 9, locationId: 3, delta: 3 }], 42),
      ],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(RestorationLedgerCorrupt);
    // The LAST event that put units on the key — the one that took it over.
    expect(err.eventId).toBe(42);
  });

  it('a legitimate move-then-partial-reverse ledger does NOT trip the belt', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 3, delta: -4 })],
      restorationEvents: [
        moveEvent([
          { productId: 9, locationId: 7, delta: -4 },
          { productId: 9, locationId: 3, delta: 4 },
        ]),
        correctionEvent([{ productId: 9, locationId: 7, delta: 4 }], 46),
      ],
    });
    await expect(run(tx)).rejects.toBeInstanceOf(AlreadyReversedRefusal);
  });
});

// ---------------------------------------------------------------------------
// The order and the record
// ---------------------------------------------------------------------------

describe('reverseBatch — the statement ORDER (I-R1) and the record', () => {
  it('lock, evidence, attempt, restoration ledger, prelock, writes — in that order', async () => {
    const { tx, trace } = makeTx({ locked: [row()] });
    await run(tx);

    expect(trace).toEqual([
      'lock batch rows FOR UPDATE',
      'auditLog.findMany',
      'orderAttributionAttempt.findFirst',
      'restoration ledger read',
      'prelock materialize',
      'prelock SELECT FOR UPDATE',
      'inventory_logs.create',
      'product_locations.upsert',
    ]);
  });

  it('the restoration ledger is read PLAIN, and only after the batch is locked', async () => {
    const { tx } = makeTx({ locked: [row()] });
    await run(tx);

    const call = (tx.auditLog.findMany as unknown as jest.Mock).mock.calls[1][0];
    expect(call).toEqual({
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
  });

  it('the prelock names exactly the keys the writes touch, in canonical order', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 12, locationId: 3, delta: -1 }),
        row({ id: 502, productId: 9, locationId: 3, delta: -2 }),
      ],
    });
    await run(tx);

    const materialize = (tx.$executeRaw as unknown as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    expect(materialize.values).toEqual([9, 3, 12, 3]);
  });

  it('onRecord runs LAST, inside the same transaction, with the context returned', async () => {
    const { tx, trace } = makeTx({ locked: [row()] });
    let seen: ReverseContext | null = null;
    const ctx = await run(tx, {
      onRecord: async (txn, context) => {
        expect(txn).toBe(tx);
        seen = context;
        trace.push('onRecord');
      },
    });

    expect(seen).toBe(ctx);
    expect(trace[trace.length - 1]).toBe('onRecord');
    expect(ctx).toEqual({
      reversedBatchId: BATCH,
      batchId: NEW_BATCH,
      orderRecordId: null,
      rows: [{ productId: 9, locationId: 3, delta: 4 }],
      restoredUnits: 4,
      previouslyRestored: 0,
      totalUnits: 4,
      physicalLocationId: null,
    });
  });

  it('NO attempt row is written — a reverse is not an attribution', async () => {
    const { tx } = makeTx({ locked: [row()] });
    await run(tx);
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });

  it('a refused reverse writes NOTHING (the tx aborts on the throw)', async () => {
    const { tx } = makeTx({ locked: [row({ locationId: null })] });
    await expect(run(tx)).rejects.toBeInstanceOf(NullLocationRowRefusal);
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('reverseBatch — the key spelling is the prelock’s own', () => {
  it('the remainder looks the restoration up under `prelockKey`', async () => {
    const { tx } = makeTx({
      locked: [row({ productId: 9, locationId: 3, delta: -4 })],
      restorationEvents: [correctionEvent([{ productId: 9, locationId: 3, delta: 1 }])],
    });
    const ctx = await run(tx);
    // The ledger's map is keyed `9:3`; a re-spelled key would miss it and this
    // reverse would restore 4 instead of 3.
    expect(prelockKey(9, 3)).toBe('9:3');
    expect(ctx.restoredUnits).toBe(3);
  });
});
