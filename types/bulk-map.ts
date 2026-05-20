export interface CatalogRow {
  externalProductId: string;
  externalVariantId: string | null;
  parentTitle: string;
  variantTitle: string | null;
  sku: string | null;
  type: 'simple' | 'variation';
  attributes: Array<{ name: string; option: string }>;
  alreadyMapped: boolean;
  existingMapping?: {
    linkId: string;
    internalProductId: number | null;
    internalProductName: string;
    // Uniform shape: always present. isBundle defaults false for single
    // mappings; componentCount is null for non-bundles.
    isBundle: boolean;
    componentCount: number | null;
  };
  isBundleCandidate?: boolean;
  wcBundledItems?: Array<{
    productId: string;
    variantId: string | null;
    defaultQuantity: number;
  }>;
}

export type CatalogWarning =
  | {
      kind: 'variations-failed';
      productId: string;
      parentTitle: string;
      message: string;
    }
  | {
      kind: 'timeout-skipped';
      productId: string;
      parentTitle: string;
      message: string;
    }
  | {
      kind: 'page-cap-reached';
      message: string;
    };

export interface CatalogResponse {
  integration: {
    id: string;
    name: string;
    platform: 'WOOCOMMERCE' | 'SHOPIFY';
    storeUrl: string;
  };
  rows: CatalogRow[];
  fetchedAt: string;
  warnings: CatalogWarning[];
}

export interface InternalProductIndexEntry {
  id: number;
  name: string;
  baseName: string | null;
  variant: string | null;
  numericValue: number | null;
  unit: string | null;
  baseNameTokens: string[];
  hasAnyMapping: boolean;
  existingMappingNote?: string;
}

export type RowState =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'confirming'; internalProductId: number }
  | { kind: 'mapped'; linkId: string; internalProductId: number; internalProductName: string }
  | { kind: 'error'; message: string; internalProductId: number };

export type PickerState =
  | { kind: 'idle' }
  | { kind: 'selecting'; rowKey: string }
  | { kind: 'ready'; rowKey: string; internalProductId: number }
  | { kind: 'saving'; rowKey: string; internalProductId: number }
  | { kind: 'success'; rowKey: string; mappedTo: string }
  | { kind: 'error'; rowKey: string; message: string; internalProductId: number };

export type SuggestionReason = 'title+size' | 'title' | 'size';

export interface Suggestion {
  product: InternalProductIndexEntry;
  score: number;
  reason: SuggestionReason;
  greyed: boolean;
}

export function rowKey(row: Pick<CatalogRow, 'externalProductId' | 'externalVariantId'>): string {
  return `${row.externalProductId}::${row.externalVariantId ?? ''}`;
}

export interface BundleComponentSnapshot {
  internalProductId: number;
  internalProductName: string;
  quantity: number;
  sortOrder: number;
}
