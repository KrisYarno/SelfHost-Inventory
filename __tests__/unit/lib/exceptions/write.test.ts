// @jest-environment node
/**
 * W1-2c — the ONE exceptions writer (contract pack REV-3 T1, EXCEPTIONS block).
 *
 * `inventory_exceptions` is a LIVING register, not a log: one row per stable
 * key, seen again and again. So the whole module is three lifecycle rules, and
 * these tests are those rules:
 *
 *   1. UPSERT ON KEY   — first sighting inserts; every later sighting advances
 *      `lastSeenAt` and REFRESHES `subject` (the values ride along so a
 *      tolerance chosen at the checkpoint applies retroactively). `firstSeenAt`
 *      is never rewritten — it is the age the reconciliation surface sorts by.
 *   2. RECURRENCE REOPENS — a RESOLVED key that is seen again clears
 *      resolvedAt/resolvedBy and KEEPS the prior note, appending an
 *      audit-visible line. Somebody resolved this once; erasing what they wrote
 *      would erase the only record of why.
 *   3. RESOLVE IS IDEMPOTENT — resolving twice is not two resolutions, and
 *      resolving a key that was never raised is a no-op returning null (the
 *      auto-resolve caller fires on every matching count and must stay silent).
 *
 * Pure + tx-scoped: no route logic, no `prisma` import of its own. Every write
 * lands in the CALLER's transaction, which is what makes "the discrepancy row
 * and the count commit together" true.
 */

import {
  upsertException,
  resolveException,
  EXCEPTION_KEY_MAX_LENGTH,
} from '@/lib/exceptions/write';
import {
  EXCEPTION_KINDS,
  EXCEPTION_KIND_MAX_LENGTH,
  W1_EXCEPTION_KINDS,
  LABELING_LOSS_SEVERITY,
  RESOLUTIONS,
  recvDiscrepancyKey,
  pendingWithStockKey,
  costDiffersKey,
  labelingLossKey,
  type LabelingLossSubject,
  type RecvDiscrepancySubject,
  type Resolution,
} from '@/lib/exceptions/kinds';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const LATER = new Date('2026-08-14T09:30:00.000Z');
const KEY = 'recv-discrepancy:5';

function mkTx() {
  const tx: any = {
    /** The row the LOCKING read answers with (null = the key was never raised). */
    __existing: null,
    __raw: [] as { sql: string; values: unknown[] }[],
    $queryRaw: jest.fn(async (query: any) => {
      tx.__raw.push({ sql: String(query.sql), values: query.values });
      return tx.__existing ? [tx.__existing] : [];
    }),
    inventoryException: {
      // Kept ONLY so the pins below can prove the writer no longer uses it: the
      // prior read was a plain `findUnique`, which answers from the
      // transaction's snapshot rather than from the row it is about to write.
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      // Kept ONLY so the pins below can prove the writer no longer uses it
      // either (M7B-D1): `update({ where: { key } })` runs a PLAIN pre-SELECT
      // from the transaction's snapshot and cannot see a row a racing winner
      // committed while this transaction waited on a lock -> P2025.
      update: jest.fn(),
      // The write the writer DOES make: DML on the latest committed row. The
      // mock applies the data to the locked row so the writer's follow-up
      // locking read (the return value) hands back the new state, as MySQL does.
      updateMany: jest.fn(async ({ data }: any) => {
        if (!tx.__existing) return { count: 0 };
        tx.__existing = { ...tx.__existing, ...data };
        return { count: 1 };
      }),
    },
  };
  return tx;
}

/** Configure what the locking read finds. */
function setExisting(tx: any, existing: Record<string, unknown> | null) {
  tx.__existing = existing;
}

/** A stored row as the DB would hand it back. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    key: KEY,
    kind: 'recv-discrepancy',
    subject: { stagingItemId: 5, shipmentId: null, productId: null, expectedQty: 10, countedQty: 12 },
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    resolvedAt: null,
    resolvedBy: null,
    note: null,
    ...overrides,
  };
}

const SUBJECT = {
  stagingItemId: 5,
  shipmentId: null,
  productId: null,
  expectedQty: 10,
  countedQty: 12,
};

const createData = (tx: any) => tx.inventoryException.create.mock.calls[0][0].data;
const updateArgs = (tx: any) => tx.inventoryException.updateMany.mock.calls[0][0];

describe('upsertException — first sighting INSERTS', () => {
  it('creates the row with kind/key/subject and both timestamps at the caller instant', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: SUBJECT,
      now: NOW,
    });

    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
    expect(createData(tx)).toEqual({
      key: KEY,
      kind: 'recv-discrepancy',
      subject: SUBJECT,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      note: null,
    });
  });

  it('stores a supplied note as the note (no prior lines to preserve)', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: SUBJECT,
      note: 'first sighting',
      now: NOW,
    });

    expect(createData(tx).note).toBe('first sighting');
  });

  it('defaults `now` to the current instant when the caller has none', async () => {
    const tx = mkTx();
    setExisting(tx, null);
    const before = Date.now();

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT });

    const { firstSeenAt, lastSeenAt } = createData(tx);
    expect(firstSeenAt).toBeInstanceOf(Date);
    expect(firstSeenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(lastSeenAt).toBe(firstSeenAt);
  });

  it('keeps the SUBJECT VALUES, not just the ids (retroactive-tolerance rule)', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: { stagingItemId: 5, shipmentId: 'ckship1', productId: 42, expectedQty: 10, countedQty: 12 },
      now: NOW,
    });

    expect(createData(tx).subject).toEqual({
      stagingItemId: 5,
      shipmentId: 'ckship1',
      productId: 42,
      expectedQty: 10,
      countedQty: 12,
    });
  });
});

describe('upsertException — a known key UPDATES', () => {
  it('advances lastSeenAt and refreshes subject, never rewriting firstSeenAt', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: { ...SUBJECT, countedQty: 15 },
      now: LATER,
    });

    expect(tx.inventoryException.create).not.toHaveBeenCalled();
    const { where, data } = updateArgs(tx);
    expect(where).toEqual({ key: KEY });
    expect(data.lastSeenAt).toBe(LATER);
    expect(data.subject).toEqual({ ...SUBJECT, countedQty: 15 });
    expect(data).not.toHaveProperty('firstSeenAt');
  });

  it('leaves an UNRESOLVED row unresolved (no spurious resolve fields)', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const { data } = updateArgs(tx);
    expect(data).not.toHaveProperty('resolvedAt');
    expect(data).not.toHaveProperty('resolvedBy');
  });

  it('leaves the note untouched when the caller supplies none', async () => {
    const tx = mkTx();
    setExisting(tx, row({ note: 'counted twice, still short' }));

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    expect(updateArgs(tx).data).not.toHaveProperty('note');
  });

  it('APPENDS a new note line, preserving what was written before', async () => {
    const tx = mkTx();
    setExisting(tx, row({ note: 'supplier notified' }));

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: SUBJECT,
      note: 'still short on recount',
      now: LATER,
    });

    expect(updateArgs(tx).data.note).toBe('supplier notified\nstill short on recount');
  });

  it('does not repeat a note line that is already the last one', async () => {
    const tx = mkTx();
    setExisting(tx, row({ note: 'supplier notified' }));

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: SUBJECT,
      note: 'supplier notified',
      now: LATER,
    });

    expect(updateArgs(tx).data).not.toHaveProperty('note');
  });
});

describe('upsertException — recurrence REOPENS a resolved key', () => {
  it('clears resolvedAt AND resolvedBy', async () => {
    const tx = mkTx();
    setExisting(tx,
      row({ resolvedAt: NOW, resolvedBy: 7 }),
    );

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const { data } = updateArgs(tx);
    expect(data.resolvedAt).toBeNull();
    expect(data.resolvedBy).toBeNull();
    expect(data.lastSeenAt).toBe(LATER);
  });

  it('preserves the prior note and appends an audit-visible reopen line carrying the instant', async () => {
    const tx = mkTx();
    setExisting(tx,
      row({ resolvedAt: NOW, resolvedBy: 7, note: 'auto: recount matched' }),
    );

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const note = updateArgs(tx).data.note as string;
    const lines = note.split('\n');
    expect(lines[0]).toBe('auto: recount matched');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(LATER.toISOString());
    expect(lines[1]).toMatch(/reopen/i);
  });

  it('writes the reopen line even when the resolved row had no note at all', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, note: null }));

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const note = updateArgs(tx).data.note as string;
    expect(note.split('\n')).toHaveLength(1);
    expect(note).toMatch(/reopen/i);
  });

  it('orders reopen line BEFORE a caller note (what happened, then what was said)', async () => {
    const tx = mkTx();
    setExisting(tx,
      row({ resolvedAt: NOW, resolvedBy: 7, note: 'closed out by Kris' }),
    );

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: SUBJECT,
      note: 'short again',
      now: LATER,
    });

    const lines = (updateArgs(tx).data.note as string).split('\n');
    expect(lines[0]).toBe('closed out by Kris');
    expect(lines[1]).toMatch(/reopen/i);
    expect(lines[2]).toBe('short again');
  });
});

describe('upsertException — the guards that keep the register coherent', () => {
  it('REFUSES a key that does not encode its kind, writing nothing', async () => {
    const tx = mkTx();

    await expect(
      upsertException(tx, { kind: 'cost-differs', key: 'recv-discrepancy:5', subject: SUBJECT, now: NOW }),
    ).rejects.toThrow(/kind/i);

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.inventoryException.create).not.toHaveBeenCalled();
    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
  });

  it('REFUSES a key longer than the column, writing nothing (silent truncation would collide keys)', async () => {
    const tx = mkTx();
    const tooLong = `recv-discrepancy:${'9'.repeat(EXCEPTION_KEY_MAX_LENGTH)}`;

    await expect(
      upsertException(tx, { kind: 'recv-discrepancy', key: tooLong, subject: SUBJECT, now: NOW }),
    ).rejects.toThrow(/191/);

    expect(tx.inventoryException.create).not.toHaveBeenCalled();
  });

  it('accepts a key of exactly the column width', async () => {
    const tx = mkTx();
    setExisting(tx, null);
    const exact = 'recv-discrepancy:' + '9'.repeat(EXCEPTION_KEY_MAX_LENGTH - 'recv-discrepancy:'.length);
    expect(exact).toHaveLength(EXCEPTION_KEY_MAX_LENGTH);

    await upsertException(tx, { kind: 'recv-discrepancy', key: exact, subject: SUBJECT, now: NOW });

    expect(tx.inventoryException.create).toHaveBeenCalledTimes(1);
  });
});

describe('resolveException', () => {
  it('is a NO-OP returning null when the key was never raised', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await expect(resolveException(tx, { key: KEY, note: 'auto: recount matched' })).resolves.toBeNull();

    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryException.create).not.toHaveBeenCalled();
  });

  it('stamps resolvedAt + resolvedBy for a human resolution', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, { key: KEY, resolvedBy: 7, note: 'counted again with Kris', now: LATER });

    const { where, data } = updateArgs(tx);
    expect(where).toEqual({ key: KEY });
    expect(data.resolvedAt).toBe(LATER);
    expect(data.resolvedBy).toBe(7);
  });

  it('resolves with resolvedBy NULL when nobody is named (the auto-resolve shape)', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, { key: KEY, note: 'auto: recount matched', now: LATER });

    expect(updateArgs(tx).data.resolvedBy).toBeNull();
    expect(updateArgs(tx).data.note).toBe('auto: recount matched');
  });

  it('APPENDS its note, preserving what the row already carried', async () => {
    const tx = mkTx();
    setExisting(tx, row({ note: 'supplier notified' }));

    await resolveException(tx, { key: KEY, resolvedBy: 7, note: 'credit received', now: LATER });

    expect(updateArgs(tx).data.note).toBe('supplier notified\ncredit received');
  });

  it('does NOT advance lastSeenAt — resolving is not another sighting', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, { key: KEY, now: LATER });

    expect(updateArgs(tx).data).not.toHaveProperty('lastSeenAt');
  });

  it('is IDEMPOTENT: an already-resolved key is not re-resolved and is not rewritten', async () => {
    const tx = mkTx();
    const resolved = row({ resolvedAt: NOW, resolvedBy: 7, note: 'auto: recount matched' });
    setExisting(tx, resolved);

    await expect(
      resolveException(tx, { key: KEY, note: 'auto: recount matched', now: LATER }),
    ).resolves.toBe(resolved);

    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
  });
});

describe('the kind vocabulary + key encodings (pack REV-3 T1)', () => {
  it('is the CLOSED seven — W1 writes three, W3 declares three, the overhaul adds one', () => {
    expect([...EXCEPTION_KINDS]).toEqual([
      'recv-discrepancy',
      'pending-with-stock',
      'cost-differs',
      'unattributed-outstock',
      'unmapped-lines',
      'gap-order',
      // Receiving/Labeling overhaul (spec §6): units discarded at the labeling
      // bench. APPENDED, so no stored kind string changes meaning.
      'labeling-loss',
    ]);
    expect([...W1_EXCEPTION_KINDS]).toEqual([
      'recv-discrepancy',
      'pending-with-stock',
      'cost-differs',
    ]);
  });

  it('labeling-loss is NOT a W1 kind (no W1 path may raise it)', () => {
    expect([...W1_EXCEPTION_KINDS]).not.toContain('labeling-loss');
  });

  it('every kind fits the VarChar(32) column', () => {
    for (const kind of EXCEPTION_KINDS) {
      expect(kind.length).toBeLessThanOrEqual(EXCEPTION_KIND_MAX_LENGTH);
    }
  });

  it('encodes keys as <kind>:<subject id> at the grain each kind is raised', () => {
    expect(recvDiscrepancyKey(5)).toBe('recv-discrepancy:5');
    expect(pendingWithStockKey(42)).toBe('pending-with-stock:42');
    expect(costDiffersKey(5)).toBe('cost-differs:5');
    // Receiving/Labeling overhaul: one labeling loss per LINE, cumulative —
    // the same grain a discard settles.
    expect(labelingLossKey(5)).toBe('labeling-loss:5');
  });

  it('declares a severity for labeling-loss ONLY (the rest stay unfrozen)', () => {
    // PK-6: no exhaustive Record<ExceptionKind, Severity> exists yet and the six
    // W3 priorities are not frozen — inventing them here would freeze a
    // reconciliation-lane decision this lane has no business making.
    expect(LABELING_LOSS_SEVERITY).toBe('medium');
  });

  it('carries the CLOSED resolution vocabulary (spec §6 / D5)', () => {
    expect([...RESOLUTIONS]).toEqual([
      'supplier-credited',
      'reshipped',
      'accepted-loss',
      'recount-corrected',
      'surplus-kept',
      'surplus-returned',
      'additional-delivery',
    ]);
    // `Resolution` is the union of exactly those members.
    const resolution: Resolution = 'accepted-loss';
    expect(RESOLUTIONS).toContain(resolution);
  });

  it('types the labeling-loss subject at the LINE grain, money included', () => {
    // A type-level pin: the subject must carry the cumulative money, not just
    // ids, so the register can answer "how much did the bench lose" from the
    // row alone (the W1 rationale for values-ride-along).
    const subject: LabelingLossSubject = {
      stagingItemId: 5,
      shipmentId: 'ship_1',
      productId: 7,
      units: 3,
      unitCostCents: 3334,
      lossCents: 10001,
      reason: 'damaged in the labeler',
    };
    expect(subject.units).toBe(3);
    expect(subject.lossCents).toBe(10001);
  });

  it('widens recv-discrepancy into a SUPERSET (W1 readers unaffected)', () => {
    // The W1 five stay REQUIRED; everything the overhaul adds is optional, so a
    // row written before this lane still satisfies the type.
    const w1Only: RecvDiscrepancySubject = {
      stagingItemId: 5,
      shipmentId: null,
      productId: null,
      expectedQty: 10,
      countedQty: 12,
    };
    const overhaul: RecvDiscrepancySubject = {
      ...w1Only,
      orderedProductId: 7,
      orderedQuantity: 10,
      verifiedQuantity: 12,
      shortUnits: 0,
      overUnits: 2,
      unitCostCents: 1250,
      lossCents: 0,
      surplusValueCents: 2500,
      note: 'two extra arrived',
      relatedShipmentId: 'ship_2',
      creditRef: 'CR-9',
    };
    expect(w1Only.countedQty).toBe(12);
    expect(overhaul.overUnits).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Receiving/Labeling overhaul (contract pack C2b.3 / PK-11, spec §6; seams
// S6/S14). Two changes, and both are about a register that two transactions can
// reach at the same instant:
//
//   THE READ IS A LOCKING READ. `findUnique` answers from the transaction's
//   REPEATABLE READ snapshot, which is older than every lock the caller holds —
//   so a decline's resolve and a concurrent booking's raise could each decide
//   from a state the other had already replaced. `SELECT ... FOR UPDATE` on the
//   key serializes them ON THE ROW ITSELF, and the loser waits rather than
//   overwriting.
//
//   RESOLUTION IS A CLASSIFICATION, NOT THE SETTLEMENT INSTANT. `resolvedAt` /
//   `resolvedBy` stay at the FIRST settlement; a later, DIFFERENT `resolution`
//   re-labels the row and says so in the note. And every resolution refreshes
//   the subject's money through `subjectPatch`, because the register must be
//   able to answer "how much" from the row alone.
// ---------------------------------------------------------------------------

const LOCKING_READ =
  /^SELECT id, `key`, kind, subject, firstSeenAt, lastSeenAt, resolvedAt, resolvedBy, note, resolution FROM inventory_exceptions WHERE `key` = \? FOR UPDATE$/;

describe('the LOCKING read (PK-11)', () => {
  it('upsertException reads the row FOR UPDATE, by bound key', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: NOW });

    expect(tx.__raw).toHaveLength(1);
    expect(tx.__raw[0].sql).toMatch(LOCKING_READ);
    expect(tx.__raw[0].values).toEqual([KEY]);
  });

  it('resolveException reads the row FOR UPDATE, by bound key', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, { key: KEY, resolvedBy: 7, now: LATER });

    // Two locking reads: the one that decides, and the one that hands the
    // written row back (M7B-D1 — the return value is re-read under the lock,
    // never assembled from the update's own pre-select).
    expect(tx.__raw).toHaveLength(2);
    expect(tx.__raw[0].sql).toMatch(LOCKING_READ);
    expect(tx.__raw[0].values).toEqual([KEY]);
    expect(tx.__raw[1].sql).toMatch(LOCKING_READ);
  });

  it('M7B-D1: every write is DML on the latest committed row (updateMany), never `update` with its snapshot pre-select', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });
    await resolveException(tx, { key: KEY, resolvedBy: 7, now: LATER });
    await resolveException(tx, { key: KEY, resolvedBy: 7, resolution: 'reshipped', now: LATER });

    expect(tx.inventoryException.update).not.toHaveBeenCalled();
    expect(tx.inventoryException.updateMany).toHaveBeenCalledTimes(3);
    for (const call of tx.inventoryException.updateMany.mock.calls) {
      expect(call[0].where).toEqual({ key: KEY });
    }
  });

  it('M7B-D1: the returned row is the RE-READ state, and a vanished row is an INVARIANT', async () => {
    const tx = mkTx();
    setExisting(tx, row({ note: 'first' }));

    const written = await resolveException(tx, { key: KEY, resolvedBy: 7, note: 'settled', now: LATER });
    expect(written?.resolvedAt).toEqual(LATER);
    expect(written?.note).toContain('settled');

    // Simulate the impossible: the row disappears between the read and the write.
    tx.inventoryException.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER }),
    ).rejects.toMatchObject({ code: 'INVARIANT', statusCode: 500 });
  });

  it('NEITHER writer takes a plain snapshot read any more', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });
    await resolveException(tx, { key: KEY, resolvedBy: 7, now: LATER });

    expect(tx.inventoryException.findUnique).not.toHaveBeenCalled();
  });

  it('the raw statement only ACQUIRES and READS — the write is still the delegate', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: NOW });

    expect(tx.__raw[0].sql).toMatch(/^SELECT /);
    expect(tx.inventoryException.create).toHaveBeenCalledTimes(1);
  });
});

describe('resolveException — the RESOLUTION classification (spec §6 / D5)', () => {
  it('stamps the supplied resolution alongside resolvedAt/resolvedBy', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 7,
      resolution: 'supplier-credited',
      now: LATER,
    });

    const { data } = updateArgs(tx);
    expect(data.resolvedAt).toBe(LATER);
    expect(data.resolvedBy).toBe(7);
    expect(data.resolution).toBe('supplier-credited');
  });

  it('writes an EXPLICIT null resolution when the caller classified nothing', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, { key: KEY, resolvedBy: 7, now: LATER });

    expect(updateArgs(tx).data.resolution).toBeNull();
  });

  it('MERGES subjectPatch into the locked subject before settling (every resolution refreshes the money)', async () => {
    const tx = mkTx();
    setExisting(tx, row());

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 7,
      resolution: 'accepted-loss',
      subjectPatch: { lossCents: 2500, shortUnits: 2 },
      now: LATER,
    });

    expect(updateArgs(tx).data.subject).toEqual({
      // everything the row already carried survives...
      stagingItemId: 5,
      shipmentId: null,
      productId: null,
      expectedQty: 10,
      countedQty: 12,
      // ...and the patch refreshes what moved.
      lossCents: 2500,
      shortUnits: 2,
    });
  });

  it('applies a subjectPatch to an ALREADY-RESOLVED row without touching the settlement', async () => {
    const tx = mkTx();
    setExisting(
      tx,
      row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss', note: 'closed by Kris' }),
    );

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 9,
      resolution: 'accepted-loss',
      subjectPatch: { lossCents: 3000 },
      now: LATER,
    });

    const { data } = updateArgs(tx);
    expect(data.subject).toMatchObject({ lossCents: 3000, countedQty: 12 });
    expect(data).not.toHaveProperty('resolvedAt');
    expect(data).not.toHaveProperty('resolvedBy');
    expect(data).not.toHaveProperty('resolution');
    expect(data).not.toHaveProperty('note');
  });

  it('is settlement-idempotent: the SAME resolution again rewrites nothing at all', async () => {
    const tx = mkTx();
    const resolved = row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss' });
    setExisting(tx, resolved);

    await expect(
      resolveException(tx, { key: KEY, resolvedBy: 9, resolution: 'accepted-loss', now: LATER }),
    ).resolves.toBe(resolved);

    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
  });

  it('never ERASES a classification when a later call supplies none', async () => {
    const tx = mkTx();
    const resolved = row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'reshipped' });
    setExisting(tx, resolved);

    await resolveException(tx, { key: KEY, resolvedBy: 9, now: LATER });

    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
  });

  it('RE-LABELS a differing resolution, keeping the ORIGINAL settlement instant and actor', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss' }));

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 9,
      resolution: 'supplier-credited',
      now: LATER,
    });

    const { data } = updateArgs(tx);
    expect(data.resolution).toBe('supplier-credited');
    expect(data).not.toHaveProperty('resolvedAt');
    expect(data).not.toHaveProperty('resolvedBy');
    expect(data).not.toHaveProperty('lastSeenAt');
  });

  it('says so in the note: "<old> -> <new>"', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss', note: 'closed by Kris' }));

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 9,
      resolution: 'supplier-credited',
      now: LATER,
    });

    const lines = (updateArgs(tx).data.note as string).split('\n');
    expect(lines[0]).toBe('closed by Kris');
    expect(lines[1]).toBe('resolution relabeled: accepted-loss -> supplier-credited');
  });

  it('names an UNCLASSIFIED prior resolution rather than pretending there was one', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, resolvedBy: 7, resolution: null }));

    await resolveException(tx, { key: KEY, resolvedBy: 9, resolution: 'reshipped', now: LATER });

    expect(updateArgs(tx).data.note).toBe('resolution relabeled: unclassified -> reshipped');
  });

  it('appends the CALLER\'s note after the relabel line (what happened, then what was said)', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss' }));

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 9,
      resolution: 'reshipped',
      note: 'box 2 landed today',
      now: LATER,
    });

    const lines = (updateArgs(tx).data.note as string).split('\n');
    expect(lines[0]).toBe('resolution relabeled: accepted-loss -> reshipped');
    expect(lines[1]).toBe('box 2 landed today');
  });

  it('refreshes the subject on a relabel too', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss' }));

    await resolveException(tx, {
      key: KEY,
      resolvedBy: 9,
      resolution: 'reshipped',
      subjectPatch: { lossCents: 0, relatedShipmentId: 'ord_2' },
      now: LATER,
    });

    expect(updateArgs(tx).data.subject).toMatchObject({
      countedQty: 12,
      lossCents: 0,
      relatedShipmentId: 'ord_2',
    });
  });

  it('stays a NO-OP for a key nobody ever raised, subjectPatch or not', async () => {
    const tx = mkTx();
    setExisting(tx, null);

    await expect(
      resolveException(tx, { key: KEY, resolution: 'accepted-loss', subjectPatch: { lossCents: 1 } }),
    ).resolves.toBeNull();

    expect(tx.inventoryException.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryException.create).not.toHaveBeenCalled();
  });
});

describe('upsertException — a reopen clears the CLASSIFICATION too', () => {
  it('clears resolution alongside resolvedAt/resolvedBy', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolvedAt: NOW, resolvedBy: 7, resolution: 'accepted-loss' }));

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const { data } = updateArgs(tx);
    expect(data.resolvedAt).toBeNull();
    expect(data.resolvedBy).toBeNull();
    expect(data.resolution).toBeNull();
  });

  it('leaves the classification alone when the row was never resolved', async () => {
    const tx = mkTx();
    setExisting(tx, row({ resolution: null }));

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    expect(updateArgs(tx).data).not.toHaveProperty('resolution');
  });
});
