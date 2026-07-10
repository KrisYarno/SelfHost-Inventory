-- Phase C (P-C1): first-class ledger<->audit join. Additive, no rebuild risk.
ALTER TABLE `inventory_logs` ADD COLUMN `batchId` VARCHAR(36) NULL, ADD INDEX `idx_inventory_logs_batch` (`batchId`);
