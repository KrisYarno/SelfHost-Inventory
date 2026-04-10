-- Separate "Stocked Out" (inventory deduction truth) from internalStatus
-- (WC order lifecycle). stockedOut tracks whether physical inventory has been
-- deducted for this order, independent of what WooCommerce says about the
-- commercial order status.
--
-- stockedOut:   true when any inventory has been deducted (fulfill/workbench)
-- stockedOutAt: when the first deduction happened
-- stockedOutBy: which user performed the deduction
ALTER TABLE `external_orders`
  ADD COLUMN `stockedOut` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `stockedOutAt` DATETIME(3) NULL,
  ADD COLUMN `stockedOutBy` INT NULL,
  ADD INDEX `idx_stocked_out` (`stockedOut`);

-- Backfill: any order that already has fulfilled items is stocked out.
-- This catches orders fulfilled before this migration existed.
UPDATE `external_orders` eo
SET eo.`stockedOut` = TRUE,
    eo.`stockedOutAt` = eo.`fulfilledAt`,
    eo.`stockedOutBy` = eo.`fulfilledBy`
WHERE EXISTS (
  SELECT 1 FROM `external_order_items` eoi
  WHERE eoi.`orderId` = eo.`id`
    AND eoi.`fulfilledQty` > 0
);
