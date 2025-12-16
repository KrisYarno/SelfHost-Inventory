export interface ProductLink {
  id: string;
  integrationId: string;
  internalProductId: number;
  externalProductId: string;
  externalVariantId: string | null;
  externalSku: string | null;
  externalTitle: string | null;
  createdAt: Date;
  integration?: {
    id: string;
    name: string;
    platform: string;
  };
}

export interface ExternalProductSearchResult {
  externalId: string;
  externalVariantId?: string;
  title: string;
  variantTitle?: string;
  sku?: string;
  price?: number;
  imageUrl?: string;
}

export interface CreateProductLinkRequest {
  integrationId: string;
  externalProductId: string;
  externalVariantId?: string;
  externalSku?: string;
  externalTitle?: string;
}
