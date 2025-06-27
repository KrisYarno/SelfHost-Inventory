import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface JournalAdjustment {
  productId: number;
  quantityChange: number;
  notes?: string;
}

interface JournalStore {
  adjustments: Record<number, JournalAdjustment>;
  
  // Actions
  addAdjustment: (adjustment: JournalAdjustment) => void;
  removeAdjustment: (productId: number) => void;
  clearAllAdjustments: () => void;
  getAdjustmentForProduct: (productId: number) => JournalAdjustment | undefined;
  
  // Computed values
  hasChanges: () => boolean;
  getTotalChanges: () => {
    additions: number;
    removals: number;
    total: number;
  };
  
  // Local storage management
  loadFromLocalStorage: () => void;
  saveToLocalStorage: () => void;
}

export const useJournalStore = create<JournalStore>()(
  persist(
    (set, get) => ({
      adjustments: {},

      addAdjustment: (adjustment) => {
        set((state) => ({
          adjustments: {
            ...state.adjustments,
            [adjustment.productId]: adjustment,
          },
        }));
      },

      removeAdjustment: (productId) => {
        set((state) => {
          const { [productId]: removed, ...rest } = state.adjustments;
          return { adjustments: rest };
        });
      },

      clearAllAdjustments: () => {
        set({ adjustments: {} });
      },

      getAdjustmentForProduct: (productId) => {
        return get().adjustments[productId];
      },

      hasChanges: () => {
        return Object.keys(get().adjustments).length > 0;
      },

      getTotalChanges: () => {
        const adjustments = Object.values(get().adjustments);
        const additions = adjustments
          .filter((adj) => adj.quantityChange > 0)
          .reduce((sum, adj) => sum + adj.quantityChange, 0);
        const removals = adjustments
          .filter((adj) => adj.quantityChange < 0)
          .reduce((sum, adj) => sum + adj.quantityChange, 0);
        
        return {
          additions,
          removals: Math.abs(removals),
          total: additions + removals,
        };
      },

      loadFromLocalStorage: () => {
        // This is handled automatically by the persist middleware
      },

      saveToLocalStorage: () => {
        // This is handled automatically by the persist middleware
      },
    }),
    {
      name: 'journal-adjustments',
      skipHydration: false,
    }
  )
);