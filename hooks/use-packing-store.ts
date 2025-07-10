import { create } from 'zustand'

interface PackingStore {
  packedItems: string[]
  addPackedItem: (itemId: string) => void
  removePackedItem: (itemId: string) => void
  clearPackedItems: () => void
  isItemPacked: (itemId: string) => boolean
}

export const usePackingStore = create<PackingStore>((set, get) => ({
  packedItems: [],
  
  addPackedItem: (itemId: string) => {
    set((state) => ({
      packedItems: [...new Set([...state.packedItems, itemId])]
    }))
  },
  
  removePackedItem: (itemId: string) => {
    set((state) => ({
      packedItems: state.packedItems.filter(id => id !== itemId)
    }))
  },
  
  clearPackedItems: () => {
    set({ packedItems: [] })
  },
  
  isItemPacked: (itemId: string) => {
    return get().packedItems.includes(itemId)
  }
}))