import { z } from 'zod';

export const CatalogRowSchema = z
  .object({
    externalProductId: z.string().min(1),
    externalVariantId: z.string().nullable(),
    parentTitle: z.string(),
    variantTitle: z.string().nullable(),
    sku: z.string().nullable(),
    type: z.enum(['simple', 'variation']),
    attributes: z.array(z.object({ name: z.string(), option: z.string() })),
    alreadyMapped: z.boolean(),
    existingMapping: z
      .object({
        linkId: z.string(),
        internalProductId: z.number().int().nullable(),
        internalProductName: z.string(),
        // Uniform shape: always present. isBundle defaults false; componentCount
        // is null for non-bundles. See app/api/integrations/[id]/catalog/route.ts.
        isBundle: z.boolean(),
        componentCount: z.number().int().nullable(),
      })
      .optional(),
    isBundleCandidate: z.boolean().optional(),
    wcBundledItems: z
      .array(
        z.object({
          productId: z.string(),
          variantId: z.string().nullable(),
          defaultQuantity: z.number().int().positive(),
        }),
      )
      .optional(),
  })
  .refine(
    (r) => r.type === 'simple' || r.externalVariantId !== null,
    { message: 'variation rows require externalVariantId', path: ['externalVariantId'] },
  );

export const CatalogWarningSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('variations-failed'),
    productId: z.string(),
    parentTitle: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('timeout-skipped'),
    productId: z.string(),
    parentTitle: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal('page-cap-reached'),
    message: z.string(),
  }),
]);

export const CatalogResponseSchema = z.object({
  integration: z.object({
    id: z.string(),
    name: z.string(),
    platform: z.enum(['WOOCOMMERCE', 'SHOPIFY']),
    storeUrl: z.string(),
  }),
  rows: z.array(CatalogRowSchema),
  fetchedAt: z.string(),
  warnings: z.array(CatalogWarningSchema),
});

export type CatalogRow = z.infer<typeof CatalogRowSchema>;
export type CatalogResponse = z.infer<typeof CatalogResponseSchema>;
