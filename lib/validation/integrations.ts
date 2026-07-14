import { z } from 'zod';

/**
 * Store URL must be a parseable absolute URL — mirrors the `new URL()` guard the
 * integration routes previously ran inline (same "Invalid store URL" message).
 * Bounded at VarChar(500) to match Integration.storeUrl.
 */
const storeUrlField = z
  .string()
  .trim()
  .min(1, 'Missing required fields')
  .max(500)
  .refine((v) => {
    try {
      new URL(v);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid store URL');

/**
 * Lane 6 (R-E8): credentials are provisioned as two explicit PAIRS.
 *
 *   writeKey / writeSecret — the write-capable key. Only the two egress write
 *                            functions can ever resolve it. Absent => every
 *                            write blocks with `no_write_credential`.
 *   readKey  / readSecret  — a Woo READ-permission key. Every read path uses it
 *                            and is therefore physically unable to mutate the store.
 *
 * The write pair is REQUIRED on create (it is the rename of the historical
 * apiKey/apiSecret, so existing integrations keep working). The read pair is
 * optional at create time — an integration without one falls back to the write
 * pair for reads and health warns until Kris provisions a read-only key in Woo.
 */

// POST /api/admin/integrations
export const CreateIntegrationSchema = z.object({
  companyId: z.string().min(1, 'Missing required fields'),
  platform: z.enum(['SHOPIFY', 'WOOCOMMERCE'], {
    errorMap: () => ({ message: 'Invalid platform. Must be SHOPIFY or WOOCOMMERCE' }),
  }),
  name: z.string().trim().min(1, 'Missing required fields').max(255),
  storeUrl: storeUrlField,
  writeKey: z.string().trim().min(1, 'Missing required fields'),
  writeSecret: z.string().trim().min(1, 'Missing required fields'),
  // Optional at create: the migration-grace fallback covers an absent read pair.
  readKey: z.string().trim().optional(),
  readSecret: z.string().trim().optional(),
  // Optional; an empty string means "fall back to env / null" per handler logic.
  webhookSecret: z.string().optional(),
});

/**
 * PUT /api/admin/integrations/[id] — partial update. Callers send either the
 * full edit form or a single-field toggle. Credential fields are left un-trimmed
 * optional strings so the handler's "empty string = leave unchanged" semantics
 * are preserved (it only re-encrypts truthy values). Unknown keys the edit form
 * also carries (companyId, platform) are stripped by zod's default.
 */
export const UpdateIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  storeUrl: storeUrlField.optional(),
  writeKey: z.string().optional(),
  writeSecret: z.string().optional(),
  readKey: z.string().optional(),
  readSecret: z.string().optional(),
  webhookSecret: z.string().optional(),
  isActive: z.boolean().optional(),
  stockSyncEnabled: z.boolean().optional(),
  fulfillmentPushEnabled: z.boolean().optional(),
  syncLocationId: z.number().int().nullable().optional(),
});

/**
 * Shared by POST /api/admin/integrations/[id]/sync and POST /api/cron/external-sync.
 * Both read an optional lookback window + max-order cap from the body (either may
 * be absent — the sync dialog omits a field when its input isn't a finite number).
 */
export const SyncOrdersSchema = z.object({
  lookbackDays: z.number().optional(),
  maxOrders: z.number().optional(),
});

export type CreateIntegrationInput = z.infer<typeof CreateIntegrationSchema>;
export type UpdateIntegrationInput = z.infer<typeof UpdateIntegrationSchema>;
export type SyncOrdersInput = z.infer<typeof SyncOrdersSchema>;
