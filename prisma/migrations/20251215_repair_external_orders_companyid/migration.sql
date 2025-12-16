-- Repair migration: ensure external_orders has companyId (multi-tenant)
-- Some deployments may have created `external_orders` before multi-tenancy, missing `companyId`.
-- This migration is written to be safe to run on different DB states.

SET @ts := DATE_FORMAT(NOW(), '%Y%m%d%H%i%S');

SET @table_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
);

-- If external_orders exists but is missing integrationId, it's a legacy/incorrect table.
-- Rename it aside and recreate the correct table shape expected by current Prisma schema.
SET @integration_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'integrationId'
);

SET @needs_recreate := IF(@table_exists > 0 AND @integration_col_exists = 0, 1, 0);

-- Rename legacy external_order_items first (if present) to avoid FK rename issues.
SET @items_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'external_order_items'
);

SET @sql := IF(
  @needs_recreate = 1 AND @items_exists > 0,
  CONCAT('RENAME TABLE `external_order_items` TO `external_order_items_legacy_', @ts, '`'),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @needs_recreate = 1,
  CONCAT('RENAME TABLE `external_orders` TO `external_orders_legacy_', @ts, '`'),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Recreate external_orders table (only when we renamed a legacy version)
SET @sql := IF(
  @needs_recreate = 1,
  'CREATE TABLE `external_orders` (\
    `id` VARCHAR(191) NOT NULL,\
    `companyId` VARCHAR(191) NOT NULL,\
    `integrationId` VARCHAR(191) NOT NULL,\
    `externalId` VARCHAR(255) NOT NULL,\
    `orderNumber` VARCHAR(100) NOT NULL,\
    `nativeStatus` VARCHAR(100) NOT NULL,\
    `financialStatus` VARCHAR(100) NULL,\
    `fulfillmentStatus` VARCHAR(100) NULL,\
    `total` DECIMAL(10, 2) NOT NULL,\
    `currency` VARCHAR(10) NOT NULL DEFAULT ''USD'',\
    `customerEmail` VARCHAR(255) NULL,\
    `customerName` VARCHAR(255) NULL,\
    `rawPayload` JSON NOT NULL,\
    `internalStatus` VARCHAR(50) NOT NULL DEFAULT ''pending'',\
    `fulfilledAt` DATETIME(3) NULL,\
    `fulfilledBy` INTEGER NULL,\
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),\
    `updatedAt` DATETIME(3) NOT NULL,\
    `externalCreatedAt` DATETIME(3) NULL,\
    INDEX `external_orders_companyId_internalStatus_idx`(`companyId`, `internalStatus`),\
    INDEX `external_orders_companyId_createdAt_idx`(`companyId`, `createdAt`),\
    UNIQUE INDEX `external_orders_integrationId_externalId_key`(`integrationId`, `externalId`),\
    PRIMARY KEY (`id`)\
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Recreate external_order_items table (only when we renamed a legacy version)
SET @sql := IF(
  @needs_recreate = 1,
  'CREATE TABLE `external_order_items` (\
    `id` VARCHAR(191) NOT NULL,\
    `orderId` VARCHAR(191) NOT NULL,\
    `externalItemId` VARCHAR(255) NULL,\
    `externalProductId` VARCHAR(255) NOT NULL,\
    `externalVariantId` VARCHAR(255) NULL,\
    `name` VARCHAR(500) NOT NULL,\
    `sku` VARCHAR(255) NULL,\
    `quantity` INTEGER NOT NULL,\
    `fulfilledQty` INTEGER NOT NULL DEFAULT 0,\
    `price` DECIMAL(10, 2) NOT NULL,\
    `productLinkId` VARCHAR(191) NULL,\
    `isMapped` BOOLEAN NOT NULL DEFAULT false,\
    INDEX `external_order_items_orderId_idx`(`orderId`),\
    INDEX `external_order_items_externalVariantId_idx`(`externalVariantId`),\
    PRIMARY KEY (`id`)\
  ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add foreign keys if referenced tables exist (best-effort).
SET @companies_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'companies'
);
SET @integrations_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integrations'
);
SET @users_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'users'
);
SET @product_links_exists := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'product_links'
);

SET @sql := IF(
  @needs_recreate = 1 AND @companies_exists > 0,
  'ALTER TABLE `external_orders` ADD CONSTRAINT `external_orders_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @needs_recreate = 1 AND @integrations_exists > 0,
  'ALTER TABLE `external_orders` ADD CONSTRAINT `external_orders_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @needs_recreate = 1 AND @users_exists > 0,
  'ALTER TABLE `external_orders` ADD CONSTRAINT `external_orders_fulfilledBy_fkey` FOREIGN KEY (`fulfilledBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @needs_recreate = 1,
  'ALTER TABLE `external_order_items` ADD CONSTRAINT `external_order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `external_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql := IF(
  @needs_recreate = 1 AND @product_links_exists > 0,
  'ALTER TABLE `external_order_items` ADD CONSTRAINT `external_order_items_productLinkId_fkey` FOREIGN KEY (`productLinkId`) REFERENCES `product_links`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add companyId column if missing
SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'companyId'
);

SET @sql := IF(
  @table_exists > 0 AND @col_exists = 0,
  'ALTER TABLE `external_orders` ADD COLUMN `companyId` VARCHAR(191) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill companyId from integrations.companyId (if possible)
SET @integrations_exists := (
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = DATABASE()
    AND table_name = 'integrations'
);

SET @integration_col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'integrationId'
);

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND column_name = 'companyId'
);

SET @sql := IF(
  @table_exists > 0 AND @integrations_exists > 0 AND @col_exists > 0 AND @integration_col_exists > 0,
  'UPDATE `external_orders` eo JOIN `integrations` i ON eo.`integrationId` = i.`id` SET eo.`companyId` = i.`companyId` WHERE eo.`companyId` IS NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- If fully backfilled, enforce NOT NULL
SET @null_count := IF(
  @table_exists > 0 AND @col_exists > 0,
  (SELECT COUNT(*) FROM `external_orders` WHERE `companyId` IS NULL),
  0
);

SET @sql := IF(
  @table_exists > 0 AND @col_exists > 0 AND @null_count = 0,
  'ALTER TABLE `external_orders` MODIFY COLUMN `companyId` VARCHAR(191) NOT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add index if missing (helps common queries)
SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'external_orders'
    AND index_name = 'external_orders_companyId_createdAt_idx'
);

SET @sql := IF(
  @table_exists > 0 AND @idx_exists = 0 AND @col_exists > 0,
  'CREATE INDEX `external_orders_companyId_createdAt_idx` ON `external_orders`(`companyId`, `createdAt`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
