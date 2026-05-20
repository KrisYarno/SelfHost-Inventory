// Centralized WPC bundle type detection. New plugin variants can be added
// here without touching the catalog fetcher.
export const KNOWN_BUNDLE_TYPES = Object.freeze([
  'woosb',
  'wpc_smart_bundle',
] as const);

export type BundleType = (typeof KNOWN_BUNDLE_TYPES)[number];

export function isBundleType(type: string | null | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  return (KNOWN_BUNDLE_TYPES as readonly string[]).includes(normalized);
}
