// @jest-environment node
//
// Reconciliation lane R-B (spec REV-7 D6, pack C2a.3) — THE PII SOURCE.
//
// This module is where the reconciliation surface's projection rules live, and
// it exists so there is exactly ONE list to widen by mistake. Three pins:
//
//   * the NINE forbidden names, exactly — with `note` deliberately NOT among
//     them (CX-6): the Exceptions finder RETURNS the admin-only
//     InventoryException.note, and a generic forbidden-name set would fail every
//     row it produces. The toolsuite gate keeps its own independent literal and
//     asserts this set is a SUPERSET of it (M5a), so narrowing here can never
//     quietly weaken that gate. `variantName` is Part 2's addition (pack CA1.4):
//     the order-items read the matcher stands on projects the item row, and the
//     per-customer variant string is the one PII-shaped column on it;
//   * the two selects, deep-frozen — a select is an allowlist, and an allowlist
//     that can be widened at runtime is a suggestion;
//   * assertNoPiiKeys, which is what the route-response harness (M2a-2) runs
//     over every envelope this lane serves.
import {
  RECONCILIATION_ORDER_SELECT,
  RECONCILIATION_PII_FIELD_NAMES,
  RECONCILIATION_USER_SELECT,
  assertNoPiiKeys,
  deepFreeze,
} from '@/lib/reconciliation/pii';

describe('RECONCILIATION_PII_FIELD_NAMES', () => {
  it('is exactly the nine names', () => {
    expect(Array.from(RECONCILIATION_PII_FIELD_NAMES).sort()).toEqual([
      'billingAddress',
      'customerEmail',
      'customerName',
      'customerPhone',
      'externalOrderUrl',
      'platformStatusRaw',
      'rawPayload',
      'shippingAddress',
      'variantName',
    ]);
  });

  it('does NOT contain `note` or `customerNote` (CX-6 — the finder returns the admin note)', () => {
    expect(RECONCILIATION_PII_FIELD_NAMES.has('note')).toBe(false);
    expect(RECONCILIATION_PII_FIELD_NAMES.has('customerNote')).toBe(false);
  });

  it('is a superset of the five names the toolsuite gate pins independently', () => {
    // The M5a gate keeps its own literal; this assertion is the same claim from
    // the other side, so neither list can drift below the other.
    for (const name of [
      'customerName',
      'customerEmail',
      'rawPayload',
      'platformStatusRaw',
      'externalOrderUrl',
    ]) {
      expect(RECONCILIATION_PII_FIELD_NAMES.has(name)).toBe(true);
    }
  });
});

describe('deepFreeze — EXPORTED for the Part 2 item select (pack CA1.4, seam S-A7)', () => {
  it('freezes recursively and returns the same object', () => {
    const o = { a: true, nested: { b: { c: true } } };
    expect(deepFreeze(o)).toBe(o);
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o.nested)).toBe(true);
    expect(Object.isFrozen(o.nested.b)).toBe(true);
  });

  it('is what makes a select an allowlist rather than a suggestion', () => {
    'use strict';
    const select = deepFreeze({ id: true, nested: { select: { productId: true } } });
    expect(() => {
      (select as unknown as Record<string, boolean>).customerEmail = true;
    }).toThrow();
  });
});

describe('the frozen selects', () => {
  it('RECONCILIATION_ORDER_SELECT is the literal D6 spells out', () => {
    expect(RECONCILIATION_ORDER_SELECT).toEqual({
      id: true,
      orderNumber: true,
      internalStatus: true,
      externalCreatedAt: true,
      companyId: true,
      integration: { select: { platform: true } },
    });
  });

  it('RECONCILIATION_USER_SELECT is { id, username } — no email, no role', () => {
    expect(RECONCILIATION_USER_SELECT).toEqual({ id: true, username: true });
  });

  it('both selects are DEEP-frozen (the nested integration select too)', () => {
    expect(Object.isFrozen(RECONCILIATION_ORDER_SELECT)).toBe(true);
    expect(Object.isFrozen(RECONCILIATION_ORDER_SELECT.integration)).toBe(true);
    expect(Object.isFrozen(RECONCILIATION_ORDER_SELECT.integration.select)).toBe(true);
    expect(Object.isFrozen(RECONCILIATION_USER_SELECT)).toBe(true);
  });

  it('a stray widening throws instead of silently selecting PII', () => {
    expect(() => {
      (RECONCILIATION_ORDER_SELECT as unknown as Record<string, unknown>).customerEmail = true;
    }).toThrow();
    expect(() => {
      (
        RECONCILIATION_ORDER_SELECT.integration.select as unknown as Record<string, unknown>
      ).apiKey = true;
    }).toThrow();
  });

  it('the order select names no forbidden field', () => {
    for (const key of Object.keys(RECONCILIATION_ORDER_SELECT)) {
      expect(RECONCILIATION_PII_FIELD_NAMES.has(key)).toBe(false);
    }
  });
});

describe('assertNoPiiKeys', () => {
  it('passes on a clean nested envelope', () => {
    expect(() =>
      assertNoPiiKeys({
        window: { from: '2026-08-01', to: '2026-08-14' },
        rows: [
          {
            batchId: 'b1',
            order: { id: 'o1', orderNumber: '23716', platform: 'woocommerce' },
            how: { classKey: 'attributed·fulfillment', sentence: 'fulfilled' },
          },
        ],
        coverage: { notes: ['none'], recordingSince: null },
      })
    ).not.toThrow();
  });

  it('throws naming the PATH of a customerEmail nested three levels deep', () => {
    let message = '';
    try {
      assertNoPiiKeys({ rows: [{ order: { customerEmail: 'a@b.test' } }] });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('customerEmail');
    expect(message).toContain('rows[0].order.customerEmail');
  });

  it('names the FIRST offending path, and every forbidden name is caught', () => {
    for (const name of Array.from(RECONCILIATION_PII_FIELD_NAMES)) {
      expect(() => assertNoPiiKeys({ payload: { [name]: 'x' } })).toThrow(
        new RegExp(`payload\\.${name}`)
      );
    }
  });

  it('ignores `note` — the admin-only exception field the finder must return', () => {
    expect(() =>
      assertNoPiiKeys({ rows: [{ kind: 'recv-discrepancy', note: 'counted twice, credited' }] })
    ).not.toThrow();
  });

  it('walks arrays of arrays and tolerates primitives, null and Date', () => {
    expect(() =>
      assertNoPiiKeys({ a: [[{ b: 1 }]], c: null, d: 'x', e: 2, f: new Date(0), g: undefined })
    ).not.toThrow();
    expect(() => assertNoPiiKeys(null)).not.toThrow();
    expect(() => assertNoPiiKeys('a string')).not.toThrow();
  });

  it('accepts a caller-supplied root path so the harness can say WHICH response', () => {
    expect(() =>
      assertNoPiiKeys({ customerName: 'x' }, 'GET /api/reconciliation/attribution')
    ).toThrow(/GET \/api\/reconciliation\/attribution\.customerName/);
  });
});
