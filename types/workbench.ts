import { ProductWithQuantity } from "./product";

// Order item represents a product in the current order
export interface OrderItem {
  product: ProductWithQuantity;
  quantity: number;
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

  // Actions
  addItem: (product: ProductWithQuantity, quantity: number) => void;
  updateItemQuantity: (productId: number, quantity: number) => void;
  removeItem: (productId: number) => void;
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