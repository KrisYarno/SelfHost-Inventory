-- Phase D: Stock Sync + Fulfillment Push fields on Integration
ALTER TABLE `integrations`
  ADD COLUMN `stockSyncEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `fulfillmentPushEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `lastStockSyncAt` DATETIME(3) NULL,
  ADD COLUMN `lastStockSyncError` TEXT NULL,
  ADD COLUMN `syncLocationId` INTEGER NULL;
