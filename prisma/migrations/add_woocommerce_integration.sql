-- Add WooCommerce Integration Tables and Columns
-- This migration adds all necessary tables and columns for WooCommerce integration

-- 1. ALTER TABLES - Add missing columns to existing tables

-- Add WooCommerce columns to products table if they don't exist
ALTER TABLE `products` 
  ADD COLUMN IF NOT EXISTS `wooProductId` INT NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS `wooVariationId` INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `wooSku` VARCHAR(255) NULL UNIQUE,
  ADD COLUMN IF NOT EXISTS `lastWooSync` DATETIME(0) NULL;

-- Add unique constraint for wooProductId and wooVariationId combination
ALTER TABLE `products` 
  ADD UNIQUE INDEX IF NOT EXISTS `unique_woo_product_variation` (`wooProductId`, `wooVariationId`);

-- Add externalOrderId to inventory_logs table
ALTER TABLE `inventory_logs` 
  ADD COLUMN IF NOT EXISTS `externalOrderId` INT NULL;

-- Add index for externalOrderId
ALTER TABLE `inventory_logs` 
  ADD INDEX IF NOT EXISTS `idx_inventory_logs_external_order` (`externalOrderId`);

-- 2. CREATE TABLES - Create new WooCommerce integration tables

-- Create ExternalOrder table
CREATE TABLE IF NOT EXISTS `external_orders` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `wooOrderId` INT NOT NULL UNIQUE,
  `orderNumber` VARCHAR(100) NOT NULL UNIQUE,
  `status` VARCHAR(50) NOT NULL COMMENT 'processing, packed, cancelled',
  `orderTotal` DECIMAL(10, 2) NOT NULL,
  `currency` VARCHAR(10) NOT NULL,
  `jsonData` JSON NOT NULL COMMENT 'Sanitized order data without personal info',
  `packedAt` DATETIME(0) NULL,
  `packedBy` INT NULL,
  `syncedAt` DATETIME(0) NOT NULL,
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_external_order_status` (`status`),
  INDEX `idx_external_order_packed_by` (`packedBy`),
  INDEX `idx_external_order_created` (`createdAt`),
  CONSTRAINT `fk_order_packed_by` FOREIGN KEY (`packedBy`) REFERENCES `users` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create ExternalOrderItem table
CREATE TABLE IF NOT EXISTS `external_order_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `orderId` INT NOT NULL,
  `productId` INT NULL,
  `wooProductId` INT NOT NULL,
  `wooVariationId` INT NOT NULL DEFAULT 0,
  `productName` VARCHAR(255) NOT NULL,
  `quantity` INT NOT NULL,
  `price` DECIMAL(10, 2) NOT NULL,
  `metaData` JSON NULL COMMENT 'For bundle info',
  PRIMARY KEY (`id`),
  INDEX `idx_order_item_order` (`orderId`),
  INDEX `idx_order_item_product` (`productId`),
  INDEX `idx_order_item_woo_product` (`wooProductId`, `wooVariationId`),
  CONSTRAINT `fk_order_item_order` FOREIGN KEY (`orderId`) REFERENCES `external_orders` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT `fk_order_item_product` FOREIGN KEY (`productId`) REFERENCES `products` (`id`) ON DELETE SET NULL ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create OrderLock table
CREATE TABLE IF NOT EXISTS `order_locks` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `orderId` INT NOT NULL UNIQUE,
  `lockedBy` INT NOT NULL,
  `lockedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expiresAt` DATETIME(0) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_order_lock_expires` (`expiresAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create Order table (legacy compatibility)
CREATE TABLE IF NOT EXISTS `orders` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `orderNumber` VARCHAR(50) NOT NULL UNIQUE,
  `total` DECIMAL(10, 2) NOT NULL,
  `currency` VARCHAR(3) NOT NULL,
  `status` VARCHAR(50) NOT NULL,
  `dateCreated` DATETIME(0) NOT NULL,
  `dateModified` DATETIME(0) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_order_status` (`status`),
  INDEX `idx_order_created` (`dateCreated`),
  INDEX `idx_order_modified` (`dateModified`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create OrderItem table (legacy compatibility)
CREATE TABLE IF NOT EXISTS `order_items` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `orderId` INT NOT NULL,
  `productId` INT NOT NULL,
  `variationId` INT NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `sku` VARCHAR(100) NOT NULL,
  `quantity` INT NOT NULL,
  `price` DECIMAL(10, 2) NOT NULL,
  `bundleParentId` INT NULL,
  `isBundleParent` BOOLEAN NOT NULL DEFAULT FALSE,
  `bundleChildren` JSON NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_orderitem_order` (`orderId`),
  INDEX `idx_orderitem_product` (`productId`),
  INDEX `idx_orderitem_sku` (`sku`),
  CONSTRAINT `fk_orderitem_order` FOREIGN KEY (`orderId`) REFERENCES `orders` (`id`) ON DELETE CASCADE ON UPDATE NO ACTION
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create SyncLog table
CREATE TABLE IF NOT EXISTS `sync_logs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `syncType` VARCHAR(50) NOT NULL,
  `syncedAt` DATETIME(0) NOT NULL,
  `recordsProcessed` INT NOT NULL DEFAULT 0,
  `errors` JSON NULL,
  `success` BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (`id`),
  INDEX `idx_sync_type_time` (`syncType`, `syncedAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create WebhookEvent table
CREATE TABLE IF NOT EXISTS `webhook_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `eventType` VARCHAR(50) NOT NULL COMMENT 'order.created, order.updated, order.deleted',
  `webhookId` VARCHAR(255) NOT NULL UNIQUE COMMENT 'WooCommerce webhook delivery ID for idempotency',
  `resourceId` INT NOT NULL COMMENT 'WooCommerce order ID',
  `payload` JSON NOT NULL COMMENT 'Sanitized webhook payload',
  `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
  `attempts` INT NOT NULL DEFAULT 0,
  `lastAttemptAt` DATETIME(0) NULL,
  `processedAt` DATETIME(0) NULL,
  `error` TEXT NULL,
  `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_webhook_status_created` (`status`, `createdAt`),
  INDEX `idx_webhook_event_type` (`eventType`),
  INDEX `idx_webhook_resource_id` (`resourceId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Note: WooCommerceProduct table already exists (created in add_woocommerce_products_table.sql)
-- Skipping creation to avoid duplicate table error

-- 3. ADD FOREIGN KEY CONSTRAINTS

-- Add foreign key constraint for inventory_logs.externalOrderId
ALTER TABLE `inventory_logs` 
  ADD CONSTRAINT IF NOT EXISTS `fk_log_external_order` 
  FOREIGN KEY (`externalOrderId`) REFERENCES `external_orders` (`id`) 
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 4. UPDATE ENUM TYPE for inventory_logs_logType if needed
-- Note: MySQL doesn't support ALTER TYPE directly, so we need to modify the column
-- This assumes the EXTERNAL_ORDER value doesn't already exist
ALTER TABLE `inventory_logs` 
  MODIFY COLUMN `logType` ENUM('ADJUSTMENT', 'TRANSFER', 'EXTERNAL_ORDER') NOT NULL DEFAULT 'ADJUSTMENT';