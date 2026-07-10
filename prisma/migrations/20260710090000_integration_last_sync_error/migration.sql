-- Phase B: durable order-sync failure signal (R-D2). Additive, no rebuild risk.
ALTER TABLE `integrations` ADD COLUMN `lastSyncError` TEXT NULL;
