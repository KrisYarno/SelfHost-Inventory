-- CreateTable: companies
CREATE TABLE `companies` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `companies_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: user_companies (junction table)
CREATE TABLE `user_companies` (
    `userId` INTEGER NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(191) NOT NULL DEFAULT 'MEMBER',

    PRIMARY KEY (`userId`, `companyId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: integrations
CREATE TABLE `integrations` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `platform` VARCHAR(50) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `storeUrl` VARCHAR(500) NOT NULL,
    `encryptedApiKey` TEXT NULL,
    `encryptedApiSecret` TEXT NULL,
    `webhookSecret` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastSyncAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `integrations_companyId_idx`(`companyId`),
    INDEX `integrations_platform_idx`(`platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: product_links
CREATE TABLE `product_links` (
    `id` VARCHAR(191) NOT NULL,
    `integrationId` VARCHAR(191) NOT NULL,
    `internalProductId` INTEGER NOT NULL,
    `externalProductId` VARCHAR(255) NOT NULL,
    `externalVariantId` VARCHAR(255) NULL,
    `externalSku` VARCHAR(255) NULL,
    `externalTitle` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `product_links_internalProductId_idx`(`internalProductId`),
    UNIQUE INDEX `product_links_integrationId_externalProductId_externalVaria_key`(`integrationId`, `externalProductId`, `externalVariantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: external_orders
CREATE TABLE `external_orders` (
    `id` VARCHAR(191) NOT NULL,
    `companyId` VARCHAR(191) NOT NULL,
    `integrationId` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(255) NOT NULL,
    `orderNumber` VARCHAR(100) NOT NULL,
    `nativeStatus` VARCHAR(100) NOT NULL,
    `financialStatus` VARCHAR(100) NULL,
    `fulfillmentStatus` VARCHAR(100) NULL,
    `total` DECIMAL(10, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `customerEmail` VARCHAR(255) NULL,
    `customerName` VARCHAR(255) NULL,
    `rawPayload` JSON NOT NULL,
    `internalStatus` VARCHAR(50) NOT NULL DEFAULT 'pending',
    `fulfilledAt` DATETIME(3) NULL,
    `fulfilledBy` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `externalCreatedAt` DATETIME(3) NULL,

    INDEX `external_orders_companyId_internalStatus_idx`(`companyId`, `internalStatus`),
    INDEX `external_orders_companyId_createdAt_idx`(`companyId`, `createdAt`),
    UNIQUE INDEX `external_orders_integrationId_externalId_key`(`integrationId`, `externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable: external_order_items
CREATE TABLE `external_order_items` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `externalItemId` VARCHAR(255) NULL,
    `externalProductId` VARCHAR(255) NOT NULL,
    `externalVariantId` VARCHAR(255) NULL,
    `name` VARCHAR(500) NOT NULL,
    `sku` VARCHAR(255) NULL,
    `quantity` INTEGER NOT NULL,
    `fulfilledQty` INTEGER NOT NULL DEFAULT 0,
    `price` DECIMAL(10, 2) NOT NULL,
    `productLinkId` VARCHAR(191) NULL,
    `isMapped` BOOLEAN NOT NULL DEFAULT false,

    INDEX `external_order_items_orderId_idx`(`orderId`),
    INDEX `external_order_items_externalVariantId_idx`(`externalVariantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey: user_companies -> users
ALTER TABLE `user_companies` ADD CONSTRAINT `user_companies_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: user_companies -> companies
ALTER TABLE `user_companies` ADD CONSTRAINT `user_companies_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: integrations -> companies
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: product_links -> integrations
ALTER TABLE `product_links` ADD CONSTRAINT `product_links_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: product_links -> products
ALTER TABLE `product_links` ADD CONSTRAINT `product_links_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: external_orders -> companies
ALTER TABLE `external_orders` ADD CONSTRAINT `external_orders_companyId_fkey` FOREIGN KEY (`companyId`) REFERENCES `companies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: external_orders -> integrations
ALTER TABLE `external_orders` ADD CONSTRAINT `external_orders_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: external_orders -> users (fulfilledBy)
ALTER TABLE `external_orders` ADD CONSTRAINT `external_orders_fulfilledBy_fkey` FOREIGN KEY (`fulfilledBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: external_order_items -> external_orders
ALTER TABLE `external_order_items` ADD CONSTRAINT `external_order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `external_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: external_order_items -> product_links
ALTER TABLE `external_order_items` ADD CONSTRAINT `external_order_items_productLinkId_fkey` FOREIGN KEY (`productLinkId`) REFERENCES `product_links`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
