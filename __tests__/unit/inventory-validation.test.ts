import { validateBatchAdjustments, validateInventoryChange } from '@/lib/inventory-validation'

// First, let's create the validation functions
describe('Inventory Validation', () => {
  describe('validateInventoryChange', () => {
    it('should allow positive adjustments on any current quantity', () => {
      expect(validateInventoryChange(0, 10)).toBe(true)
      expect(validateInventoryChange(50, 10)).toBe(true)
      expect(validateInventoryChange(100, 1)).toBe(true)
    })

    it('should allow negative adjustments within available quantity', () => {
      expect(validateInventoryChange(100, -50)).toBe(true)
      expect(validateInventoryChange(10, -10)).toBe(true)
      expect(validateInventoryChange(1, -1)).toBe(true)
    })

    it('should prevent negative adjustments exceeding available quantity', () => {
      expect(validateInventoryChange(10, -11)).toBe(false)
      expect(validateInventoryChange(0, -1)).toBe(false)
      expect(validateInventoryChange(50, -100)).toBe(false)
    })

    it('should handle zero adjustments', () => {
      expect(validateInventoryChange(100, 0)).toBe(true)
      expect(validateInventoryChange(0, 0)).toBe(true)
    })

    it('should handle edge cases', () => {
      // Very large numbers
      expect(validateInventoryChange(Number.MAX_SAFE_INTEGER - 1, 1)).toBe(true)
      expect(validateInventoryChange(1, -Number.MAX_SAFE_INTEGER)).toBe(false)
      
      // Decimal values (if supported)
      expect(validateInventoryChange(10.5, -0.5)).toBe(true)
      expect(validateInventoryChange(0.1, -0.2)).toBe(false)
    })
  })

  describe('validateBatchAdjustments', () => {
    const mockInventory = new Map([
      [1, { productId: 1, locationId: 1, quantity: 100 }],
      [2, { productId: 2, locationId: 1, quantity: 50 }],
      [3, { productId: 3, locationId: 1, quantity: 0 }],
    ])

    it('should validate all adjustments successfully', () => {
      const adjustments = [
        { productId: 1, locationId: 1, delta: -50 },
        { productId: 2, locationId: 1, delta: 20 },
      ]

      const result = validateBatchAdjustments(adjustments, mockInventory)
      
      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should catch multiple validation errors', () => {
      const adjustments = [
        { productId: 1, locationId: 1, delta: -150 }, // Exceeds available
        { productId: 3, locationId: 1, delta: -1 },   // No inventory
        { productId: 4, locationId: 1, delta: -10 },  // Product not found
      ]

      const result = validateBatchAdjustments(adjustments, mockInventory)
      
      expect(result.isValid).toBe(false)
      expect(result.errors).toHaveLength(3)
      expect(result.errors[0]).toContain('Insufficient inventory')
      expect(result.errors[1]).toContain('No inventory available')
      expect(result.errors[2]).toContain('Product not found')
    })

    it('should handle new inventory creation', () => {
      const adjustments = [
        { productId: 4, locationId: 1, delta: 100 }, // New product, positive adjustment
      ]

      const result = validateBatchAdjustments(adjustments, mockInventory)
      
      expect(result.isValid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should validate optimistic locking', () => {
      const inventoryWithVersions = new Map([
        [1, { productId: 1, locationId: 1, quantity: 100, version: 5 }],
      ])

      const adjustments = [
        { productId: 1, locationId: 1, delta: -10, expectedVersion: 5 }, // Correct version
        { productId: 1, locationId: 1, delta: -10, expectedVersion: 4 }, // Wrong version
      ]

      const result = validateBatchAdjustments(adjustments, inventoryWithVersions)
      
      expect(result.isValid).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('version mismatch')
    })
  })
})