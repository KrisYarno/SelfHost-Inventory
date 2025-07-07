-- Add soft delete fields to products table
ALTER TABLE `products` 
ADD COLUMN `deletedAt` DATETIME(0) NULL,
ADD COLUMN `deletedBy` INT NULL;

-- Add foreign key constraint for deletedBy
ALTER TABLE `products`
ADD CONSTRAINT `products_deletedBy_fkey` FOREIGN KEY (`deletedBy`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Add index for deletedAt to improve query performance
CREATE INDEX `idx_deleted` ON `products`(`deletedAt`);