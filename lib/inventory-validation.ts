/**
 * Inventory validation utilities for mass update operations
 */

export interface ValidationResult {
  isValid: boolean
  errors: string[]
}

export interface InventoryRecord {
  productId: number
  locationId: number
  quantity: number
  version?: number
}

export interface AdjustmentRecord {
  productId: number
  locationId: number
  delta: number
  expectedVersion?: number
}

/**
 * Validates if an inventory change is allowed
 * @param currentQuantity The current inventory quantity
 * @param change The proposed change (positive or negative)
 * @returns true if the change is valid, false otherwise
 */
export function validateInventoryChange(currentQuantity: number, change: number): boolean {
  const newQuantity = currentQuantity + change
  return newQuantity >= 0
}

/**
 * Validates a batch of inventory adjustments
 * @param adjustments Array of adjustments to validate
 * @param currentInventory Map of current inventory by productId
 * @returns Validation result with any errors found
 */
export function validateBatchAdjustments(
  adjustments: AdjustmentRecord[],
  currentInventory: Map<number, InventoryRecord>
): ValidationResult {
  const errors: string[] = []

  for (const adjustment of adjustments) {
    const inventory = currentInventory.get(adjustment.productId)

    // Check if product exists in inventory
    if (!inventory) {
      // Allow positive adjustments for new products
      if (adjustment.delta < 0) {
        errors.push(`Product ${adjustment.productId}: Product not found in inventory`)
      }
      continue
    }

    // Check version if optimistic locking is used
    if (adjustment.expectedVersion !== undefined && inventory.version !== undefined) {
      if (adjustment.expectedVersion !== inventory.version) {
        errors.push(`Product ${adjustment.productId}: Version mismatch (expected ${adjustment.expectedVersion}, got ${inventory.version})`)
        continue
      }
    }

    // Check if adjustment would result in negative inventory
    const newQuantity = inventory.quantity + adjustment.delta
    if (newQuantity < 0) {
      if (inventory.quantity === 0) {
        errors.push(`Product ${adjustment.productId}: No inventory available`)
      } else {
        errors.push(`Product ${adjustment.productId}: Insufficient inventory (current: ${inventory.quantity}, trying to remove: ${Math.abs(adjustment.delta)})`)
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}

/**
 * Groups adjustments by location for efficient processing
 * @param adjustments Array of adjustments
 * @returns Map of adjustments grouped by locationId
 */
export function groupAdjustmentsByLocation(
  adjustments: AdjustmentRecord[]
): Map<number, AdjustmentRecord[]> {
  const grouped = new Map<number, AdjustmentRecord[]>()

  for (const adjustment of adjustments) {
    const locationAdjustments = grouped.get(adjustment.locationId) || []
    locationAdjustments.push(adjustment)
    grouped.set(adjustment.locationId, locationAdjustments)
  }

  return grouped
}

/**
 * Calculates the net change for a set of adjustments
 * @param adjustments Array of adjustments
 * @returns Object with additions, removals, and net totals
 */
export function calculateNetChanges(adjustments: AdjustmentRecord[]) {
  let additions = 0
  let removals = 0

  for (const adjustment of adjustments) {
    if (adjustment.delta > 0) {
      additions += adjustment.delta
    } else {
      removals += Math.abs(adjustment.delta)
    }
  }

  return {
    additions,
    removals,
    net: additions - removals
  }
}

/**
 * Validates adjustment data types and required fields
 * @param adjustment The adjustment to validate
 * @returns true if valid, error message if invalid
 */
export function validateAdjustmentData(adjustment: any): true | string {
  if (typeof adjustment.productId !== 'number') {
    return 'productId must be a number'
  }
  if (typeof adjustment.locationId !== 'number') {
    return 'locationId must be a number'
  }
  if (typeof adjustment.delta !== 'number') {
    return 'delta must be a number'
  }
  if (adjustment.expectedVersion !== undefined && typeof adjustment.expectedVersion !== 'number') {
    return 'expectedVersion must be a number if provided'
  }
  return true
}