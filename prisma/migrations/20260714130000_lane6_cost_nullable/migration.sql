-- Lane 6 (R-D3 / review B2): make products.costPrice nullable and backfill the
-- legacy zero-cost rows to NULL. Under the old schema `costPrice DECIMAL(10,2)
-- NOT NULL DEFAULT 0.00`, "unknown cost" and "genuinely free" were the SAME value,
-- so every valuation of a warehouse with no cost data on file read "$0.00".
--
-- After this migration:
--   * NULL            = cost unknown (analytics emits null + a coverage figure)
--   * an explicit 0   = genuinely free (a rare, deliberate human entry — kept)
--
-- All 80 live products are 0-as-in-unknown, so the backfill nulls every one; a
-- human who later enters 0 on purpose means "free" and is preserved by the writers.
--
-- information_schema-guarded so live (column NOT NULL WITH default) and fresh
-- (column already nullable, e.g. a re-run) envs run the SAME migration idempotently.

-- 1. Drop the default + make nullable, only while the column is still NOT NULL.
SET @notnull := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'products'
    AND COLUMN_NAME = 'costPrice'
    AND IS_NULLABLE = 'NO'
);
SET @sql := IF(
  @notnull = 1,
  'ALTER TABLE `products` MODIFY COLUMN `costPrice` DECIMAL(10,2) NULL DEFAULT NULL',
  'SELECT 1'
);
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. Backfill legacy zeros -> NULL (idempotent: once nulled, no rows match). Runs
--    only after the column can hold NULL.
UPDATE `products` SET `costPrice` = NULL WHERE `costPrice` = 0;
