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

/**
 * W1-2b PARSER FIX (see the identical note in change-tracking-guards.test.ts):
 * the old regex stopped at the first `;` ANYWHERE after the `=`, and the Lane 4
 * member comment contains one. Four members past that point were invisible to
 * this gate, so a taxonomy that did not list them still passed. Strip comments
 * first, then cut at the declaration's real terminator.
 */
function parseAuditActionTypeMembers(moduleSource: string): string[] {
  const start = moduleSource.search(/export type AuditActionType\s*=/);
  if (start < 0) throw new Error('could not locate the AuditActionType declaration');
  const decommented = moduleSource
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const end = decommented.indexOf(';');
  if (end < 0) throw new Error('the AuditActionType declaration has no terminating `;`');
  const memberRe = /['"]([A-Z0-9_]+)['"]/g;
  const members: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(decommented.slice(0, end))) !== null) members.push(m[1]);
  return members;
}

const unionMembers = parseAuditActionTypeMembers(fs.readFileSync(CHANGE_TRACKING_PATH, 'utf8'));

describe('taxonomy completeness (writer-exhaustive)', () => {
  it('parses a plausible union (self-check) incl. the Lane 3 addition', () => {
    // Lane 6 added PLATFORM_WRITE_ATTEMPT (52); the inventory-accuracy lane's
    // W1-2a added the six SHIPMENT_* verbs (58) and W1-2b added STAGING_RECOUNT
    // (59). The next four are the Lane 4 members the pre-fix parser truncated
    // away — they were in the union all along (63). W1-3a added
    // GRADUATE_OVERRIDE (64). The Receiving/Labeling overhaul adds the verify,
    // the batch stock-in and the exception resolution (67).
    expect(unionMembers.length).toBe(67);
    expect(unionMembers).toContain('GRADUATE_OVERRIDE');
    expect(unionMembers).toContain('STAGING_VERIFY');
    expect(unionMembers).toContain('STAGING_STOCK_IN');
    expect(unionMembers).toContain('EXCEPTION_RESOLVE');
    expect(unionMembers).toContain('ANALYTICS_REBUILD_TRIGGER');
    expect(unionMembers).toContain('USER_APPROVAL_REMINDER_SENT');
    expect(unionMembers).toContain('PLATFORM_WRITE_ATTEMPT');
    expect(unionMembers).toContain('SHIPMENT_CANCEL');
    expect(unionMembers).toContain('SHIPMENT_UNLINK');
    expect(unionMembers).toContain('STAGING_RECOUNT');
    expect(new Set(unionMembers).size).toBe(unionMembers.length);
  });

  it('PARSER REGRESSION: a semicolon inside a member comment no longer truncates', () => {
    // The Lane 4 comment ("...via the deep scan; token/hash never enter
    // payloads") sits between PLATFORM_WRITE_ATTEMPT and the last four members.
    // The pre-fix regex stopped there, so these four were invisible to every
    // gate that reads the union — and to the admin filter built from it.
    for (const hidden of [
      'AI_PROVIDER_CREATE',
      'AI_PROVIDER_UPDATE',
      'API_TOKEN_CREATE',
      'API_TOKEN_REVOKE',
    ]) {
      expect(unionMembers).toContain(hidden);
      expect(ALL_ACTION_TYPES).toContain(hidden);
    }
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
    // Lane 4 folds (AI / API -> SETTINGS): correct all along, but only reachable
    // through the filter now that the four members are in ALL_ACTION_TYPES.
    expect(actionMeta('AI_PROVIDER_CREATE').group).toBe('SETTINGS');
    expect(actionMeta('API_TOKEN_REVOKE').group).toBe('SETTINGS');
    // W1-2b: the count endpoint's verb lands in the pre-staging group.
    expect(actionMeta('STAGING_RECOUNT').group).toBe('STAGING');
    expect(actionMeta('STAGING_RECOUNT').verb).toBe('RECOUNT');
    expect(actionMeta('STAGING_RECOUNT').label).toBe('Item counted');
    // Receiving/Labeling overhaul: EXCEPTION_* has no group of its own — a
    // discrepancy is settled inside the receiving flow, so it FOLDS into
    // STAGING the way SHIPMENT and GRADUATE already do.
    expect(actionMeta('EXCEPTION_RESOLVE').group).toBe('STAGING');
  });

  it('Receiving/Labeling overhaul: the three new members carry full meta (PK-7)', () => {
    expect(actionMeta('EXCEPTION_RESOLVE')).toEqual({
      group: 'STAGING',
      verb: 'RESOLVE',
      tone: 'positive',
      label: 'Exception resolved',
    });
    expect(actionMeta('STAGING_VERIFY')).toEqual({
      group: 'STAGING',
      verb: 'VERIFY',
      tone: 'neutral',
      label: 'Line verified',
    });
    expect(actionMeta('STAGING_STOCK_IN')).toEqual({
      group: 'STAGING',
      verb: 'STOCK_IN',
      tone: 'positive',
      label: 'Labeled units stocked',
    });
  });

  it('the STAGING group is DISPLAYED as the flow it now is', () => {
    // The group holds pre-staging history AND the supply-order/labeling flow
    // that replaces it; "Pre-staging" would name a page that is being retired.
    const staging = ACTION_GROUPS.find((g) => g.key === 'STAGING');
    expect(staging?.label).toBe('Receiving & Labeling');
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
    ['SHIPMENT_CLOSE', 'positive'],
    ['PRODUCT_RESTORE', 'positive'],
    ['SIGNUP', 'positive'],
    // negative
    ['PRODUCT_DELETE', 'negative'],
    ['USER_DELETION', 'negative'],
    ['PRODUCT_DECLINE', 'negative'],
    ['USER_REJECTION', 'negative'],
    ['STAGING_DISCARD', 'negative'],
    ['SHIPMENT_CANCEL', 'negative'],
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
    ['SHIPMENT_LINK', 'info'],
    ['SHIPMENT_UNLINK', 'info'],
    // W1-2b: a count is evidence-gathering, not a judgement about the stock.
    ['STAGING_RECOUNT', 'info'],
    // Receiving/Labeling overhaul: booking labeled units is stock arriving
    // (positive); settling an exception closes a problem (positive); a verify
    // reports what turned up and passes no judgement (neutral).
    ['STAGING_STOCK_IN', 'positive'],
    ['EXCEPTION_RESOLVE', 'positive'],
    ['STAGING_VERIFY', 'neutral'],
    // neutral
    ['PRODUCT_UPDATE', 'neutral'],
    ['USER_ROLE_CHANGE', 'neutral'],
    ['BUNDLE_CHANGE', 'neutral'],
    // Lane 4 members, reachable through the union again after the parser fix.
    ['AI_PROVIDER_CREATE', 'positive'],
    ['API_TOKEN_REVOKE', 'negative'],
    ['AI_PROVIDER_UPDATE', 'neutral'],
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

  it('SETTINGS now expands to the Lane 4 members the truncated union hid', () => {
    const members = expandActionGroup('SETTINGS');
    expect(members).toContain('SETTINGS_UPDATE');
    expect(members).toContain('AI_PROVIDER_CREATE');
    expect(members).toContain('AI_PROVIDER_UPDATE');
    expect(members).toContain('API_TOKEN_CREATE');
    expect(members).toContain('API_TOKEN_REVOKE');
  });

  it('STAGING expands to the count verb alongside the rest of the queue', () => {
    expect(expandActionGroup('STAGING')).toContain('STAGING_RECOUNT');
  });

  it('STAGING also expands to the overhaul members (the admin filter reaches them)', () => {
    const members = expandActionGroup('STAGING');
    expect(members).toContain('STAGING_VERIFY');
    expect(members).toContain('STAGING_STOCK_IN');
    expect(members).toContain('EXCEPTION_RESOLVE');
  });

  it('returns null for an unknown group (caller answers 400)', () => {
    expect(expandActionGroup('NONSENSE')).toBeNull();
    expect(expandActionGroup('UNKNOWN')).toBeNull();
    expect(expandActionGroup('')).toBeNull();
  });
});
