-- Lane 6 — L-WOO: read-only WooCommerce fulfillment observation feed.
--
-- Three additive tables. Woo core has NO per-item fulfillment quantity, so the
-- only truthful metric is "units on a COMPLETED order" (unitsOnCompletedOrder),
-- attributed to date_completed_gmt. NEVER "fulfilled quantity".
--
-- Guarded DDL throughout (MySQL 8 has no CREATE TABLE / ADD CONSTRAINT
-- IF-NOT-EXISTS for foreign keys) so this migration is a no-op on any environment
-- that already has the tables.

-- ---------------------------------------------------------------------------
-- fulfillment_observations — line-item grain (REV-2 #18).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fulfillment_observations` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `integrationId` VARCHAR(191) NOT NULL,
  `externalOrderId` VARCHAR(64) NOT NULL,
  `externalItemId` VARCHAR(64) NOT NULL,
  `productId` INTEGER NULL,
  `unitsOnCompletedOrder` INTEGER NOT NULL,
  `orderStatus` VARCHAR(24) NOT NULL,
  `completedAt` DATETIME(3) NULL,
  `sourceModifiedAt` DATETIME(3) NOT NULL,
  `hasPartialRefund` BOOLEAN NOT NULL DEFAULT false,
  `isFullyRefunded` BOOLEAN NOT NULL DEFAULT false,
  `tombstonedAt` DATETIME(3) NULL,
  `lastObservedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `fulfillment_obs_integration_order_item_key`(`integrationId`, `externalOrderId`, `externalItemId`),
  INDEX `fulfillment_observations_completedAt_idx`(`completedAt`),
  INDEX `fulfillment_observations_integrationId_tombstonedAt_idx`(`integrationId`, `tombstonedAt`),
  INDEX `fulfillment_observations_productId_idx`(`productId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- fulfillment_sync_state — durable per-integration cursor + backfill state
-- (REV-2 #22/#23/#28). Deliberately NOT Integration.lastSyncAt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fulfillment_sync_state` (
  `integrationId` VARCHAR(191) NOT NULL,
  `cursorModifiedAt` DATETIME(3) NULL,
  `backfillPage` INTEGER NULL,
  `backfillBefore` DATETIME(3) NULL,
  `backfillComplete` BOOLEAN NOT NULL DEFAULT false,
  `lockedAt` DATETIME(3) NULL,
  `heartbeatAt` DATETIME(3) NULL,
  `lastRunAt` DATETIME(3) NULL,
  `lastError` TEXT NULL,
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`integrationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- fulfillment_observation_hints — webhook latency hints (REV-2 #15). The poll,
-- never the webhook, consumes these by GETting current order state.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `fulfillment_observation_hints` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `integrationId` VARCHAR(191) NOT NULL,
  `externalOrderId` VARCHAR(64) NOT NULL,
  `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processedAt` DATETIME(3) NULL,

  UNIQUE INDEX `fulfillment_observation_hints_integrationId_externalOrderId_key`(`integrationId`, `externalOrderId`),
  INDEX `fulfillment_observation_hints_processedAt_idx`(`processedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Foreign keys (guarded — added only when absent). ON DELETE CASCADE: these are
-- platform-derived rows, meaningless without their integration.
-- ---------------------------------------------------------------------------
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME='fulfillment_observations'
              AND CONSTRAINT_NAME='fulfillment_observations_integrationId_fkey');
SET @sql := IF(@fk=0,
  'ALTER TABLE `fulfillment_observations` ADD CONSTRAINT `fulfillment_observations_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME='fulfillment_sync_state'
              AND CONSTRAINT_NAME='fulfillment_sync_state_integrationId_fkey');
SET @sql := IF(@fk=0,
  'ALTER TABLE `fulfillment_sync_state` ADD CONSTRAINT `fulfillment_sync_state_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
            WHERE TABLE_SCHEMA=DATABASE()
              AND TABLE_NAME='fulfillment_observation_hints'
              AND CONSTRAINT_NAME='fulfillment_observation_hints_integrationId_fkey');
SET @sql := IF(@fk=0,
  'ALTER TABLE `fulfillment_observation_hints` ADD CONSTRAINT `fulfillment_observation_hints_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
