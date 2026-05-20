import { z } from 'zod';

// Bounds reference (matches prisma/schema.prisma):
//   product_links.externalProductId  VarChar(255)
//   product_links.externalVariantId  VarChar(255)
//   product_links.externalSku        VarChar(255)
//   product_links.externalTitle      VarChar(500)
//   products.name                    VarChar(255) -> used for snapshot internalProductName
//   bundle_components.quantity       INT (MySQL signed 2^31-1); domain max kept at 9999 to
//     guard against UI typos and to keep quantity*quantityToFulfill within safe-integer math.
// integrationId is a cuid (~25 chars); 64 covers cuid/uuid/legacy ids without hitting the
// default Prisma VarChar(191) limit.

export const BundleComponentSnapshotSchema = z.object({
  internalProductId: z.number().int().positive(),
  // internalProductName optional for backward compat with older snapshots
  internalProductName: z.string().max(255).optional(),
  quantity: z.number().int().positive().max(9999),
  // sortOrder is optional for backward compat with snapshots created before it was added
  sortOrder: z.number().int().nonnegative().max(1000).optional(),
});

export const BundleComponentSnapshotArraySchema = z
  .array(BundleComponentSnapshotSchema)
  .min(1)
  .max(50);

export const BundleComponentInputSchema = z.object({
  internalProductId: z.number().int().positive(),
  quantity: z.number().int().positive().max(9999).default(1),
});

export const CreateBundleLinkSchema = z.object({
  integrationId: z.string().min(1).max(64),
  externalProductId: z.string().min(1).max(255),
  externalVariantId: z.string().max(255).optional(),
  externalSku: z.string().max(255).optional(),
  externalTitle: z.string().max(500).optional(),
  components: z
    .array(BundleComponentInputSchema)
    .min(1, 'Bundle must have at least one component')
    .max(50, 'Bundle cannot have more than 50 components')
    .refine(
      (cs) => new Set(cs.map((c) => c.internalProductId)).size === cs.length,
      { message: 'Components must not contain duplicate internalProductId values' },
    ),
});

export const UpdateBundleLinkSchema = z.object({
  components: z
    .array(BundleComponentInputSchema)
    .min(1, 'Bundle must have at least one component')
    .max(50, 'Bundle cannot have more than 50 components')
    .refine(
      (cs) => new Set(cs.map((c) => c.internalProductId)).size === cs.length,
      { message: 'Components must not contain duplicate internalProductId values' },
    ),
});

export type CreateBundleLinkInput = z.infer<typeof CreateBundleLinkSchema>;
export type UpdateBundleLinkInput = z.infer<typeof UpdateBundleLinkSchema>;
