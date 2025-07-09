-- Add optimistic locking fields to product_locations table
ALTER TABLE `product_locations` 
ADD COLUMN `version` INT NOT NULL DEFAULT 0,
ADD COLUMN `updatedAt` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Add index on updatedAt for potential query optimization
CREATE INDEX `idx_product_locations_updated` ON `product_locations`(`updatedAt`);