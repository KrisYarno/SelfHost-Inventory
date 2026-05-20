import { z } from 'zod';

export const BundleComponentSnapshotSchema = z.object({
  internalProductId: z.number().int().positive(),
  // internalProductName optional for backward compat with older snapshots
  internalProductName: z.string().optional(),
  quantity: z.number().int().positive(),
  // sortOrder is optional for backward compat with snapshots created before it was added
  sortOrder: z.number().int().nonnegative().optional(),
});

export const BundleComponentSnapshotArraySchema = z.array(BundleComponentSnapshotSchema).min(1);

export const BundleComponentInputSchema = z.object({
  internalProductId: z.number().int().positive(),
  quantity: z.number().int().positive().default(1),
});

export const CreateBundleLinkSchema = z.object({
  integrationId: z.string().min(1),
  externalProductId: z.string().min(1),
  externalVariantId: z.string().optional(),
  externalSku: z.string().optional(),
  externalTitle: z.string().optional(),
  components: z
    .array(BundleComponentInputSchema)
    .min(1, 'Bundle must have at least one component')
    .refine(
      (cs) => new Set(cs.map((c) => c.internalProductId)).size === cs.length,
      { message: 'Components must not contain duplicate internalProductId values' },
    ),
});

export const UpdateBundleLinkSchema = z.object({
  components: z
    .array(BundleComponentInputSchema)
    .min(1, 'Bundle must have at least one component')
    .refine(
      (cs) => new Set(cs.map((c) => c.internalProductId)).size === cs.length,
      { message: 'Components must not contain duplicate internalProductId values' },
    ),
});

export type CreateBundleLinkInput = z.infer<typeof CreateBundleLinkSchema>;
export type UpdateBundleLinkInput = z.infer<typeof UpdateBundleLinkSchema>;
