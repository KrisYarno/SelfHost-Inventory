import { create } from "zustand";
import { WorkbenchState, OrderItem } from "@/types/workbench";
import { ProductWithQuantity } from "@/types/product";

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  // Initial state
  orderItems: [],
  orderReference: "",
  isProcessing: false,

  // Actions
  addItem: (product: ProductWithQuantity, quantity: number) => {
    set((state) => {
      const existingItemIndex = state.orderItems.findIndex(
        (item) => item.product.id === product.id
      );

      if (existingItemIndex !== -1) {
        // Update existing item quantity
        const newItems = [...state.orderItems];
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
          orderItems: [...state.orderItems, { product, quantity: actualQuantity }],
        };
      }
    });
  },

  updateItemQuantity: (productId: number, quantity: number) => {
    set((state) => {
      const newItems = state.orderItems.map((item) => {
        if (item.product.id === productId) {
          // Don't exceed available stock
          const actualQuantity = Math.min(quantity, item.product.currentQuantity);
          return { ...item, quantity: actualQuantity };
        }
        return item;
      });
      
      // Remove items with 0 quantity
      return { orderItems: newItems.filter((item) => item.quantity > 0) };
    });
  },

  removeItem: (productId: number) => {
    set((state) => ({
      orderItems: state.orderItems.filter((item) => item.product.id !== productId),
    }));
  },

  setOrderReference: (reference: string) => {
    set({ orderReference: reference });
  },

  clearOrder: () => {
    set({
      orderItems: [],
      orderReference: "",
      isProcessing: false,
    });
  },

  setIsProcessing: (processing: boolean) => {
    set({ isProcessing: processing });
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