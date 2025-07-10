-- CreateTable
CREATE TABLE `woocommerce_products` (
    `id` VARCHAR(191) NOT NULL,
    `wooCommerceId` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(255) NULL,
    `productId` INTEGER NULL,
    `createdAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updatedAt` DATETIME(0) NOT NULL,

    UNIQUE INDEX `woocommerce_products_wooCommerceId_key`(`wooCommerceId`),
    INDEX `idx_woo_product_mapping`(`productId`),
    INDEX `idx_woo_product_name`(`name`),
    INDEX `idx_woo_product_sku`(`sku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `woocommerce_products` ADD CONSTRAINT `woocommerce_products_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE SET NULL ON UPDATE NO ACTION;

-- Update Product table to add missing fields
ALTER TABLE `products` ADD COLUMN `sku` VARCHAR(255) NULL;
ALTER TABLE `products` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- Update AuditLog table
ALTER TABLE `audit_logs` MODIFY COLUMN `entityId` VARCHAR(255) NULL;
ALTER TABLE `audit_logs` ADD COLUMN `metadata` JSON NULL;