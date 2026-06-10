-- Add nullable transferId to inventory_logs: pairs the +/- rows of a transfer.
-- Guarded: MySQL lacks IF NOT EXISTS for ADD COLUMN, so guard via information_schema.
SET @col_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventory_logs'
    AND COLUMN_NAME = 'transferId'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE `inventory_logs` ADD COLUMN `transferId` VARCHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
