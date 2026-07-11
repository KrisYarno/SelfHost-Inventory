/**
 * @jest-environment node
 *
 * Trunk completeness gate for `lib/change-tracking/taxonomy.ts`
 * (Lane 3 spec §3 D3 / §10 R-L7 / §11 D-L5).
 *
 * - Every `AuditActionType` union member (parsed from source, so a member added
 *   to the TYPE without a taxonomy entry still fails here) resolves to a
 *   non-UNKNOWN group + verb + label + tone.
 * - `ACTION_GROUPS` membership is EXACTLY the union (no missing / extra member).
 * - Retired / wrong-cased / garbage strings resolve to UNKNOWN on both axes.
 * - The verb->tone table matches spec §11 D-L5 verbatim at representative points.
 *
 * taxonomy.ts imports only a TYPE from lib/change-tracking, so no prisma /
 * next/headers runtime dependency is pulled in.
 */

import fs from 'fs';
import path from 'path';
import {
  actionMeta,
  ACTION_GROUPS,
  ALL_ACTION_TYPES,
  expandActionGroup,
} from '@/lib/change-tracking/taxonomy';

const CHANGE_TRACKING_PATH = path.join(process.cwd(), 'lib', 'change-tracking.ts');

function parseAuditActionTypeMembers(moduleSource: string): string[] {
  const block = moduleSource.match(/export type AuditActionType\s*=([\s\S]*?);/);
  if (!block) throw new Error('could not locate the AuditActionType declaration');
  const memberRe = /['"]([A-Z0-9_]+)['"]/g;
  const members: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(block[1])) !== null) members.push(m[1]);
  return members;
}

const unionMembers = parseAuditActionTypeMembers(fs.readFileSync(CHANGE_TRACKING_PATH, 'utf8'));

describe('taxonomy completeness (writer-exhaustive)', () => {
  it('parses a plausible union (self-check) incl. the Lane 3 addition', () => {
    expect(unionMembers.length).toBe(50);
    expect(unionMembers).toContain('ANALYTICS_REBUILD_TRIGGER');
    expect(new Set(unionMembers).size).toBe(unionMembers.length);
  });

  it('every union member -> non-UNKNOWN group, verb, label, tone', () => {
    const offenders = unionMembers.filter((t) => {
      const meta = actionMeta(t);
      return (
        meta.group === 'UNKNOWN' ||
        meta.verb === 'UNKNOWN' ||
        !meta.label ||
        !meta.tone
      );
    });
    expect(offenders).toEqual([]);
  });

  it('ALL_ACTION_TYPES equals the union exactly (no missing / extra)', () => {
    expect(new Set(ALL_ACTION_TYPES)).toEqual(new Set(unionMembers));
    expect(ALL_ACTION_TYPES.length).toBe(unionMembers.length);
  });

  it('ACTION_GROUPS members union equals the full union (drives the grouped filter)', () => {
    const grouped = ACTION_GROUPS.flatMap((g) => g.members);
    expect(new Set(grouped)).toEqual(new Set(unionMembers));
    // No member is double-listed across groups.
    expect(grouped.length).toBe(unionMembers.length);
    // No group key is UNKNOWN (checked at runtime via string comparison).
    expect(ACTION_GROUPS.every((g) => (g.key as string) !== 'UNKNOWN')).toBe(true);
  });
});

describe('actionMeta group / verb derivation', () => {
  it('prefix-derives groups, incl. the SYSTEM / ACCOUNT / MAPPING folds', () => {
    expect(actionMeta('PRODUCT_UPDATE').group).toBe('PRODUCT');
    expect(actionMeta('INVENTORY_TRANSFER').group).toBe('INVENTORY');
    expect(actionMeta('EXTERNAL_ORDER_FULFILLMENT').group).toBe('ORDER');
    expect(actionMeta('DATA_EXPORT').group).toBe('SYSTEM');
    expect(actionMeta('BACKUP_CREATED').group).toBe('SYSTEM');
    expect(actionMeta('ANALYTICS_REBUILD_TRIGGER').group).toBe('SYSTEM');
    expect(actionMeta('SIGNUP').group).toBe('ACCOUNT');
    expect(actionMeta('BUNDLE_CHANGE').group).toBe('MAPPING');
    expect(actionMeta('ACCOUNT_PASSWORD_CHANGE').group).toBe('ACCOUNT');
  });

  it('parses the MOST SPECIFIC trailing verb (BULK_UPDATE over UPDATE, AUTO_ADD)', () => {
    expect(actionMeta('INVENTORY_BULK_UPDATE').verb).toBe('BULK_UPDATE');
    expect(actionMeta('INVENTORY_TRANSFER_AUTO_ADD').verb).toBe('AUTO_ADD');
    expect(actionMeta('EXTERNAL_ORDER_PARTIAL_FULFILLMENT').verb).toBe('FULFILLMENT');
    expect(actionMeta('ANALYTICS_REBUILD_TRIGGER').verb).toBe('TRIGGER');
    expect(actionMeta('SIGNUP').verb).toBe('SIGNUP');
    expect(actionMeta('BACKUP_CREATED').verb).toBe('CREATED');
  });
});

describe('verb -> tone table (spec §11 D-L5 verbatim)', () => {
  const cases: Array<[string, string]> = [
    // positive
    ['PRODUCT_CREATE', 'positive'],
    ['BACKUP_CREATED', 'positive'],
    ['PRODUCT_APPROVE', 'positive'],
    ['USER_APPROVAL', 'positive'],
    ['STAGING_GRADUATE', 'positive'],
    ['PRODUCT_RESTORE', 'positive'],
    ['SIGNUP', 'positive'],
    // negative
    ['PRODUCT_DELETE', 'negative'],
    ['USER_DELETION', 'negative'],
    ['PRODUCT_DECLINE', 'negative'],
    ['USER_REJECTION', 'negative'],
    ['STAGING_DISCARD', 'negative'],
    // warning
    ['INVENTORY_ADJUSTMENT', 'warning'],
    ['INVENTORY_BULK_UPDATE', 'warning'],
    ['EXTERNAL_ORDER_UNFULFILLMENT', 'warning'],
    // info
    ['INVENTORY_TRANSFER', 'info'],
    ['EXTERNAL_ORDER_FULFILLMENT', 'info'],
    ['INVENTORY_TRANSFER_AUTO_ADD', 'info'],
    ['DATA_EXPORT', 'info'],
    ['ANALYTICS_REBUILD_TRIGGER', 'info'],
    // neutral
    ['PRODUCT_UPDATE', 'neutral'],
    ['USER_ROLE_CHANGE', 'neutral'],
    ['BUNDLE_CHANGE', 'neutral'],
  ];
  it.each(cases)('%s -> %s', (actionType, tone) => {
    expect(actionMeta(actionType).tone).toBe(tone);
  });
});

describe('reader-tolerance (R-L7)', () => {
  it('the pre-fix wrong-cased ProductUpdate -> UNKNOWN on both axes', () => {
    const meta = actionMeta('ProductUpdate');
    expect(meta.group).toBe('UNKNOWN');
    expect(meta.verb).toBe('UNKNOWN');
    expect(meta.tone).toBe('neutral');
    // still a safe, non-empty label
    expect(meta.label.length).toBeGreaterThan(0);
  });

  it('garbage / empty -> UNKNOWN', () => {
    for (const bad of ['', 'ZZZ_NONSENSE', 'lolwut', '123', 'PRODUCT']) {
      const meta = actionMeta(bad);
      expect(meta.group).toBe('UNKNOWN');
      expect(meta.verb).toBe('UNKNOWN');
    }
  });
});

describe('expandActionGroup', () => {
  it('expands a known group to its members', () => {
    const members = expandActionGroup('PRODUCT');
    expect(members).not.toBeNull();
    expect(members).toContain('PRODUCT_CREATE');
    expect(members).toContain('PRODUCT_UPDATE');
    expect(members!.every((m) => actionMeta(m).group === 'PRODUCT')).toBe(true);
  });

  it('returns null for an unknown group (caller answers 400)', () => {
    expect(expandActionGroup('NONSENSE')).toBeNull();
    expect(expandActionGroup('UNKNOWN')).toBeNull();
    expect(expandActionGroup('')).toBeNull();
  });
});
