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
  return {
    inventoryException: {
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
    },
  } as any;
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
const updateArgs = (tx: any) => tx.inventoryException.update.mock.calls[0][0];

describe('upsertException — first sighting INSERTS', () => {
  it('creates the row with kind/key/subject and both timestamps at the caller instant', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(null);

    await upsertException(tx, {
      kind: 'recv-discrepancy',
      key: KEY,
      subject: SUBJECT,
      now: NOW,
    });

    expect(tx.inventoryException.update).not.toHaveBeenCalled();
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
    tx.inventoryException.findUnique.mockResolvedValue(null);

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
    tx.inventoryException.findUnique.mockResolvedValue(null);
    const before = Date.now();

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT });

    const { firstSeenAt, lastSeenAt } = createData(tx);
    expect(firstSeenAt).toBeInstanceOf(Date);
    expect(firstSeenAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(lastSeenAt).toBe(firstSeenAt);
  });

  it('keeps the SUBJECT VALUES, not just the ids (retroactive-tolerance rule)', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(null);

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
    tx.inventoryException.findUnique.mockResolvedValue(row());

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
    tx.inventoryException.findUnique.mockResolvedValue(row());

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const { data } = updateArgs(tx);
    expect(data).not.toHaveProperty('resolvedAt');
    expect(data).not.toHaveProperty('resolvedBy');
  });

  it('leaves the note untouched when the caller supplies none', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(row({ note: 'counted twice, still short' }));

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    expect(updateArgs(tx).data).not.toHaveProperty('note');
  });

  it('APPENDS a new note line, preserving what was written before', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(row({ note: 'supplier notified' }));

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
    tx.inventoryException.findUnique.mockResolvedValue(row({ note: 'supplier notified' }));

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
    tx.inventoryException.findUnique.mockResolvedValue(
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
    tx.inventoryException.findUnique.mockResolvedValue(
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
    tx.inventoryException.findUnique.mockResolvedValue(row({ resolvedAt: NOW, note: null }));

    await upsertException(tx, { kind: 'recv-discrepancy', key: KEY, subject: SUBJECT, now: LATER });

    const note = updateArgs(tx).data.note as string;
    expect(note.split('\n')).toHaveLength(1);
    expect(note).toMatch(/reopen/i);
  });

  it('orders reopen line BEFORE a caller note (what happened, then what was said)', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(
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

    expect(tx.inventoryException.findUnique).not.toHaveBeenCalled();
    expect(tx.inventoryException.create).not.toHaveBeenCalled();
    expect(tx.inventoryException.update).not.toHaveBeenCalled();
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
    tx.inventoryException.findUnique.mockResolvedValue(null);
    const exact = 'recv-discrepancy:' + '9'.repeat(EXCEPTION_KEY_MAX_LENGTH - 'recv-discrepancy:'.length);
    expect(exact).toHaveLength(EXCEPTION_KEY_MAX_LENGTH);

    await upsertException(tx, { kind: 'recv-discrepancy', key: exact, subject: SUBJECT, now: NOW });

    expect(tx.inventoryException.create).toHaveBeenCalledTimes(1);
  });
});

describe('resolveException', () => {
  it('is a NO-OP returning null when the key was never raised', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(null);

    await expect(resolveException(tx, { key: KEY, note: 'auto: recount matched' })).resolves.toBeNull();

    expect(tx.inventoryException.update).not.toHaveBeenCalled();
    expect(tx.inventoryException.create).not.toHaveBeenCalled();
  });

  it('stamps resolvedAt + resolvedBy for a human resolution', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(row());

    await resolveException(tx, { key: KEY, resolvedBy: 7, note: 'counted again with Kris', now: LATER });

    const { where, data } = updateArgs(tx);
    expect(where).toEqual({ key: KEY });
    expect(data.resolvedAt).toBe(LATER);
    expect(data.resolvedBy).toBe(7);
  });

  it('resolves with resolvedBy NULL when nobody is named (the auto-resolve shape)', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(row());

    await resolveException(tx, { key: KEY, note: 'auto: recount matched', now: LATER });

    expect(updateArgs(tx).data.resolvedBy).toBeNull();
    expect(updateArgs(tx).data.note).toBe('auto: recount matched');
  });

  it('APPENDS its note, preserving what the row already carried', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(row({ note: 'supplier notified' }));

    await resolveException(tx, { key: KEY, resolvedBy: 7, note: 'credit received', now: LATER });

    expect(updateArgs(tx).data.note).toBe('supplier notified\ncredit received');
  });

  it('does NOT advance lastSeenAt — resolving is not another sighting', async () => {
    const tx = mkTx();
    tx.inventoryException.findUnique.mockResolvedValue(row());

    await resolveException(tx, { key: KEY, now: LATER });

    expect(updateArgs(tx).data).not.toHaveProperty('lastSeenAt');
  });

  it('is IDEMPOTENT: an already-resolved key is not re-resolved and is not rewritten', async () => {
    const tx = mkTx();
    const resolved = row({ resolvedAt: NOW, resolvedBy: 7, note: 'auto: recount matched' });
    tx.inventoryException.findUnique.mockResolvedValue(resolved);

    await expect(
      resolveException(tx, { key: KEY, note: 'auto: recount matched', now: LATER }),
    ).resolves.toBe(resolved);

    expect(tx.inventoryException.update).not.toHaveBeenCalled();
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
