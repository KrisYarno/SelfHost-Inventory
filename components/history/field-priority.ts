/**
 * components/history/field-priority.ts — core-change-first ordering for the
 * shared history renderer family (Lane 3 spec §11 D-L5, tables VERBATIM).
 *
 * `orderChanges` sorts a canonical change set so the single most significant
 * field renders first (Linear core-change-first), driven by a per-entity
 * priority table — NEVER object insertion order. Fields not on a table keep
 * their insertion order after the prioritized fields; the noise keys
 * `updatedAt`/`createdAt`/`version` always sort last.
 */

import type { ActionGroup } from '@/lib/change-tracking/taxonomy';
import type { ChangePair } from '@/lib/change-tracking/extract-changes';

/**
 * Per-entity field-priority tables (spec §11 D-L5, VERBATIM). Each inner array
 * is one priority TIER — fields sharing a tier keep their relative insertion
 * order (e.g. PRODUCT `name`/`baseName`). Tiers are listed most-significant
 * first.
 */
const PRIORITY_TIERS: Partial<Record<ActionGroup, readonly (readonly string[])[]>> = {
  PRODUCT: [
    ['name', 'baseName'],
    ['variant'],
    ['quantity'],
    ['costPrice'],
    ['retailPrice'],
    ['lowStockThreshold'],
    ['approvalStatus'],
    ['unit'],
    ['numericValue'],
  ],
  INVENTORY: [['delta'], ['location'], ['reasonCode']],
  USER: [['isAdmin'], ['isApproved'], ['username']],
  INTEGRATION: [['isActive'], ['stockSyncEnabled'], ['fulfillmentPushEnabled'], ['syncLocationId']],
};

/** Noise keys — always sorted last, in their own insertion order. */
const NOISE_KEYS: ReadonlySet<string> = new Set(['updatedAt', 'createdAt', 'version']);

// Rank bands: prioritized tiers occupy [0, REST_BASE); non-priority "rest"
// fields occupy [REST_BASE, NOISE_BASE); noise keys occupy [NOISE_BASE, ...).
const REST_BASE = 1_000;
const NOISE_BASE = 1_000_000;

/**
 * Order a canonical change set core-change-first per the entity's priority
 * table. Stable: ties (same tier, or same band) preserve insertion order.
 */
export function orderChanges(
  changes: Record<string, ChangePair>,
  entityHint: ActionGroup,
): [string, ChangePair][] {
  const tiers = PRIORITY_TIERS[entityHint] ?? [];
  const tierRank = new Map<string, number>();
  tiers.forEach((tier, i) => {
    for (const key of tier) if (!tierRank.has(key)) tierRank.set(key, i);
  });

  const rankOf = (key: string, insertionIdx: number): number => {
    if (NOISE_KEYS.has(key)) return NOISE_BASE + insertionIdx;
    const tier = tierRank.get(key);
    if (tier !== undefined) return tier;
    return REST_BASE + insertionIdx;
  };

  return Object.entries(changes)
    .map(([key, pair], idx) => ({ key, pair, rank: rankOf(key, idx), idx }))
    .sort((a, b) => a.rank - b.rank || a.idx - b.idx)
    .map(({ key, pair }) => [key, pair]);
}
