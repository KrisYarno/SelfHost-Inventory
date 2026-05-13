import type { CatalogRow } from '@/types/bulk-map';

export interface ShopifyCatalogResult {
  rows: CatalogRow[];
  warnings: string[];
}

export async function fetchShopifyCatalog(
  _shopDomain: string,
  _accessToken: string,
): Promise<ShopifyCatalogResult> {
  throw new Error('Shopify bulk-map catalog fetch is not implemented yet');
}
