import { renderHook, act } from '@testing-library/react'
import { useJournalStore } from '@/hooks/use-journal'

describe('useJournalStore', () => {
  beforeEach(() => {
    // Clear the store before each test
    const { result } = renderHook(() => useJournalStore())
    act(() => {
      result.current.clearAllAdjustments()
    })
  })

  describe('addAdjustment', () => {
    it('should add a new adjustment', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
          version: 1
        })
      })

      expect(result.current.adjustments[1]).toEqual({
        productId: 1,
        quantityChange: 10,
        version: 1
      })
    })

    it('should update existing adjustment', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
          version: 1
        })
      })

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 20,
          version: 2
        })
      })

      expect(result.current.adjustments[1]).toEqual({
        productId: 1,
        quantityChange: 20,
        version: 2
      })
    })

    it('should handle multiple products', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: -5,
        })
        result.current.addAdjustment({
          productId: 3,
          quantityChange: 15,
        })
      })

      expect(Object.keys(result.current.adjustments)).toHaveLength(3)
      expect(result.current.adjustments[1].quantityChange).toBe(10)
      expect(result.current.adjustments[2].quantityChange).toBe(-5)
      expect(result.current.adjustments[3].quantityChange).toBe(15)
    })
  })

  describe('removeAdjustment', () => {
    it('should remove an adjustment', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
      })

      act(() => {
        result.current.removeAdjustment(1)
      })

      expect(result.current.adjustments[1]).toBeUndefined()
    })

    it('should not affect other adjustments', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: 20,
        })
      })

      act(() => {
        result.current.removeAdjustment(1)
      })

      expect(result.current.adjustments[1]).toBeUndefined()
      expect(result.current.adjustments[2]).toBeDefined()
    })
  })

  describe('clearAllAdjustments', () => {
    it('should clear all adjustments', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: 20,
        })
      })

      act(() => {
        result.current.clearAllAdjustments()
      })

      expect(Object.keys(result.current.adjustments)).toHaveLength(0)
    })
  })

  describe('getAdjustmentForProduct', () => {
    it('should return adjustment for specific product', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
      })

      const adjustment = result.current.getAdjustmentForProduct(1)
      expect(adjustment).toEqual({
        productId: 1,
        quantityChange: 10,
      })
    })

    it('should return undefined for non-existent product', () => {
      const { result } = renderHook(() => useJournalStore())

      const adjustment = result.current.getAdjustmentForProduct(999)
      expect(adjustment).toBeUndefined()
    })
  })

  describe('hasChanges', () => {
    it('should return false when no adjustments', () => {
      const { result } = renderHook(() => useJournalStore())

      expect(result.current.hasChanges()).toBe(false)
    })

    it('should return true when adjustments exist', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
      })

      expect(result.current.hasChanges()).toBe(true)
    })
  })

  describe('getTotalChanges', () => {
    it('should calculate totals correctly', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: -5,
        })
        result.current.addAdjustment({
          productId: 3,
          quantityChange: 15,
        })
        result.current.addAdjustment({
          productId: 4,
          quantityChange: -3,
        })
      })

      const totals = result.current.getTotalChanges()
      expect(totals.additions).toBe(25) // 10 + 15
      expect(totals.removals).toBe(8) // |-5| + |-3|
      expect(totals.total).toBe(17) // 25 + (-8)
    })

    it('should handle empty adjustments', () => {
      const { result } = renderHook(() => useJournalStore())

      const totals = result.current.getTotalChanges()
      expect(totals.additions).toBe(0)
      expect(totals.removals).toBe(0)
      expect(totals.total).toBe(0)
    })

    it('should handle only additions', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 10,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: 20,
        })
      })

      const totals = result.current.getTotalChanges()
      expect(totals.additions).toBe(30)
      expect(totals.removals).toBe(0)
      expect(totals.total).toBe(30)
    })

    it('should handle only removals', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: -10,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: -20,
        })
      })

      const totals = result.current.getTotalChanges()
      expect(totals.additions).toBe(0)
      expect(totals.removals).toBe(30)
      expect(totals.total).toBe(-30)
    })
  })

  describe('edge cases', () => {
    it('should handle zero quantity change', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 0,
        })
      })

      expect(result.current.adjustments[1].quantityChange).toBe(0)
      const totals = result.current.getTotalChanges()
      expect(totals.additions).toBe(0)
      expect(totals.removals).toBe(0)
      expect(totals.total).toBe(0)
    })

    it('should handle large numbers', () => {
      const { result } = renderHook(() => useJournalStore())

      act(() => {
        result.current.addAdjustment({
          productId: 1,
          quantityChange: 999999,
        })
        result.current.addAdjustment({
          productId: 2,
          quantityChange: -888888,
        })
      })

      const totals = result.current.getTotalChanges()
      expect(totals.additions).toBe(999999)
      expect(totals.removals).toBe(888888)
      expect(totals.total).toBe(111111)
    })
  })
})