-- Add external order sync fields (safe/idempotent).

SET @table_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
);

-- platformStatusRaw (JSON)
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'platformStatusRaw'
);
SET @sql := IF(
  @table_exists > 0 AND @col_exists = 0,
  'ALTER TABLE `external_orders` ADD COLUMN `platformStatusRaw` JSON NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- externalStatusHash (VARCHAR(64))
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'externalStatusHash'
);
SET @sql := IF(
  @table_exists > 0 AND @col_exists = 0,
  'ALTER TABLE `external_orders` ADD COLUMN `externalStatusHash` VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- externalOrderUrl (VARCHAR(500))
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'externalOrderUrl'
);
SET @sql := IF(
  @table_exists > 0 AND @col_exists = 0,
  'ALTER TABLE `external_orders` ADD COLUMN `externalOrderUrl` VARCHAR(500) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- externalUpdatedAt (DATETIME(3))
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'externalUpdatedAt'
);
SET @sql := IF(
  @table_exists > 0 AND @col_exists = 0,
  'ALTER TABLE `external_orders` ADD COLUMN `externalUpdatedAt` DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- lastSeenAt (DATETIME(3))
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'lastSeenAt'
);
SET @sql := IF(
  @table_exists > 0 AND @col_exists = 0,
  'ALTER TABLE `external_orders` ADD COLUMN `lastSeenAt` DATETIME(3) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index for integrationId + externalUpdatedAt
SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND index_name = 'external_orders_integrationId_externalUpdatedAt_idx'
);
SET @sql := IF(
  @table_exists > 0 AND @idx_exists = 0,
  'CREATE INDEX `external_orders_integrationId_externalUpdatedAt_idx` ON `external_orders` (`integrationId`, `externalUpdatedAt`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill lastSeenAt for existing rows (use updatedAt as a safe proxy).
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'lastSeenAt'
);
SET @sql := IF(
  @table_exists > 0 AND @col_exists > 0,
  'UPDATE `external_orders` SET `lastSeenAt` = `updatedAt` WHERE `lastSeenAt` IS NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
