/**
 * @jest-environment node
 *
 * Guard tests for `lib/change-tracking.ts` (plan Task 6; spec §10 R-D7 + R-D15).
 *
 * Test 1 (R-D7)  — redaction schema scan: every Prisma schema FIELD whose name
 *                  matches /secret|password|token|key|hash/i must be covered by
 *                  the runtime redaction denylist (REDACTED_KEYS) or explicitly
 *                  classified as safe in SAFE_FIELDS below. A new secret-shaped
 *                  column added without a redaction decision fails this test BY
 *                  NAME.
 * Test 2 (R-D15) — actionType taxonomy shape: every AuditActionType union member
 *                  must end in a known verb. The union is a TYPE (erased at
 *                  runtime), and this test deliberately does NOT depend on a
 *                  parallel value-array in the module: it parses the union's
 *                  source text, so members added to the type without touching
 *                  any runtime list are still guarded.
 *
 * Both tests import ONLY the stable Task-2 exports (REDACTED_KEYS + the type
 * unions); everything else is derived from source text on disk.
 */

import fs from 'fs';
import path from 'path';

// lib/change-tracking.ts transitively imports @/lib/prisma (instantiates
// PrismaClient) and next/headers; neither is exercised here — stub both.
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('next/headers', () => ({ headers: jest.fn() }));

import { REDACTED_KEYS, type AuditActionType } from '@/lib/change-tracking';

const SCHEMA_PATH = path.join(process.cwd(), 'prisma', 'schema.prisma');
const CHANGE_TRACKING_PATH = path.join(process.cwd(), 'lib', 'change-tracking.ts');

// ---------------------------------------------------------------------------
// Test 1 (R-D7) — redaction schema scan
// ---------------------------------------------------------------------------

/** Field-name shape that demands a redaction decision. */
const SECRET_SHAPED = /secret|password|token|key|hash/i;

/**
 * Schema fields that MATCH `SECRET_SHAPED` but are verified non-secret. Every
 * entry here was checked against the actual schema declaration and usage:
 *
 * - `key`                — SystemSetting.key: the settings row's lookup NAME
 *                          (`@id VarChar(100)`, e.g. a feature-flag id); the
 *                          value lives in the `value` column.
 * - `dayKey`             — ProductStockSnapshot / ProductSalesFact day-grain
 *                          key (`Char(10)`, "YYYY-MM-DD"). "key" = grouping
 *                          key, not credential.
 * - `externalStatusHash` — ExternalOrder change-detection fingerprint of the
 *                          platform status payload (`VarChar(64)`, R-D4 gate);
 *                          a digest for dedupe, not secret material.
 *
 * NOT allowlisted (the plan seeded these, but they do NOT match SECRET_SHAPED
 * — allowlisting ghosts would silently pre-approve future secret-shaped fields
 * that happen to reuse the name): batchId, entityId, transferId,
 * priceSourceLinkId, webhookFailureCount, lastWebhookReceivedAt. The
 * "allowlist entries must be real matchers present in the schema" assertion
 * below enforces this permanently.
 */
export const SAFE_FIELDS: readonly string[] = [
  'key',
  'dayKey',
  'externalStatusHash',
  // Lane 4 (R-A4): AssistantRun.tokenId is a cuid REFERENCE to api_tokens.id,
  // not secret material (the secret's digest lives in tokenHash, which is
  // denylisted). Safe to appear in telemetry rows.
  'tokenId',
  // Multi-user substrate (spec C1/G2): AssistantRequest token COUNTS as reported
  // by the provider (nullable Ints; NULL = not reported) — usage telemetry the
  // admin usage page exists to display, never credential material. Redacting
  // them would erase the usage feature's own data.
  'inputTokens',
  'outputTokens',
  'totalTokens',
];

interface SchemaField {
  model: string;
  field: string;
}

/**
 * Extract `{ model, field }` for every field declared inside a `model` block.
 * Enum/generator/datasource blocks are excluded; `@@` block attributes and
 * comment lines are skipped. Relation fields count too — their NAMES surface
 * in payloads just like scalars.
 */
function parseModelFields(schemaSource: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let currentModel: string | null = null;

  for (const rawLine of schemaSource.split('\n')) {
    const line = rawLine.split('//')[0]; // strip // and /// comments
    const modelStart = line.match(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
    if (modelStart) {
      currentModel = modelStart[1];
      continue;
    }
    if (/^\s*\}/.test(line)) {
      currentModel = null;
      continue;
    }
    if (!currentModel) continue;
    const fieldMatch = line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s+\S/);
    if (!fieldMatch) continue;
    fields.push({ model: currentModel, field: fieldMatch[1] });
  }

  return fields;
}

describe('R-D7 guard: every secret-shaped schema field has a redaction decision', () => {
  const schemaSource = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const allFields = parseModelFields(schemaSource);
  const redactedLower = new Set(REDACTED_KEYS.map((k) => k.toLowerCase()));

  it('parses the schema into a plausible field list (parser self-check)', () => {
    // If the parser regresses to zero/near-zero fields, the scan below would
    // pass vacuously — pin a floor and two known sentinels instead.
    expect(allFields.length).toBeGreaterThan(100);
    expect(allFields).toContainEqual({ model: 'User', field: 'passwordHash' });
    expect(allFields).toContainEqual({ model: 'Integration', field: 'webhookSecret' });
  });

  it('every SAFE_FIELDS entry is a real secret-shaped schema field (no ghosts)', () => {
    const schemaFieldNames = new Set(allFields.map((f) => f.field));
    for (const safe of SAFE_FIELDS) {
      expect(safe).toMatch(SECRET_SHAPED);
      expect(schemaFieldNames.has(safe)).toBe(true);
    }
  });

  it('classifies every field matching /secret|password|token|key|hash/i', () => {
    const unclassified = allFields
      .filter(({ field }) => SECRET_SHAPED.test(field))
      .filter(({ field }) => !redactedLower.has(field.toLowerCase()))
      .filter(({ field }) => !SAFE_FIELDS.includes(field))
      .map(({ model, field }) => `${model}.${field}`);

    // A failure names the field: add it to REDACTED_KEYS in
    // lib/change-tracking.ts (secret) or to SAFE_FIELDS above (verified safe,
    // with a justification comment).
    expect(unclassified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 2 (R-D15) — actionType verb-suffix taxonomy guard
// ---------------------------------------------------------------------------

/**
 * Known trailing verbs (plan Task 6 list, tuned to the final union):
 * - `DELETION` added: USER_DELETION is an active member; nominalization
 *   parallel to APPROVAL/REJECTION/ADJUSTMENT/DEDUCTION already in the list.
 * - `STOCK_IN` added: covers legacy INVENTORY_STOCK_IN (never-emitted, dies
 *   with lib/audit.ts in Task 14) and matches the live inventory_logs_logType
 *   STOCK_IN value, so the verb may outlive the legacy member. If Task 14
 *   removes INVENTORY_STOCK_IN and no STOCK_IN action returns, prune it here.
 * Other legacy-until-Task-14 members (EMAIL_SENT, SYSTEM_MAINTENANCE,
 * INVENTORY_DEDUCTION, PRODUCT_BULK_DELETE, INVENTORY_ADJUSTMENT,
 * LOCATION_UPDATE) are covered by the plan's own verbs — no allowlist needed.
 */
const KNOWN_VERBS: readonly string[] = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'DELETION',
  'APPROVE',
  'APPROVAL',
  'DECLINE',
  'REJECT',
  'REJECTION',
  'RESTORE',
  'GRADUATE',
  'DISCARD',
  'TRANSFER',
  'ADJUSTMENT',
  'DEDUCTION',
  'FULFILLMENT',
  'UNFULFILLMENT',
  'CHANGE',
  'IMPORT',
  'EXPORT',
  'SIGNUP',
  'CREATED',
  'SYNC',
  'AUTO_ADD',
  'MAINTENANCE',
  'SENT',
  'BULK_UPDATE',
  'STOCK_IN',
  // Lane 3 (R-L14): ANALYTICS_REBUILD_TRIGGER -- the manual-rebuild admin action.
  'TRIGGER',
  // Lane 4 (D7): API_TOKEN_REVOKE -- token administration.
  'REVOKE',
  // Lane 6 (D-E5): PLATFORM_WRITE_ATTEMPT -- every outbound platform write,
  // sent / blocked / dry-run.
  'ATTEMPT',
  // Inventory-accuracy lane (pack REV-2 T4): the receiving header's lifecycle
  // (SHIPMENT_CLOSE / SHIPMENT_CANCEL) and its line membership
  // (SHIPMENT_LINK / SHIPMENT_UNLINK).
  'CLOSE',
  'CANCEL',
  'LINK',
  'UNLINK',
  // W1-2b: STAGING_RECOUNT -- the count endpoint's audit verb (first count and
  // every recount alike).
  'RECOUNT',
];

/**
 * Parse the AuditActionType union's members out of lib/change-tracking.ts
 * source. Anchored on the type DECLARATION and stopped at its terminating
 * `;`, so concurrent additions elsewhere in the module (e.g. Task 5's read
 * functions) cannot leak into the parse.
 *
 * W1-2b PARSER FIX: the old one-shot regex (`=([\s\S]*?);`) stopped at the
 * first semicolon of any kind — including one inside a MEMBER COMMENT. The
 * Lane 4 block ("...via the deep scan; token/hash never enter payloads")
 * carries exactly that, so the union silently truncated four members short and
 * this gate, the taxonomy completeness gate, and the admin filter all agreed on
 * a union that was missing AI_PROVIDER_CREATE / AI_PROVIDER_UPDATE /
 * API_TOKEN_CREATE / API_TOKEN_REVOKE. Comments are stripped BEFORE the
 * terminator is located, so the parse ends at the union's real end.
 */
function parseAuditActionTypeMembers(moduleSource: string): string[] {
  const start = moduleSource.search(/export type AuditActionType\s*=/);
  if (start < 0) {
    throw new Error(
      '[guards] could not locate the `export type AuditActionType =` declaration in lib/change-tracking.ts',
    );
  }
  const decommented = moduleSource
    .slice(start)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const end = decommented.indexOf(';');
  if (end < 0) {
    throw new Error('[guards] the AuditActionType declaration has no terminating `;`');
  }
  const memberRe = /['"]([A-Z0-9_]+)['"]/g;
  const members: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = memberRe.exec(decommented.slice(0, end))) !== null) {
    members.push(match[1]);
  }
  return members;
}

// Compile-time link between the parsed source and the exported type: if the
// union were renamed/retyped, this line (and the import above) breaks.
const SENTINEL_MEMBERS: readonly AuditActionType[] = [
  'PRODUCT_UPDATE', // carried-over section
  'USER_ROLE_CHANGE', // spec D5 additions section
  'BACKUP_CREATED', // mid-union anchor
  // W1-2b: the two members that sit AFTER the semicolon-bearing Lane 4 comment.
  // They are the truncation regression pin — the pre-fix parser saw neither.
  'AI_PROVIDER_CREATE',
  'API_TOKEN_REVOKE', // last member — proves the parse reached the real end
];

describe('R-D15 guard: every AuditActionType member ends in a known verb', () => {
  const moduleSource = fs.readFileSync(CHANGE_TRACKING_PATH, 'utf8');
  const members = parseAuditActionTypeMembers(moduleSource);

  it('parses a plausible member list (parser self-check)', () => {
    // 52 members today; Task 14 removes ~7 legacy ones — floor at 40.
    expect(members.length).toBeGreaterThanOrEqual(40);
    for (const sentinel of SENTINEL_MEMBERS) {
      expect(members).toContain(sentinel);
    }
    // Duplicate members in a union are dead weight and usually a merge slip.
    expect(new Set(members).size).toBe(members.length);
  });

  it('every member is a known verb or ends in _<verb>', () => {
    const violators = members.filter(
      (member) => !KNOWN_VERBS.some((verb) => member === verb || member.endsWith(`_${verb}`)),
    );

    // A failure names the member: pick an existing verb suffix for the new
    // actionType, or (for a genuinely new operation kind) add the verb to
    // KNOWN_VERBS here.
    expect(violators).toEqual([]);
  });
});
