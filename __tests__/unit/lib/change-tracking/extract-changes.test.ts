/**
 * @jest-environment node
 *
 * Unit tests for `lib/change-tracking/extract-changes.ts` (Lane 3 R-L7 adapter).
 * Covers every known historical `details` shape + malformed inputs.
 */

import { extractChanges } from '@/lib/change-tracking/extract-changes';

describe('extractChanges — known historical shapes', () => {
  it('foundation shape: details.changes alongside actor envelope', () => {
    const details = {
      changes: {
        name: { from: 'Old', to: 'New' },
        quantity: { from: 3, to: 5 },
      },
      actor: { kind: 'USER' },
    };
    expect(extractChanges(details)).toEqual({
      name: { from: 'Old', to: 'New' },
      quantity: { from: 3, to: 5 },
    });
  });

  it('pre-foundation product-update shape: { productName, changes }', () => {
    const details = {
      productName: 'Widget',
      changes: {
        variant: { from: null, to: '500mg' },
        lowStockThreshold: { from: 10, to: 25 },
      },
    };
    expect(extractChanges(details)).toEqual({
      variant: { from: null, to: '500mg' },
      lowStockThreshold: { from: 10, to: 25 },
    });
  });

  it('preserves [REDACTED] values verbatim (they are the truthful value)', () => {
    const details = { changes: { passwordHash: { from: '[REDACTED]', to: '[REDACTED]' } } };
    expect(extractChanges(details)).toEqual({
      passwordHash: { from: '[REDACTED]', to: '[REDACTED]' },
    });
  });

  it('preserves null from/to (a real absent-before value)', () => {
    const details = { changes: { unit: { from: null, to: 'mg' } } };
    expect(extractChanges(details)).toEqual({ unit: { from: null, to: 'mg' } });
  });

  it('drops entries that are not a {from,to} pair but keeps the valid ones', () => {
    const details = {
      changes: {
        name: { from: 'a', to: 'b' },
        broken: 'not-a-pair',
        halfPair: { from: 1 }, // missing `to`
        nested: [1, 2, 3],
      },
    };
    expect(extractChanges(details)).toEqual({ name: { from: 'a', to: 'b' } });
  });
});

describe('extractChanges — absent / malformed -> null', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'PRODUCT_UPDATE'],
    ['a number', 42],
    ['an array', [{ from: 1, to: 2 }]],
    ['no changes key', { productName: 'Widget' }],
    ['changes is a string', { changes: 'nope' }],
    ['changes is an array', { changes: [{ from: 1, to: 2 }] }],
    ['changes is empty', { changes: {} }],
    ['changes has only invalid entries', { changes: { a: 'x', b: 5 } }],
  ])('%s -> null', (_label, input) => {
    expect(extractChanges(input as unknown)).toBeNull();
  });

  it('never throws on adversarial input', () => {
    const circular: Record<string, unknown> = { changes: {} };
    circular.self = circular;
    expect(() => extractChanges(circular)).not.toThrow();
    expect(extractChanges(circular)).toBeNull();
  });
});
