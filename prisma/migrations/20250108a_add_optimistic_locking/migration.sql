-- Add optimistic locking support to product_locations table
-- This prevents race conditions when multiple users update inventory simultaneously

-- Add version column for optimistic locking
ALTER TABLE product_locations 
ADD COLUMN version INT NOT NULL DEFAULT 0;

-- Add timestamp column to track when records are updated
ALTER TABLE product_locations 
ADD COLUMN updatedAt DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Add index on updatedAt for performance
CREATE INDEX idx_product_locations_updated ON product_locations(updatedAt);