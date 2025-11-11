-- CreateTable
CREATE TABLE `users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `isAdmin` BOOLEAN NOT NULL DEFAULT false,
    `email` VARCHAR(255) NOT NULL,
    `isApproved` BOOLEAN NOT NULL DEFAULT false,
    `defaultLocationId` INTEGER NOT NULL DEFAULT 1,
    `emailAlerts` BOOLEAN NULL DEFAULT false,

    UNIQUE INDEX `email`(`email`),
    INDEX `fk_user_default_location`(`defaultLocationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `products` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `baseName` VARCHAR(150) NULL,
    `variant` VARCHAR(100) NULL,
    `unit` VARCHAR(20) NULL,
    `numericValue` DECIMAL(10, 2) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 0,
    `location` INTEGER NOT NULL DEFAULT 1,
    `lowStockThreshold` INTEGER NULL DEFAULT 1,
    `costPrice` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `retailPrice` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `deletedAt` DATETIME(0) NULL,
    `deletedBy` INTEGER NULL,

    INDEX `idx_product_sorting`(`baseName`, `numericValue`, `variant`),
    INDEX `idx_deleted`(`deletedAt`),
    INDEX `idx_products_name_fulltext`(`name`),
    INDEX `idx_products_baseName_fulltext`(`baseName`),
    INDEX `idx_products_variant_fulltext`(`variant`),
    INDEX `idx_products_search_composite`(`baseName`, `variant`, `name`),
    INDEX `products_deletedBy_fkey`(`deletedBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `locations` (
    `id` INTEGER NOT NULL,
    `name` VARCHAR(100) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inventory_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `delta` INTEGER NOT NULL,
    `changeTime` DATETIME(0) NOT NULL,
    `locationId` INTEGER NULL,
    `logType` ENUM('ADJUSTMENT', 'TRANSFER') NOT NULL DEFAULT 'ADJUSTMENT',

    INDEX `fk_log_location`(`locationId`),
    INDEX `idx_inventory_logs_product_location_time_desc`(`productId`, `locationId`, `changeTime`),
    INDEX `idx_inventory_logs_type_time`(`logType`, `changeTime`),
    INDEX `idx_inventory_logs_user_covering`(`userId`, `changeTime`, `productId`, `locationId`, `delta`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_locations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `locationId` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `fk_pl_location`(`locationId`),
    INDEX `idx_product_locations_version`(`version`, `updatedAt`),
    INDEX `idx_product_locations_updated`(`updatedAt`),
    UNIQUE INDEX `unique_product_location`(`productId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `notificationType` VARCHAR(50) NOT NULL,
    `sentAt` DATETIME(0) NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_product_type`(`userId`, `productId`, `notificationType`),
    INDEX `idx_notif_product`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `actionType` VARCHAR(50) NOT NULL,
    `entityType` VARCHAR(50) NOT NULL,
    `entityId` INTEGER NULL,
    `batchId` VARCHAR(36) NULL,
    `action` TEXT NOT NULL,
    `details` JSON NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(255) NULL,
    `affectedCount` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_audit_user`(`userId`),
    INDEX `idx_audit_actionType`(`actionType`),
    INDEX `idx_audit_entity`(`entityType`, `entityId`),
    INDEX `idx_audit_batch`(`batchId`),
    INDEX `idx_audit_created`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `fk_user_default_location` FOREIGN KEY (`defaultLocationId`) REFERENCES `locations`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_deletedBy_fkey` FOREIGN KEY (`deletedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_logs` ADD CONSTRAINT `fk_log_location` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `inventory_logs` ADD CONSTRAINT `inventory_logs_ibfk_1` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `inventory_logs` ADD CONSTRAINT `inventory_logs_ibfk_2` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `product_locations` ADD CONSTRAINT `fk_pl_location` FOREIGN KEY (`locationId`) REFERENCES `locations`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `product_locations` ADD CONSTRAINT `fk_pl_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `notification_history` ADD CONSTRAINT `fk_notif_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `notification_history` ADD CONSTRAINT `fk_notif_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `fk_audit_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

