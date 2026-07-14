/**
 * lib/integrations/public-select.ts — the ONE allowlist of Integration fields
 * that may leave the server.
 *
 * WHY AN ALLOWLIST AND NOT A DESTRUCTURING OMIT (REV-2 #10):
 * The admin routes used to redact by omission —
 *
 *   const { encryptedApiKey: _a, encryptedApiSecret: _b, webhookSecret: _c, ...safe } = row;
 *
 * — which fails OPEN. Every new secret column added to `Integration` leaks by
 * default until somebody remembers to extend the destructure. Lane 6 adds FOUR
 * such columns (encryptedWriteKey/Secret, encryptedReadKey/Secret); the next lane
 * will add more.
 *
 * A Prisma `select` allowlist fails CLOSED: a new column is invisible to the API
 * until it is explicitly, deliberately added here.
 *
 * NOTHING SECRET GOES IN THIS OBJECT. There is a test that proves it
 * (`__tests__/integration/api/lane6-integration-credential-redaction.test.ts`)
 * by cross-checking against the Prisma schema's encrypted-field list.
 */

export const PUBLIC_INTEGRATION_SELECT = {
  id: true,
  companyId: true,
  platform: true,
  name: true,
  storeUrl: true,
  isActive: true,
  lastSyncAt: true,
  createdAt: true,
  updatedAt: true,
  stockSyncEnabled: true,
  fulfillmentPushEnabled: true,
  lastStockSyncAt: true,
  lastStockSyncError: true,
  lastSyncError: true,
  syncLockedAt: true,
  syncLocationId: true,
  lastWebhookReceivedAt: true,
  lastWebhookError: true,
  webhookFailureCount: true,
} as const;

/**
 * The credential-presence booleans the admin UI needs in order to show "a write
 * key is on file" / "no read key yet" WITHOUT ever shipping the material itself.
 * Computed server-side from the encrypted columns; only the booleans are sent.
 */
export interface IntegrationCredentialStatus {
  hasWriteCredential: boolean;
  hasReadCredential: boolean;
  hasWebhookSecret: boolean;
}

export function credentialStatus(row: {
  encryptedWriteKey: string | null;
  encryptedWriteSecret: string | null;
  encryptedReadKey: string | null;
  encryptedReadSecret: string | null;
  webhookSecret: string | null;
}): IntegrationCredentialStatus {
  return {
    hasWriteCredential: !!row.encryptedWriteKey && !!row.encryptedWriteSecret,
    hasReadCredential: !!row.encryptedReadKey && !!row.encryptedReadSecret,
    hasWebhookSecret: !!row.webhookSecret,
  };
}

/** Select for the credential-presence booleans only. Never returned verbatim. */
export const CREDENTIAL_PRESENCE_SELECT = {
  encryptedWriteKey: true,
  encryptedWriteSecret: true,
  encryptedReadKey: true,
  encryptedReadSecret: true,
  webhookSecret: true,
} as const;

/** The exact set of Integration columns that hold secret material. */
export const INTEGRATION_SECRET_FIELDS = [
  "encryptedWriteKey",
  "encryptedWriteSecret",
  "encryptedReadKey",
  "encryptedReadSecret",
  "webhookSecret",
] as const;

/**
 * Build the API representation of an Integration by CONSTRUCTION, not by
 * filtering.
 *
 * This is the fail-closed direction. `{ ...row }` minus a denylist leaks every
 * field somebody forgets to deny; building the object key-by-key from the
 * allowlist means an unlisted column simply never appears. A secret can only
 * escape if someone types its name into PUBLIC_INTEGRATION_SELECT below — which
 * is exactly the deliberate, reviewable act we want it to be.
 */
export function toPublicIntegration<
  T extends Record<string, unknown>,
>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PUBLIC_INTEGRATION_SELECT)) {
    if (key in row) out[key] = row[key];
  }
  // Relations the admin list/detail views carry alongside the scalar allowlist.
  if ("company" in row) out.company = row.company;
  if ("_count" in row) out._count = row._count;
  return out;
}
