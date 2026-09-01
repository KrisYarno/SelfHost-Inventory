import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface JournalAdjustment {
  productId: number;
  quantityChange: number;
  version?: number;
}

/**
 * THE REQUEST CAP, CLIENT-SIDE (reconciliation Part 2, pack REV-22 F4).
 *
 * `/api/inventory/batch-adjust` refuses more than 100 adjustments in one
 * request (`lib/validation/inventory.ts`: "at most 100 items per request"), and
 * B1's prelock caps the key set for the same reason. The journal's cart has no
 * such limit, so a stocker could spend an hour on 140 rows and learn about the
 * cap only from a 400 — with the whole batch refused and nothing to tell them
 * which half to cut. These three constants are what the cart counts against;
 * the copy is shared so the action bar and the review dialog say ONE sentence.
 */
export const MAX_JOURNAL_ITEMS = 100;

/** The counter becomes visible from here on — before the cap, not at it. */
export const JOURNAL_COUNTER_FROM = 80;

export const JOURNAL_CAP_MESSAGE = `at most ${MAX_JOURNAL_ITEMS} items per request — split this batch`;

interface JournalStore {
  adjustments: Record<number, JournalAdjustment>;
  
  // Actions
  addAdjustment: (adjustment: JournalAdjustment) => void;
  removeAdjustment: (productId: number) => void;
  clearAllAdjustments: () => void;
  /**
   * Re-seed every pending entry's `version` from a fresh product read
   * (reconciliation Part 2, pack REV-22 F5).
   *
   * The cart is persisted, so an entry keeps the version it captured when the
   * operator typed the number — and after a 409 that version is stale FOREVER:
   * the page refetched the products but never told the cart, so every retry
   * re-sent the losing `expectedVersion`. Quantities are the operator's intent
   * and are never touched; a product the read did not return keeps what it had
   * (inventing a version for it would be worse than the honest conflict).
   */
  reseedVersions: (products: Array<{ id: number; version?: number }>) => void;
  getAdjustmentForProduct: (productId: number) => JournalAdjustment | undefined;
  
  // Computed values
  hasChanges: () => boolean;
  getTotalChanges: () => {
    additions: number;
    removals: number;
    total: number;
  };
}

export const useJournalStore = create<JournalStore>()(
  persist(
    (set, get) => ({
      adjustments: {},

      addAdjustment: (adjustment) => {
        set((state) => {
          const newAdjustments = {
            ...state.adjustments,
            [adjustment.productId]: adjustment,
          };
          return { adjustments: newAdjustments };
        });
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

      reseedVersions: (products) => {
        set((state) => {
          const freshVersions: Record<number, number | undefined> = {};
          products.forEach((product) => {
            freshVersions[product.id] = product.version;
          });

          const adjustments: Record<number, JournalAdjustment> = {};
          Object.values(state.adjustments).forEach((adjustment) => {
            adjustments[adjustment.productId] = Object.prototype.hasOwnProperty.call(
              freshVersions,
              adjustment.productId
            )
              ? { ...adjustment, version: freshVersions[adjustment.productId] }
              : adjustment;
          });

          return { adjustments };
        });
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
          total: additions + removals, // This is the net change (removals is negative)
        };
      },

    }),
    {
      name: 'journal-adjustments',
      skipHydration: false,
      partialize: (state) => ({ adjustments: state.adjustments }), // Only persist adjustments
    }
  )
);