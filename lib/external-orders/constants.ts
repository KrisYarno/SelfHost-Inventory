/**
 * Sentinel values for bundle fulfillment/unfulfillment results.
 *
 * Bundle items have no single internalProductId — they expand into multiple
 * component deductions. These sentinels stand in for the scalar fields in
 * FulfillmentResult.fulfilled / unfulfill restored arrays so callers can
 * filter them out (id > 0) when they need real product/log identifiers.
 */

/** Placeholder productId for bundle line items (no single internal product). */
export const BUNDLE_SENTINEL_PRODUCT_ID = -1 as const;

/** Placeholder inventoryLogId for bundle line items (multiple logs created). */
export const BUNDLE_SENTINEL_INVENTORY_LOG_ID = -1 as const;
