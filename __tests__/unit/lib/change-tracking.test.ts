/**
 * @jest-environment node
 *
 * Unit tests for `lib/change-tracking.ts` — the transactional change-capture core
 * that replaces the fire-and-forget `lib/audit.ts` write path.
 *
 * Structure mirrors the plan's task boundaries:
 *   Task 2 — pure core: newBatchId / normalizeEntityId / redactDeep / diff + the
 *            COMPANY_SCOPED_ENTITY_TYPES / REDACTED_KEYS constants.
 *   Task 3 — recordChange (hard-abort, joins the caller's tx).
 *   Task 4 — recordIngestion (best-effort, never throws).
 *
 * This repo does NOT use a real test DB. Prisma is mocked with jest-mock-extended
 * and `next/headers` is a manual mock (same harness idiom as
 * inventory.transaction.test.ts + the staging/scratchpad route suites).
 */

import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { Prisma } from '@prisma/client';

jest.mock('@/lib/prisma', () => {
  const { mockDeep: md } = require('jest-mock-extended');
  return { __esModule: true, default: md() };
});

const mockHeaders = jest.fn();
jest.mock('next/headers', () => ({
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

import prisma from '@/lib/prisma';
import {
  newBatchId,
  normalizeEntityId,
  redactDeep,
  diff,
  recordChange,
  recordIngestion,
  COMPANY_SCOPED_ENTITY_TYPES,
  REDACTED_KEYS,
  type ChangeEvent,
} from '@/lib/change-tracking';

const mockPrisma = prisma as unknown as DeepMockProxy<typeof prisma>;

const HEADER_VALUES: Record<string, string> = {
  'x-forwarded-for': '203.0.113.5, 10.0.0.1',
  'x-real-ip': '203.0.113.9',
  'user-agent': 'jest-agent/1.0',
};

function makeHeaderStore(values: Record<string, string> = HEADER_VALUES) {
  return { get: (name: string) => values[name] ?? null };
}

/** Stand-in for a non-plain Decimal-like value (matches Prisma.Decimal shape). */
class FakeDecimal {
  constructor(private readonly v: string) {}
  toString(): string {
    return this.v;
  }
}

// ---------------------------------------------------------------------------
// Task 2 — pure core
// ---------------------------------------------------------------------------

describe('change-tracking: constants', () => {
  it('REDACTED_KEYS covers the Global-Constraints denylist', () => {
    for (const key of [
      'passwordHash',
      'encryptedApiKey',
      'encryptedApiSecret',
      'webhookSecret',
      'apiKey',
      'apiSecret',
      'password',
      'newPassword',
      'currentPassword',
    ]) {
      expect(REDACTED_KEYS).toContain(key);
    }
  });

  it('COMPANY_SCOPED_ENTITY_TYPES is exactly {COMPANY, INTEGRATION, MAPPING, ORDER}', () => {
    expect(COMPANY_SCOPED_ENTITY_TYPES.has('COMPANY')).toBe(true);
    expect(COMPANY_SCOPED_ENTITY_TYPES.has('INTEGRATION')).toBe(true);
    expect(COMPANY_SCOPED_ENTITY_TYPES.has('MAPPING')).toBe(true);
    expect(COMPANY_SCOPED_ENTITY_TYPES.has('ORDER')).toBe(true);
    expect(COMPANY_SCOPED_ENTITY_TYPES.has('USER')).toBe(false);
    expect(COMPANY_SCOPED_ENTITY_TYPES.has('PRODUCT')).toBe(false);
    expect(COMPANY_SCOPED_ENTITY_TYPES.size).toBe(4);
  });
});

describe('change-tracking: newBatchId', () => {
  it('returns a uuid-v4-shaped string', () => {
    expect(newBatchId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('returns a distinct value on each call', () => {
    expect(newBatchId()).not.toBe(newBatchId());
  });
});

describe('change-tracking: normalizeEntityId', () => {
  it('stringifies a numeric id', () => {
    expect(normalizeEntityId(42)).toBe('42');
    expect(normalizeEntityId(0)).toBe('0');
  });

  it('passes a cuid / numeric string through', () => {
    expect(normalizeEntityId('clh1abcd0000xyz')).toBe('clh1abcd0000xyz');
    expect(normalizeEntityId('42')).toBe('42');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEntityId('  abc  ')).toBe('abc');
  });

  it('treats null and undefined as absent (-> null)', () => {
    expect(normalizeEntityId(null)).toBeNull();
    expect(normalizeEntityId(undefined)).toBeNull();
  });

  it('throws on empty / whitespace-only string', () => {
    expect(() => normalizeEntityId('')).toThrow();
    expect(() => normalizeEntityId('   ')).toThrow();
  });

  it('throws on NaN / non-finite numbers', () => {
    expect(() => normalizeEntityId(NaN)).toThrow();
    expect(() => normalizeEntityId(Infinity)).toThrow();
    expect(() => normalizeEntityId(-Infinity)).toThrow();
  });
});

describe('change-tracking: redactDeep', () => {
  it('redacts every denylist key case-insensitively at the top level', () => {
    const out = redactDeep({
      password: 'hunter2',
      PasswordHash: 'abc',
      apiKey: 'k',
      username: 'kris',
    });
    expect(out.password).toBe('[REDACTED]');
    expect(out.PasswordHash).toBe('[REDACTED]');
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.username).toBe('kris');
  });

  it('redacts denylist keys nested in objects-in-arrays-in-objects', () => {
    const out: any = redactDeep({
      integrations: [
        { name: 'shopify', encryptedApiSecret: 's3cr3t', enabled: true },
        { name: 'ebay', webhookSecret: 'wh', nested: { apiSecret: 'x' } },
      ],
    });
    expect(out.integrations[0].encryptedApiSecret).toBe('[REDACTED]');
    expect(out.integrations[0].name).toBe('shopify');
    expect(out.integrations[1].webhookSecret).toBe('[REDACTED]');
    expect(out.integrations[1].nested.apiSecret).toBe('[REDACTED]');
  });

  it('does not mutate its input', () => {
    const input = { password: 'p', keep: 'v' };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactDeep(input);
    expect(input).toEqual(snapshot);
  });

  it('does not traverse into Dates (leaves them intact)', () => {
    const d = new Date('2026-07-09T00:00:00.000Z');
    const out = redactDeep({ when: d, password: 'p' });
    expect(out.when).toBe(d);
    expect(out.password).toBe('[REDACTED]');
  });
});

describe('change-tracking: diff', () => {
  it('returns only the changed fields, dropping unchanged ones', () => {
    const before = { name: 'A', qty: 1, sku: 'S1' };
    const after = { name: 'B', qty: 1, sku: 'S2' };
    expect(diff(before, after, ['name', 'qty', 'sku'])).toEqual({
      name: { from: 'A', to: 'B' },
      sku: { from: 'S1', to: 'S2' },
    });
  });

  it('records null -> value and value -> null transitions', () => {
    const before = { a: null as number | null, b: 5 as number | null };
    const after = { a: 7 as number | null, b: null as number | null };
    expect(diff(before, after, ['a', 'b'])).toEqual({
      a: { from: null, to: 7 },
      b: { from: 5, to: null },
    });
  });

  it('treats null<->undefined as no change (both absent)', () => {
    const before = { a: null as unknown };
    const after = { a: undefined as unknown };
    expect(diff(before as Record<string, unknown>, after as Record<string, unknown>, ['a'])).toEqual({});
  });

  it('compares Decimal-like values via String() (equal -> no change)', () => {
    // A Decimal-like is a NON-plain object (class instance, e.g. Prisma.Decimal).
    const before = { price: new FakeDecimal('1.50') };
    const after = { price: new FakeDecimal('1.50') };
    expect(diff(before, after, ['price'])).toEqual({});
  });

  it('compares Decimal-like values via String() (differ -> change with string from/to)', () => {
    const before = { price: new FakeDecimal('1.50') };
    const after = { price: new FakeDecimal('2.00') };
    expect(diff(before, after, ['price'])).toEqual({
      price: { from: '1.50', to: '2.00' },
    });
  });

  it('compares Dates via String()', () => {
    const d1 = new Date('2026-07-09T00:00:00.000Z');
    const d1again = new Date('2026-07-09T00:00:00.000Z');
    const d2 = new Date('2026-07-10T00:00:00.000Z');
    expect(diff({ at: d1 }, { at: d1again }, ['at'])).toEqual({});
    const changed = diff({ at: d1 }, { at: d2 }, ['at']);
    expect(changed.at.from).toBe(String(d1));
    expect(changed.at.to).toBe(String(d2));
  });

  it('redacts a changed denylisted field to [REDACTED]/[REDACTED]', () => {
    const before = { passwordHash: 'old', username: 'kris' };
    const after = { passwordHash: 'new', username: 'kris2' };
    expect(diff(before, after, ['passwordHash', 'username'])).toEqual({
      passwordHash: { from: '[REDACTED]', to: '[REDACTED]' },
      username: { from: 'kris', to: 'kris2' },
    });
  });

  it('does not emit an unchanged denylisted field', () => {
    const before = { passwordHash: 'same', name: 'A' };
    const after = { passwordHash: 'same', name: 'B' };
    expect(diff(before, after, ['passwordHash', 'name'])).toEqual({
      name: { from: 'A', to: 'B' },
    });
  });
});

// ---------------------------------------------------------------------------
// Task 3 — recordChange (hard-abort, joins the caller's tx)
// ---------------------------------------------------------------------------

describe('change-tracking: recordChange', () => {
  let createMock: jest.Mock;
  let mockTx: Prisma.TransactionClient;

  beforeEach(() => {
    mockReset(mockPrisma);
    createMock = jest.fn().mockResolvedValue({ id: 1 });
    mockTx = { auditLog: { create: createMock } } as unknown as Prisma.TransactionClient;
    mockHeaders.mockReset();
    mockHeaders.mockResolvedValue(makeHeaderStore());
  });

  const lastData = () => createMock.mock.calls[0][0].data;

  it('writes on the SAME tx passed in (not the singleton prisma)', async () => {
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: 42,
      action: 'Updated product',
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('USER actor: records userId + actorKind "USER" and normalizes entityId to string', async () => {
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: 42,
      action: 'Updated product 42',
    });
    const data = lastData();
    expect(data.userId).toBe(7);
    expect(data.actorKind).toBe('USER');
    expect(data.entityId).toBe('42');
    expect(typeof data.entityId).toBe('string');
    expect(data.actionType).toBe('PRODUCT_UPDATE');
    expect(data.entityType).toBe('PRODUCT');
    expect(data.affectedCount).toBe(1);
  });

  it('machine actor: userId null, actorKind from kind, envelope redacted under details.actor', async () => {
    await recordChange(mockTx, {
      actor: {
        kind: 'WEBHOOK',
        envelope: { source: 'shopify', apiKey: 'sk_live_xyz' },
      },
      actionType: 'EXTERNAL_ORDER_FULFILLMENT',
      entityType: 'ORDER',
      entityId: 'ord_abc',
      companyId: 'cmp_1',
      action: 'Order fulfilled via webhook',
    });
    const data = lastData();
    expect(data.userId).toBeNull();
    expect(data.actorKind).toBe('WEBHOOK');
    expect(data.details.actor).toEqual({ source: 'shopify', apiKey: '[REDACTED]' });
  });

  it('carries the diff verbatim under details.changes', async () => {
    const changes = { name: { from: 'A', to: 'B' } };
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: 42,
      action: 'Updated product',
      changes,
    });
    expect(lastData().details.changes).toEqual(changes);
  });

  it('deep-redacts denylisted keys inside details', async () => {
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'INTEGRATION_UPDATE',
      entityType: 'INTEGRATION',
      entityId: 'int_1',
      companyId: 'cmp_1',
      action: 'Updated integration',
      details: { name: 'shopify', encryptedApiSecret: 'raw-secret' },
    });
    const data = lastData();
    expect(data.details.name).toBe('shopify');
    expect(data.details.encryptedApiSecret).toBe('[REDACTED]');
  });

  it('passes batchId through verbatim', async () => {
    const batchId = newBatchId();
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'INVENTORY_TRANSFER',
      entityType: 'INVENTORY',
      entityId: 42,
      action: 'Transfer',
      batchId,
    });
    expect(lastData().batchId).toBe(batchId);
  });

  it('captures ipAddress + userAgent from headers()', async () => {
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'PRODUCT_UPDATE',
      entityType: 'PRODUCT',
      entityId: 42,
      action: 'Updated product',
    });
    const data = lastData();
    expect(data.ipAddress).toBe('203.0.113.5');
    expect(data.userAgent).toBe('jest-agent/1.0');
  });

  it('tolerates headers() throwing (SYSTEM caller outside a request)', async () => {
    mockHeaders.mockRejectedValue(new Error('headers() outside request scope'));
    await expect(
      recordChange(mockTx, {
        actor: { kind: 'SYSTEM' },
        actionType: 'SYSTEM_MAINTENANCE',
        entityType: 'SYSTEM',
        action: 'Cron ran',
      }),
    ).resolves.toBeUndefined();
    const data = lastData();
    expect(data.ipAddress).toBeUndefined();
    expect(data.userAgent).toBeUndefined();
    expect(data.actorKind).toBe('SYSTEM');
  });

  it('PROPAGATES a create rejection (hard-abort — no swallow)', async () => {
    createMock.mockRejectedValue(new Error('db down'));
    await expect(
      recordChange(mockTx, {
        actor: { userId: 7 },
        actionType: 'PRODUCT_UPDATE',
        entityType: 'PRODUCT',
        entityId: 42,
        action: 'Updated product',
      }),
    ).rejects.toThrow('db down');
  });

  it('company-scoped entityType without companyId THROWS in non-production', async () => {
    // Jest runs with NODE_ENV=test (!== production) -> throw path.
    await expect(
      recordChange(mockTx, {
        actor: { userId: 7 },
        actionType: 'COMPANY_UPDATE',
        entityType: 'COMPANY',
        entityId: 'cmp_1',
        action: 'Updated company',
      }),
    ).rejects.toThrow(/companyId/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('company-scoped entityType WITH companyId records it', async () => {
    await recordChange(mockTx, {
      actor: { userId: 7 },
      actionType: 'COMPANY_UPDATE',
      entityType: 'COMPANY',
      entityId: 'cmp_1',
      companyId: 'cmp_1',
      action: 'Updated company',
    });
    expect(lastData().companyId).toBe('cmp_1');
  });

  it('in production, missing companyId records null + console.error (no throw)', async () => {
    const prev = process.env.NODE_ENV;
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // @ts-expect-error - NODE_ENV is readonly in the type but writable at runtime
      process.env.NODE_ENV = 'production';
      await recordChange(mockTx, {
        actor: { userId: 7 },
        actionType: 'COMPANY_UPDATE',
        entityType: 'COMPANY',
        entityId: 'cmp_1',
        action: 'Updated company',
      });
      expect(lastData().companyId).toBeNull();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      // @ts-expect-error - restore
      process.env.NODE_ENV = prev;
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4 — recordIngestion (best-effort, never throws)
// ---------------------------------------------------------------------------

describe('change-tracking: recordIngestion', () => {
  let errSpy: jest.SpyInstance;

  const webhookEvent: ChangeEvent = {
    actor: { kind: 'WEBHOOK', envelope: { source: 'shopify' } },
    actionType: 'EXTERNAL_ORDER_FULFILLMENT',
    entityType: 'ORDER',
    entityId: 'ord_1',
    companyId: 'cmp_1',
    action: 'Order fulfilled via webhook',
  };

  beforeEach(() => {
    mockReset(mockPrisma);
    mockHeaders.mockReset();
    mockHeaders.mockRejectedValue(new Error('no request scope')); // machine path
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('writes via the singleton prisma (own tx) and returns true on success', async () => {
    (mockPrisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 1 });
    const ok = await recordIngestion(webhookEvent);
    expect(ok).toBe(true);
    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const data = (mockPrisma.auditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(data.actorKind).toBe('WEBHOOK');
    expect(data.userId).toBeNull();
    expect(data.entityId).toBe('ord_1');
  });

  it('never throws on create failure: returns false, logs, invokes onFailure', async () => {
    const boom = new Error('db down');
    (mockPrisma.auditLog.create as jest.Mock).mockRejectedValue(boom);
    const onFailure = jest.fn();

    let ok: boolean | undefined;
    await expect(
      (async () => {
        ok = await recordIngestion(webhookEvent, { onFailure });
      })(),
    ).resolves.toBeUndefined();

    expect(ok).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(boom);
    expect(errSpy).toHaveBeenCalled();
  });

  it('swallows an onFailure callback that itself throws (still returns false, no throw)', async () => {
    (mockPrisma.auditLog.create as jest.Mock).mockRejectedValue(new Error('db down'));
    const onFailure = jest.fn().mockRejectedValue(new Error('health counter exploded'));

    let ok: boolean | undefined;
    await expect(
      (async () => {
        ok = await recordIngestion(webhookEvent, { onFailure });
      })(),
    ).resolves.toBeUndefined();

    expect(ok).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('returns true with no onFailure provided', async () => {
    (mockPrisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 2 });
    await expect(recordIngestion(webhookEvent)).resolves.toBe(true);
  });

  it('awaits an async onFailure before resolving', async () => {
    (mockPrisma.auditLog.create as jest.Mock).mockRejectedValue(new Error('db down'));
    const order: string[] = [];
    const onFailure = jest.fn(async () => {
      await Promise.resolve();
      order.push('onFailure-done');
    });
    const ok = await recordIngestion(webhookEvent, { onFailure });
    order.push('returned');
    expect(ok).toBe(false);
    expect(order).toEqual(['onFailure-done', 'returned']);
  });
});
