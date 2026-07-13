-- CreateTable
CREATE TABLE `webhook_deliveries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `integrationId` VARCHAR(191) NOT NULL,
    `bodyDigest` CHAR(64) NOT NULL,
    `eventId` VARCHAR(128) NULL,
    `status` ENUM('PROCESSING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'PROCESSING',
    `claimedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `webhook_deliveries_receivedAt_idx`(`receivedAt`),
    UNIQUE INDEX `webhook_deliveries_integrationId_bodyDigest_key`(`integrationId`, `bodyDigest`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `external_orders_updatedAt_idx` ON `external_orders`(`updatedAt`);

-- AddForeignKey
ALTER TABLE `webhook_deliveries` ADD CONSTRAINT `webhook_deliveries_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
