import { ProductWithQuantity } from "./product";
import type { ExternalOrder } from "./external-orders";
import type { SkippedLineClass } from "@/lib/workbench/skipped-lines";

// Order item represents a product in the current order
export interface OrderItem {
  product: ProductWithQuantity;
  quantity: number;
  fulfillmentItemId?: string;  // ExternalOrderItem.id for fulfillment API
  source?: 'manual' | 'wc-order';  // Track origin for separate handling
  // Facelift F0-1: what the store-order line still NEEDS (its remaining
  // quantity), stamped on every store-order cart line. `quantity` is what this
  // cart will deduct, capped at the stock here; the row says when the two
  // differ. Display only: the fulfil and deduct bodies are built field by
  // field and never carry it.
  neededQuantity?: number;
}

// Metadata stored when a WC order is selected
export interface SelectedExternalOrder {
  id: string;
  orderNumber: string;
  customerName?: string;
  total?: number;
  // P1-10: integrationId is needed by workbench to render the Map button in
  // UnmappedItemsAlert and to wire ProductMapDialog.
  integrationId?: string;
  // Facelift F0 FR1-1 (a): the location whose stock built this cart, and how
  // many deductible lines that build produced. The order outlives the page in
  // this store and the shell's location can change on any page, so "built here"
  // is recorded, never assumed: the page rebuilds while it differs from the
  // selected location, and Complete waits. Null when the rows the build read
  // were not known to be any one location's.
  builtAtLocationId: number | null;
  builtCartCount: number;
}

// Unmapped item from a WC order that couldn't be added to the cart.
// Extended with externalProductId/externalVariantId so UnmappedItemsAlert can
// hand a valid external reference to ProductMapDialog (P2: previously passed
// empty string which would create broken mappings).
//
// isBundle: bundle items can't be added to the workbench cart (cart items are
// 1:1 with a single internal product). They are surfaced as a separate row so
// operators see "Bundle — fulfill via Order Details" instead of an unmapped
// warning that suggests no mapping exists.
//
// class (W2-1 ride-along, registered at W0.5-a): the STRUCTURAL truth — which of
// `selectExternalOrder`'s push branches produced this line (four since facelift
// F0-1 added `out-of-stock`, which exists ONLY as a recorded class). Until now that
// was re-derived downstream from "does the line carry an external product
// reference?", which is correct only because the branch that omits the reference
// happens to be the one that means `unavailable`. The hook knows which branch it
// took; recording it removes the inference. Optional so a line built anywhere
// else still type-checks — classifySkippedLine falls back to the old heuristic.
export interface UnmappedExternalItem {
  name: string;
  sku?: string;
  quantity: number;
  externalItemId?: string;
  externalProductId?: string;
  externalVariantId?: string;
  isBundle?: boolean;
  class?: SkippedLineClass;
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

  // Facelift F0 FR2-1: the SELECTION's generation. Every action that changes
  // the selected order or the cart's source bumps it, and so does
  // `invalidateInFlightReads`. An order read captures it when it is issued and
  // does nothing at all if it has moved by the time the read resolves — the
  // order id alone cannot tell a clear-and-reselect of the SAME order apart.
  selectionSeq: number;

  // Actions
  addItem: (product: ProductWithQuantity, quantity: number, source?: 'manual' | 'wc-order', fulfillmentItemId?: string) => void;
  updateItemQuantity: (productId: number, quantity: number, fulfillmentItemId?: string) => void;
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
  selectExternalOrder: (
    order: ExternalOrder,
    products: ProductWithQuantity[],
    locationId: number | null
  ) => void;
  clearExternalOrder: () => void;
  // FR2-1: bumps `selectionSeq` alone, so every order read in flight is stale.
  invalidateInFlightReads: () => void;

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