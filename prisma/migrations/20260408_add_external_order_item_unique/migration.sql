-- Pre-migration audit: run this to check for duplicates before applying
-- SELECT orderId, externalItemId, COUNT(*) as cnt FROM external_order_items
-- WHERE externalItemId IS NOT NULL GROUP BY orderId, externalItemId HAVING cnt > 1;
-- If duplicates exist, delete the older duplicates before applying this migration.

-- Add unique constraint on (orderId, externalItemId) for ExternalOrderItem.
-- MySQL unique indexes allow multiple NULLs, so items without an externalItemId won't conflict.
ALTER TABLE `external_order_items` ADD UNIQUE INDEX `idx_order_item_unique` (`orderId`, `externalItemId`);
