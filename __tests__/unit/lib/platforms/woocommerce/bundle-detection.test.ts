// @jest-environment node
import { isBundleType, KNOWN_BUNDLE_TYPES } from '@/lib/platforms/woocommerce/bundle-detection';

describe('isBundleType', () => {
  it.each([
    ['woosb', true],
    ['wpc_smart_bundle', true],
    ['simple', false],
    ['variable', false],
    ['', false],
    ['Woosb', true], // case-insensitive
    ['WPC_SMART_BUNDLE', true], // case-insensitive
  ])('isBundleType(%s) → %s', (input, expected) => {
    expect(isBundleType(input)).toBe(expected);
  });

  it('returns false for null/undefined', () => {
    expect(isBundleType(null as unknown as string)).toBe(false);
    expect(isBundleType(undefined as unknown as string)).toBe(false);
  });

  it('exports KNOWN_BUNDLE_TYPES as a frozen array', () => {
    expect(KNOWN_BUNDLE_TYPES).toContain('woosb');
    expect(() => (KNOWN_BUNDLE_TYPES as unknown as string[]).push('new')).toThrow();
  });
});
