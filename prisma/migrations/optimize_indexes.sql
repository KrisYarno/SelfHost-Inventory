-- Optimize product search performance
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_baseName ON products(baseName);
CREATE INDEX IF NOT EXISTS idx_products_variant ON products(variant);

-- Optimize inventory log queries
CREATE INDEX IF NOT EXISTS idx_inventory_logs_product_location_time 
ON inventory_logs(productId, locationId, changeTime DESC);

-- Optimize location-based queries
CREATE INDEX IF NOT EXISTS idx_product_locations_location 
ON product_locations(locationId);

-- Optimize product location lookups
CREATE INDEX IF NOT EXISTS idx_product_locations_product 
ON product_locations(productId);

-- Composite index for stock level queries
CREATE INDEX IF NOT EXISTS idx_inventory_logs_composite 
ON inventory_logs(productId, locationId, delta);

-- Index for user-based queries
CREATE INDEX IF NOT EXISTS idx_inventory_logs_user_time 
ON inventory_logs(userId, changeTime DESC);