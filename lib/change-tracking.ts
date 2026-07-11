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

import { Prisma } from '@prisma/client';
import { headers } from 'next/headers';
import { v4 as uuidv4 } from 'uuid';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Taxonomy (spec §3 D5). Seeded from lib/audit.ts's current unions and EXTENDED
// with the D5 additions. Nothing is removed yet — the never-emitted members die
// with lib/audit.ts in Task 14.
// ---------------------------------------------------------------------------

// D5 closure prune (Phase B T10): EMAIL_SENT, SYSTEM_MAINTENANCE,
// INVENTORY_STOCK_IN, INVENTORY_DEDUCTION, LOCATION_UPDATE, PRODUCT_BULK_DELETE,
// CATALOG_IMPORT (spec R-D17) removed — grep-verified zero emit sites;
// historical DB rows render via the log-style unknown-actionType fallback.
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
  | 'PRODUCT_APPROVE'
  | 'PRODUCT_DECLINE'
  | 'STAGING_CREATE'
  | 'STAGING_GRADUATE'
  | 'STAGING_DISCARD'
  | 'SCRATCHPAD_CREATE'
  | 'SCRATCHPAD_UPDATE'
  | 'SCRATCHPAD_DELETE'
  | 'INVENTORY_ADJUSTMENT'
  | 'INVENTORY_BULK_UPDATE'
  | 'INVENTORY_TRANSFER'
  | 'INVENTORY_TRANSFER_AUTO_ADD'
  | 'EXTERNAL_ORDER_FULFILLMENT'
  | 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT'
  | 'EXTERNAL_ORDER_UNFULFILLMENT'
  | 'LOCATION_CREATE'
  | 'LOCATION_DELETE'
  | 'SETTINGS_UPDATE'
  | 'DATA_EXPORT'
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
  | 'BACKUP_CREATED'
  // --- Phase B additions ---
  | 'STAGING_UPDATE'
  | 'EXTERNAL_ORDER_CREATE'
  | 'EXTERNAL_ORDER_UPDATE'
  | 'EXTERNAL_ORDER_DELETE'
  // --- Lane 3 additions (spec R-L14): the admin manual-rebuild action. Run
  // telemetry itself stays out of the audit log -- only the human TRIGGER is
  // recorded.
  | 'ANALYTICS_REBUILD_TRIGGER';

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

// ---------------------------------------------------------------------------
// Write path — shared payload assembly
// ---------------------------------------------------------------------------

/** Best-effort ip/userAgent from the request; absent for machine callers. */
async function captureRequestContext(): Promise<{ ipAddress?: string; userAgent?: string }> {
  try {
    const headersList = await headers();
    return {
      ipAddress:
        headersList.get('x-forwarded-for')?.split(',')[0] ||
        headersList.get('x-real-ip') ||
        undefined,
      userAgent: headersList.get('user-agent') || undefined,
    };
  } catch {
    // headers() throws when called outside a request scope (SYSTEM/WEBHOOK). Fine.
    return {};
  }
}

/**
 * Resolve a ChangeEvent into the `audit_logs` create payload:
 *   - actor -> (userId|null, actorKind)
 *   - entityId normalized to string|null
 *   - companyId asserted for company-scoped types (dev throw / prod record-null)
 *   - details = redactDeep({ ...details, changes, actor:envelope })
 *   - ip/userAgent captured from headers()
 * Shared by both write tiers so the row shape is identical regardless of path.
 */
async function buildAuditData(event: ChangeEvent): Promise<Prisma.AuditLogUncheckedCreateInput> {
  const actorKind: ActorKind = event.actor.kind ?? 'USER';
  const userId = event.actor.userId ?? null;

  let companyId: string | null = event.companyId ?? null;
  if (COMPANY_SCOPED_ENTITY_TYPES.has(event.entityType) && !companyId) {
    const message = `[change-tracking] companyId is required for company-scoped entityType "${event.entityType}" (actionType ${event.actionType})`;
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(message);
    }
    console.error(message);
    companyId = null;
  }

  const mergedDetails: Record<string, unknown> = { ...(event.details ?? {}) };
  if (event.changes && Object.keys(event.changes).length > 0) {
    mergedDetails.changes = event.changes;
  }
  const envelope = 'envelope' in event.actor ? event.actor.envelope : undefined;
  if (envelope && Object.keys(envelope).length > 0) {
    mergedDetails.actor = envelope;
  }
  const redactedDetails = redactDeep(mergedDetails);
  const details =
    Object.keys(redactedDetails).length > 0
      ? (redactedDetails as Prisma.InputJsonValue)
      : undefined;

  const { ipAddress, userAgent } = await captureRequestContext();

  return {
    userId,
    actorKind,
    companyId,
    actionType: event.actionType,
    entityType: event.entityType,
    entityId: normalizeEntityId(event.entityId),
    action: event.action,
    details,
    affectedCount: event.affectedCount ?? 1,
    batchId: event.batchId ?? null,
    ipAddress,
    userAgent,
  };
}

/**
 * TRANSACTIONAL, hard-abort write (spec §3 D3(a) / §10 R-D2). MUST be called with
 * the SAME `tx` as the mutation it records — it does NOT catch: a failed record
 * aborts the caller's transaction, so an unrecordable user change never commits.
 * (companyId assertion throws in dev; the create rejection propagates.)
 */
export async function recordChange(
  tx: Prisma.TransactionClient,
  event: ChangeEvent,
): Promise<void> {
  const data = await buildAuditData(event);
  await tx.auditLog.create({ data });
}

/**
 * BEST-EFFORT write for machine ingestion paths (webhook/cron) (spec §3 / §10
 * R-D2). Uses its own implicit transaction (`prisma.auditLog.create`) and NEVER
 * throws into the caller: on failure it logs, awaits `opts.onFailure` (which is
 * itself try/caught so a broken health hook cannot surface), and returns false.
 * Returns true when the row is written. Callers wire `onFailure` to their health
 * counter (webhooks: webhookFailureCount/lastWebhookError; cron: job lastError).
 */
export async function recordIngestion(
  event: ChangeEvent,
  opts?: { onFailure?: (err: unknown) => void | Promise<void> },
): Promise<boolean> {
  try {
    const data = await buildAuditData(event);
    await prisma.auditLog.create({ data });
    return true;
  } catch (err) {
    console.error('[change-tracking] ingestion record failed', err);
    if (opts?.onFailure) {
      try {
        await opts.onFailure(err);
      } catch (callbackErr) {
        console.error('[change-tracking] ingestion onFailure callback threw', callbackErr);
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Read path (spec §4 read-path compat / §10 R-D5). Ported verbatim from
// lib/audit.ts's AuditService.getAuditLogs/getBatchLogs — same query, same
// include shape, same ordering. The ONLY change is the filter's `entityId`
// type: `number` -> `string`, matching the migrated VARCHAR(64) column so both
// numeric-string ids (`"42"`) and cuid strings filter identically.
// ---------------------------------------------------------------------------

/**
 * Retrieve audit logs with filtering.
 */
export async function getAuditLogs(filters: {
  userId?: number
  actionType?: AuditActionType
  entityType?: EntityType
  entityId?: string
  batchId?: string
  startDate?: Date
  endDate?: Date
  limit?: number
  offset?: number
}) {
  const where: any = {}

  if (filters.userId) where.userId = filters.userId
  if (filters.actionType) where.actionType = filters.actionType
  if (filters.entityType) where.entityType = filters.entityType
  if (filters.entityId) where.entityId = filters.entityId
  if (filters.batchId) where.batchId = filters.batchId

  if (filters.startDate || filters.endDate) {
    where.createdAt = {}
    if (filters.startDate) where.createdAt.gte = filters.startDate
    if (filters.endDate) where.createdAt.lte = filters.endDate
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit || 50,
      skip: filters.offset || 0
    }),
    prisma.auditLog.count({ where })
  ])

  return { logs, total }
}
