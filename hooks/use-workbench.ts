import { create } from "zustand";
import { WorkbenchState, OrderItem, UnmappedExternalItem } from "@/types/workbench";
import { ProductWithQuantity } from "@/types/product";
import type { ExternalOrder } from "@/types/external-orders";
import { toast } from "sonner";

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  // Initial state
  orderItems: [],
  orderReference: "",
  isProcessing: false,
  orderQueue: [],

  // WC order integration state
  orderSource: 'manual' as const,
  selectedExternalOrder: null,
  unmappedExternalItems: [],

  // Actions
  // Amendment 5: items with different sources don't merge (even same product)
  addItem: (product: ProductWithQuantity, quantity: number, source?: 'manual' | 'wc-order', fulfillmentItemId?: string) => {
    set((state) => {
      const itemSource = source || 'manual';

      // Only merge items with the same product AND same source
      const existingItemIndex = state.orderItems.findIndex(
        (item) => item.product.id === product.id && (item.source || 'manual') === itemSource
      );

      if (existingItemIndex !== -1) {
        // Update existing item quantity
        const newItems = [...state.orderItems];
        newItems[existingItemIndex] = { ...newItems[existingItemIndex] };
        newItems[existingItemIndex].quantity += quantity;

        // Don't exceed available stock
        if (newItems[existingItemIndex].quantity > product.currentQuantity) {
          newItems[existingItemIndex].quantity = product.currentQuantity;
        }

        return { orderItems: newItems };
      } else {
        // Add new item
        const actualQuantity = Math.min(quantity, product.currentQuantity);
        return {
          orderItems: [...state.orderItems, {
            product,
            quantity: actualQuantity,
            source: itemSource,
            fulfillmentItemId,
          }],
        };
      }
    });
  },

  // Amendment 5: updateItemQuantity uses fulfillmentItemId to distinguish same-product entries
  updateItemQuantity: (productId: number, quantity: number, fulfillmentItemId?: string) => {
    set((state) => {
      const newItems = state.orderItems.map((item) => {
        if (item.product.id !== productId) return item;
        // Discriminate by fulfillmentItemId when both WC and manual entries exist
        if (fulfillmentItemId !== undefined && item.fulfillmentItemId !== fulfillmentItemId) return item;
        if (fulfillmentItemId === undefined && item.fulfillmentItemId !== undefined) return item;
        const actualQuantity = Math.min(quantity, item.product.currentQuantity);
        return { ...item, quantity: actualQuantity };
      });

      return { orderItems: newItems.filter((item) => item.quantity > 0) };
    });
  },

  // Amendment 5: removeItem uses fulfillmentItemId to distinguish same-product entries
  removeItem: (productId: number, fulfillmentItemId?: string) => {
    set((state) => ({
      orderItems: state.orderItems.filter((item) => {
        if (item.product.id !== productId) return true;
        // If fulfillmentItemId provided, only remove matching entry
        if (fulfillmentItemId !== undefined) {
          return item.fulfillmentItemId !== fulfillmentItemId;
        }
        // If no fulfillmentItemId, remove manual entries for this product
        return item.fulfillmentItemId !== undefined;
      }),
    }));
  },

  setOrderReference: (reference: string) => {
    set({ orderReference: reference });
  },

  // Amendment 6: clearOrder also resets WC state
  clearOrder: () => {
    set({
      orderItems: [],
      orderReference: "",
      isProcessing: false,
      orderSource: 'manual',
      selectedExternalOrder: null,
      unmappedExternalItems: [],
    });
  },

  setIsProcessing: (processing: boolean) => {
    set({ isProcessing: processing });
  },

  // Queue actions
  addToQueue: (reference: string) => {
    const trimmed = reference.trim();
    if (!trimmed) return;
    set((state) => {
      const newQueue = [...state.orderQueue, trimmed];
      // If no current order reference, auto-populate from first queue item
      if (!state.orderReference.trim()) {
        return {
          orderQueue: newQueue.slice(1),
          orderReference: newQueue[0],
        };
      }
      return { orderQueue: newQueue };
    });
  },

  removeFromQueue: (index: number) => {
    set((state) => ({
      orderQueue: state.orderQueue.filter((_, i) => i !== index),
    }));
  },

  clearQueue: () => {
    set({ orderQueue: [] });
  },

  // Amendment 6: advanceQueue forces manual mode since queue only stores string references
  advanceQueue: () => {
    const state = get();
    if (state.orderQueue.length === 0) return null;
    const [next, ...rest] = state.orderQueue;
    set({
      orderItems: [],
      orderReference: next,
      isProcessing: false,
      orderQueue: rest,
      orderSource: 'manual',
      selectedExternalOrder: null,
      unmappedExternalItems: [],
    });
    return next;
  },

  reorderQueue: (fromIndex: number, toIndex: number) => {
    set((state) => {
      const newQueue = [...state.orderQueue];
      const [moved] = newQueue.splice(fromIndex, 1);
      newQueue.splice(toIndex, 0, moved);
      return { orderQueue: newQueue };
    });
  },

  getQueuePosition: () => {
    const state = get();
    // Only show position when there's a current order reference and queue items
    if (!state.orderReference.trim()) return null;
    const total = state.orderQueue.length + 1; // +1 for the current order
    if (total <= 1) return null;
    return { current: 1, total };
  },

  // WC order actions
  // P1-8: When switching away from a WC order, clear the full WC state so the
  // manual tab doesn't inherit stale items, a WC order reference, or the
  // selectedExternalOrder banner.
  setOrderSource: (source: 'manual' | 'wc-order') => {
    set((state) => {
      if (source === 'manual' && state.selectedExternalOrder) {
        return {
          orderSource: 'manual',
          selectedExternalOrder: null,
          unmappedExternalItems: [],
          orderItems: [],
          orderReference: '',
        };
      }
      return { orderSource: source };
    });
  },

  selectExternalOrder: (order: ExternalOrder, products: ProductWithQuantity[]) => {
    const cartItems: OrderItem[] = [];
    const unmappedItems: UnmappedExternalItem[] = [];

    if (order.items) {
      for (const item of order.items) {
        // Skip fully fulfilled items
        const remainingQty = item.quantity - item.fulfilledQty;
        if (remainingQty <= 0) continue;

        // Bundle items can't be added to the workbench cart (cart entries are
        // 1:1 with a single internal product). Surface them with isBundle=true
        // so the alert can render the right message — operators fulfill bundles
        // via the Order Details sheet, not the workbench. They are still mapped
        // (isMapped=true with productLink.isBundle=true), so don't treat as
        // "unmapped" — the message is different.
        if (item.isMapped && item.productLink?.isBundle) {
          unmappedItems.push({
            name: item.name,
            sku: item.sku ?? undefined,
            quantity: remainingQty,
            externalItemId: item.id,
            externalProductId: item.externalProductId ?? undefined,
            externalVariantId: item.externalVariantId ?? undefined,
            isBundle: true,
          });
        } else if (item.isMapped && item.productLink?.internalProduct) {
          // Find matching product in the loaded products array
          const matchingProduct = products.find(
            (p) => p.id === item.productLink!.internalProductId
          );

          if (matchingProduct) {
            let qty = remainingQty;

            // Amendment 8: warn if order needs more than available stock, cap at stock
            if (qty > matchingProduct.currentQuantity) {
              toast.warning(
                `${matchingProduct.name}: order needs ${qty}, only ${matchingProduct.currentQuantity} in stock`
              );
              qty = matchingProduct.currentQuantity;
            }

            if (qty > 0) {
              cartItems.push({
                product: matchingProduct,
                quantity: qty,
                fulfillmentItemId: item.id,
                source: 'wc-order',
              });
            }
          } else {
            // Product was mapped but not found in loaded products array
            unmappedItems.push({
              name: item.name,
              sku: item.sku ?? undefined,
              quantity: remainingQty,
              externalItemId: item.id,
            });
          }
        } else {
          // Not mapped — store as unmapped
          unmappedItems.push({
            name: item.name,
            sku: item.sku ?? undefined,
            quantity: remainingQty,
            externalItemId: item.id,
            externalProductId: item.externalProductId ?? undefined,
            externalVariantId: item.externalVariantId ?? undefined,
          });
        }
      }
    }

    set({
      orderSource: 'wc-order',
      selectedExternalOrder: {
        id: order.id,
        orderNumber: order.orderNumber,
        customerName: order.customerName ?? undefined,
        total: order.total,
        integrationId: order.integrationId, // P1-10: thread through for Map button
      },
      orderReference: order.orderNumber,
      orderItems: cartItems,
      unmappedExternalItems: unmappedItems,
    });
  },

  clearExternalOrder: () => {
    set({
      selectedExternalOrder: null,
      unmappedExternalItems: [],
      orderItems: [],
      orderReference: "",
      orderSource: 'manual',
    });
  },

  // Computed values
  getTotalItems: () => {
    const state = get();
    return state.orderItems.length;
  },

  getTotalQuantity: () => {
    const state = get();
    return state.orderItems.reduce((total, item) => total + item.quantity, 0);
  },
}));