/**
 * THE SHARED PREAMBLE (reconciliation Part 2, pack CB2a.1; spec §2.5 / §2.7(4)).
 *
 * `lockAttributableBatch` is the ONE spelling of "lock this batch's rows and
 * read what the ledger says about it", which the manual-attribution core, the
 * reverse, the move and the attributable correction all run before their own
 * ladders. Two things are pinned here and nowhere else:
 *
 *   THE REFUSAL ORDER — NOT_ATTRIBUTABLE -> TOO_MANY_ROWS -> MIXED_STAMPS, the
 *   ladder the attribution core has always had. A consumer that inherited a
 *   different order would answer a different sentence for the same batch.
 *
 *   THE STATEMENT ORDER — the row lock FIRST (so the transaction's read view
 *   opens after it and postdates every committed restoration), the evidence read
 *   second, the three refusals next, and the attempt read LAST, so a 5000-row
 *   batch refused at the bound never pays for it.
 *
 * Plus the SOURCE pins that keep the extraction honest: one locking statement
 * under `lib/`, one spelling of the attempt ordering beyond the report's own,
 * one spelling of the fulfilment fact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { mockDeep } from 'jest-mock-extended';
import type { Prisma } from '@prisma/client';

import {
  lockAttributableBatch,
  partiallyStamped,
  type LockedBatchRow,
} from '@/lib/reconciliation/lock-attributable-batch';
import { batchEvidence, fulfillmentFact } from '@/lib/reconciliation/population';
import {
  MANUAL_ATTRIBUTION_ROW_LIMIT,
  MixedStampsRefusal,
  NotAttributableRefusal,
  TooManyRowsRefusal,
} from '@/lib/reconciliation/refusals';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const BATCH = 'ledger-batch-1';

type AuditRow = {
  id: number;
  actionType: string;
  entityId: string | null;
  details: Record<string, unknown> | null;
};

const DEDUCT_EVENT: AuditRow = {
  id: 3,
  actionType: 'INVENTORY_DEDUCT',
  entityId: '9',
  details: { intent: 'order' },
};

function row(over: Partial<LockedBatchRow> = {}): LockedBatchRow {
  return {
    id: 501,
    productId: 9,
    locationId: 3,
    delta: -2,
    userId: 4,
    logType: 'SALE',
    orderRecordId: null,
    ...over,
  };
}

function makeTx(fixture: {
  locked?: LockedBatchRow[];
  auditEvents?: AuditRow[];
  latestAttempt?: { evidence: string | null } | null;
}) {
  const tx = mockDeep<Prisma.TransactionClient>();
  (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async () => fixture.locked ?? [row()]);
  (tx.auditLog.findMany as unknown as jest.Mock).mockImplementation(
    async () => fixture.auditEvents ?? [DEDUCT_EVENT],
  );
  (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mockImplementation(
    async () => fixture.latestAttempt ?? null,
  );
  return tx;
}

describe('lockAttributableBatch — the statement it issues', () => {
  it('locks the population rows FOR UPDATE in id order, with the widened column list', async () => {
    const tx = makeTx({});
    await lockAttributableBatch(tx, BATCH);

    const query = (tx.$queryRaw as unknown as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    expect(query.sql).toContain(
      'SELECT l.id, l.productId, l.locationId, l.delta, l.userId, l.logType, l.orderRecordId',
    );
    expect(query.sql).toContain('FROM inventory_logs l WHERE l.batchId = ?');
    expect(query.sql).toContain('ORDER BY l.id FOR UPDATE');
    // The population predicate, rendered — never re-spelled here.
    expect(query.sql).toContain('l.logType IN (?,?)');
    expect(query.sql).toContain('l.delta < 0');
    expect(query.sql).toContain('l.batchId IS NOT NULL');
    expect(query.values).toEqual([BATCH, 'SALE', 'ADJUSTMENT']);
  });

  it('reads the evidence under the LEDGER batch id, id-ascending', async () => {
    const tx = makeTx({});
    await lockAttributableBatch(tx, BATCH);

    expect(tx.auditLog.findMany).toHaveBeenCalledWith({
      where: { batchId: BATCH },
      orderBy: { id: 'asc' },
      select: { id: true, actionType: true, entityId: true, details: true },
    });
  });

  it('reads the LATEST attempt by attemptedAt then id, both descending, evidence only', async () => {
    const tx = makeTx({});
    await lockAttributableBatch(tx, BATCH);

    // Never `orderBy: { id: 'desc' }`: that filesorts AND can pick a different
    // row than the drill-down and the report's join.
    expect(tx.orderAttributionAttempt.findFirst).toHaveBeenCalledWith({
      where: { batchId: BATCH },
      orderBy: [{ attemptedAt: 'desc' }, { id: 'desc' }],
      select: { evidence: true },
    });
  });

  it('THE ORDER PIN: lock, then evidence, then the attempt — the read view opens after the lock', async () => {
    const tx = makeTx({});
    await lockAttributableBatch(tx, BATCH);

    const lock = (tx.$queryRaw as unknown as jest.Mock).mock.invocationCallOrder[0];
    const evidence = (tx.auditLog.findMany as unknown as jest.Mock).mock.invocationCallOrder[0];
    const attempt = (tx.orderAttributionAttempt.findFirst as unknown as jest.Mock).mock
      .invocationCallOrder[0];
    expect(lock).toBeLessThan(evidence);
    expect(evidence).toBeLessThan(attempt);
  });
});

describe('lockAttributableBatch — the frozen refusal ladder', () => {
  it('1. NOT_ATTRIBUTABLE on an empty population, BEFORE the evidence read', async () => {
    const tx = makeTx({ locked: [] });
    await expect(lockAttributableBatch(tx, BATCH)).rejects.toBeInstanceOf(NotAttributableRefusal);
    expect(tx.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('2. NOT_ATTRIBUTABLE on R0 — a pre-0b-1 mass-update session', async () => {
    const tx = makeTx({
      locked: [row({ logType: 'ADJUSTMENT' })],
      auditEvents: [
        { id: 1, actionType: 'INVENTORY_BULK_UPDATE', entityId: null, details: { rows: 40 } },
      ],
    });
    await expect(lockAttributableBatch(tx, BATCH)).rejects.toBeInstanceOf(NotAttributableRefusal);
    expect(tx.orderAttributionAttempt.findFirst).not.toHaveBeenCalled();
  });

  it('3. TOO_MANY_ROWS one past the bound, naming both figures — and no attempt read', async () => {
    const locked = Array.from({ length: MANUAL_ATTRIBUTION_ROW_LIMIT + 1 }, (_, i) =>
      row({ id: 500 + i, productId: 9 + (i % 3) }),
    );
    const tx = makeTx({ locked });

    await expect(lockAttributableBatch(tx, BATCH)).rejects.toBeInstanceOf(TooManyRowsRefusal);
    await expect(lockAttributableBatch(tx, BATCH)).rejects.toMatchObject({
      code: 'TOO_MANY_ROWS',
      rowCount: MANUAL_ATTRIBUTION_ROW_LIMIT + 1,
      productCount: 3,
      limit: MANUAL_ATTRIBUTION_ROW_LIMIT,
    });
    // The bound refuses BEFORE the attempt read — a 5000-row batch never pays it.
    expect(tx.orderAttributionAttempt.findFirst).not.toHaveBeenCalled();
  });

  it('3. exactly the bound is accepted', async () => {
    const locked = Array.from({ length: MANUAL_ATTRIBUTION_ROW_LIMIT }, (_, i) =>
      row({ id: 500 + i }),
    );
    const result = await lockAttributableBatch(makeTx({ locked }), BATCH);
    expect(result.rows).toHaveLength(MANUAL_ATTRIBUTION_ROW_LIMIT);
  });

  it('4. MIXED_STAMPS on two distinct non-null ids, which ride out', async () => {
    const tx = makeTx({
      locked: [row({ id: 501, orderRecordId: 'ord-1' }), row({ id: 502, orderRecordId: 'ord-2' })],
    });
    await expect(lockAttributableBatch(tx, BATCH)).rejects.toBeInstanceOf(MixedStampsRefusal);
    await expect(
      lockAttributableBatch(makeTx({ locked: [row({ orderRecordId: 'ord-1' })] }), BATCH),
    ).resolves.toMatchObject({ stamps: ['ord-1'], current: 'ord-1' });
  });

  it('the refusals precede the attempt read, all three of them', async () => {
    for (const locked of [
      [] as LockedBatchRow[],
      Array.from({ length: MANUAL_ATTRIBUTION_ROW_LIMIT + 1 }, (_, i) => row({ id: 500 + i })),
      [row({ id: 501, orderRecordId: 'a' }), row({ id: 502, orderRecordId: 'b' })],
    ]) {
      const tx = makeTx({ locked });
      await expect(lockAttributableBatch(tx, BATCH)).rejects.toBeDefined();
      expect(tx.orderAttributionAttempt.findFirst).not.toHaveBeenCalled();
    }
  });
});

describe('lockAttributableBatch — what it returns', () => {
  it('carries the widened row, the stamp facts, the evidence, the counts and the first row id', async () => {
    const locked = [
      row({ id: 501, productId: 9, locationId: 3, delta: -2, userId: 4 }),
      row({ id: 502, productId: 10, locationId: 3, delta: -5, userId: 4 }),
    ];
    const result = await lockAttributableBatch(makeTx({ locked }), BATCH);

    expect(result.rows).toEqual(locked);
    expect(result.stamps).toEqual([]);
    expect(result.current).toBeNull();
    expect(result.firstRowId).toBe(501);
    expect(result.productCount).toBe(2);
    expect(result.evidence.attributable).toBe(true);
    expect(result.evidence.fulfillmentEvent).toBeNull();
    expect(result.fulfilled).toBe(false);
  });

  it('never exposes the attempt row — the fulfilment fact is the only thing it becomes', async () => {
    const result = await lockAttributableBatch(
      makeTx({ latestAttempt: { evidence: 'fulfillment' } }),
      BATCH,
    );
    expect(result.fulfilled).toBe(true);
    expect(Object.keys(result).sort()).toEqual([
      'current',
      'evidence',
      'firstRowId',
      'fulfilled',
      'productCount',
      'rows',
      'stamps',
    ]);
  });

  it('reads the fulfilment fact off the EVENT even with no attempt row', async () => {
    const result = await lockAttributableBatch(
      makeTx({
        auditEvents: [
          { id: 4, actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityId: 'ord-9', details: {} },
        ],
        latestAttempt: null,
      }),
      BATCH,
    );
    expect(result.fulfilled).toBe(true);
    expect(result.evidence.fulfillmentOrderId).toBe('ord-9');
  });
});

describe('partiallyStamped — the truth table', () => {
  const stamped = { orderRecordId: 'ord-1' };
  const unstamped = { orderRecordId: null };

  it('one stamp and at least one null row -> both counts', () => {
    expect(partiallyStamped([stamped, unstamped, unstamped], ['ord-1'])).toEqual({
      stamped: 1,
      unstamped: 2,
    });
  });

  it('one stamp and NO null rows -> null (a uniformly stamped batch)', () => {
    expect(partiallyStamped([stamped, stamped], ['ord-1'])).toBeNull();
  });

  it('NO stamps -> null (a uniformly unstamped batch, however many rows)', () => {
    expect(partiallyStamped([unstamped, unstamped], [])).toBeNull();
  });

  it('MORE than one stamp -> null: that batch is MIXED_STAMPS, not partly stamped', () => {
    expect(partiallyStamped([stamped, unstamped], ['ord-1', 'ord-2'])).toBeNull();
  });

  it('an empty row set -> null', () => {
    expect(partiallyStamped([], [])).toBeNull();
  });
});

describe('fulfillmentFact — the truth table', () => {
  const noEvent = batchEvidence([DEDUCT_EVENT], [{ logType: 'SALE' }]);
  const withEvent = batchEvidence(
    [{ actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityId: 'ord-9', details: {} }],
    [{ logType: 'SALE' }],
  );

  it('the EVENT alone is enough', () => {
    expect(fulfillmentFact(withEvent, null)).toBe(true);
    expect(fulfillmentFact(withEvent, { evidence: 'manual' })).toBe(true);
  });

  it("the LATEST attempt's evidence alone is enough", () => {
    expect(fulfillmentFact(noEvent, { evidence: 'fulfillment' })).toBe(true);
  });

  it('neither -> false, for every shape of "no attempt"', () => {
    expect(fulfillmentFact(noEvent, null)).toBe(false);
    expect(fulfillmentFact(noEvent, undefined)).toBe(false);
    expect(fulfillmentFact(noEvent, { evidence: null })).toBe(false);
    expect(fulfillmentFact(noEvent, { evidence: 'manual' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SOURCE PINS — the extraction is only real if the old copies are GONE
// ---------------------------------------------------------------------------

function libFilesContaining(needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) return;
      if (fs.readFileSync(full, 'utf8').includes(needle)) {
        hits.push(path.relative(REPO_ROOT, full));
      }
    });
  };
  walk(path.join(REPO_ROOT, 'lib'));
  return hits.sort();
}

describe('source pins (pack CB2a.1)', () => {
  it('exactly ONE file under lib/ carries the batch-row locking SELECT', () => {
    expect(libFilesContaining('SELECT l.id, l.productId')).toEqual([
      'lib/reconciliation/lock-attributable-batch.ts',
    ]);
  });

  it('the manual-attribution core carries no locking statement of its own', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'lib/reconciliation/attribute-batch.ts'),
      'utf8',
    );
    expect(source).not.toContain('FOR UPDATE');
    expect(source).not.toContain('attemptedAt');
  });

  it("exactly TWO files under lib/ spell the attempt ordering (the helper and the report)", () => {
    expect(libFilesContaining("attemptedAt: 'desc'")).toEqual([
      'lib/reconciliation/attribution.ts',
      'lib/reconciliation/lock-attributable-batch.ts',
    ]);
  });

  it('the fulfilment predicate has ONE spelling under lib/', () => {
    expect(libFilesContaining("=== 'fulfillment'")).toEqual(['lib/reconciliation/population.ts']);
  });

  it('the helper names neither the attempt writer nor the core it was extracted from', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'lib/reconciliation/lock-attributable-batch.ts'),
      'utf8',
    );
    expect(source).not.toContain('lib/attribution/attempts');
    expect(source).not.toContain('attribute-batch');
  });
});
