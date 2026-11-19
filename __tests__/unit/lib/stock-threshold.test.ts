/**
 * @jest-environment node
 *
 * Unit tests for `lib/stock-threshold.ts` (Lane 3 R-L13 semantics).
 * Inheritance: NULL = inherit / 0 = disabled / >0 = override; INCLUSIVE compare.
 */

import fs from 'fs';
import path from 'path';

jest.mock('@/lib/prisma', () => ({
  __esModule: true,
  default: { systemSetting: { findUnique: jest.fn() } },
}));

import prisma from '@/lib/prisma';
import {
  LOW_STOCK_DEFAULT_FALLBACK,
  getLowStockDefault,
  effectiveLowStockThreshold,
  isLowStock,
  stockState,
  type StockState,
} from '@/lib/stock-threshold';

const m = prisma as unknown as { systemSetting: { findUnique: jest.Mock } };

beforeEach(() => jest.clearAllMocks());

describe('effectiveLowStockThreshold (inheritance model)', () => {
  it('null / undefined inherit the system default', () => {
    expect(effectiveLowStockThreshold(null, 10)).toBe(10);
    expect(effectiveLowStockThreshold(undefined, 15)).toBe(15);
  });

  it('0 stays 0 (disabled) — distinct from inherit', () => {
    expect(effectiveLowStockThreshold(0, 10)).toBe(0);
    expect(effectiveLowStockThreshold(0, 15)).toBe(0);
  });

  it('a positive override is returned as-is', () => {
    expect(effectiveLowStockThreshold(5, 10)).toBe(5);
    expect(effectiveLowStockThreshold(25, 10)).toBe(25);
  });
});

describe('isLowStock (INCLUSIVE, 0 = disabled)', () => {
  it('effectiveThreshold 0 (or negative) is disabled: false at ANY quantity', () => {
    for (const qty of [0, 1, 5, 100, 9999]) {
      expect(isLowStock(qty, 0)).toBe(false);
      expect(isLowStock(qty, -3)).toBe(false);
    }
  });

  it('boundary: quantity === threshold is LOW (inclusive)', () => {
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(1, 1)).toBe(true);
  });

  it('quantity below threshold is low; above is not', () => {
    expect(isLowStock(5, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
  });

  it('quantity 0 is out-of-stock, NOT low stock', () => {
    expect(isLowStock(0, 10)).toBe(false);
    expect(isLowStock(-2, 10)).toBe(false);
  });
});

describe('getLowStockDefault (SystemSetting lowStockDefaultThreshold)', () => {
  it('returns the parsed setting value', async () => {
    m.systemSetting.findUnique.mockResolvedValue({ value: '15' });
    await expect(getLowStockDefault()).resolves.toBe(15);
    const arg = m.systemSetting.findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ key: 'lowStockDefaultThreshold' });
  });

  it('0 is a valid default (disables inheriting products)', async () => {
    m.systemSetting.findUnique.mockResolvedValue({ value: '0' });
    await expect(getLowStockDefault()).resolves.toBe(0);
  });

  it('falls back to 10 when the row is missing', async () => {
    m.systemSetting.findUnique.mockResolvedValue(null);
    await expect(getLowStockDefault()).resolves.toBe(LOW_STOCK_DEFAULT_FALLBACK);
    expect(LOW_STOCK_DEFAULT_FALLBACK).toBe(10);
  });

  it('falls back to 10 when the value is not a non-negative integer', async () => {
    for (const bad of ['abc', '', '-5', '1.5foo']) {
      m.systemSetting.findUnique.mockResolvedValue({ value: bad });
      await expect(getLowStockDefault()).resolves.toBe(10);
    }
  });
});

// Facelift F2-2: the ONE place the five stock states are decided, on a product's
// all-locations total (null = no stock row at all).
describe('stockState (facelift F2-2)', () => {
  it('null -> no-record (no stock row), at any threshold', () => {
    expect(stockState(null, 10)).toBe('no-record');
    expect(stockState(null, 0)).toBe('no-record');
    expect(stockState(null, -1)).toBe('no-record');
  });

  it('a negative total -> below-zero, at any threshold', () => {
    expect(stockState(-1, 10)).toBe('below-zero');
    expect(stockState(-40, 0)).toBe('below-zero');
    expect(stockState(-3, -5)).toBe('below-zero');
  });

  it('0 -> out (a 0 row is not "no record"), at any threshold', () => {
    expect(stockState(0, 10)).toBe('out');
    expect(stockState(0, 0)).toBe('out');
    expect(stockState(0, -5)).toBe('out');
  });

  it('low is INCLUSIVE under isLowStock: 1..threshold is low, above is ok', () => {
    expect(stockState(1, 10)).toBe('low');
    expect(stockState(10, 10)).toBe('low');
    expect(stockState(11, 10)).toBe('ok');
    expect(stockState(1, 1)).toBe('low');
    expect(stockState(2, 1)).toBe('ok');
  });

  it('a threshold of 0 (disabled) is never low: any positive total is ok', () => {
    for (const total of [1, 5, 10, 9999]) expect(stockState(total, 0)).toBe('ok');
  });

  it('a negative threshold is disabled too: any positive total is ok', () => {
    for (const total of [1, 5, 10, 9999]) expect(stockState(total, -3)).toBe('ok');
  });

  it('an inherited threshold reads through effectiveLowStockThreshold', () => {
    expect(stockState(8, effectiveLowStockThreshold(null, 10))).toBe('low');
    expect(stockState(8, effectiveLowStockThreshold(0, 10))).toBe('ok');
    expect(stockState(8, effectiveLowStockThreshold(5, 10))).toBe('ok');
  });

  it('answers exactly the five states', () => {
    const seen = new Set<StockState>([
      stockState(null, 10),
      stockState(-1, 10),
      stockState(0, 10),
      stockState(5, 10),
      stockState(50, 10),
    ]);
    expect(Array.from(seen).sort()).toEqual(['below-zero', 'low', 'no-record', 'ok', 'out']);
  });
});

// Facelift F2 A17: the helper's module reads prisma, so the shared product type
// reaches it TYPE-ONLY — nothing of it may land in a client bundle through
// `types/product.ts` (or the hook that re-uses that type).
describe('A17 — StockState reaches the shared types type-only', () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
  const importsOfHelper = (src: string) =>
    src.split('\n').filter((line) => /from\s*['"]@\/lib\/stock-threshold['"]/.test(line));

  it('types/product.ts: `import type { StockState }` and no value import', () => {
    const lines = importsOfHelper(read('types/product.ts'));
    expect(lines).toEqual(['import type { StockState } from "@/lib/stock-threshold";']);
    expect(read('types/product.ts')).toMatch(/stockState\?: StockState;/);
  });

  it('hooks/use-products.ts does not value-import the helper', () => {
    for (const line of importsOfHelper(read('hooks/use-products.ts'))) {
      expect(line).toMatch(/^import type /);
    }
  });
});
