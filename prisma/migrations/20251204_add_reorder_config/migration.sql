-- CreateTable: Global reorder settings (singleton, always id=1)
CREATE TABLE `global_reorder_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `defaultLeadTimeDays` INTEGER NOT NULL DEFAULT 14,
    `defaultSafetyStockDays` INTEGER NOT NULL DEFAULT 7,
    `holdingCostRate` DECIMAL(5, 4) NOT NULL DEFAULT 0.25,
    `updatedBy` INTEGER NULL,
    `updatedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Insert default row for singleton table
INSERT INTO `global_reorder_settings` (`id`, `defaultLeadTimeDays`, `defaultSafetyStockDays`, `holdingCostRate`)
VALUES (1, 14, 7, 0.25);

-- CreateTable: Per-product reorder configuration
CREATE TABLE `product_reorder_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `leadTimeDays` INTEGER NULL,
    `customSafetyStockDays` INTEGER NULL,
    `minOrderQuantity` INTEGER NOT NULL DEFAULT 1,
    `reorderPointOverride` INTEGER NULL,
    `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updatedAt` DATETIME(0) NOT NULL,

    UNIQUE INDEX `product_reorder_configs_productId_key`(`productId`),
    INDEX `idx_reorder_config_product`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_reorder_configs` ADD CONSTRAINT `product_reorder_configs_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
