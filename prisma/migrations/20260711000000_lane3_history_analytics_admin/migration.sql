-- Lane 3: run history, timeline/receipt indexes, threshold inheritance (spec R-L9/R-L13/R-L14, D8/D9)
CREATE TABLE `analytics_rebuild_runs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `job` VARCHAR(32) NOT NULL,
  `mode` VARCHAR(16) NOT NULL,
  `source` VARCHAR(16) NOT NULL,
  `status` VARCHAR(16) NOT NULL,
  `requestedByUserId` INT NULL,
  `startedAt` DATETIME(3) NOT NULL,
  `finishedAt` DATETIME(3) NULL,
  `durationMs` INT NULL,
  `windowFrom` CHAR(10) NULL,
  `windowTo` CHAR(10) NULL,
  `rowsDeleted` INT NOT NULL DEFAULT 0,
  `rowsInserted` INT NOT NULL DEFAULT 0,
  `unattributed` INT NOT NULL DEFAULT 0,
  `flaggedPairs` INT NOT NULL DEFAULT 0,
  `sourceWatermark` DATETIME(0) NULL,
  `skippedReason` VARCHAR(64) NULL,
  `error` TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_rebuild_runs_job_started` (`job`, `startedAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `audit_logs`
  DROP INDEX `idx_audit_entity`,
  ADD INDEX `idx_audit_entity_time` (`entityType`, `entityId`, `createdAt`);

ALTER TABLE `inventory_logs`
  ADD INDEX `idx_inventory_logs_type_product_time` (`logType`, `productId`, `changeTime`);

ALTER TABLE `products` ALTER `lowStockThreshold` DROP DEFAULT;
UPDATE `products` SET `lowStockThreshold` = NULL WHERE `lowStockThreshold` = 10;
