import { z } from 'zod';
import {
  isCatalogProductId,
  NO_STORE_PRODUCT_MAPPING_REFUSAL,
} from '@/lib/orders/catalog-product-id';

/**
 * Validation schema for creating a product link
 */
export const CreateProductLinkSchema = z.object({
  integrationId: z.string().min(1, 'Integration ID is required'),
  // A line with no store product ("" / "0", e.g. typed by hand in the store) has
  // nothing to map: refused here so the create's backfill can never attach those
  // lines. `""` still reports the `min` message first.
  externalProductId: z
    .string()
    .min(1, 'External product ID is required')
    .refine(isCatalogProductId, { message: NO_STORE_PRODUCT_MAPPING_REFUSAL }),
  externalVariantId: z.string().optional(),
  externalSku: z.string().optional(),
  externalTitle: z.string().optional(),
});

/**
 * Validation schema for product link query parameters (e.g., linkId for DELETE)
 */
export const ProductLinkQuerySchema = z.object({
  linkId: z.string().min(1, 'Link ID is required'),
});

/**
 * Validation schema for external product search query
 */
export const SearchProductsQuerySchema = z.object({
  q: z.string().min(1, 'Search query is required'),
});

export type CreateProductLinkInput = z.infer<typeof CreateProductLinkSchema>;
export type ProductLinkQueryInput = z.infer<typeof ProductLinkQuerySchema>;
export type SearchProductsQueryInput = z.infer<typeof SearchProductsQuerySchema>;
