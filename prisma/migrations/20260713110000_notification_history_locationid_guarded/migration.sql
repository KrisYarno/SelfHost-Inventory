-- NotificationHistory.locationId drift repair: schema-declared + code-written since 2026-04,
-- present on ALL live DBs, absent from every migration (fresh bootstrap broke). Guarded DDL
-- so live envs (column exists) and fresh envs (column missing) run the SAME migration.
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='notification_history' AND COLUMN_NAME='locationId');
SET @sql := IF(@col=0, 'ALTER TABLE `notification_history` ADD COLUMN `locationId` INT NULL', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='notification_history' AND INDEX_NAME='idx_user_product_loc_type');
SET @sql := IF(@idx=0, 'CREATE INDEX `idx_user_product_loc_type` ON `notification_history`(`userId`,`productId`,`locationId`,`notificationType`)', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Rev-2 preflight: null out orphan pointers so the FK cannot fail on live data
UPDATE `notification_history` nh LEFT JOIN `locations` l ON nh.`locationId` = l.`id`
  SET nh.`locationId` = NULL WHERE nh.`locationId` IS NOT NULL AND l.`id` IS NULL;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='notification_history' AND CONSTRAINT_NAME='notification_history_locationId_fkey');
SET @sql := IF(@fk=0, 'ALTER TABLE `notification_history` ADD CONSTRAINT `notification_history_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
