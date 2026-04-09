-- Backfill for product_locations.minQuantity which exists in prisma/schema.prisma
-- but was never captured in a migration. Drift discovered during Phase 6 QA
-- when the fulfill/validate endpoint failed with
-- "The column `inventory.product_locations.minQuantity` does not exist".
--
-- Per-location minimum on hand; 0 disables the low-stock trigger for that row.
ALTER TABLE `product_locations`
  ADD COLUMN `minQuantity` INT NOT NULL DEFAULT 0;
