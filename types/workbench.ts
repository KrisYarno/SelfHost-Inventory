import { ProductWithQuantity } from "./product";
import type { ExternalOrder } from "./external-orders";

// Order item represents a product in the current order
export interface OrderItem {
  product: ProductWithQuantity;
  quantity: number;
  fulfillmentItemId?: string;  // ExternalOrderItem.id for fulfillment API
  source?: 'manual' | 'wc-order';  // Track origin for separate handling
}

// Metadata stored when a WC order is selected
export interface SelectedExternalOrder {
  id: string;
  orderNumber: string;
  customerName?: string;
  total?: number;
}

// Unmapped item from a WC order that couldn't be added to the cart
export interface UnmappedExternalItem {
  name: string;
  sku?: string;
  quantity: number;
  externalItemId?: string;
}

// Workbench state interface
export interface WorkbenchState {
  // Current order items
  orderItems: OrderItem[];

  // Order reference/number
  orderReference: string;

  // UI state
  isProcessing: boolean;

  // Order queue
  orderQueue: string[];

  // WC order integration state
  orderSource: 'manual' | 'wc-order';
  selectedExternalOrder: SelectedExternalOrder | null;
  unmappedExternalItems: UnmappedExternalItem[];

  // Actions
  addItem: (product: ProductWithQuantity, quantity: number, source?: 'manual' | 'wc-order', fulfillmentItemId?: string) => void;
  updateItemQuantity: (productId: number, quantity: number) => void;
  removeItem: (productId: number, fulfillmentItemId?: string) => void;
  setOrderReference: (reference: string) => void;
  clearOrder: () => void;
  setIsProcessing: (processing: boolean) => void;

  // Queue actions
  addToQueue: (reference: string) => void;
  removeFromQueue: (index: number) => void;
  clearQueue: () => void;
  advanceQueue: () => string | null;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  getQueuePosition: () => { current: number; total: number } | null;

  // WC order actions
  setOrderSource: (source: 'manual' | 'wc-order') => void;
  selectExternalOrder: (order: ExternalOrder, products: ProductWithQuantity[]) => void;
  clearExternalOrder: () => void;

  // Computed values
  getTotalItems: () => number;
  getTotalQuantity: () => number;
}

// Order deduction request
export interface DeductInventoryRequest {
  orderReference: string;
  items: {
    productId: number;
    quantity: number;
  }[];
  notes?: string;
}

// Order deduction response
export interface DeductInventoryResponse {
  success: boolean;
  transactionId: string;
  itemsProcessed: number;
  message?: string;
}

// Quantity picker options
export const QUICK_QUANTITIES = [1, 2, 3, 4, 5] as const;
export type QuickQuantity = typeof QUICK_QUANTITIES[number];