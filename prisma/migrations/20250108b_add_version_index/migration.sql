-- Index for optimistic locking version checks
-- This migration depends on 20250108_add_optimistic_locking being applied first
CREATE INDEX idx_product_locations_version 
ON product_locations(version, updatedAt);