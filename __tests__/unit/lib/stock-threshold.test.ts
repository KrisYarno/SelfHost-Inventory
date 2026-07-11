/**
 * @jest-environment node
 *
 * Unit tests for `lib/stock-threshold.ts` (Lane 3 R-L13 semantics).
 * Inheritance: NULL = inherit / 0 = disabled / >0 = override; INCLUSIVE compare.
 */

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
