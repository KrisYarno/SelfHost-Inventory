/**
 * lib/stock-threshold.ts — the single home for low-stock threshold semantics
 * (Lane 3 spec §3 D10 as amended by §10 R-L13).
 *
 * Inheritance model (locked): `NULL = inherit system default / 0 = disabled /
 * >0 = explicit override`. The comparison is unified INCLUSIVE across every
 * surface: a product is low on stock iff `0 < quantity <= effectiveThreshold`
 * (an `effectiveThreshold <= 0` disables the alert entirely).
 *
 * Every low-stock consumer routes through these helpers; the trunk enforcement
 * gate (`__tests__/integration/lane3-low-stock-gate.test.ts`) fails any file
 * that computes low stock with a literal instead.
 */

import prisma from '@/lib/prisma';

/** Seeded system default when the `lowStockDefaultThreshold` setting is unset. */
export const LOW_STOCK_DEFAULT_FALLBACK = 10;

const LOW_STOCK_DEFAULT_SETTING_KEY = 'lowStockDefaultThreshold';

/**
 * Read the configurable system-wide default low-stock threshold from
 * `SystemSetting['lowStockDefaultThreshold']`. Falls back to
 * `LOW_STOCK_DEFAULT_FALLBACK` (10) when the row is missing or its value is not
 * a non-negative integer. 0 is a valid default (disables alerts for every
 * product that inherits it).
 */
export async function getLowStockDefault(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: LOW_STOCK_DEFAULT_SETTING_KEY },
    select: { value: true },
  });
  if (!row) return LOW_STOCK_DEFAULT_FALLBACK;

  // Strict: a malformed setting must not silently degrade (e.g. parseInt would
  // read "1.5foo" as 1). Only a clean non-negative integer is honored.
  const trimmed = row.value.trim();
  if (!/^\d+$/.test(trimmed)) return LOW_STOCK_DEFAULT_FALLBACK;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : LOW_STOCK_DEFAULT_FALLBACK;
}

/**
 * Resolve a product's effective threshold under the inheritance model:
 *   - null / undefined -> the system default (inherit)
 *   - 0                -> 0 (disabled, preserved distinctly from inherit)
 *   - n               -> n (explicit override)
 */
export function effectiveLowStockThreshold(
  productThreshold: number | null | undefined,
  systemDefault: number,
): number {
  return productThreshold === null || productThreshold === undefined
    ? systemDefault
    : productThreshold;
}

/**
 * The one shared low-stock predicate (INCLUSIVE). An effective threshold of 0
 * (or negative) disables the alert; otherwise a product is low iff it has some
 * stock AND is at-or-below its threshold. Out-of-stock (`quantity <= 0`) is a
 * distinct state and is NOT low stock.
 */
export function isLowStock(quantity: number, effectiveThreshold: number): boolean {
  if (effectiveThreshold <= 0) return false;
  return quantity > 0 && quantity <= effectiveThreshold;
}

/** Facelift F2-2: a product's stock state, judged on its all-locations total. */
export type StockState = 'ok' | 'low' | 'out' | 'below-zero' | 'no-record';

/**
 * Facelift F2-2: the ONLY place the five stock states are decided. The products
 * route computes it from each product's total; every UI reads it from the
 * response and never recomputes it.
 *   - null  -> 'no-record' (the product has NO stock row; structural, never 0)
 *   - < 0   -> 'below-zero'
 *   - 0     -> 'out'
 *   - low under `isLowStock` (INCLUSIVE; a threshold <= 0 disables) -> 'low'
 *   - otherwise 'ok'
 */
export function stockState(total: number | null, effectiveThreshold: number): StockState {
  if (total === null) return 'no-record';
  if (total < 0) return 'below-zero';
  if (total === 0) return 'out';
  if (isLowStock(total, effectiveThreshold)) return 'low';
  return 'ok';
}
