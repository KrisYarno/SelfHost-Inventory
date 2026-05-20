-- Bundle product mapping: support 1 external → N internal mappings with quantities
-- Note: MySQL 8 does not allow CHECK constraints on columns used in FK referential actions.
-- The isBundle/internalProductId invariant is enforced at the application layer instead.
-- Note: Some statements are wrapped in procedures to handle partial-apply idempotency.

ALTER TABLE `product_links`
  MODIFY COLUMN `internalProductId` INT NULL;

CREATE PROCEDURE _add_bundle_cols()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_links' AND COLUMN_NAME = 'isBundle'
  ) THEN
    ALTER TABLE `product_links` ADD COLUMN `isBundle` BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE `product_links` ADD INDEX `idx_product_links_isBundle` (`isBundle`);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'external_order_items' AND COLUMN_NAME = 'bundleComponentSnapshot'
  ) THEN
    ALTER TABLE `external_order_items` ADD COLUMN `bundleComponentSnapshot` JSON NULL;
  END IF;
END;

CALL _add_bundle_cols();

DROP PROCEDURE _add_bundle_cols;

CREATE TABLE IF NOT EXISTS `bundle_components` (
  `id` VARCHAR(191) NOT NULL,
  `productLinkId` VARCHAR(191) NOT NULL,
  `internalProductId` INT NOT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `sortOrder` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bundle_components_pl_ip` (`productLinkId`, `internalProductId`),
  KEY `idx_bundle_components_ip` (`internalProductId`),
  CONSTRAINT `fk_bundle_components_product_link`
    FOREIGN KEY (`productLinkId`) REFERENCES `product_links`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bundle_components_internal_product`
    FOREIGN KEY (`internalProductId`) REFERENCES `products`(`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
