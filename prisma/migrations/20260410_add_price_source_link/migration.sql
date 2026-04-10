-- Retail Price Sync: add priceSourceLinkId to products.
-- Points at the ONE ProductLink whose external regular_price should be
-- pulled into this product's retailPrice on manual sync.
-- NULL = manual pricing (current behavior, default for all existing rows).
-- ON DELETE SET NULL: if the linked ProductLink is removed, the product
-- reverts to manual pricing and keeps its last-synced retailPrice value.
-- The products table uses utf8mb4_0900_ai_ci but product_links uses
-- utf8mb4_unicode_ci. The FK column must match the referenced column's
-- collation for MySQL to accept the constraint.
ALTER TABLE `products`
  ADD COLUMN `priceSourceLinkId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL;

ALTER TABLE `products`
  ADD INDEX `idx_price_source` (`priceSourceLinkId`);

ALTER TABLE `products`
  ADD CONSTRAINT `fk_price_source_link`
    FOREIGN KEY (`priceSourceLinkId`)
    REFERENCES `product_links`(`id`)
    ON DELETE SET NULL;
