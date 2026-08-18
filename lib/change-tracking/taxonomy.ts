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
  // Inventory-accuracy lane (T4): closing a shipment is a completed receipt.
  CLOSE: 'positive',
  // Receiving/Labeling overhaul: settling an exception CLOSES a problem — the
  // one act on the register that means something got better.
  RESOLVE: 'positive',
  // negative
  DELETE: 'negative',
  DELETION: 'negative',
  DECLINE: 'negative',
  REJECT: 'negative',
  REJECTION: 'negative',
  DISCARD: 'negative',
  REVOKE: 'negative', // Lane 4: API_TOKEN_REVOKE
  CANCEL: 'negative', // Inventory-accuracy lane (T4): SHIPMENT_CANCEL
  // warning
  ADJUSTMENT: 'warning',
  BULK_UPDATE: 'warning',
  UNFULFILLMENT: 'warning',
  // Lane 6: an outbound platform write was attempted. Warning tone by design —
  // this is the event class the owner explicitly wants to be unmissable, and a
  // BLOCKED attempt is exactly as noteworthy as a sent one.
  ATTEMPT: 'warning',
  // info
  TRANSFER: 'info',
  FULFILLMENT: 'info',
  IMPORT: 'info',
  EXPORT: 'info',
  // Inventory-accuracy lane (T4): a line joining/leaving a receiving header is
  // routine bookkeeping, not a judgement about the stock.
  LINK: 'info',
  UNLINK: 'info',
  // W1-2b: a count is evidence-gathering. It reports what is on the dock; the
  // judgement about a discrepancy belongs to the exception row, not the verb.
  RECOUNT: 'info',
  // W1-3a: the ledger was deliberately made to disagree with the count. Legal,
  // reasoned, and exactly the class of event the feed must never bury.
  OVERRIDE: 'warning',
  SYNC: 'info',
  AUTO_ADD: 'info',
  SENT: 'info',
  TRIGGER: 'info',
  // neutral
  UPDATE: 'neutral',
  // Receiving/Labeling overhaul: a verify REPORTS what turned up on the dock.
  // The judgement about a shortage belongs to the exception row it raises, not
  // to the act of counting — the same reasoning that made RECOUNT informational.
  VERIFY: 'neutral',
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
  // Inventory-accuracy lane (T4). UNLINK precedes LINK per the longest-first
  // rule, even though '_LINK' cannot match a '..._UNLINK' member today.
  'UNLINK',
  'UNFULFILLMENT',
  'FULFILLMENT',
  'ADJUSTMENT',
  'DEDUCTION',
  'ATTEMPT',
  'APPROVAL',
  'REJECTION',
  'DELETION',
  'MAINTENANCE',
  'CREATED',
  'APPROVE',
  'DECLINE',
  'GRADUATE',
  'RESTORE',
  // Receiving/Labeling overhaul: EXCEPTION_RESOLVE. No shorter verb is a suffix
  // of it, so its position among the same-length verbs is immaterial.
  'RESOLVE',
  'DISCARD',
  // W1-2b: STAGING_RECOUNT. No shorter 'COUNT' verb exists, so there is no
  // longest-first ambiguity to resolve here.
  'RECOUNT',
  // W1-3a: GRADUATE_OVERRIDE. Longer than the existing 'GRADUATE' verb and not a
  // suffix of it, so ordering against it is immaterial.
  'OVERRIDE',
  'TRANSFER',
  'TRIGGER',
  'SIGNUP',
  'IMPORT',
  'EXPORT',
  'REJECT',
  'REVOKE',
  'CANCEL',
  'CHANGE',
  'CREATE',
  'DELETE',
  'UPDATE',
  // Receiving/Labeling overhaul: STAGING_VERIFY. Nothing shorter is a suffix of
  // it either; it sits with the other six-letter verbs.
  'VERIFY',
  'CLOSE',
  'LINK',
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
  // Inventory-accuracy lane (T4): a receiving header IS the staging domain's
  // header, so SHIPMENT_* folds into the existing STAGING group rather than
  // minting a group (established fold idiom: BUNDLE -> MAPPING, AI -> SETTINGS).
  SHIPMENT: 'STAGING',
  // W1-3a: GRADUATE_OVERRIDE's leading token is the act, not a domain — the pack
  // fixed the member's NAME, so the fold table absorbs it the same way SHIPMENT
  // and BUNDLE are absorbed. Graduation is pre-staging work, hence STAGING.
  GRADUATE: 'STAGING',
  // Receiving/Labeling overhaul (G1p-7): EXCEPTION_RESOLVE's leading token names
  // the register, not a domain. Every exception this lane settles is raised and
  // resolved inside the receiving/labeling flow, so it folds into STAGING the
  // same way SHIPMENT and GRADUATE do rather than minting a group of its own.
  EXCEPTION: 'STAGING',
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
  PLATFORM: 'SYSTEM', // PLATFORM_WRITE_ATTEMPT (Lane 6 — egress is a system event)
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
  USER_APPROVAL_REMINDER_SENT: 'Approval reminder sent',
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
  PLATFORM_WRITE_ATTEMPT: 'Platform write attempt',
  SHIPMENT_CREATE: 'Shipment opened',
  SHIPMENT_UPDATE: 'Shipment updated',
  SHIPMENT_CLOSE: 'Shipment closed',
  SHIPMENT_CANCEL: 'Shipment cancelled',
  SHIPMENT_LINK: 'Item linked to shipment',
  SHIPMENT_UNLINK: 'Item unlinked from shipment',
  // One verb covers the first count and every recount, so the label states the
  // act rather than claiming a re-count that may not have happened.
  STAGING_RECOUNT: 'Item counted',
  // Names the divergence outright — "override" alone would read as a permission
  // grant rather than "the ledger was booked away from the count".
  GRADUATE_OVERRIDE: 'Graduated with a quantity override',
  // Receiving/Labeling overhaul. Title Case of the tokens would read "Staging
  // Verify" / "Staging Stock In" / "Exception Resolve" — the acts named in
  // schema terms rather than in the operator's.
  STAGING_VERIFY: 'Line verified',
  STAGING_STOCK_IN: 'Labeled units stocked',
  EXCEPTION_RESOLVE: 'Exception resolved',
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
  'USER_APPROVAL_REMINDER_SENT',
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
  'STAGING_RECOUNT',
  'GRADUATE_OVERRIDE',
  'SHIPMENT_CREATE',
  'SHIPMENT_UPDATE',
  'SHIPMENT_CLOSE',
  'SHIPMENT_CANCEL',
  'SHIPMENT_LINK',
  'SHIPMENT_UNLINK',
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
  'PLATFORM_WRITE_ATTEMPT',
  // Lane 4 (W1-2b ride-along). These were in the union and had labels, a group
  // fold and verbs all along, but were MISSING here: the completeness gate
  // parsed the union source with a regex that stopped at the first `;`, and the
  // Lane 4 member comment contains one -- so the gate compared the taxonomy
  // against a union four members short and passed. The visible consequence was
  // an admin audit-log filter that answered 400 for real, emitted actions
  // (ALL_ACTION_TYPES is that route's allowlist).
  'AI_PROVIDER_CREATE',
  'AI_PROVIDER_UPDATE',
  'API_TOKEN_CREATE',
  'API_TOKEN_REVOKE',
  // Receiving/Labeling overhaul (spec §11): the verify, the labeled-batch
  // booking and the exception settlement.
  'STAGING_VERIFY',
  'STAGING_STOCK_IN',
  'EXCEPTION_RESOLVE',
];

// Display order + labels for the non-UNKNOWN groups.
const GROUP_LABELS: readonly { key: Exclude<ActionGroup, 'UNKNOWN'>; label: string }[] = [
  { key: 'PRODUCT', label: 'Products' },
  { key: 'INVENTORY', label: 'Inventory' },
  { key: 'ORDER', label: 'Orders' },
  // Receiving/Labeling overhaul: the group holds pre-staging history AND the
  // supply-order / labeling flow that replaces it, so it is named for the work
  // rather than for a page being retired.
  { key: 'STAGING', label: 'Receiving & Labeling' },
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
