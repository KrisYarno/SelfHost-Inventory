-- Drop legacy WooCommerce columns from products table
-- These are replaced by the new multi-tenant ProductLink system

-- NOTE:
-- This migration is intentionally written to be idempotent/safe to re-run.
-- Production databases may already be partially-migrated or have had these columns/index removed.

-- Drop the legacy unique index (if it exists)
SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'products'
    AND index_name = 'unique_woo_product_variation'
);
SET @sql := IF(
  @idx_exists > 0,
  'ALTER TABLE `products` DROP INDEX `unique_woo_product_variation`',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop legacy columns (if they exist)
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'products'
    AND column_name = 'isActive'
);
SET @sql := IF(@col_exists > 0, 'ALTER TABLE `products` DROP COLUMN `isActive`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'products'
    AND column_name = 'wooProductId'
);
SET @sql := IF(@col_exists > 0, 'ALTER TABLE `products` DROP COLUMN `wooProductId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'products'
    AND column_name = 'wooVariationId'
);
SET @sql := IF(@col_exists > 0, 'ALTER TABLE `products` DROP COLUMN `wooVariationId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
