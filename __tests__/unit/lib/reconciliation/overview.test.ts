/**
 * @jest-environment node
 *
 * THE OVERVIEW COUNTS (reconciliation lane, pack C2c.3; spec REV-7 D11).
 *
 * Two numbers for the ops-health panel and nothing else: how many exception
 * rows are open, and how many deductions in the last fortnight NAMED an order
 * and did not end up attributed to one. It is COUNT-ONLY by contract — it never
 * runs the derivation, never classifies, and never grows a third figure quietly
 * — because this line is polled every 60 seconds on a page nobody is reading.
 *
 * The no-derive rule is pinned as a SOURCE SCAN rather than a mock assertion: a
 * mock only proves the code path this fixture took, and the rule is about the
 * module, not the path.
 */

import { Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

import prisma from '@/lib/prisma';
import { getReconciliationOverview } from '@/lib/reconciliation/overview';

const db = prisma as unknown as DeepMockProxy<PrismaClient>;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const MODULE_PATH = path.join(process.cwd(), 'lib/reconciliation/overview.ts');

beforeEach(() => {
  mockReset(db);
  (db.inventoryException.count as unknown as jest.Mock).mockResolvedValue(4);
  (db.$queryRaw as unknown as jest.Mock).mockResolvedValue([{ n: 2 }]);
});

function statement(): Prisma.Sql {
  return (db.$queryRaw as unknown as jest.Mock).mock.calls[0][0] as Prisma.Sql;
}

describe('getReconciliationOverview', () => {
  it('answers the two counts and the instant they were taken', async () => {
    await expect(getReconciliationOverview(NOW)).resolves.toEqual({
      openExceptions: 4,
      unmatchedIntended14d: 2,
      asOf: '2026-08-20T12:00:00.000Z',
    });
  });

  it('takes EXACTLY two statements', async () => {
    await getReconciliationOverview(NOW);
    expect(db.inventoryException.count).toHaveBeenCalledTimes(1);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    // Nothing else: no ledger findMany, no audit read, no user lookup.
    expect(db.inventory_logs.findMany).not.toHaveBeenCalled();
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.orderAttributionAttempt.findFirst).not.toHaveBeenCalled();
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('counts the OPEN half of the register through the exceptions producer', async () => {
    await getReconciliationOverview(NOW);
    expect((db.inventoryException.count as unknown as jest.Mock).mock.calls[0][0]).toEqual({
      where: { resolvedAt: null },
    });
  });

  it('windows the last 14 days on the batch time axis', async () => {
    await getReconciliationOverview(NOW);
    const sql = statement();
    expect(sql.sql).toContain('HAVING MIN(l.changeTime) >= ? AND MIN(l.changeTime) < ?');
    expect(sql.values).toContainEqual(new Date(NOW.getTime() - 14 * DAY));
    expect(sql.values).toContainEqual(NOW);
  });

  it('reads the population through the ONE predicate renderer (R-3)', async () => {
    await getReconciliationOverview(NOW);
    const sql = statement();
    expect(sql.sql).toContain('l.logType IN (?,?)');
    expect(sql.sql).toContain('l.delta < 0');
    expect(sql.sql).toContain('l.batchId IS NOT NULL');
    expect(sql.values).toContainEqual('SALE');
    expect(sql.values).toContainEqual('ADJUSTMENT');
  });

  it('counts only batches whose rows carry NO stamp', async () => {
    await getReconciliationOverview(NOW);
    expect(statement().sql).toContain('MAX(l.orderRecordId IS NOT NULL) = 0');
  });

  it("reads the batch's EARLIEST audit event, by id", async () => {
    await getReconciliationOverview(NOW);
    expect(statement().sql).toContain(
      'SELECT a2.id FROM audit_logs a2 WHERE a2.batchId = b.batchId ORDER BY a2.id ASC LIMIT 1',
    );
  });

  it('applies R4 BEFORE R5, so the workbench "Other" tap never counts', async () => {
    await getReconciliationOverview(NOW);
    const sql = statement().sql;
    // R4: a stated non-order intent disqualifies the batch outright...
    expect(sql).toContain("NOT IN ('other','damage-loss')");
    // ...and only then does a typed reference (R5) make it count.
    expect(sql).toContain("= 'order'");
    expect(sql).toContain('orderReference');
    expect(sql.indexOf("NOT IN ('other','damage-loss')")).toBeLessThan(
      sql.indexOf('orderReference'),
    );
  });

  it('defaults `now` to the wall clock when the caller does not pass one', async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const result = await getReconciliationOverview();
    jest.useRealTimers();
    expect(result.asOf).toBe('2026-08-20T12:00:00.000Z');
  });

  it('an empty answer is 0, not a crash', async () => {
    (db.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);
    await expect(getReconciliationOverview(NOW)).resolves.toMatchObject({
      unmatchedIntended14d: 0,
    });
  });
});

describe('the module never derives (pack C2c.3)', () => {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');

  it('does not import the derivation', () => {
    expect(source).not.toMatch(/from\s+['"][^'"]*derive['"]/);
    expect(source).not.toContain('deriveHistoricalAttempt');
  });

  it('does not name the exceptions delegate either — the producer owns it', () => {
    // The ops-health GET segment reaches this module, and the exceptions write
    // boundary fails any GET that mentions the delegate.
    expect(source).not.toContain('inventoryException');
  });
});
