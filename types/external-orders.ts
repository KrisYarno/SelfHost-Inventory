/**
 * External Orders Type Definitions
 *
 * Mirrors the Prisma schema for ExternalOrder and ExternalOrderItem models.
 * Used for type-safe data handling in the Orders Dashboard.
 */

export type PlatformType = 'SHOPIFY' | 'WOOCOMMERCE';
export type InternalOrderStatus = 'pending' | 'processing' | 'fulfilled' | 'cancelled';

export interface ExternalOrderItem {
  id: string;
  orderId: string;
  externalItemId: string | null;
  externalProductId: string;
  externalVariantId: string | null;
  name: string;
  sku: string | null;
  quantity: number;
  fulfilledQty: number;
  price: number;
  productLinkId: string | null;
  isMapped: boolean;
  // Populated relations
  productLink?: {
    id: string;
    internalProductId: number;
    externalSku: string | null;
    externalTitle: string | null;
    internalProduct?: {
      id: number;
      name: string;
      baseName: string | null;
      variant: string | null;
    };
  };
}

export interface ExternalOrder {
  id: string;
  companyId: string;
  integrationId: string;
  externalId: string;
  orderNumber: string;
  nativeStatus: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: number;
  currency: string;
  customerEmail: string | null;
  customerName: string | null;
  rawPayload: any;
  internalStatus: InternalOrderStatus;
  fulfilledAt: Date | null;
  fulfilledBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  externalCreatedAt: Date | null;
  // Populated relations
  company?: {
    id: string;
    name: string;
    slug: string;
  };
  integration?: {
    id: string;
    platform: PlatformType;
    name: string;
    storeUrl: string;
  };
  items?: ExternalOrderItem[];
  fulfilledByUser?: {
    id: number;
    username: string;
    email: string;
  };
}

// API Request/Response Types
export interface ExternalOrderFilters {
  companyId?: string;
  platform?: PlatformType | 'ALL';
  status?: InternalOrderStatus | 'all';
  search?: string;
  page?: number;
  pageSize?: number;
  cursor?: string;
}

export interface ExternalOrdersResponse {
  orders: ExternalOrder[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface ExternalOrderDetailsResponse {
  order: ExternalOrder;
}

// UI Helper Types
export interface PlatformBadgeConfig {
  label: string;
  color: string;
  bgColor: string;
  icon: 'shopify' | 'woocommerce';
}

export const PLATFORM_CONFIGS: Record<PlatformType, PlatformBadgeConfig> = {
  SHOPIFY: {
    label: 'Shopify',
    color: 'text-white',
    bgColor: 'bg-green-600',
    icon: 'shopify',
  },
  WOOCOMMERCE: {
    label: 'WooCommerce',
    color: 'text-white',
    bgColor: 'bg-purple-600',
    icon: 'woocommerce',
  },
};

export const STATUS_COLORS: Record<InternalOrderStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  processing: 'bg-blue-100 text-blue-800 border-blue-300',
  fulfilled: 'bg-green-100 text-green-800 border-green-300',
  cancelled: 'bg-gray-100 text-gray-800 border-gray-300',
};
