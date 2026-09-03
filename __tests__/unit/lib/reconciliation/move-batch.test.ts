/**
 * THE MOVE CORE (reconciliation Part 2, pack CB2c.1; spec §2.6 / §2.7).
 *
 * Every rung of the frozen ladder, the statement ORDER the arithmetic depends
 * on, and the four invariants that make a reclassification honest: the pair is
 * written physical-then-ledger, its two legs share one `transferId` and net to
 * zero across the two locations, there are exactly two legs per product, and the
 * source check reads the LOCKED `product_locations` row rather than a consistent
 * read another writer can already have moved past.
 *
 * The transaction client is a stand-in that RECORDS what it was asked, in order,
 * so "the lock precedes the ledger read" and "the prelock precedes the first
 * write" are pinned as facts rather than as intentions — and the prelock's
 * returning read answers with real quantities, because the whole of rung 10 is
 * about what that read said.
 */

import { mockDeep } from 'jest-mock-extended';
import { Prisma } from '@prisma/client';

import { prelockKey } from '@/lib/inventory/prelock';
import { moveBatch, type MoveContext } from '@/lib/reconciliation/move-batch';
import { RestorationLedgerCorrupt } from '@/lib/reconciliation/restorations';
import {
  AlreadyMovedRefusal,
  BatchMovedRefusal,
  BatchRestoredRefusal,
  FulfilledBatchRefusal,
  InsufficientAtSourceRefusal,
  MixedStampsRefusal,
  MultiLocationRefusal,
  NotAttributableRefusal,
  NullLocationRowRefusal,
  PartiallyStampedRefusal,
  SameLocationRefusal,
  TooManyRowsRefusal,
  UnattributedRefusal,
} from '@/lib/reconciliation/refusals';

const BATCH = 'ledger-batch-1';
const NEW_BATCH = 'new-batch-9';
/** The batch's own rows sit here; the stock actually left `PHYSICAL`. */
const LEDGER = 3;
const PHYSICAL = 7;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    locationId: LEDGER,
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

function moveEvent(rows: unknown[], id = 43, ledger = LEDGER, physical = PHYSICAL): RestorationEvent {
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
  /** `prelockKey` -> what the LOCKED `product_locations` row holds. */
  stock?: Record<string, number>;
  /** Everything the fixture does not name. Generous by default. */
  defaultStock?: number;
}

/** A transaction client that answers the core's reads and RECORDS the order. */
function makeTx(fixture: TxFixture = {}) {
  const trace: string[] = [];
  const tx = mockDeep<Prisma.TransactionClient>();
  const locked = fixture.locked ?? [row()];
  const defaultStock = fixture.defaultStock ?? 1000;

  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (query: Prisma.Sql) => {
    if (query.sql.includes('product_locations')) {
      trace.push('prelock SELECT FOR UPDATE');
      // The prelock's returning read, answered from the fixture's books: rung
      // 10 is entirely about what these quantities say.
      const keys: Array<{ productId: number; locationId: number }> = [];
      for (let i = 0; i + 1 < query.values.length; i += 2) {
        keys.push({
          productId: query.values[i] as number,
          locationId: query.values[i + 1] as number,
        });
      }
      return keys.map((key) => ({
        productId: key.productId,
        locationId: key.locationId,
        quantity:
          fixture.stock?.[prelockKey(key.productId, key.locationId)] ?? defaultStock,
        version: 1,
      }));
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
    physicalLocationId?: number;
    actor?: { userId: number; isAdmin: boolean };
    onRecord?: (tx: Prisma.TransactionClient, ctx: MoveContext) => Promise<void>;
  } = {},
) {
  return moveBatch(
    tx,
    {
      batchId: BATCH,
      physicalLocationId: over.physicalLocationId ?? PHYSICAL,
      discovered: { orderRecordId: over.discovered === undefined ? null : over.discovered },
      actor: over.actor ?? ADMIN,
      newBatchId: NEW_BATCH,
    },
    over.onRecord ?? (async () => undefined),
  );
}

/** The ledger rows the core actually wrote, in write order. */
function written(tx: Prisma.TransactionClient) {
  return (tx.inventory_logs.create as unknown as jest.Mock).mock.calls.map((call) => call[0].data);
}

// ---------------------------------------------------------------------------
// The ladder, rung by rung
// ---------------------------------------------------------------------------

describe('moveBatch — the preamble refusals it inherits (rung 1)', () => {
  it('NOT_ATTRIBUTABLE when the batch has no population rows', async () => {
    const { tx } = makeTx({ locked: [] });
    await expect(run(tx)).rejects.toBeInstanceOf(NotAttributableRefusal);
  });

  it('TOO_MANY_ROWS above the bound, before any location is considered', async () => {
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

describe('moveBatch — rung 2: the actor rule comes FIRST', () => {
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

  it('the PROVABLE actor of an unstamped batch moves it', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 7 }), row({ id: 502, userId: 7 })] });
    const ctx = await run(tx, { actor: { userId: 7, isAdmin: false } });
    expect(ctx.pairs).toEqual([
      { productId: 9, units: 8, transferId: expect.stringMatching(UUID) },
    ]);
  });

  it('an ADMIN moves an unstamped batch somebody else recorded', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 99 })] });
    await expect(run(tx)).resolves.toMatchObject({ ledgerLocationId: LEDGER });
  });

  // The move names TWO locations and the units at each of them. Every one of
  // those is a fact about a batch an unauthorised caller may not touch, which
  // is why authorisation is rung 2 and not rung 9.
  it('the actor rule precedes the STALE-DISCOVERY guard — authorisation before data', async () => {
    const { tx } = makeTx({ locked: [row({ userId: 99 })] });
    await expect(
      run(tx, { discovered: 'ord-1', actor: { userId: 7, isAdmin: false } }),
    ).rejects.toBeInstanceOf(UnattributedRefusal);
  });
});

describe('moveBatch — rungs 3 to 6', () => {
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

  it('rung 6: MULTI_LOCATION names every location the batch spans, ascending', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 5 }), row({ id: 502, locationId: 3 }), row({ id: 503, locationId: 5 })],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(MultiLocationRefusal);
    expect(err.locationIds).toEqual([3, 5]);
    expect(err.message).toBe('This batch spans 2 locations (3, 5) and cannot be moved as one');
  });

  it('rung 6: ONE location is asserted, never assumed — the single-location batch passes', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: LEDGER }), row({ id: 502, locationId: LEDGER })],
    });
    await expect(run(tx)).resolves.toMatchObject({ ledgerLocationId: LEDGER });
  });
});

describe('moveBatch — rung 7: a fulfilment-evidenced batch is NEVER moved (PK-1)', () => {
  it('refuses with the EVENT’s order, even though the ledger rows carry none', async () => {
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
    expect(err.orderRecordId).toBe('ord-5');
    expect(err.orderNumber).toBeNull();
    expect(err.message).toBe(
      'Fulfilled against #ord-5 — change it via unfulfill/refulfill, not here',
    );
    // Nothing was written: the repair lives in unfulfill + refulfil.
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it('an ATTEMPT-ONLY fulfilment is refused too, and names no order', async () => {
    const { tx } = makeTx({ locked: [row()], latestAttempt: { evidence: 'fulfillment' } });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(FulfilledBatchRefusal);
    expect(err.orderRecordId).toBeNull();
    expect(err.message).toBe('This fulfilled batch names no order — repair via unfulfill/refulfill');
  });

  it('is NOT gated on the stamp: a STAMPED fulfilled batch refuses the same way', async () => {
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

  // The order of rungs 6 and 7 is observable: a fulfilled batch spanning two
  // locations answers MULTI_LOCATION, because the source has to exist before
  // "which repair does this batch need" is a question worth asking.
  it('rung 6 precedes rung 7 — a multi-location fulfilled batch says MULTI_LOCATION', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: 3 }), row({ id: 502, locationId: 5 })],
      auditEvents: [
        { id: 4, actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityId: 'ord-5', details: {} },
      ],
    });
    await expect(run(tx)).rejects.toBeInstanceOf(MultiLocationRefusal);
  });
});

describe('moveBatch — rung 8: SAME_LOCATION', () => {
  it('refuses a destination that IS the ledger location, and names it', async () => {
    const { tx } = makeTx({ locked: [row({ locationId: LEDGER })] });
    const err = await run(tx, { physicalLocationId: LEDGER }).catch((e) => e);
    expect(err).toBeInstanceOf(SameLocationRefusal);
    expect(err.locationId).toBe(LEDGER);
    expect(err.message).toBe(
      "Location 3 is already this batch's ledger location — choose a different one",
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('rung 7 precedes rung 8 — a fulfilled batch pointed at its own location says FULFILLED_BATCH', async () => {
    const { tx } = makeTx({
      locked: [row({ locationId: LEDGER })],
      latestAttempt: { evidence: 'fulfillment' },
    });
    await expect(run(tx, { physicalLocationId: LEDGER })).rejects.toBeInstanceOf(
      FulfilledBatchRefusal,
    );
  });
});

describe('moveBatch — rung 9: the restoration ledger (I-M2)', () => {
  it('a batch whose units were put back is refused BATCH_RESTORED with the total', async () => {
    const { tx } = makeTx({
      locked: [row({ delta: -4 })],
      restorationEvents: [correctionEvent([{ productId: 9, locationId: LEDGER, delta: 3 }])],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(BatchRestoredRefusal);
    expect(err.restoredUnits).toBe(3);
    expect(err.message).toBe(
      'This batch has already been put back (3 units) — it can no longer be re-attributed or moved',
    );
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it('the restored total sums EVERY key, not just the first', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 9, delta: -4 }),
        row({ id: 502, productId: 10, delta: -2 }),
      ],
      restorationEvents: [
        correctionEvent([
          { productId: 9, locationId: LEDGER, delta: 4 },
          { productId: 10, locationId: LEDGER, delta: 2 },
        ]),
      ],
    });
    const err = await run(tx).catch((e) => e);
    expect(err.restoredUnits).toBe(6);
  });

  it('a batch already moved is refused ALREADY_MOVED, naming the location and the minute', async () => {
    const { tx } = makeTx({
      locked: [row({ delta: -4 })],
      restorationEvents: [
        moveEvent([
          { productId: 9, locationId: PHYSICAL, delta: -4 },
          { productId: 9, locationId: LEDGER, delta: 4 },
        ]),
      ],
    });
    const err = await run(tx, { physicalLocationId: 8 }).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyMovedRefusal);
    expect(err.physicalLocationId).toBe(PHYSICAL);
    expect(err.at).toBe('2026-09-02T14:31:22.000Z');
    expect(err.message).toBe(
      'This batch was moved to location 7 on 2026-09-02 14:31 UTC — it can no longer be re-attributed or moved again',
    );
  });

  it('a MALFORMED restoration event is fail-closed, never a move on an unreadable ledger', async () => {
    const { tx } = makeTx({
      locked: [row()],
      restorationEvents: [correctionEvent('not an array' as unknown as unknown[], 41)],
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(RestorationLedgerCorrupt);
    expect(err.eventId).toBe(41);
  });

  it('rung 8 precedes rung 9 — SAME_LOCATION answers before the ledger is even read', async () => {
    const { tx, trace } = makeTx({
      locked: [row({ locationId: LEDGER })],
      restorationEvents: [correctionEvent([{ productId: 9, locationId: LEDGER, delta: 4 }])],
    });
    await expect(run(tx, { physicalLocationId: LEDGER })).rejects.toBeInstanceOf(
      SameLocationRefusal,
    );
    expect(trace).not.toContain('restoration ledger read');
  });
});

describe('moveBatch — rung 10: the source is checked on the LOCKED row (I-M3)', () => {
  it('INSUFFICIENT_AT_SOURCE names the product, the location, the books and the need', async () => {
    const { tx } = makeTx({
      locked: [row({ productId: 9, delta: -4 })],
      stock: { [prelockKey(9, PHYSICAL)]: 3 },
    });
    const err = await run(tx).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientAtSourceRefusal);
    expect(err.productId).toBe(9);
    expect(err.locationId).toBe(PHYSICAL);
    expect(err.onBook).toBe(3);
    expect(err.needed).toBe(4);
    expect(err.message).toBe(
      'Location 7 has 3 of product 9 on the books — 4 needed to move this batch',
    );
    // The prelock ran (the check reads what it returned); nothing was written.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
  });

  it('EXACTLY enough at the source is enough — the comparison is `<`, not `<=`', async () => {
    const { tx } = makeTx({
      locked: [row({ productId: 9, delta: -4 })],
      stock: { [prelockKey(9, PHYSICAL)]: 4 },
    });
    await expect(run(tx)).resolves.toMatchObject({ pairs: [expect.objectContaining({ units: 4 })] });
  });

  it('the check reads the PHYSICAL key — a full ledger location does not excuse an empty source', async () => {
    const { tx } = makeTx({
      locked: [row({ productId: 9, delta: -4 })],
      stock: { [prelockKey(9, PHYSICAL)]: 0, [prelockKey(9, LEDGER)]: 500 },
    });
    await expect(run(tx)).rejects.toBeInstanceOf(InsufficientAtSourceRefusal);
  });

  it('the LOWEST product id is the one that answers when two are short', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 12, delta: -4 }),
        row({ id: 502, productId: 9, delta: -4 }),
      ],
      stock: { [prelockKey(9, PHYSICAL)]: 0, [prelockKey(12, PHYSICAL)]: 0 },
    });
    const err = await run(tx).catch((e) => e);
    expect(err.productId).toBe(9);
  });

  it('the prelock names BOTH ends of every pair, in canonical order', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 12, delta: -1 }),
        row({ id: 502, productId: 9, delta: -2 }),
      ],
    });
    await run(tx);

    const materialize = (tx.$executeRaw as unknown as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    // (productId, locationId) ascending — the prelock's own comparator, over the
    // 2P key set {(9,3),(9,7),(12,3),(12,7)}.
    expect(materialize.values).toEqual([9, LEDGER, 9, PHYSICAL, 12, LEDGER, 12, PHYSICAL]);
  });
});

// ---------------------------------------------------------------------------
// The pair
// ---------------------------------------------------------------------------

describe('moveBatch — rung 11: the TRANSFER pair', () => {
  it('writes the PHYSICAL leg first and the LEDGER leg second (the order pin, I-M1)', async () => {
    const { tx } = makeTx({ locked: [row({ productId: 9, delta: -4 })] });
    await run(tx);

    const rows = written(tx);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ productId: 9, locationId: PHYSICAL, delta: -4 });
    expect(rows[1]).toMatchObject({ productId: 9, locationId: LEDGER, delta: 4 });
  });

  it('both legs are TRANSFER rows under the NEW batch id, stamped like the batch', async () => {
    const { tx } = makeTx({ locked: [row({ orderRecordId: 'ord-9' })] });
    await run(tx, { discovered: 'ord-9' });

    written(tx).forEach((data) => {
      expect(data).toMatchObject({
        logType: 'TRANSFER',
        batchId: NEW_BATCH,
        orderRecordId: 'ord-9',
        userId: 1,
      });
    });
  });

  it('I-M4: the pair shares ONE transferId and nets to zero across the two locations', async () => {
    const { tx } = makeTx({ locked: [row({ productId: 9, delta: -4 })] });
    const ctx = await run(tx);

    const rows = written(tx);
    expect(rows[0].transferId).toBe(rows[1].transferId);
    expect(rows[0].transferId).toMatch(UUID);
    expect(rows[0].delta + rows[1].delta).toBe(0);
    expect(ctx.pairs[0].transferId).toBe(rows[0].transferId);
  });

  it('I-M4: two products get two DIFFERENT transferIds, and 2 × pairs.length rows', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 9, delta: -4 }),
        row({ id: 502, productId: 10, delta: -2 }),
      ],
    });
    const ctx = await run(tx);

    expect(ctx.pairs).toEqual([
      { productId: 9, units: 4, transferId: expect.stringMatching(UUID) },
      { productId: 10, units: 2, transferId: expect.stringMatching(UUID) },
    ]);
    expect(ctx.pairs[0].transferId).not.toBe(ctx.pairs[1].transferId);
    expect(ctx.rows).toHaveLength(2 * ctx.pairs.length);

    // Per product: exactly two legs, netting to zero.
    ctx.pairs.forEach((pair) => {
      const legs = ctx.rows.filter((r) => r.productId === pair.productId);
      expect(legs).toHaveLength(2);
      expect(legs.reduce((sum, leg) => sum + leg.delta, 0)).toBe(0);
    });
  });

  it('products are iterated by productId ASCENDING, whatever order the rows arrived in', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 12, delta: -1 }),
        row({ id: 502, productId: 9, delta: -2 }),
        row({ id: 503, productId: 12, delta: -3 }),
      ],
    });
    const ctx = await run(tx);

    expect(ctx.pairs.map((pair) => pair.productId)).toEqual([9, 12]);
    // The units are the batch's own Σ per product, negated.
    expect(ctx.pairs.map((pair) => pair.units)).toEqual([2, 4]);
    expect(ctx.rows).toEqual([
      { productId: 9, locationId: PHYSICAL, delta: -2 },
      { productId: 9, locationId: LEDGER, delta: 2 },
      { productId: 12, locationId: PHYSICAL, delta: -4 },
      { productId: 12, locationId: LEDGER, delta: 4 },
    ]);
  });

  it('the ctx rows ARE the applied deltas — same keys, same numbers, same order', async () => {
    const { tx } = makeTx({
      locked: [
        row({ id: 501, productId: 9, delta: -4 }),
        row({ id: 502, productId: 10, delta: -2 }),
      ],
    });
    const ctx = await run(tx);

    const applied = written(tx).map((data) => ({
      productId: data.productId,
      locationId: data.locationId,
      delta: data.delta,
    }));
    expect(applied).toEqual(ctx.rows);
  });
});

// ---------------------------------------------------------------------------
// The order and the record
// ---------------------------------------------------------------------------

describe('moveBatch — the statement ORDER (I-M1) and the record', () => {
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

  it('onRecord runs LAST, inside the same transaction, with the context returned', async () => {
    const { tx, trace } = makeTx({ locked: [row({ productId: 9, delta: -4 })] });
    let seen: MoveContext | null = null;
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
      movedBatchId: BATCH,
      batchId: NEW_BATCH,
      orderRecordId: null,
      ledgerLocationId: LEDGER,
      physicalLocationId: PHYSICAL,
      pairs: [{ productId: 9, units: 4, transferId: expect.stringMatching(UUID) }],
      rows: [
        { productId: 9, locationId: PHYSICAL, delta: -4 },
        { productId: 9, locationId: LEDGER, delta: 4 },
      ],
    });
  });

  it('NO attempt row is written — a move is not an attribution', async () => {
    const { tx } = makeTx({ locked: [row()] });
    await run(tx);
    expect(tx.orderAttributionAttempt.create).not.toHaveBeenCalled();
  });

  it('a refused move writes NOTHING (the tx aborts on the throw)', async () => {
    const { tx } = makeTx({ locked: [row({ locationId: null })] });
    await expect(run(tx)).rejects.toBeInstanceOf(NullLocationRowRefusal);
    expect(tx.inventory_logs.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
