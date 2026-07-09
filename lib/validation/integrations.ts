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

// POST /api/admin/integrations
export const CreateIntegrationSchema = z.object({
  companyId: z.string().min(1, 'Missing required fields'),
  platform: z.enum(['SHOPIFY', 'WOOCOMMERCE'], {
    errorMap: () => ({ message: 'Invalid platform. Must be SHOPIFY or WOOCOMMERCE' }),
  }),
  name: z.string().trim().min(1, 'Missing required fields').max(255),
  storeUrl: storeUrlField,
  apiKey: z.string().trim().min(1, 'Missing required fields'),
  apiSecret: z.string().trim().min(1, 'Missing required fields'),
  // Optional; an empty string means "fall back to env / null" per handler logic.
  webhookSecret: z.string().optional(),
});

/**
 * PUT /api/admin/integrations/[id] — partial update. Callers send either the
 * full edit form or a single-field toggle. apiKey/apiSecret/webhookSecret are
 * left un-trimmed strings so the handler's "empty string = leave unchanged"
 * semantics are preserved (it only re-encrypts truthy values). Unknown keys the
 * edit form also carries (companyId, platform) are stripped by zod's default.
 */
export const UpdateIntegrationSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  storeUrl: storeUrlField.optional(),
  apiKey: z.string().optional(),
  apiSecret: z.string().optional(),
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
