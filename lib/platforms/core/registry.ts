/**
 * Platform adapter registry
 * Factory pattern to get the correct adapter for a given platform
 */

import type { PlatformAdapter, PlatformType } from './types';
import { shopifyAdapter } from '../shopify/adapter';
import { wooCommerceAdapter } from '../woocommerce/adapter';

/**
 * Registry of all available platform adapters
 */
const adapters: Record<PlatformType, PlatformAdapter> = {
  SHOPIFY: shopifyAdapter,
  WOOCOMMERCE: wooCommerceAdapter,
};

/**
 * Get platform adapter by platform type
 * @param platform - Platform identifier
 * @returns Platform adapter instance
 * @throws Error if platform is not supported
 */
export function getPlatformAdapter(platform: PlatformType): PlatformAdapter {
  const adapter = adapters[platform];

  if (!adapter) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  return adapter;
}

/**
 * Get all registered platform adapters
 * @returns Array of all platform adapters
 */
export function getAllPlatformAdapters(): PlatformAdapter[] {
  return Object.values(adapters);
}

/**
 * Check if a platform is supported
 * @param platform - Platform identifier
 * @returns True if platform is supported
 */
export function isPlatformSupported(platform: string): platform is PlatformType {
  return platform in adapters;
}

/**
 * Get list of all supported platform types
 * @returns Array of platform type strings
 */
export function getSupportedPlatforms(): PlatformType[] {
  return Object.keys(adapters) as PlatformType[];
}
