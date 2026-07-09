/**
 * lib/change-tracking.ts — the transactional, universally-addressed change-capture
 * core (spec 2026-07-08 §3 D3/D5, §10 R-D2/R-D5/R-D6/R-D7/R-D8/R-D11/R-D14).
 *
 * Two write tiers, baked into the function names (never a call-site judgment):
 *   - recordChange(tx, e)  : joins the caller's transaction; THROWS on failure so
 *                            an unrecordable user change never commits.
 *   - recordIngestion(e)   : best-effort for machine paths (webhook/cron); NEVER
 *                            throws — logs + fires an onFailure health callback.
 *
 * `lib/audit.ts` stays alive (deprecated) until Task 14 deletes it; both modules
 * coexist and their type unions are intentionally duplicated during the migration.
 */

import { v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// Taxonomy (spec §3 D5). Seeded from lib/audit.ts's current unions and EXTENDED
// with the D5 additions. Nothing is removed yet — the never-emitted members die
// with lib/audit.ts in Task 14.
// ---------------------------------------------------------------------------

export type AuditActionType =
  // --- carried over from lib/audit.ts ---
  | 'USER_APPROVAL'
  | 'USER_REJECTION'
  | 'USER_DELETION'
  | 'USER_UPDATE'
  | 'USER_BULK_APPROVAL'
  | 'USER_BULK_REJECTION'
  | 'PRODUCT_CREATE'
  | 'PRODUCT_UPDATE'
  | 'PRODUCT_DELETE'
  | 'PRODUCT_BULK_DELETE'
  | 'PRODUCT_APPROVE'
  | 'PRODUCT_DECLINE'
  | 'STAGING_CREATE'
  | 'STAGING_GRADUATE'
  | 'STAGING_DISCARD'
  | 'SCRATCHPAD_CREATE'
  | 'SCRATCHPAD_UPDATE'
  | 'SCRATCHPAD_DELETE'
  | 'INVENTORY_ADJUSTMENT'
  | 'INVENTORY_STOCK_IN'
  | 'INVENTORY_DEDUCTION'
  | 'INVENTORY_BULK_UPDATE'
  | 'INVENTORY_TRANSFER'
  | 'INVENTORY_TRANSFER_AUTO_ADD'
  | 'EXTERNAL_ORDER_FULFILLMENT'
  | 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT'
  | 'EXTERNAL_ORDER_UNFULFILLMENT'
  | 'LOCATION_CREATE'
  | 'LOCATION_UPDATE'
  | 'LOCATION_DELETE'
  | 'SETTINGS_UPDATE'
  | 'EMAIL_SENT'
  | 'DATA_EXPORT'
  | 'SYSTEM_MAINTENANCE'
  // --- spec D5 additions ---
  | 'USER_ROLE_CHANGE'
  | 'ACCOUNT_PASSWORD_CHANGE'
  | 'ACCOUNT_USERNAME_CHANGE'
  | 'ACCOUNT_PREFERENCES_CHANGE'
  | 'COMPANY_CREATE'
  | 'COMPANY_UPDATE'
  | 'COMPANY_DELETE'
  | 'INTEGRATION_CREATE'
  | 'INTEGRATION_UPDATE'
  | 'INTEGRATION_DELETE'
  | 'INTEGRATION_SYNC_CONFIG_CHANGE'
  | 'MAPPING_CREATE'
  | 'MAPPING_DELETE'
  | 'BUNDLE_CHANGE'
  | 'PRODUCT_RESTORE'
  | 'SIGNUP'
  | 'CATALOG_IMPORT'
  | 'BACKUP_CREATED';

export type EntityType =
  | 'USER'
  | 'PRODUCT'
  | 'INVENTORY'
  | 'LOCATION'
  | 'SETTINGS'
  | 'SYSTEM'
  | 'STAGING'
  | 'SCRATCHPAD'
  // --- spec D5 additions ---
  | 'COMPANY'
  | 'INTEGRATION'
  | 'MAPPING'
  | 'ORDER'
  | 'ACCOUNT';

export type ActorKind = 'USER' | 'SYSTEM' | 'WEBHOOK' | 'LLM';

export type Actor =
  | { userId: number; kind?: 'USER' }
  | { kind: 'SYSTEM' | 'WEBHOOK' | 'LLM'; userId?: number; envelope?: Record<string, unknown> };

export type ChangeDiff = Record<string, { from: unknown; to: unknown }>;

export interface ChangeEvent {
  actor: Actor;
  actionType: AuditActionType;
  entityType: EntityType;
  entityId?: string | number | null;
  companyId?: string;
  action: string;
  changes?: ChangeDiff;
  details?: Record<string, unknown>;
  batchId?: string;
  affectedCount?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Company-scoped entity types (spec Global Constraints). Events for these MUST
 * carry a companyId; `recordChange` asserts it (dev throw / prod record-null).
 */
export const COMPANY_SCOPED_ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'COMPANY',
  'INTEGRATION',
  'MAPPING',
  'ORDER',
]);

/**
 * Redaction denylist (spec §3 D3(c) / §10 R-D7). Exact key names, matched
 * case-insensitively; a matching key's value is replaced with `[REDACTED]`.
 */
export const REDACTED_KEYS: readonly string[] = [
  'passwordHash',
  'encryptedApiKey',
  'encryptedApiSecret',
  'webhookSecret',
  'apiKey',
  'apiSecret',
  'password',
  'newPassword',
  'currentPassword',
];

const REDACTED_KEY_SET = new Set<string>(REDACTED_KEYS.map((k) => k.toLowerCase()));
const REDACTED_MARKER = '[REDACTED]';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Fresh v4 uuid for a batch of related events (replaces the deleted singleton). */
export function newBatchId(): string {
  return uuidv4();
}

/**
 * Normalize an entity id to its canonical string form.
 * - number -> String(number) (rejects NaN / ±Infinity)
 * - string -> trimmed (rejects empty / whitespace-only)
 * - null / undefined -> null (the entity is genuinely unaddressed, e.g. bulk ops)
 */
export function normalizeEntityId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  if (typeof id === 'number') {
    if (!Number.isFinite(id)) {
      throw new Error(`[change-tracking] entityId must be a finite number, got ${String(id)}`);
    }
    return String(id);
  }
  const trimmed = id.trim();
  if (trimmed === '') {
    throw new Error('[change-tracking] entityId string must not be empty');
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Decimal-like = a non-plain, non-Date, non-array object exposing `toString`
 * (e.g. Prisma.Decimal). We compare/serialize these via String() rather than
 * traversing them.
 */
function isDecimalLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !isPlainObject(value) &&
    typeof (value as { toString?: unknown }).toString === 'function'
  );
}

/**
 * Canonicalize a value for BOTH comparison and recording:
 * - null / undefined collapse to null (so "both absent" reads as equal)
 * - Date and Decimal-like collapse to their String() form
 * - everything else passes through
 */
function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return String(value);
  if (isDecimalLike(value)) return String(value);
  return value;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = REDACTED_KEY_SET.has(key.toLowerCase()) ? REDACTED_MARKER : redactValue(val);
    }
    return out;
  }
  // Primitives, Dates, Decimals, etc. are returned as-is (not traversed).
  return value;
}

/**
 * Deep-scan copy of `value` with every denylisted key (case-insensitive exact
 * match) replaced by `[REDACTED]`. Recurses through plain objects and arrays
 * only; never mutates the input; does not descend into Dates/Decimals.
 */
export function redactDeep<T>(value: T): T {
  return redactValue(value) as T;
}

/**
 * Field-level before/after diff. Returns a changed-fields-only map. Comparison
 * is `Object.is` over canonicalized values (Date/Decimal via String(), absence
 * collapsed to null). A changed field whose name is denylisted records
 * `{ from: '[REDACTED]', to: '[REDACTED]' }` — never the real values.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: T,
  fields: (keyof T & string)[],
): ChangeDiff {
  const result: ChangeDiff = {};
  for (const field of fields) {
    const from = canonicalizeValue(before[field]);
    const to = canonicalizeValue(after[field]);
    if (Object.is(from, to)) continue;
    result[field] = REDACTED_KEY_SET.has(field.toLowerCase())
      ? { from: REDACTED_MARKER, to: REDACTED_MARKER }
      : { from, to };
  }
  return result;
}
