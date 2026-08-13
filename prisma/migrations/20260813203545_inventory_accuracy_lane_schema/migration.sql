-- Inventory-accuracy lane (contract pack REV-2 T1) — THE migration.
--
-- The whole lane's schema rides this ONE additive migration: two net-new tables
-- (inbound_shipments, inventory_exceptions), six new nullable columns on two
-- existing tables, three indexes, two actor foreign keys. Nothing is dropped and
-- no existing column is modified.
--
-- Unguarded (plain generated DDL), matching 20260810211125's precedent: every
-- structure here is net-new to this lane, so none can pre-exist on any
-- environment. The guarded information_schema style is reserved for the repair /
-- adoption migrations, where the structure IS already present somewhere.
--
-- NOTE on inventory_logs.orderRecordId: the production database carries a
-- DB-ONLY `externalOrderId` column on this table — an INT with a foreign key to
-- external_orders_legacy_20251215223839. It is the wrong type against the wrong
-- target and can never be adopted, so the lane's column is a distinct, final
-- name. This migration does not touch the legacy column.

-- AlterTable
ALTER TABLE `staging_items` ADD COLUMN `countedAt` DATETIME(3) NULL,
    ADD COLUMN `countedBy` INTEGER NULL,
    ADD COLUMN `shipmentId` VARCHAR(30) NULL,
    ADD COLUMN `unitCostCents` INTEGER NULL;

-- AlterTable
ALTER TABLE `inventory_logs` ADD COLUMN `inboundShipmentId` VARCHAR(30) NULL,
    ADD COLUMN `orderRecordId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `inbound_shipments` (
    `id` VARCHAR(30) NOT NULL,
    `supplierRef` VARCHAR(255) NULL,
    `status` ENUM('OPEN', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `createdBy` INTEGER NOT NULL,
    `closedBy` INTEGER NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `closedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_exceptions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `subject` JSON NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedBy` INTEGER NULL,
    `note` TEXT NULL,

    UNIQUE INDEX `inventory_exceptions_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `staging_items_shipmentId_idx` ON `staging_items`(`shipmentId`);

-- CreateIndex
CREATE INDEX `inventory_logs_orderRecordId_idx` ON `inventory_logs`(`orderRecordId`);

-- CreateIndex
CREATE INDEX `inventory_logs_inboundShipmentId_idx` ON `inventory_logs`(`inboundShipmentId`);

-- AddForeignKey
ALTER TABLE `staging_items` ADD CONSTRAINT `staging_items_countedBy_fkey` FOREIGN KEY (`countedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inbound_shipments` ADD CONSTRAINT `inbound_shipments_createdBy_fkey` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;
