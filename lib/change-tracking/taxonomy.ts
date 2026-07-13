/**
 * lib/change-tracking/taxonomy.ts — the trunk rendering contract for audit
 * actions (Lane 3 spec §3 D3 as amended by §10 R-L7 + §11 D-L5).
 *
 * Reader-tolerant, writer-exhaustive:
 *   - `actionMeta(actionType: string)` is TOTAL over `string`. Known members map
 *     to a real group + verb + human label + tone; retired / malformed / wrong-
 *     cased historical values (e.g. the pre-fix `'ProductUpdate'`) fall back to
 *     `{ group:'UNKNOWN', verb:'UNKNOWN', label:<prettified>, tone:'neutral' }`.
 *   - `ACTION_GROUPS` / `expandActionGroup` drive the admin feed's grouped filter
 *     (Stripe action-group model) and are exhaustive over the writer union.
 *
 * Deliberately consolidates spec D3's actionGroup()/actionVerb()/actionLabel()
 * into ONE total `actionMeta()` — identical data, single lookup, one UNKNOWN
 * fallback path (R-L7). The completeness gate asserts over `actionMeta`.
 */

import type { AuditActionType } from '@/lib/change-tracking';

export type ActionGroup =
  | 'USER'
  | 'ACCOUNT'
  | 'PRODUCT'
  | 'INVENTORY'
  | 'STAGING'
  | 'SCRATCHPAD'
  | 'COMPANY'
  | 'INTEGRATION'
  | 'MAPPING'
  | 'ORDER'
  | 'LOCATION'
  | 'SETTINGS'
  | 'SYSTEM'
  | 'UNKNOWN';

export type ActionTone = 'positive' | 'negative' | 'warning' | 'info' | 'neutral';

export interface ActionMeta {
  group: ActionGroup;
  verb: string;
  label: string;
  tone: ActionTone;
}

// ---------------------------------------------------------------------------
// Verb -> tone table (spec §11 D-L5 VERBATIM). 7-hue -> 5-tone loss accepted;
// icons carry the rest. Unlisted verbs (incl. UNKNOWN) resolve to 'neutral'.
// ---------------------------------------------------------------------------

const VERB_TONE: Readonly<Record<string, ActionTone>> = {
  // positive
  CREATE: 'positive',
  CREATED: 'positive',
  APPROVE: 'positive',
  APPROVAL: 'positive',
  GRADUATE: 'positive',
  RESTORE: 'positive',
  SIGNUP: 'positive',
  STOCK_IN: 'positive',
  // negative
  DELETE: 'negative',
  DELETION: 'negative',
  DECLINE: 'negative',
  REJECT: 'negative',
  REJECTION: 'negative',
  DISCARD: 'negative',
  REVOKE: 'negative', // Lane 4: API_TOKEN_REVOKE
  // warning
  ADJUSTMENT: 'warning',
  BULK_UPDATE: 'warning',
  UNFULFILLMENT: 'warning',
  // info
  TRANSFER: 'info',
  FULFILLMENT: 'info',
  IMPORT: 'info',
  EXPORT: 'info',
  SYNC: 'info',
  AUTO_ADD: 'info',
  SENT: 'info',
  TRIGGER: 'info',
  // neutral
  UPDATE: 'neutral',
  CHANGE: 'neutral',
  MAINTENANCE: 'neutral',
  UNKNOWN: 'neutral',
};

// Known trailing verbs, ordered LONGEST-FIRST so a member matches its most
// specific suffix (INVENTORY_BULK_UPDATE -> BULK_UPDATE, not UPDATE;
// INVENTORY_TRANSFER_AUTO_ADD -> AUTO_ADD). Superset of the R-D15 guard list
// and the D-L5 tone table.
const KNOWN_VERBS: readonly string[] = [
  'STOCK_IN',
  'BULK_UPDATE',
  'AUTO_ADD',
  'UNFULFILLMENT',
  'FULFILLMENT',
  'ADJUSTMENT',
  'DEDUCTION',
  'APPROVAL',
  'REJECTION',
  'DELETION',
  'MAINTENANCE',
  'CREATED',
  'APPROVE',
  'DECLINE',
  'GRADUATE',
  'RESTORE',
  'DISCARD',
  'TRANSFER',
  'TRIGGER',
  'SIGNUP',
  'IMPORT',
  'EXPORT',
  'REJECT',
  'REVOKE',
  'CHANGE',
  'CREATE',
  'DELETE',
  'UPDATE',
  'SYNC',
  'SENT',
];

/**
 * Group by leading token (prefix map), with explicit folds for members whose
 * prefix is not itself a group: DATA_EXPORT / BACKUP_CREATED /
 * ANALYTICS_REBUILD_TRIGGER -> SYSTEM; SIGNUP -> ACCOUNT; BUNDLE_CHANGE ->
 * MAPPING (bundle composition is product mapping).
 */
const PREFIX_GROUP: Readonly<Record<string, ActionGroup>> = {
  USER: 'USER',
  ACCOUNT: 'ACCOUNT',
  PRODUCT: 'PRODUCT',
  INVENTORY: 'INVENTORY',
  STAGING: 'STAGING',
  SCRATCHPAD: 'SCRATCHPAD',
  COMPANY: 'COMPANY',
  INTEGRATION: 'INTEGRATION',
  MAPPING: 'MAPPING',
  BUNDLE: 'MAPPING',
  EXTERNAL: 'ORDER', // EXTERNAL_ORDER_*
  LOCATION: 'LOCATION',
  SETTINGS: 'SETTINGS',
  DATA: 'SYSTEM', // DATA_EXPORT
  BACKUP: 'SYSTEM', // BACKUP_CREATED
  ANALYTICS: 'SYSTEM', // ANALYTICS_REBUILD_TRIGGER
  SIGNUP: 'ACCOUNT',
  AI: 'SETTINGS', // AI_PROVIDER_* (Lane 4 — provider configuration is settings)
  API: 'SETTINGS', // API_TOKEN_* (Lane 4 — token administration is settings)
};

// Human labels. Default = Title Case of the tokens; overrides give the register
// the UI copy standard (D-L6) expects (esp. ORDER, whose restricted stub reads
// "Order fulfillment — company-scoped" per R-L5).
const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  EXTERNAL_ORDER_FULFILLMENT: 'Order fulfillment',
  EXTERNAL_ORDER_PARTIAL_FULFILLMENT: 'Order partial fulfillment',
  EXTERNAL_ORDER_UNFULFILLMENT: 'Order unfulfillment',
  EXTERNAL_ORDER_CREATE: 'Order created',
  EXTERNAL_ORDER_UPDATE: 'Order updated',
  EXTERNAL_ORDER_DELETE: 'Order deleted',
  DATA_EXPORT: 'Data export',
  BACKUP_CREATED: 'Backup created',
  ANALYTICS_REBUILD_TRIGGER: 'Analytics rebuild triggered',
  SIGNUP: 'Signup',
  BUNDLE_CHANGE: 'Bundle changed',
  INVENTORY_TRANSFER_AUTO_ADD: 'Transfer auto-add',
  INVENTORY_BULK_UPDATE: 'Inventory bulk update',
  AI_PROVIDER_CREATE: 'AI provider created',
  AI_PROVIDER_UPDATE: 'AI provider updated',
  API_TOKEN_CREATE: 'API token created',
  API_TOKEN_REVOKE: 'API token revoked',
};

function titleCase(actionType: string): string {
  return actionType
    .split('_')
    .filter((t) => t.length > 0)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join(' ');
}

/** Parse the most specific known trailing verb, or 'UNKNOWN'. */
function parseVerb(actionType: string): string {
  for (const verb of KNOWN_VERBS) {
    if (actionType === verb || actionType.endsWith(`_${verb}`)) return verb;
  }
  return 'UNKNOWN';
}

/** Group by the leading token via PREFIX_GROUP, or 'UNKNOWN'. */
function parseGroup(actionType: string): ActionGroup {
  const prefix = actionType.split('_', 1)[0];
  return PREFIX_GROUP[prefix] ?? 'UNKNOWN';
}

/**
 * TOTAL over `string`. A value that resolves to no known group OR no known verb
 * is treated as UNKNOWN on BOTH axes (so a stray legacy `'ProductUpdate'` — no
 * underscore, wrong case — never masquerades as a real action).
 */
export function actionMeta(actionType: string): ActionMeta {
  const group = parseGroup(actionType);
  const verb = parseVerb(actionType);

  if (group === 'UNKNOWN' || verb === 'UNKNOWN') {
    return {
      group: 'UNKNOWN',
      verb: 'UNKNOWN',
      label: titleCase(actionType) || String(actionType),
      tone: 'neutral',
    };
  }

  return {
    group,
    verb,
    label: LABEL_OVERRIDES[actionType] ?? titleCase(actionType),
    tone: VERB_TONE[verb] ?? 'neutral',
  };
}

// ---------------------------------------------------------------------------
// Writer-exhaustive membership (drives the grouped action filter; also the
// completeness gate's source of "every union member"). `ALL_ACTION_TYPES` is
// typed `AuditActionType[]`, so the compiler rejects any non-member; the trunk
// completeness test cross-checks it against the union source so a NEW member
// added without a taxonomy entry fails CI.
// ---------------------------------------------------------------------------

export const ALL_ACTION_TYPES: readonly AuditActionType[] = [
  'USER_APPROVAL',
  'USER_REJECTION',
  'USER_DELETION',
  'USER_UPDATE',
  'USER_BULK_APPROVAL',
  'USER_BULK_REJECTION',
  'USER_ROLE_CHANGE',
  'ACCOUNT_PASSWORD_CHANGE',
  'ACCOUNT_USERNAME_CHANGE',
  'ACCOUNT_PREFERENCES_CHANGE',
  'SIGNUP',
  'PRODUCT_CREATE',
  'PRODUCT_UPDATE',
  'PRODUCT_DELETE',
  'PRODUCT_APPROVE',
  'PRODUCT_DECLINE',
  'PRODUCT_RESTORE',
  'STAGING_CREATE',
  'STAGING_GRADUATE',
  'STAGING_DISCARD',
  'STAGING_UPDATE',
  'SCRATCHPAD_CREATE',
  'SCRATCHPAD_UPDATE',
  'SCRATCHPAD_DELETE',
  'INVENTORY_ADJUSTMENT',
  'INVENTORY_BULK_UPDATE',
  'INVENTORY_TRANSFER',
  'INVENTORY_TRANSFER_AUTO_ADD',
  'COMPANY_CREATE',
  'COMPANY_UPDATE',
  'COMPANY_DELETE',
  'INTEGRATION_CREATE',
  'INTEGRATION_UPDATE',
  'INTEGRATION_DELETE',
  'INTEGRATION_SYNC_CONFIG_CHANGE',
  'MAPPING_CREATE',
  'MAPPING_DELETE',
  'BUNDLE_CHANGE',
  'EXTERNAL_ORDER_FULFILLMENT',
  'EXTERNAL_ORDER_PARTIAL_FULFILLMENT',
  'EXTERNAL_ORDER_UNFULFILLMENT',
  'EXTERNAL_ORDER_CREATE',
  'EXTERNAL_ORDER_UPDATE',
  'EXTERNAL_ORDER_DELETE',
  'LOCATION_CREATE',
  'LOCATION_DELETE',
  'SETTINGS_UPDATE',
  'DATA_EXPORT',
  'BACKUP_CREATED',
  'ANALYTICS_REBUILD_TRIGGER',
];

// Display order + labels for the non-UNKNOWN groups.
const GROUP_LABELS: readonly { key: Exclude<ActionGroup, 'UNKNOWN'>; label: string }[] = [
  { key: 'PRODUCT', label: 'Products' },
  { key: 'INVENTORY', label: 'Inventory' },
  { key: 'ORDER', label: 'Orders' },
  { key: 'STAGING', label: 'Pre-staging' },
  { key: 'SCRATCHPAD', label: 'Scratchpad' },
  { key: 'USER', label: 'Users' },
  { key: 'ACCOUNT', label: 'Account' },
  { key: 'COMPANY', label: 'Companies' },
  { key: 'INTEGRATION', label: 'Integrations' },
  { key: 'MAPPING', label: 'Mappings' },
  { key: 'LOCATION', label: 'Locations' },
  { key: 'SETTINGS', label: 'Settings' },
  { key: 'SYSTEM', label: 'System' },
];

export const ACTION_GROUPS: readonly {
  key: Exclude<ActionGroup, 'UNKNOWN'>;
  label: string;
  members: AuditActionType[];
}[] = GROUP_LABELS.map(({ key, label }) => ({
  key,
  label,
  members: ALL_ACTION_TYPES.filter((t) => actionMeta(t).group === key),
})).filter((g) => g.members.length > 0);

const GROUP_KEYS = new Set<string>(ACTION_GROUPS.map((g) => g.key));

/**
 * Expand a group key to its member actionTypes for a server-side
 * `actionType: { in: members }` filter. Returns null when `group` is not a
 * known group (caller answers 400).
 */
export function expandActionGroup(group: string): AuditActionType[] | null {
  if (!GROUP_KEYS.has(group)) return null;
  return ACTION_GROUPS.find((g) => g.key === group)?.members ?? null;
}
